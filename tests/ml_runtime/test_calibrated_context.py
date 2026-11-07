"""Vertical tests for the operator-only calibrated public context preparer.

Synthetic coordinate-coded tests run in the isolated ML runtime behind the
existing ``SELDINGER_RUN_MODEL_TESTS=1`` gate. The base-environment lazy
import guard runs everywhere (no NumPy/NiBabel required). No network, no
model weights, no application installation.
"""

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]

pytestmark = pytest.mark.skipif(
    os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1",
    reason="Requires the separately installed ML runtime",
)


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_synthetic(tmp_path, affine, shape=(6, 7, 5), dtype="int32", units=("mm", "sec")):
    """Asymmetric, coordinate-coded synthetic volume: value encodes indices."""
    import nibabel as nib
    import numpy as np

    i, j, k = np.indices(shape)
    data = (10000 * i + 100 * j + k + 7).astype(dtype)
    img = nib.Nifti1Image(data, np.asarray(affine, dtype=np.float64))
    img.header.set_xyzt_units(*units)
    path = tmp_path / "synthetic-src.nii.gz"
    nib.save(img, str(path))
    return path, data


# Reflected, anisotropic, translated RAS affine (mm declaration).
REFLECTED_AFFINE = [
    [-1.5, 0.0, 0.0, 90.0],
    [0.0, -0.75, 0.0, -40.0],
    [0.0, 0.0, 2.0, 11.0],
    [0.0, 0.0, 0.0, 1.0],
]

# Oblique orthogonal affine: 90-degree axis permutation with reflection
# (orthonormal rotation, det = -1), distinct from a corner-only translation.
OBLIQUE_AFFINE = [
    [0.0, 0.0, -1.25, 33.0],
    [-2.5, 0.0, 0.0, -17.0],
    [0.0, 1.0, 0.0, 5.0],
    [0.0, 0.0, 0.0, 1.0],
]


def _crop_expected(data, start, size):
    return data[
        start[0] : start[0] + size[0], start[1] : start[1] + size[1], start[2] : start[2] + size[2]
    ]


def _prepare(tmp_path, source_path, start, size, provenance=None, output_name="ctx", expected=None):
    from planner.calibrated_context import prepare_calibrated_context

    out = tmp_path / output_name
    if expected is None:
        expected = _sha256(source_path)
    return prepare_calibrated_context(
        source_path,
        out,
        expected_sha256=expected,
        start_xyz=list(start),
        size_xyz=list(size),
        provenance=provenance or {"source": "synthetic-test"},
    )


def test_reflected_anisotropic_crop_holds_exact_absolute_scalars_and_world(tmp_path):
    """Coordinate-coded: every saved voxel must equal the absolute source
    scalar at its source index and land at the source world position."""
    import nibabel as nib
    import numpy as np

    src_path, data = _write_synthetic(tmp_path, REFLECTED_AFFINE)
    start, size = (1, 2, 1), (3, 4, 2)
    result = _prepare(tmp_path, src_path, start, size)

    saved = nib.load(str(result["image_path"]))
    crop = np.asanyarray(saved.dataobj)
    expected = _crop_expected(data, start, size)
    assert crop.shape == tuple(size)
    assert crop.dtype == np.dtype("int32")
    # Exact absolute scalars, not a reordered/coordinate-plausible array.
    assert np.array_equal(crop, expected)

    src_affine = nib.load(str(src_path)).affine
    for ci in range(size[0]):
        for cj in range(size[1]):
            for ck in range(size[2]):
                si = start[0] + ci
                sj = start[1] + cj
                sk = start[2] + ck
                src_world = src_affine @ np.array([si, sj, sk, 1.0])
                out_world = saved.affine @ np.array([ci, cj, ck, 1.0])
                assert np.allclose(src_world[:3], out_world[:3], atol=1e-3)


def test_oblique_orthogonal_affine_roundtrip_distinguishes_index_errors(tmp_path):
    """A permuted/oblique orthogonal affine catches corner/index composition
    errors that a diagonal translated affine would not."""
    import nibabel as nib
    import numpy as np

    src_path, data = _write_synthetic(tmp_path, OBLIQUE_AFFINE)
    start, size = (2, 1, 3), (2, 3, 1)
    result = _prepare(tmp_path, src_path, start, size)

    saved = nib.load(str(result["image_path"]))
    crop = np.asanyarray(saved.dataobj)
    assert np.array_equal(crop, _crop_expected(data, start, size))

    src_affine = nib.load(str(src_path)).affine
    for probe in [(0, 0, 0), (size[0] - 1, size[1] - 1, size[2] - 1), (1, 2, 0)]:
        s = [start[d] + probe[d] for d in range(3)]
        src_world = (src_affine @ np.array([*s, 1.0]))[:3]
        out_world = (saved.affine @ np.array([*probe, 1.0]))[:3]
        assert np.allclose(src_world, out_world, atol=1e-3), (probe, src_world, out_world)


def test_true_oblique_crop_manifest_binds_actual_serialized_geometry(tmp_path):
    import nibabel as nib
    import numpy as np

    angle = np.deg2rad(37.0)
    rotation = np.array(
        [[np.cos(angle), -np.sin(angle), 0.0], [np.sin(angle), np.cos(angle), 0.0], [0.0, 0.0, 1.0]]
    )
    affine = np.eye(4)
    affine[:3, :3] = rotation @ np.diag([-0.4, 0.7, 1.2])
    affine[:3, 3] = [12.12345, -34.5678, 0.8888]
    source, data = _write_synthetic(tmp_path, affine)
    start = (1, 2, 1)
    size = (3, 4, 2)
    result = _prepare(tmp_path, source, start, size)
    saved = nib.load(result["image_path"])
    assert np.array_equal(np.asanyarray(saved.dataobj), _crop_expected(data, start, size))
    assert np.array_equal(np.array(result["manifest"]["image"]["affine_ras"]), saved.affine)
    source_affine = nib.load(source).affine
    for index in np.ndindex(size):
        source_index = np.array([*(np.asarray(index) + start), 1.0])
        out_index = np.array([*index, 1.0])
        assert np.allclose(
            source_affine @ source_index, saved.affine @ out_index, atol=1e-5, rtol=0
        )
        assert np.allclose(
            np.linalg.inv(saved.affine) @ (source_affine @ source_index),
            out_index,
            atol=1e-5,
            rtol=0,
        )


def test_manifest_schema_and_source_provenance_separation(tmp_path):
    src_path, _ = _write_synthetic(tmp_path, REFLECTED_AFFINE)
    prov = {"origin": "zenodo-15697196", "license": "CC BY 4.0", "notes": ["a", 1, 2.5]}
    result = _prepare(tmp_path, src_path, (1, 2, 1), (3, 4, 2), provenance=prov)

    manifest = result["manifest"]
    assert manifest["image"]["filename"] == "context-cta.nii.gz"
    assert manifest["image"]["sha256"] == _sha256(result["image_path"])
    assert manifest["image"]["bytes"] == result["image_path"].stat().st_size
    assert manifest["image"]["shape_xyz"] == [3, 4, 2]
    assert manifest["image"]["dtype"] == "int32"
    assert manifest["image"]["spatial_units"] == "mm"
    assert len(manifest["image"]["affine_ras"]) == 4
    assert manifest["source_image_sha256"] == _sha256(src_path)
    assert manifest["crop"] == {"start_voxels": [1, 2, 1], "size_voxels": [3, 4, 2]}
    assert manifest["source_provenance"] == prov
    notes = " ".join(manifest["selection_and_evidence_limits"]["notes"])
    assert "DICOM-derived image mm/HU calibration is" not in notes
    assert "unvalidated XY-flip STL placement" not in notes
    assert manifest["clinical_validation"] is False
    assert manifest["application_installation"] is False
    # Keep caller provenance separate from measured output fields.
    assert manifest["source_provenance"] is not manifest["image"]
    with open(result["manifest_path"]) as handle:
        assert json.load(handle) == manifest


@pytest.mark.parametrize("bad", [float("inf"), -float("inf"), float("nan")])
def test_nonfinite_crop_is_rejected_before_any_artifact_is_written(tmp_path, bad):
    import nibabel as nib
    import numpy as np

    data = np.ones((4, 4, 4), dtype=np.float32)
    data[1, 1, 1] = bad
    image = nib.Nifti1Image(data, np.eye(4))
    image.header.set_xyzt_units("mm")
    source = tmp_path / "nonfinite.nii.gz"
    nib.save(image, source)
    with pytest.raises(ValueError, match="finite"):
        _prepare(tmp_path, source, (0, 0, 0), (3, 3, 3))
    assert not (tmp_path / "ctx" / "context-cta.nii.gz").exists()
    assert not (tmp_path / "ctx" / "manifest.json").exists()


def test_singular_source_affine_rejected_before_writing(tmp_path):
    import nibabel as nib
    import numpy as np

    image = nib.Nifti1Image(np.ones((4, 4, 4), dtype=np.int32), np.eye(4))
    image.header.set_xyzt_units("mm")
    singular = np.eye(4)
    singular[:3, 1] = singular[:3, 0]
    image.set_sform(singular, code=1)
    image.set_qform(None, code=0)
    source = tmp_path / "singular.nii.gz"
    nib.save(image, source)
    with pytest.raises(ValueError, match="affine"):
        _prepare(tmp_path, source, (1, 1, 1), (2, 2, 2))
    assert not (tmp_path / "ctx" / "context-cta.nii.gz").exists()


def test_guard_hash_mismatch_rejected(tmp_path):
    src_path, _ = _write_synthetic(tmp_path, REFLECTED_AFFINE)
    bad = "0" * 64
    with pytest.raises(ValueError):
        _prepare(tmp_path, src_path, (1, 2, 1), (3, 4, 2), expected=bad)


@pytest.mark.parametrize("token", ["0x" + "a" * 62, "１" * 64, " " + "a" * 63])
def test_hash_validator_rejects_non_ascii_hex_syntax(token):
    from planner.calibrated_context import _validate_sha256

    with pytest.raises(ValueError, match="hexadecimal"):
        _validate_sha256(token)


def test_guard_malformed_hash_string(tmp_path):
    src_path, _ = _write_synthetic(tmp_path, REFLECTED_AFFINE)
    for bad in ["", "abc", "ZZ" * 32, 123]:
        with pytest.raises(ValueError):
            _prepare(tmp_path, src_path, (1, 2, 1), (3, 4, 2), expected=bad)


def test_guard_symlinked_source_rejected(tmp_path):
    src_path, _ = _write_synthetic(tmp_path, REFLECTED_AFFINE)
    link = tmp_path / "link-src.nii.gz"
    link.symlink_to(src_path)
    with pytest.raises(ValueError):
        _prepare(tmp_path, link, (1, 2, 1), (3, 4, 2), expected=_sha256(src_path))


@pytest.mark.parametrize("slope,intercept", [(2.0, 0.0), (1.0, 100.0), (0.5, -1024.0)])
def test_nonidentity_nifti_scaling_rejected_explicitly_before_output(tmp_path, slope, intercept):
    import nibabel as nib
    import numpy as np

    image = nib.Nifti1Image(np.arange(64, dtype=np.int16).reshape(4, 4, 4), np.eye(4))
    image.header.set_xyzt_units("mm")
    image.header.set_slope_inter(slope, intercept)
    source = tmp_path / "scaled.nii.gz"
    nib.save(image, source)
    proxy = nib.load(source).dataobj
    assert proxy.slope == slope and proxy.inter == intercept
    with pytest.raises(ValueError, match="scaling"):
        _prepare(tmp_path, source, (0, 0, 0), (2, 2, 2))
    assert not (tmp_path / "ctx").exists()


def test_guard_non_mm_units_rejected(tmp_path):
    import nibabel as nib
    import numpy as np

    shape = (4, 4, 4)
    img = nib.Nifti1Image(np.zeros(shape, dtype=np.int16), np.eye(4))
    img.header.set_xyzt_units("unknown", "sec")
    src_path = tmp_path / "unknown-units.nii.gz"
    nib.save(img, str(src_path))
    with pytest.raises(ValueError):
        _prepare(tmp_path, src_path, (0, 0, 0), (2, 2, 2))


def test_guard_invalid_bounds_and_coordinates(tmp_path):
    src_path, _ = _write_synthetic(tmp_path, REFLECTED_AFFINE)
    good = _sha256(src_path)
    cases = [
        ((4, 2, 1), (3, 4, 2)),  # start+size exceeds shape on axis 0
        ((-1, 2, 1), (3, 4, 2)),  # negative start
        ((1, 2, 1), (0, 4, 2)),  # empty crop
        ((True, 2, 1), (3, 4, 2)),  # boolean coordinate
        ((1.0, 2, 1), (3, 4, 2)),  # noninteger coordinate
        (("1", 2, 1), (3, 4, 2)),  # not integers at all
    ]
    for start, size in cases:
        with pytest.raises(ValueError):
            _prepare(tmp_path, src_path, start, size, expected=good)


def test_source_voxel_ceiling_cannot_wrap_int64_before_materialization(tmp_path, monkeypatch):
    from types import SimpleNamespace

    import nibabel as nib
    import numpy as np

    from planner.calibrated_context import _load_source_image

    # Header-only stand-in: no huge array is allocated by this guard test.
    image = SimpleNamespace(
        shape=(2**31, 2**31, 4),
        header=SimpleNamespace(get_xyzt_units=lambda: ("mm", "sec")),
        affine=np.eye(4),
    )
    monkeypatch.setattr(nib, "load", lambda path: image)
    with pytest.raises(ValueError, match="source voxel ceiling"):
        _load_source_image(tmp_path / "header-only.nii")


def test_guard_oversized_context_above_voxel_cap(tmp_path):
    """A crop above the 8,000,000-voxel context cap must be rejected before
    large voxel materialization (source itself stays below its 1e8 ceiling)."""
    import nibabel as nib
    import numpy as np

    shape = (200, 201, 200)  # 8,040,000 source voxels < 1e8 ceiling
    img = nib.Nifti1Image(np.zeros(shape, dtype=np.int16), np.eye(4))
    img.header.set_xyzt_units("mm", "sec")
    src_path = tmp_path / "large-src.nii.gz"
    nib.save(img, str(src_path))
    with pytest.raises(ValueError):
        _prepare(tmp_path, src_path, (0, 0, 0), (200, 201, 200))


def test_output_path_that_is_file_raises_guard_error_and_preserves_bytes(tmp_path):
    source, _ = _write_synthetic(tmp_path, REFLECTED_AFFINE)
    output = tmp_path / "ctx"
    output.write_bytes(b"do-not-touch-file")
    with pytest.raises(ValueError, match="output"):
        _prepare(tmp_path, source, (1, 2, 1), (3, 4, 2))
    assert output.read_bytes() == b"do-not-touch-file"


def test_symlinked_output_directory_is_rejected_without_touching_target(tmp_path):
    source, _ = _write_synthetic(tmp_path, REFLECTED_AFFINE)
    target = tmp_path / "other-output"
    target.mkdir()
    (tmp_path / "ctx").symlink_to(target, target_is_directory=True)
    with pytest.raises(ValueError, match="symlink"):
        _prepare(tmp_path, source, (1, 2, 1), (3, 4, 2))
    assert list(target.iterdir()) == []


@pytest.mark.parametrize("filename", ["context-cta.nii.gz", "manifest.json"])
def test_guard_preexisting_output_artifact_protected(tmp_path, filename):
    src_path, _ = _write_synthetic(tmp_path, REFLECTED_AFFINE)
    out = tmp_path / "ctx"
    out.mkdir()
    sentinel = out / filename
    sentinel.write_bytes(b"do-not-touch")
    with pytest.raises(ValueError):
        _prepare(tmp_path, src_path, (1, 2, 1), (3, 4, 2))
    assert sentinel.read_bytes() == b"do-not-touch"


def test_written_manifest_is_read_back_before_success(tmp_path, monkeypatch):
    source, _ = _write_synthetic(tmp_path, REFLECTED_AFFINE)
    original_dump = json.dump

    def corrupted_dump(payload, handle, **kwargs):
        return original_dump({"unexpected": "disk corruption"}, handle, **kwargs)

    monkeypatch.setattr(json, "dump", corrupted_dump)
    with pytest.raises(ValueError, match="manifest readback"):
        _prepare(tmp_path, source, (1, 2, 1), (3, 4, 2))


def test_tuple_provenance_is_rejected_instead_of_silently_coerced(tmp_path):
    source, _ = _write_synthetic(tmp_path, REFLECTED_AFFINE)
    with pytest.raises(ValueError, match="unsupported type tuple"):
        _prepare(tmp_path, source, (1, 2, 1), (3, 4, 2), provenance={"origin": ("a", "b")})
    assert not (tmp_path / "ctx").exists()


def test_guard_nonfinite_provenance_rejected(tmp_path):
    src_path, _ = _write_synthetic(tmp_path, REFLECTED_AFFINE)
    with pytest.raises(ValueError):
        _prepare(tmp_path, src_path, (1, 2, 1), (3, 4, 2), provenance={"x": float("nan")})


def test_base_environment_lazy_import_guard():
    """``planner.calibrated_context`` must import with NumPy blocked, proving
    the optional ML imports stay function-local (base env has no NumPy)."""
    blocker = (
        "import sys\n"
        "class _Block:\n"
        "    def find_module(self, name, path=None):\n"
        "        if name == 'numpy' or name.startswith('numpy.'):\n"
        "            raise ImportError('numpy blocked for lazy-import guard')\n"
        "        return None\n"
        "    def find_spec(self, name, path=None, target=None):\n"
        "        if name == 'numpy' or name.startswith('numpy.'):\n"
        "            raise ImportError('numpy blocked for lazy-import guard')\n"
        "        return None\n"
        "sys.meta_path.insert(0, _Block())\n"
        f"sys.path.insert(0, {str(ROOT)!r})\n"
        "import planner.calibrated_context\n"
        "print('LAZY_IMPORT_OK')\n"
    )
    for python in (str(ROOT / ".venv" / "bin" / "python"), sys.executable):
        if not Path(python).exists():
            continue
        proc = subprocess.run(
            [python, "-c", blocker],
            capture_output=True,
            check=False,
            text=True,
            timeout=120,
        )
        assert proc.returncode == 0, proc.stderr
        assert "LAZY_IMPORT_OK" in proc.stdout
        return
    pytest.fail("No base interpreter available for lazy-import guard")
