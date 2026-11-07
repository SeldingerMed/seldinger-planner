"""Tests for the accepted binary mask to world surface helper (section A)."""

import math
import os
import subprocess
import sys

import pytest

from planner.mask_geometry import surface_from_mask

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Requires isolated imaging runtime", allow_module_level=True)
import numpy as np
from skimage import measure

ML_PYTHON = ".runtime/ml-runtime/bin/python"


def _block_mask(shape, lo, hi):
    mask = np.zeros(shape, dtype=np.uint8)
    mask[lo[0] : hi[0], lo[1] : hi[1], lo[2] : hi[2]] = 1
    return mask


def _identity_affine():
    aff = np.eye(4)
    return aff


def _oblique_reflected_affine():
    scale = np.diag([2.0, 3.0, 4.0, 1.0])
    rot = np.eye(4)
    c, s = math.cos(0.7), math.sin(0.7)
    rot[:2, :2] = [[c, -s], [s, c]]
    reflect = np.eye(4)
    reflect[0, 0] = -1.0
    aff = scale @ rot @ reflect
    aff[:3, 3] = [10.0, -5.0, 2.0]
    return aff


def _world_points(result):
    pts = set()
    for tri in result["triangles_world"]:
        for v in tri:
            pts.add(tuple(round(c, 6) for c in v))
    return pts


def test_nonhomogeneous_affine_is_rejected():
    mask = _block_mask((5, 5, 5), (1, 1, 1), (4, 4, 4))
    affine = np.eye(4)
    affine[3, 0] = 0.1
    with pytest.raises(ValueError, match="homogeneous"):
        surface_from_mask(mask, affine)


def test_voxel_cap_precedes_scalar_scans(monkeypatch):
    mask = np.broadcast_to(np.uint8(0), (201, 201, 201))

    def forbidden(*args, **kwargs):
        raise AssertionError("oversized input reached scalar scanning")

    monkeypatch.setattr(np, "isfinite", forbidden)
    with pytest.raises(ValueError, match="cap"):
        surface_from_mask(mask, np.eye(4))


def test_solid_block_half_voxel_surface_coordinates():
    mask = _block_mask((8, 8, 8), (1, 1, 1), (6, 6, 6))
    result = surface_from_mask(mask, _identity_affine())
    pts = np.array(sorted(_world_points(result)))
    assert pts.shape[1] == 3
    assert math.isclose(pts[:, 0].min(), 0.5, abs_tol=1e-9)
    assert math.isclose(pts[:, 0].max(), 5.5, abs_tol=1e-9)
    assert result["foreground_voxels"] == 125
    assert result["touches_image_boundary"] is False
    assert result["method"] == "native_binary_marching_cubes_0_5"
    assert result["clinical_validation"] is False
    assert len(result["triangles_world"]) <= 50000


def test_oblique_reflected_affine_maps_full_transform():
    mask = _block_mask((6, 6, 6), (1, 1, 1), (5, 5, 5))
    aff = _oblique_reflected_affine()
    result = surface_from_mask(mask, aff)
    verts, _faces, _, _ = measure.marching_cubes(
        mask.astype(np.float64), level=0.5, step_size=1, allow_degenerate=False
    )
    hom = np.concatenate([verts, np.ones((len(verts), 1))], axis=1)
    expected = (hom @ aff.T)[:, :3]
    got = _world_points(result)
    for p in expected:
        assert tuple(round(float(c), 6) for c in p) in got
    assert np.linalg.det(aff) < 0  # reflection present


def test_seed_selects_exact_component_not_automatic_choice():
    mask = np.zeros((12, 12, 12), dtype=np.uint8)
    mask[1:4, 1:4, 1:4] = 1  # 27-voxel cube
    mask[8:11, 8:11, 8:11] = 1  # separate 27-voxel cube
    seeded = surface_from_mask(mask, _identity_affine(), seed_ijk=(8, 8, 8))
    assert seeded["foreground_voxels"] == 27
    pts = np.array(sorted(_world_points(seeded)))
    assert pts[:, 0].min() >= 7.5 and pts[:, 0].max() <= 10.5
    unseeded = surface_from_mask(mask, _identity_affine())
    assert unseeded["foreground_voxels"] == 54


def test_seed_component_is_6_connected_not_diagonal():
    mask = np.zeros((5, 5, 5), dtype=np.uint8)
    mask[2, 2, 2] = 1
    mask[3, 3, 3] = 1  # only diagonal/corner adjacency
    result = surface_from_mask(mask, _identity_affine(), seed_ijk=(2, 2, 2))
    assert result["foreground_voxels"] == 1


def test_asymmetric_shape_geometry_follows_indices():
    mask = np.zeros((10, 10, 10), dtype=np.uint8)
    mask[1:3, 1:7, 1:3] = 1  # long arm along j
    mask[1:7, 1:3, 1:3] = 1  # long arm along i
    result = surface_from_mask(mask, _identity_affine())
    assert result["foreground_voxels"] == 24 + 24 - 8
    pts = np.array(sorted(_world_points(result)))
    assert math.isclose(pts[:, 0].min(), 0.5, abs_tol=1e-9)
    assert math.isclose(pts[:, 0].max(), 6.5, abs_tol=1e-9)
    assert math.isclose(pts[:, 1].min(), 0.5, abs_tol=1e-9)
    assert math.isclose(pts[:, 1].max(), 6.5, abs_tol=1e-9)


def test_boundary_contact_reported_and_rejected():
    mask = np.zeros((6, 6, 6), dtype=np.uint8)
    mask[0:3, 1:4, 1:4] = 1  # touches i=0 plane
    with pytest.raises(ValueError, match="boundary"):
        surface_from_mask(mask, _identity_affine())
    allowed = surface_from_mask(mask, _identity_affine(), reject_boundary=False)
    assert allowed["touches_image_boundary"] is True


def test_guards_reject_invalid_inputs():
    good = _block_mask((5, 5, 5), (1, 1, 1), (4, 4, 4))
    with pytest.raises(ValueError):
        surface_from_mask(np.zeros((4, 4, 4)), _identity_affine())  # empty
    with pytest.raises(ValueError):
        surface_from_mask(np.ones((4, 4, 4)), _identity_affine())  # wholly filled
    with pytest.raises(ValueError):
        surface_from_mask(np.zeros((4, 4)), _identity_affine())  # not 3D
    nonbinary = np.zeros((4, 4, 4))
    nonbinary[1, 1, 1] = 0.5
    with pytest.raises(ValueError):
        surface_from_mask(nonbinary, _identity_affine())
    with pytest.raises(ValueError):
        surface_from_mask(np.ones((201, 201, 201), dtype=np.uint8), _identity_affine())
    oversized = np.zeros((4, 4, 4))
    oversized[0, 0, 0] = np.nan
    with pytest.raises(ValueError):
        surface_from_mask(oversized, _identity_affine())
    with pytest.raises(ValueError):
        surface_from_mask(good, np.zeros((3, 3)))
    singular = np.eye(4)
    singular[3, 3] = 0.0
    with pytest.raises(ValueError):
        surface_from_mask(good, singular)
    bad_affine = np.eye(4)
    bad_affine[0, 0] = np.nan
    with pytest.raises(ValueError):
        surface_from_mask(good, bad_affine)


def test_foreground_cap_enforced_before_heavy_work():
    mask = np.zeros((320, 320, 1), dtype=np.uint8)
    mask[:315, :, 0] = 1  # 100800 foreground voxels, under voxel cap
    with pytest.raises(ValueError, match="foreground"):
        surface_from_mask(mask, _identity_affine())


def test_seed_type_and_placement_guards():
    mask = _block_mask((6, 6, 6), (1, 1, 1), (4, 4, 4))
    with pytest.raises(ValueError):
        surface_from_mask(mask, _identity_affine(), seed_ijk=(1.0, 1, 1))
    with pytest.raises(ValueError):
        surface_from_mask(mask, _identity_affine(), seed_ijk=(True, 1, 1))
    with pytest.raises(ValueError):
        surface_from_mask(mask, _identity_affine(), seed_ijk=(1, 1))
    with pytest.raises(ValueError):
        surface_from_mask(mask, _identity_affine(), seed_ijk=(0, 1, 1))  # background
    with pytest.raises(ValueError):
        surface_from_mask(mask, _identity_affine(), seed_ijk=(99, 1, 1))  # out of bounds


def test_triangles_are_json_compatible():
    mask = _block_mask((5, 5, 5), (1, 1, 1), (4, 4, 4))
    result = surface_from_mask(mask, _identity_affine())
    tri = result["triangles_world"]
    assert isinstance(tri, list)
    assert all(len(t) == 3 for t in tri)
    assert all(isinstance(c, float) for t in tri for v in t for c in v)


def test_module_import_is_lazy_in_base_runtime():
    code = (
        "import sys,planner.mask_geometry;"
        "heavy={'numpy','scipy','skimage'};"
        "loaded=heavy.intersection(sys.modules);"
        "assert not loaded, loaded"
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        timeout=30,
        cwd=".",
        check=False,
    )
    assert result.returncode == 0, result.stderr.decode()


def test_module_import_is_lazy_in_ml_runtime():
    code = (
        "import sys,planner.mask_geometry;"
        "heavy={'numpy','scipy','skimage'};"
        "loaded=heavy.intersection(sys.modules);"
        "assert not loaded, loaded"
    )
    result = subprocess.run(
        [ML_PYTHON, "-c", code],
        capture_output=True,
        timeout=60,
        cwd=".",
        check=False,
    )
    assert result.returncode == 0, result.stderr.decode()
