"""The virtual X-ray control frame: geometry, pose and calibration.

Synthetic volumes only. A dense bead drawn in a scan must appear where the
studio's own camera and pixel convention put it, after the known move, and
the written DICOM object must be admitted as a calibrated frame carrying the
same view.
"""

import os
import sys
from pathlib import Path

import pytest

if os.environ.get("SELDINGER_RUN_INGEST_TESTS", "1") != "1":
    pytest.skip("Requires the ingest runtime", allow_module_level=True)

np = pytest.importorskip("numpy")
pytest.importorskip("pydicom")

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "research"))

import virtual_xray as vx

from planner.carm_geometry import camera, project

VIEW = {
    "primary_deg": 20.0,
    "secondary_deg": -10.0,
    "source_detector_mm": 1000.0,
    "source_isocenter_mm": 700.0,
    "detector_width_mm": 160.0,
    "detector_height_mm": 160.0,
}


def turn(axis, degrees):
    a = np.radians(degrees)
    k = np.asarray(axis, dtype=float) / np.linalg.norm(axis)
    kx = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + np.sin(a) * kx + (1 - np.cos(a)) * kx @ kx


def bead_scan(bead_voxel=(30, 22, 26)):
    volume = np.full((60, 50, 56), -1000.0, dtype=np.float32)
    i, j, k = bead_voxel
    volume[i - 1 : i + 2, j - 1 : j + 2, k - 1 : k + 2] = 3000.0
    affine = np.diag([-1.0, -1.0, 1.0, 1.0])
    affine[:3, 3] = [25.0, 20.0, -30.0]
    return volume, affine, np.asarray(bead_voxel, dtype=float)


def pixel_of(view, columns, rows, point, isocenter):
    x, y, _ = project(camera(view, isocenter), [float(c) for c in point])
    return (
        (x / view["detector_width_mm"] + 0.5) * columns,
        (0.5 - y / view["detector_height_mm"]) * rows,
    )


def darkest(frame):
    weights = (frame.max() - frame) ** 4
    rows, columns = np.indices(frame.shape)
    total = weights.sum()
    return (columns * weights).sum() / total + 0.5, (rows * weights).sum() / total + 0.5


@pytest.mark.parametrize("moved", [False, True])
def test_a_bead_lands_where_the_studio_camera_projects_it(moved):
    volume, affine, bead = bead_scan()
    matrix = np.eye(4)
    if moved:
        matrix[:3, :3] = turn([0.3, 1.0, 0.2], 7.0)
        matrix[:3, 3] = [6.0, -4.0, 9.0]
    isocenter = [-4.0, -2.0, -2.0]
    frame = vx.render(volume, affine, VIEW, isocenter, matrix.tolist(), 128, 128, step_mm=0.5)
    world = (matrix @ affine @ np.r_[bead, 1.0])[:3]
    expected = pixel_of(VIEW, 128, 128, world, isocenter)
    found = darkest(frame)
    assert np.hypot(found[0] - expected[0], found[1] - expected[1]) < 0.35
    assert frame.max() <= 1.0 and frame.min() > 0.0


def test_the_move_changes_where_the_bead_lands():
    volume, affine, _ = bead_scan()
    still = vx.render(volume, affine, VIEW, [0, 0, 0], np.eye(4).tolist(), 64, 64)
    matrix = np.eye(4)
    matrix[:3, 3] = [10.0, 0.0, 0.0]
    moved = vx.render(volume, affine, VIEW, [0, 0, 0], matrix.tolist(), 64, 64)
    assert np.hypot(*np.subtract(darkest(still), darkest(moved))) > 3


def test_air_passes_and_water_attenuates_by_its_path_length():
    water = np.zeros((40, 40, 40), dtype=np.float32)
    affine = np.eye(4)
    affine[:3, 3] = -19.5
    view = dict(VIEW, primary_deg=0.0, secondary_deg=0.0, detector_width_mm=60.0)
    view["detector_height_mm"] = 60.0
    frame = vx.render(water, affine, view, [0, 0, 0], np.eye(4).tolist(), 16, 16, step_mm=0.25)
    centre = frame[8, 8]
    # 40 mm of water along the central ray.
    assert centre == pytest.approx(np.exp(-0.02 * 40.0), rel=0.03)
    air = np.full_like(water, -1000.0)
    assert vx.render(air, affine, view, [0, 0, 0], np.eye(4).tolist(), 16, 16).min() == 1.0


def test_a_matrix_that_is_not_rigid_is_refused():
    volume, affine, _ = bead_scan()
    bad = np.eye(4)
    bad[0, 0] = 1.1
    with pytest.raises(ValueError, match="rigid"):
        vx.render(volume, affine, VIEW, [0, 0, 0], bad.tolist(), 32, 32)


def test_the_frame_is_admitted_as_calibrated_with_its_view():
    from planner.projection_ingest import _plane

    frame = np.linspace(0.2, 1.0, 64 * 64).reshape(64, 64)
    data = vx.xa_dicom(frame, VIEW, seed="test")
    plane, _ = _plane(data)
    assert plane["calibration"] == {"status": "calibrated", "missing": []}
    assert plane["primary_angle_deg"] == VIEW["primary_deg"]
    assert plane["secondary_angle_deg"] == VIEW["secondary_deg"]
    assert plane["source_detector_mm"] == VIEW["source_detector_mm"]
    assert plane["source_isocenter_mm"] == VIEW["source_isocenter_mm"]
    assert plane["imager_pixel_spacing_mm"][0] * 64 == pytest.approx(160.0)
    assert plane["burned_in_annotation"] == "no"
    assert (plane["rows"], plane["columns"]) == (64, 64)


def test_the_stored_frame_is_log_processed_and_brighter_where_less_attenuated():
    import io

    import pydicom

    line = np.linspace(0.0, 4.0, 64 * 64).reshape(64, 64)
    data = vx.xa_dicom(np.exp(-line), VIEW, seed="log")
    pixels = pydicom.dcmread(io.BytesIO(data)).pixel_array.astype(float)
    assert pixels[0, 0] == 4095 and pixels[-1, -1] == 0
    # Linear in the line integral, not in the transmitted fraction.
    middle = pixels[32, 0]
    assert middle == pytest.approx(4095 * (1 - line[32, 0] / np.percentile(line, 99.5)), abs=1)


def test_the_admitted_frame_is_what_frame_admission_keeps():
    from planner.frame_ingest import _dicom_frames

    rng = np.random.default_rng(3)
    transmitted = np.exp(-rng.uniform(0.1, 5.0, size=(48, 48)))
    data = vx.xa_dicom(transmitted, VIEW, seed="gray")
    rows, columns, frames = _dicom_frames(data, [0])
    assert (rows, columns) == (48, 48)
    expected = vx.admitted_gray8(vx.detector_pixels(transmitted))
    assert np.frombuffer(frames[0], dtype=np.uint8).reshape(48, 48).tolist() == expected.tolist()


def test_rectangular_detector_pixels_are_refused():
    with pytest.raises(ValueError, match="square"):
        vx.xa_dicom(np.ones((32, 64)), VIEW, seed="x")
