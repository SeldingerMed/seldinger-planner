"""Synthetic tests for the deterministic centerline-proposal module.

propose_centerline turns the accepted binary vessel mask plus the RAS-mm
affine and operator-selected start/end anchors into a bounded skeleton-graph
path proposal. The proposal is not a validated clinical centerline: the
parent records it only as operator-input support and requires explicit
operator confirmation before any downstream use.
"""

import os
import subprocess
import sys

import pytest

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Requires isolated imaging runtime", allow_module_level=True)

import numpy as np

from planner import centerline
from planner.centerline import propose_centerline


@pytest.mark.parametrize("reverse", [False, True])
def test_overlapping_foreground_connectors_keep_simple_anchor_path(reverse):
    import numpy as np

    from planner.centerline import propose_centerline

    x, y, _z = np.indices((13, 13, 16))
    mask = ((x - 6) ** 2 + (y - 6) ** 2 <= 16).astype(np.uint8)
    expected = [[6, i, 8] for i in range(2, 6)]
    if reverse:
        expected.reverse()
    result = propose_centerline(mask, np.eye(4), expected[0], expected[-1])
    assert result["path_ras"] == expected
    assert len({tuple(p) for p in result["path_ras"]}) == len(expected)
    assert result["operator_confirmation_required"] is True
    assert result["clinical_validation"] is False


def test_loop_erasure_does_not_count_removed_detour_as_path_length():
    import numpy as np

    from planner.centerline import propose_centerline

    x, y, _z = np.indices((11, 11, 16))
    mask = ((x - 5) ** 2 + (y - 5) ** 2 <= 9).astype(np.uint8)
    # The connector union contains 4 nodes, but the actual path between
    # these anchors has only 3 nodes. It must still fail the four-point minimum.
    with pytest.raises(ValueError, match="too short"):
        propose_centerline(mask, np.eye(4), [5, 4, 8], [5, 2, 8])


def test_same_skeleton_join_is_included_once_between_disjoint_connectors():
    mask = _tube_along_x(shape=(11, 5, 5), y_radius=2, z_radius=2)
    affine = np.eye(4)
    result = propose_centerline(mask, affine, [5.0, 0.0, 0.0], [5.0, 4.0, 4.0])
    expected = [[5.0, 0.0, 0.0], [5.0, 1.0, 1.0], [5.0, 2.0, 2.0], [5.0, 3.0, 3.0], [5.0, 4.0, 4.0]]
    np.testing.assert_allclose(result["path_ras"], expected)
    assert result["point_count"] == 5
    assert result["path_ras"].count([5.0, 2.0, 2.0]) == 1
    _assert_foreground_rounding(mask, affine, result)


def _identity_affine(translation=(0.0, 0.0, 0.0)):
    aff = np.eye(4)
    aff[:3, 3] = translation
    return aff


def _tube_along_x(shape=(11, 5, 4), center_y=2, center_z=2, y_radius=0, z_radius=0):
    mask = np.zeros(shape, dtype=bool)
    yy, zz = np.ogrid[: shape[1], : shape[2]]
    tube = (np.abs(yy - center_y) <= y_radius) & (np.abs(zz - center_z) <= z_radius)
    mask[:, tube] = True
    return mask


def _to_ras(mask, aff, ijk):
    return (aff @ np.r_[np.asarray(ijk, dtype=float), 1.0])[:3]


def _native_round(mask_shape, aff, point):
    inv = np.linalg.inv(aff)
    native = (inv @ np.r_[np.asarray(point, dtype=float), 1.0])[:3]
    return tuple(round(float(v)) for v in native)


def _assert_foreground_rounding(mask, aff, result):
    for point in result["path_ras"]:
        ijk = _native_round(mask.shape, aff, point)
        assert mask[ijk], f"path point {point} rounds off vessel foreground at {ijk}"


def _assert_contract(mask, aff, start, end, result):
    assert set(result) >= {
        "path_ras",
        "proximal_index",
        "distal_index",
        "method",
        "operator_confirmation_required",
        "clinical_validation",
        "spatial_units",
        "length_mm",
        "point_count",
    }
    n = len(result["path_ras"])
    assert 4 <= n <= 32
    assert result["point_count"] == n
    assert result["operator_confirmation_required"] is True
    assert result["clinical_validation"] is False
    assert result["spatial_units"] == "mm"
    assert result["proximal_index"] != result["distal_index"]
    for idx in (result["proximal_index"], result["distal_index"]):
        assert isinstance(idx, int) and 1 <= idx < n - 1
    _assert_foreground_rounding(mask, aff, result)
    # endpoints round to the operator anchor voxels
    assert _native_round(mask.shape, aff, result["path_ras"][0]) == _native_round(
        mask.shape, aff, start
    )
    assert _native_round(mask.shape, aff, result["path_ras"][-1]) == _native_round(
        mask.shape, aff, end
    )


def test_foreground_anchors_need_not_already_be_skeleton_voxels():
    mask = np.zeros((21, 9, 9), dtype=np.uint8)
    mask[1:20, 1:8, 1:8] = 1
    start, end = [4.0, 2.0, 4.0], [16.0, 6.0, 4.0]
    result = propose_centerline(mask, np.eye(4), start, end)
    _assert_contract(mask, np.eye(4), start, end, result)
    assert len({tuple(p) for p in result["path_ras"]}) == len(result["path_ras"])


def test_corner_touching_but_face_disconnected_lumen_is_rejected():
    mask = np.zeros((9, 9, 9), dtype=np.uint8)
    for i in range(1, 8):
        mask[i, i, i] = 1
    with pytest.raises(ValueError, match="No connected"):
        propose_centerline(mask, np.eye(4), [1.0, 1.0, 1.0], [7.0, 7.0, 7.0])


def test_straight_tube_known_value_tracer():
    """Real skeleton->path known-value GREEN tracer on a unit-mm straight tube."""
    mask = _tube_along_x()
    aff = _identity_affine()
    start = _to_ras(mask, aff, (0, 2, 2))
    end = _to_ras(mask, aff, (10, 2, 2))
    result = propose_centerline(mask, aff, start, end)
    _assert_contract(mask, aff, start, end, result)
    assert result["length_mm"] == pytest.approx(10.0, abs=1e-6)
    assert result["method"] == "accepted_vessel_mask_skeleton_centerline_proposal"
    # path stays on the tube axis
    for point in result["path_ras"]:
        native = (np.linalg.inv(aff) @ np.r_[point, 1.0])[:3]
        assert native[1] == pytest.approx(2.0, abs=1e-6)
        assert native[2] == pytest.approx(2.0, abs=1e-6)


def test_sheared_anisotropic_affine_physical_length():
    """Edge weights use physical distance through a sheared, rotated affine."""
    mask = _tube_along_x(shape=(11, 5, 4))
    aff = np.eye(4)
    # 2 mm along x per voxel plus shear coupling y and a rotation about z
    theta = np.pi / 6
    c, s = np.cos(theta), np.sin(theta)
    rot = np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])
    aff[:3, :3] = rot @ np.array([[2.0, 0.0, 0.0], [0.5, 1.0, 0.0], [0.0, 0.0, 1.5]])
    aff[:3, 3] = [5.0, -3.0, 8.0]
    start = _to_ras(mask, aff, (0, 2, 2))
    end = _to_ras(mask, aff, (10, 2, 2))
    # analytic physical length of the ten axis-0 voxel steps
    step = aff[:3, :3] @ np.array([1.0, 0.0, 0.0])
    expected = 10.0 * float(np.linalg.norm(step))
    result = propose_centerline(mask, aff, start, end)
    _assert_contract(mask, aff, start, end, result)
    assert result["length_mm"] == pytest.approx(expected, rel=1e-9)


def test_deterministic_reproducibility():
    mask = _tube_along_x(shape=(13, 7, 6), center_y=3, center_z=3, y_radius=1, z_radius=1)
    aff = _identity_affine((1.0, 2.0, 3.0))
    start = _to_ras(mask, aff, (0, 3, 3))
    end = _to_ras(mask, aff, (12, 3, 3))
    first = propose_centerline(mask, aff, start, end)
    second = propose_centerline(mask, aff, start, end)
    assert first == second


def test_curved_branched_vessel_follows_skeleton():
    """L-shaped thin vessel: path bends at the junction, no straight-line cut."""
    mask = np.zeros((11, 3, 6), dtype=bool)
    mask[0:10, 1, 1] = True
    mask[10, 1, 1:6] = True  # bend toward the +z direction
    aff = np.eye(4)
    start = _to_ras(mask, aff, (0, 1, 1))
    end = _to_ras(mask, aff, (10, 1, 5))
    result = propose_centerline(mask, aff, start, end)
    _assert_contract(mask, aff, start, end, result)
    # lee skeleton cuts one diagonal at the bend: length must follow the
    # skeleton (>= the axial run) and stay far below nothing; chord is ~10.77
    assert 13.0 <= result["length_mm"] <= 14.0 + 1e-9
    # some interior point must sit at the corner voxel, not on the chord
    inv = np.linalg.inv(aff)
    distances = [
        float(np.linalg.norm((inv @ np.r_[p, 1.0])[:3] - np.array([10.0, 1.0, 1.0])))
        for p in result["path_ras"]
    ]
    # the lee skeleton bends near the corner voxel rather than cutting the
    # chord across background; assert a nearest path point within one step
    assert min(distances) <= 1.0 + 1e-9


def test_tiny_vessel_below_minimum_points_is_rejected():
    mask = np.zeros((3, 3, 3), dtype=bool)
    mask[:, 1, 1] = True  # only 3 skeleton voxels along the axis
    aff = _identity_affine()
    start = _to_ras(mask, aff, (0, 1, 1))
    end = _to_ras(mask, aff, (2, 1, 1))
    with pytest.raises(ValueError, match="four"):
        propose_centerline(mask, aff, start, end)


def test_identical_anchors_rejected():
    mask = _tube_along_x()
    aff = _identity_affine()
    point = _to_ras(mask, aff, (2, 2, 2))
    with pytest.raises(ValueError, match="distinct"):
        propose_centerline(mask, aff, point, point)


def test_anchor_off_grid_rejected():
    mask = _tube_along_x()
    aff = _identity_affine((0.0, 0.0, 0.0))
    start = _to_ras(mask, aff, (0, 2, 2))
    outside = [-5.0, 2.0, 2.0]
    with pytest.raises(ValueError, match="outside"):
        propose_centerline(mask, aff, outside, start)
    with pytest.raises(ValueError, match="outside"):
        propose_centerline(mask, aff, start, [50.0, 2.0, 2.0])


def test_anchor_not_foreground_rejected():
    mask = _tube_along_x()
    aff = _identity_affine()
    with pytest.raises(ValueError, match="foreground"):
        propose_centerline(mask, aff, [0.0, 0.0, 0.0], _to_ras(mask, aff, (10, 2, 2)))


def test_disconnected_anchor_components_rejected():
    mask = _tube_along_x(shape=(11, 5, 4))
    mask[6, 2, 2] = False  # split the tube into two components
    aff = _identity_affine()
    start = _to_ras(mask, aff, (0, 2, 2))
    end = _to_ras(mask, aff, (10, 2, 2))
    with pytest.raises(ValueError, match="No connected centerline path"):
        propose_centerline(mask, aff, start, end)


def test_unrelated_island_is_ignored():
    mask = _tube_along_x(shape=(13, 5, 4))
    mask[0, 0, 0] = True  # foreground island, no path near it
    aff = _identity_affine()
    start = _to_ras(mask, aff, (0, 2, 2))
    end = _to_ras(mask, aff, (12, 2, 2))
    result = propose_centerline(mask, aff, start, end)
    _assert_contract(mask, aff, start, end, result)


def test_graph_budget_exceeded_rejected(monkeypatch):
    mask = _tube_along_x(shape=(13, 5, 4), center_y=2, center_z=2, y_radius=1, z_radius=1)
    aff = _identity_affine()
    start = _to_ras(mask, aff, (0, 2, 2))
    end = _to_ras(mask, aff, (12, 2, 2))
    monkeypatch.setattr(centerline, "MAX_SKELETON_NODES", 5)
    with pytest.raises(ValueError, match="budget"):
        propose_centerline(mask, aff, start, end)


def test_grid_size_bound_rejected(monkeypatch):
    mask = _tube_along_x()
    aff = _identity_affine()
    start = _to_ras(mask, aff, (0, 2, 2))
    end = _to_ras(mask, aff, (10, 2, 2))
    monkeypatch.setattr(centerline, "MAX_GRID_VOXELS", 10)
    with pytest.raises(ValueError, match="grid"):
        propose_centerline(mask, aff, start, end)


def test_invalid_affines_rejected():
    mask = _tube_along_x()
    good = _identity_affine()
    start = _to_ras(mask, good, (0, 2, 2))
    end = _to_ras(mask, good, (10, 2, 2))

    singular = good.copy()
    singular[0, 0] = 0.0
    with pytest.raises(ValueError, match="affine"):
        propose_centerline(mask, singular, start, end)

    nonfinite = good.copy()
    nonfinite[1, 1] = np.nan
    with pytest.raises(ValueError, match="affine"):
        propose_centerline(mask, nonfinite, start, end)

    bad_row = good.copy()
    bad_row[3] = [0.0, 0.0, 1.0, 1.0]
    with pytest.raises(ValueError, match="affine"):
        propose_centerline(mask, bad_row, start, end)

    with pytest.raises(ValueError, match="affine"):
        propose_centerline(mask, np.eye(3), start, end)


def test_non_mm_spatial_units_rejected():
    mask = _tube_along_x()
    aff = _identity_affine()
    start = _to_ras(mask, aff, (0, 2, 2))
    end = _to_ras(mask, aff, (10, 2, 2))
    with pytest.raises(ValueError, match="spatial_units|mm"):
        propose_centerline(mask, aff, start, end, spatial_units="cm")


def test_non_binary_and_non_3d_masks_rejected():
    aff = _identity_affine()
    start = [0.0, 2.0, 2.0]
    end = [10.0, 2.0, 2.0]

    multilevel = np.zeros((11, 5, 4), dtype=np.uint8)
    multilevel[:, 2, 2] = 2
    with pytest.raises(ValueError, match="binary"):
        propose_centerline(multilevel, aff, start, end)

    with pytest.raises(ValueError, match="three-dimensional|3"):
        propose_centerline(np.zeros((11, 5), dtype=bool), aff, start, end)


def test_lazy_runtime_imports():
    """Importing planner.centerline must not pull numpy/skimage at module scope."""
    code = (
        "import sys, os; sys.path.insert(0, os.getcwd()); "
        "import planner.centerline as m; "
        "assert not any(x.startswith('numpy') or x.startswith('skimage') or x == 'scipy' "
        "for x in sys.modules), sorted(x for x in sys.modules if 'num' in x or 'ski' in x); "
        "print('LAZY_OK')"
    )
    env = dict(os.environ)
    env.pop("SELDINGER_RUN_MODEL_TESTS", None)
    proc = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        check=False,
        text=True,
        env=env,
        cwd=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    assert "LAZY_OK" in proc.stdout


def test_missing_skeletonizer_reports_actual_dependency(monkeypatch):
    """When skimage is unavailable the failure names the real dependency."""
    real_import = __builtins__.__import__ if hasattr(__builtins__, "__import__") else __import__

    def fake_import(name, *args, **kwargs):
        if name.startswith("skimage"):
            raise ImportError("No module named 'skimage'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", fake_import)
    mask = _tube_along_x()
    aff = _identity_affine()
    start = _to_ras(mask, aff, (0, 2, 2))
    end = _to_ras(mask, aff, (10, 2, 2))
    with pytest.raises(ImportError, match="scikit-image"):
        propose_centerline(mask, aff, start, end)
