"""Synthetic native-output checks. Never opens clinical or public-case pixels."""

import gzip
import hashlib
import os

import pytest

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Requires isolated imaging runtime", allow_module_level=True)

import nibabel as nib
import numpy as np

from planner.device_surface import native_surface


def encoded(block, units="mm"):
    mask = np.zeros((8, 9, 10), dtype=np.uint8)
    mask[block : block + 2, 2:5, 3:6] = 1
    affine = np.array([[-0.5, 0, 0, 12], [0, 0.8, 0, -4], [0, 0, 1.3, 7], [0, 0, 0, 1]])
    image = nib.Nifti1Image(mask, affine)
    image.header.set_xyzt_units(units)
    return gzip.compress(image.to_bytes(), mtime=0)


def test_native_surface_uses_exact_hashed_bytes_after_path_replacement(tmp_path, monkeypatch):
    path = tmp_path / "mask.nii.gz"
    first, second = encoded(1), encoded(4)
    path.write_bytes(first)
    sha = hashlib.sha256(first).hexdigest()
    expected = native_surface(path, sha)
    real_sha = hashlib.sha256
    changed = {"done": False}

    def hashing(data):
        result = real_sha(data)
        if not changed["done"]:
            path.write_bytes(second)
            changed["done"] = True
        return result

    monkeypatch.setattr(hashlib, "sha256", hashing)
    assert native_surface(path, sha) == expected


def test_display_surface_accepts_bounded_complete_mesh_above_analysis_budget(tmp_path):
    from planner.mask_geometry import surface_from_mask

    xyz = np.indices((64, 64, 64))
    distance_squared = ((xyz - 32) ** 2).sum(axis=0)
    mask = ((distance_squared <= 25**2) & (distance_squared > 24**2)).astype(np.uint8)
    # The analysis budget remains 50k; only the display adapter gets 60k.
    with pytest.raises(ValueError, match="50000 cap"):
        surface_from_mask(mask, np.eye(4))
    image = nib.Nifti1Image(mask, np.eye(4))
    image.header.set_xyzt_units("mm")
    raw = gzip.compress(image.to_bytes(), mtime=0)
    path = tmp_path / "synthetic-shell.nii.gz"
    path.write_bytes(raw)
    data = native_surface(path, hashlib.sha256(raw).hexdigest())
    count = int.from_bytes(data[80:84], "little")
    assert count == 53920
    assert len(data) == 84 + 50 * count


def test_display_surface_still_rejects_mesh_over_its_separate_budget(tmp_path):
    xyz = np.indices((64, 64, 64))
    distance_squared = ((xyz - 32) ** 2).sum(axis=0)
    mask = ((distance_squared <= 26**2) & (distance_squared > 25**2)).astype(np.uint8)
    image = nib.Nifti1Image(mask, np.eye(4))
    image.header.set_xyzt_units("mm")
    raw = gzip.compress(image.to_bytes(), mtime=0)
    path = tmp_path / "synthetic-over-budget-shell.nii.gz"
    path.write_bytes(raw)
    with pytest.raises(ValueError, match="60000 cap"):
        native_surface(path, hashlib.sha256(raw).hexdigest())


def test_native_surface_requires_declared_mm_and_preserves_world_geometry(tmp_path):
    path = tmp_path / "mask.nii.gz"
    data = encoded(1)
    path.write_bytes(data)
    surface = native_surface(path, hashlib.sha256(data).hexdigest())
    faces = np.ndarray(
        (int.from_bytes(surface[80:84], "little"),),
        dtype=np.dtype([("normal", "<f4", 3), ("vertices", "<f4", (3, 3)), ("attr", "<u2")]),
        buffer=surface,
        offset=84,
    )
    points = faces["vertices"].reshape(-1, 3)
    assert np.allclose(points.min(axis=0), [10.75, -2.8, 10.25], atol=1e-5)
    assert np.allclose(points.max(axis=0), [11.75, -0.4, 14.15], atol=1e-5)
    unknown = encoded(1, "unknown")
    path.write_bytes(unknown)
    with pytest.raises(ValueError, match="geometry"):
        native_surface(path, hashlib.sha256(unknown).hexdigest())
