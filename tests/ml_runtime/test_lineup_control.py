"""The virtual X-ray control's preparation and vessel scoring, on synthetic data."""

import json
import os
import sys
from pathlib import Path

import pytest

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Requires isolated imaging runtime", allow_module_level=True)

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "research"))

import lineup_control as lc

VIEW = {
    "primary_deg": 0.0,
    "secondary_deg": 0.0,
    "source_detector_mm": 1200.0,
    "source_isocenter_mm": 800.0,
    "detector_width_mm": 300.0,
    "detector_height_mm": 300.0,
}
MODEL = {
    "branches": [
        {"name": "aorta", "path_ras": [[0, 0, 60], [0, 0, 0]]},
        {"name": "right_iliac", "path_ras": [[0, 0, 0], [-30, 0, -60]]},
        {"name": "left_iliac", "path_ras": [[0, 0, 0], [30, 0, -60]]},
    ],
    "bifurcation_ras": [0, 0, 0],
}


def truth(matrix, isocenter=(0.0, 0.0, 0.0)):
    return {
        "isocenter": list(isocenter),
        "volume_to_carm_ras": np.asarray(matrix).tolist(),
        "planes": [{"plane": "single", "view": VIEW, "columns": 512, "rows": 512}],
    }


def saved(matrix, isocenter=(0.0, 0.0, 0.0)):
    return {
        "isocenter": list(isocenter),
        "volume_to_carm_ras": np.asarray(matrix).tolist(),
        "planes": [{"plane": "single", "view": VIEW}],
    }


def test_a_saved_pose_equal_to_the_known_pose_scores_zero():
    m = np.eye(4)
    m[:3, 3] = [5, -3, 8]
    out = lc.score(saved(m), MODEL, truth(m))
    plane = out["planes"]["single"]
    assert plane["all_vessel_points"]["max_px"] == pytest.approx(0, abs=1e-9)
    assert out["three_d"]["max_mm"] == pytest.approx(0, abs=1e-9)
    # The start was 5 mm across and 3 mm up the beam... about 5.4 mm at the
    # isocentre for points near it.
    assert plane["start_all_vessel_points"]["mean_mm_at_isocenter"] > 4


def test_a_shift_across_the_beam_scores_its_size_at_the_isocentre():
    m = np.eye(4)
    found = np.eye(4)
    found[:3, 3] = [2.0, 0, 0]  # 2 mm toward the patient's left, across the AP beam
    out = lc.score(saved(found), MODEL, truth(m))
    bif = out["planes"]["single"]["bifurcation"]
    assert bif["mean_mm_at_isocenter"] == pytest.approx(2.0, rel=1e-6)
    assert bif["mean_px"] == pytest.approx(2.0 * 1200 / 800 / (300 / 512), rel=1e-6)
    assert out["three_d"]["mean_across_first_beam_mm"] == pytest.approx(2.0)
    assert out["three_d"]["mean_along_first_beam_mm"] == pytest.approx(0.0, abs=1e-9)


def test_a_different_isocentre_with_the_matching_shift_is_the_same_pose():
    m = np.eye(4)
    m[:3, 3] = [1, 2, 3]
    other = m.copy()
    other[:3, 3] += [10, -4, 6]
    out = lc.score(saved(other, (10, -4, 6)), MODEL, truth(m))
    assert out["planes"]["single"]["all_vessel_points"]["max_px"] == pytest.approx(0, abs=1e-6)


def test_vessel_points_name_ends_and_bifurcation():
    points = lc.vessel_points(MODEL)
    assert set(points) == {
        "aorta",
        "right_iliac",
        "left_iliac",
        "aorta_end",
        "right_iliac_end",
        "left_iliac_end",
        "bifurcation",
    }
    assert len(points["aorta"]) == 13  # 0, 5, ..., 60 mm


def test_resampling_keeps_world_positions_and_cuts_the_lowest_part():
    affine = np.diag([-1.0, -1.0, 1.0, 1.0])
    affine[:3, 3] = [10, 20, -50]
    index = np.indices((40, 30, 100)).reshape(3, -1).T
    world = index @ affine[:3, :3].T + affine[:3, 3]
    # Values that are world coordinates: linear interpolation returns them.
    for axis in range(3):
        volume = world[:, axis].reshape(40, 30, 100).astype(np.int16) * 1
        out, out_affine = lc.resample_lowest(volume, affine, grid_mm=2.0, lowest_mm=60.0)
        assert out.shape == (20, 15, 30)
        inner = np.indices(out.shape)[:, 1:-1, 1:-1, 1:-1].reshape(3, -1).T
        expected = inner @ out_affine[:3, :3].T + out_affine[:3, 3]
        assert np.abs(out[tuple(inner.T)] - expected[:, axis]).max() <= 0.5
    assert out_affine[2, 3] == pytest.approx(affine[2, 3] + 0.5)
    assert np.allclose(np.diag(out_affine[:3, :3]), [-2, -2, 2])


def test_the_installed_source_has_a_manifest_the_loader_reads(tmp_path):
    from planner.image_source import InstalledNiftiSourceStore

    volume = np.zeros((20, 20, 20), dtype=np.int16)
    affine = np.diag([-2.0, -2.0, 2.0, 1.0])
    manifest = lc.install_source(tmp_path, "control-x", volume, affine, {"origin": "test"})
    store = InstalledNiftiSourceStore(
        tmp_path / "installed-sources" / "control-x", source_id="control-x"
    )
    loaded = store.load()
    assert loaded[0]["image"]["sha256"] == manifest["image"]["sha256"]
    assert (
        json.loads((tmp_path / "installed-sources" / "control-x" / "manifest.json").read_text())[
            "clinical_validation"
        ]
        is False
    )


def test_a_disturbance_is_rigid_bounded_and_turns_about_the_isocentre():
    rng = np.random.default_rng(0)
    iso = np.array([10.0, -20.0, 30.0])
    for _ in range(200):
        m = lc.disturbance(rng, iso)
        r = m[:3, :3]
        assert np.allclose(r @ r.T, np.eye(3)) and np.linalg.det(r) > 0
        shift = m[:3, :3] @ iso + m[:3, 3] - iso
        assert np.hypot(shift[0], shift[2]) <= 15.0 + 1e-9
        assert abs(shift[1]) <= 30.0 + 1e-9
        assert np.degrees(np.arccos((np.trace(r) - 1) / 2)) <= np.sqrt(3) * 8.0 + 1e-6


def test_a_control_case_holds_its_scan_truths_and_admitted_frames(tmp_path):
    volume = np.full((24, 20, 22), -1000, dtype=np.int16)
    volume[8:16, 6:14, 6:16] = 700
    affine = np.diag([-2.0, -2.0, 2.0, 1.0])
    records = lc.control_case(volume, affine, tmp_path / "c", poses=2, seed=5, side=32)
    assert [r["pose"] for r in records] == ["pose0", "pose1"]
    assert np.allclose(records[0]["volume_to_carm_ras"], np.eye(4))
    assert not np.allclose(records[1]["volume_to_carm_ras"], np.eye(4))
    meta = json.loads((tmp_path / "c" / "volume.json").read_text())
    assert meta["shape"] == [24, 20, 22]
    raw = np.frombuffer((tmp_path / "c" / "volume.i16").read_bytes(), dtype="<i2")
    assert np.array_equal(raw.reshape(meta["shape"], order="F"), volume)
    frames = json.loads((tmp_path / "c" / "frames" / "pose1" / "frames.json").read_text())
    assert [p["plane"] for p in frames["planes"]] == ["a", "b"]
    for plane in ("a", "b"):
        gray = (tmp_path / "c" / "frames" / "pose1" / f"{plane}-000000.gray").read_bytes()
        assert len(gray) == 32 * 32 and min(gray) == 0 and max(gray) == 255
    truth = json.loads((tmp_path / "c" / "truth-pose1.json").read_text())
    assert truth["volume_to_carm_ras"] == records[1]["volume_to_carm_ras"]
