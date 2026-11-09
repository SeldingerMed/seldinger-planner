"""Synthetic tests for the bounded native-grid source-context crop helper.

Runs only in the installed optional ML runtime, gated by
``SELDINGER_RUN_MODEL_TESTS=1``. All fixtures are synthetic; no real data,
weights, network, secrets or Git access.
"""

import gzip
import hashlib
import os
import stat
import sys
from pathlib import Path

import pytest

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Separate ML runtime only", allow_module_level=True)

import nibabel as nib
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from planner.source_context import prepare_source_context


def _prepare(src, out, sha, **overrides):
    options = {
        "expected_sha256": sha,
        "source_id": "synthetic-context-a",
        "start_voxels": [1, 2, 0],
        "size_voxels": [3, 3, 4],
        "source_provenance": {"upstream_image_sha256": sha, "origin": "synthetic fixture"},
        "selection_basis": "operator-selected synthetic fixture",
    }
    options.update(overrides)
    return prepare_source_context(src, out, **options)


def test_reject_contradictory_upstream_hash(tmp_path):
    src, _, _, sha = _make_source(tmp_path)
    out = tmp_path / "contradictory"
    with pytest.raises(ValueError, match="upstream_image_sha256"):
        _prepare(src, out, sha, source_provenance={"upstream_image_sha256": "f" * 64})
    assert not out.exists()


def test_large_compressible_int32_crop_admitted_under_stored_cap(tmp_path):
    from planner.image_source import InstalledNiftiSourceStore

    data = np.zeros((192, 192, 192), dtype=np.int32)
    image = nib.Nifti1Image(data, np.eye(4), dtype=data.dtype)
    image.header.set_xyzt_units("mm", "unknown")
    raw = image.to_bytes()
    assert len(raw) > 16 * 1024 * 1024
    src = tmp_path / "large-compressible.nii.gz"
    payload = gzip.compress(raw, mtime=0)
    src.write_bytes(payload)
    sha = hashlib.sha256(payload).hexdigest()
    out = tmp_path / "large-prepared"
    manifest = _prepare(src, out, sha, start_voxels=[0, 0, 0], size_voxels=[192, 192, 192])
    assert manifest["image"]["bytes"] < 16 * 1024 * 1024
    admitted, _, _ = InstalledNiftiSourceStore(out, source_id=SOURCE_ID).load()
    assert admitted["image"]["shape_xyz"] == [192, 192, 192]


def test_source_changed_mid_decode_leaves_no_admitted_output(tmp_path, monkeypatch):
    src, _, _, sha = _make_source(tmp_path)
    original = nib.Nifti1Image.from_bytes
    calls = 0

    def replace_after_decode(raw):
        nonlocal calls
        result = original(raw)
        calls += 1
        if calls == 1:
            payload = bytearray(src.read_bytes())
            payload[-1] ^= 1
            assert hashlib.sha256(payload).hexdigest() != sha
            src.write_bytes(payload)
        return result

    monkeypatch.setattr(nib.Nifti1Image, "from_bytes", replace_after_decode)
    out = tmp_path / "changed-source"
    with pytest.raises(ValueError, match="source file changed"):
        _prepare(src, out, sha)
    assert not out.exists()


@pytest.mark.parametrize("slope,inter", [(0.0, 5.0), (float("nan"), float("nan"))])
def test_disabled_scaling_preserves_raw_scalars(tmp_path, slope, inter):
    import struct

    src, data, _, _ = _make_source(tmp_path)
    raw = bytearray(gzip.decompress(src.read_bytes()))
    struct.pack_into("<ff", raw, 112, slope, inter)
    payload = gzip.compress(raw, mtime=0)
    src.write_bytes(payload)
    sha = hashlib.sha256(payload).hexdigest()
    decoded = nib.Nifti1Image.from_bytes(raw)
    assert decoded.dataobj.slope == 1 and decoded.dataobj.inter == 0
    manifest = _prepare(src, tmp_path / "disabled-scaling", sha)
    crop = nib.load(tmp_path / "disabled-scaling" / manifest["image"]["filename"])
    assert np.array_equal(np.asanyarray(crop.dataobj), data[1:4, 2:5, 0:4])


def test_final_store_admission_failure_removes_only_owned_output(tmp_path, monkeypatch):
    from planner.image_source import InstalledNiftiSourceStore

    src, _, _, sha = _make_source(tmp_path)
    out = tmp_path / "admission-failure"
    calls = []

    def reject(self):
        calls.append(self)
        raise ValueError("injected final source admission refusal")

    monkeypatch.setattr(InstalledNiftiSourceStore, "load", reject)
    with pytest.raises(ValueError, match="final source admission"):
        _prepare(src, out, sha)
    assert len(calls) == 1
    assert not out.exists()


def test_reject_nonfinite_crop_before_publication(tmp_path):
    data = np.zeros((6, 7, 5), dtype=np.float32)
    data[1, 2, 0] = np.inf
    image = nib.Nifti1Image(data, np.eye(4))
    image.header.set_xyzt_units("mm", "unknown")
    payload = gzip.compress(image.to_bytes(), mtime=0)
    src = tmp_path / "nonfinite.nii.gz"
    src.write_bytes(payload)
    out = tmp_path / "nonfinite-context"
    with pytest.raises(ValueError, match="finite"):
        _prepare(src, out, hashlib.sha256(payload).hexdigest())
    assert not out.exists()


@pytest.mark.parametrize("dtype", ["uint8", "uint16", "int16", "int32", "float32"])
@pytest.mark.parametrize("endian", ["<", ">"])
@pytest.mark.parametrize("compressed", [False, True])
def test_supported_dtype_endian_container_preserves_values(tmp_path, dtype, endian, compressed):
    from planner.image_source import InstalledNiftiSourceStore

    data = np.arange(6 * 7 * 5).reshape(6, 7, 5).astype(np.dtype(dtype))
    header = nib.Nifti1Header(endianness=endian)
    header.set_data_dtype(data.dtype)
    image = nib.Nifti1Image(data, _oblique_affine(), header=header)
    image.header.set_xyzt_units("mm", "unknown")
    raw = image.to_bytes()
    payload = gzip.compress(raw, mtime=0) if compressed else raw
    src = tmp_path / ("typed.nii.gz" if compressed else "typed.nii")
    src.write_bytes(payload)
    out = tmp_path / "typed-context"
    manifest = _prepare(src, out, hashlib.sha256(payload).hexdigest())
    admitted, _, paths = InstalledNiftiSourceStore(out, source_id=SOURCE_ID).load()
    crop = nib.load(paths["image"])
    assert admitted == manifest and manifest["image"]["dtype"] == dtype
    assert np.array_equal(np.asanyarray(crop.dataobj), data[1:4, 2:5, 0:4])
    assert crop.get_data_dtype() == np.dtype(dtype)


SOURCE_ID = "synthetic-context-a"
START = [1, 2, 0]
SIZE = [3, 3, 4]
PROVENANCE = {"upstream_image_sha256": "0" * 64, "origin": "synthetic fixture"}


def _oblique_affine() -> np.ndarray:
    angle = 0.3
    rot = np.array(
        [
            [np.cos(angle), -np.sin(angle), 0.0],
            [np.sin(angle), np.cos(angle), 0.0],
            [0.0, 0.0, 1.0],
        ]
    )
    mat = rot @ np.diag([3.0, 2.5, 2.0])
    affine = np.eye(4)
    affine[:3, :3] = mat
    affine[:3, 3] = [-12.0, 7.5, 3.25]
    return affine


def _make_source(tmp_path: Path, *, slope: float = 1.0, inter: float = 0.0):
    shape = (6, 7, 5)
    data = (np.arange(np.prod(shape), dtype=np.int64) % 900 - 400).reshape(shape).astype(np.int16)
    affine = _oblique_affine()
    img = nib.Nifti1Image(data, affine)
    img.set_sform(affine, code=1)
    img.set_qform(affine, code=1)
    img.header.set_xyzt_units("mm", "unknown")
    img.header.set_slope_inter(slope, inter)
    raw = img.to_bytes()
    payload = gzip.compress(raw, mtime=0)
    src = tmp_path / "source.nii.gz"
    src.write_bytes(payload)
    return src, data, affine, hashlib.sha256(payload).hexdigest()


def test_prepare_positive_admits_via_installed_store(tmp_path):
    src, data, affine, sha = _make_source(tmp_path)
    out = tmp_path / "prepared"
    assert not out.exists()
    manifest = prepare_source_context(
        src,
        out,
        expected_sha256=sha,
        source_id=SOURCE_ID,
        start_voxels=START,
        size_voxels=SIZE,
        source_provenance={**PROVENANCE, "upstream_image_sha256": sha},
        selection_basis="operator-selected",
    )
    # Manifest content
    assert manifest["clinical_validation"] is False
    assert manifest["version"] == 1
    assert manifest["source_image_sha256"] == sha
    assert manifest["source_provenance"] == {**PROVENANCE, "upstream_image_sha256": sha}
    assert manifest["selection_basis"] == "operator-selected"
    assert manifest["crop"] == {
        "start_voxels": START,
        "size_voxels": SIZE,
    }
    image = manifest["image"]
    assert image["filename"] == "context-cta.nii.gz"
    assert image["dtype"] == "int16"
    assert image["shape_xyz"] == list(SIZE)
    assert image["spatial_units"] == "mm"
    image_path = out / "context-cta.nii.gz"
    assert image["bytes"] == image_path.stat().st_size
    assert image["sha256"] == hashlib.sha256(image_path.read_bytes()).hexdigest()
    assert "source_path" not in manifest and str(src) not in repr(manifest)
    # Private modes, freshly created directory only
    assert stat.S_IMODE(out.stat().st_mode) == 0o700
    assert stat.S_IMODE(image_path.stat().st_mode) == 0o600
    assert stat.S_IMODE((out / "manifest.json").stat().st_mode) == 0o600
    # Exact preserved scalars on the native grid
    out_img = nib.Nifti1Image.from_bytes(gzip.decompress(image_path.read_bytes()))
    expected = data[
        START[0] : START[0] + SIZE[0], START[1] : START[1] + SIZE[1], START[2] : START[2] + SIZE[2]
    ]
    assert np.array_equal(np.asanyarray(out_img.dataobj), expected)
    assert out_img.get_data_dtype() == np.dtype(np.int16)
    # Every corner world mapping: full affine at native start+corner == crop affine at corner
    readback = np.asarray(out_img.affine)
    for corner in [
        (0, 0, 0),
        (SIZE[0] - 1, 0, 0),
        (0, SIZE[1] - 1, SIZE[2] - 1),
        (SIZE[0] - 1, SIZE[1] - 1, SIZE[2] - 1),
    ]:
        native = [START[i] + corner[i] for i in range(3)]
        full_world = affine @ np.array([*native, 1.0])
        crop_world = readback @ np.array([*corner, 1.0])
        assert np.allclose(full_world, crop_world, atol=1e-4)
    # Serialized readback affine matches the source-world transform
    expected_crop = affine @ np.array(
        [[1, 0, 0, START[0]], [0, 1, 0, START[1]], [0, 0, 1, START[2]], [0, 0, 0, 1]]
    )
    assert np.allclose(readback, expected_crop, atol=1e-4)
    # Manifest affine equals the serialized readback
    assert np.allclose(np.asarray(image["affine_ras"]), readback, atol=1e-6)
    # Source unchanged
    assert hashlib.sha256(src.read_bytes()).hexdigest() == sha
    # Actual final admission through the existing installed-source reader
    from planner.image_source import InstalledNiftiSourceStore

    loaded_manifest, _manifest_sha, paths = InstalledNiftiSourceStore(
        out, source_id=SOURCE_ID
    ).load()
    assert loaded_manifest["crop"]["start_voxels"] == START
    assert loaded_manifest["image"]["shape_xyz"] == list(SIZE)
    assert paths["image"] == image_path


def test_reject_wrong_sha(tmp_path):
    src, _data, _affine, _sha = _make_source(tmp_path)
    sha = "a" * 64
    with pytest.raises(ValueError, match="sha"):
        prepare_source_context(
            src,
            tmp_path / "o1",
            expected_sha256="a" * 64,
            source_id=SOURCE_ID,
            start_voxels=START,
            size_voxels=SIZE,
            source_provenance={**PROVENANCE, "upstream_image_sha256": sha},
            selection_basis="operator-selected",
        )


def test_reject_symlink_input(tmp_path):
    src, _data, _affine, sha = _make_source(tmp_path)
    link = tmp_path / "link.nii.gz"
    link.symlink_to(src)
    with pytest.raises(ValueError, match="symlink"):
        prepare_source_context(
            link,
            tmp_path / "o2",
            expected_sha256=sha,
            source_id=SOURCE_ID,
            start_voxels=START,
            size_voxels=SIZE,
            source_provenance={**PROVENANCE, "upstream_image_sha256": sha},
            selection_basis="operator-selected",
        )


def test_reject_nonidentity_scaling(tmp_path):
    for slope, inter in [(2.0, 0.0), (1.0, 5.0)]:
        src, _data, _affine, sha = _make_source(tmp_path, slope=slope, inter=inter)
        with pytest.raises(ValueError, match="scal"):
            prepare_source_context(
                src,
                tmp_path / f"o3-{slope}-{inter}",
                expected_sha256=sha,
                source_id=SOURCE_ID,
                start_voxels=START,
                size_voxels=SIZE,
                source_provenance={**PROVENANCE, "upstream_image_sha256": sha},
                selection_basis="operator-selected",
            )


def test_reject_non_mm_units(tmp_path):
    _src, data, affine, _sha = _make_source(tmp_path)
    img = nib.Nifti1Image(data, affine)
    img.set_sform(affine, code=1)
    img.header.set_xyzt_units("sec", "unknown")
    payload = gzip.compress(img.to_bytes(), mtime=0)
    bad = tmp_path / "units.nii.gz"
    bad.write_bytes(payload)
    sha = hashlib.sha256(payload).hexdigest()
    with pytest.raises(ValueError, match="mm"):
        prepare_source_context(
            bad,
            tmp_path / "o4",
            expected_sha256=hashlib.sha256(payload).hexdigest(),
            source_id=SOURCE_ID,
            start_voxels=START,
            size_voxels=SIZE,
            source_provenance={**PROVENANCE, "upstream_image_sha256": sha},
            selection_basis="operator-selected",
        )


def test_reject_missing_sform(tmp_path):
    _src, data, affine, _sha = _make_source(tmp_path)
    img = nib.Nifti1Image(data, affine)
    img.set_sform(None, code=0)
    img.header.set_xyzt_units("mm", "unknown")
    payload = gzip.compress(img.to_bytes(), mtime=0)
    bad = tmp_path / "nosform.nii.gz"
    bad.write_bytes(payload)
    sha = hashlib.sha256(payload).hexdigest()
    with pytest.raises(ValueError, match="sform"):
        prepare_source_context(
            bad,
            tmp_path / "o5",
            expected_sha256=hashlib.sha256(payload).hexdigest(),
            source_id=SOURCE_ID,
            start_voxels=START,
            size_voxels=SIZE,
            source_provenance={**PROVENANCE, "upstream_image_sha256": sha},
            selection_basis="operator-selected",
        )


def test_reject_bad_crop_inputs(tmp_path):
    src, _data, _affine, sha = _make_source(tmp_path)
    common = {
        "expected_sha256": sha,
        "source_id": SOURCE_ID,
        "source_provenance": {**PROVENANCE, "upstream_image_sha256": sha},
        "selection_basis": "operator-selected",
    }
    cases = [
        {"start_voxels": [True, 0, 0], "size_voxels": SIZE},  # bool coercion
        {"start_voxels": [1.0, 0, 0], "size_voxels": SIZE},  # float coercion
        {"start_voxels": [-1, 0, 0], "size_voxels": SIZE},  # negative
        {"start_voxels": START, "size_voxels": [4, 0, 4]},  # non-positive size
        {"start_voxels": [4, 0, 0], "size_voxels": SIZE},  # out of native bounds
        {"start_voxels": START, "size_voxels": [2000, 2000, 2000]},  # axis cap
    ]
    for i, case in enumerate(cases):
        with pytest.raises(ValueError):
            prepare_source_context(src, tmp_path / f"o6-{i}", **common, **case)


def test_reject_existing_output_dir(tmp_path):
    src, _data, _affine, sha = _make_source(tmp_path)
    out = tmp_path / "o7"
    out.mkdir()
    with pytest.raises(ValueError, match="exist"):
        prepare_source_context(
            src,
            out,
            expected_sha256=sha,
            source_id=SOURCE_ID,
            start_voxels=START,
            size_voxels=SIZE,
            source_provenance={**PROVENANCE, "upstream_image_sha256": sha},
            selection_basis="operator-selected",
        )


def test_reject_invalid_source_id_or_basis(tmp_path):
    src, _data, _affine, sha = _make_source(tmp_path)
    common = {
        "expected_sha256": sha,
        "start_voxels": START,
        "size_voxels": SIZE,
        "source_provenance": {**PROVENANCE, "upstream_image_sha256": sha},
    }
    with pytest.raises(ValueError, match="source_id"):
        prepare_source_context(
            src, tmp_path / "o8", source_id="Bad ID", selection_basis="operator-selected", **common
        )
    with pytest.raises(ValueError, match="selection_basis"):
        prepare_source_context(
            src, tmp_path / "o9", source_id=SOURCE_ID, selection_basis="  ", **common
        )
