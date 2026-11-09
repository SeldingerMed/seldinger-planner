"""Bounded provenance-preserving native-grid source-context crop helper.

Offline operator configuration: turns an approved local full NIfTI-1 source
(pinned SHA, explicit identity, mm units, explicit sform, identity ArrayProxy
scaling) into a bounded same-grid crop bundle that passes the existing
``InstalledNiftiSourceStore`` admission reader. This module deliberately makes
no claim about public/clinical rights; format acceptance never implies source
authorization. Imaging imports stay lazy inside ``prepare_source_context``.
"""

import gzip
import hashlib
import io
import json
import math
import os
import re
import struct
from pathlib import Path
from typing import Any, NoReturn, cast

COMPRESSED_LIMIT = 128 * 1024 * 1024
# Separate offline input budget for the observed calibrated int32 full source.
# The app's output/source transport limits remain 8M voxels / 16MiB stored.
DECOMPRESSED_LIMIT = 384 * 1024 * 1024 + 65536 + 352
GRID_VOXEL_LIMIT = 134_217_728
AXIS_LIMIT = 4096
IMAGE_FILENAME = "context-cta.nii.gz"
IMAGE_BYTE_LIMIT = 16 * 1024 * 1024
MANIFEST_BYTE_LIMIT = 16384
MAX_CROP_AXIS = 2048
MAX_CROP_VOXELS = 8_000_000
AFFINE_ABS_TOL = 1e-4
SOURCE_ID_PATTERN = re.compile(r"[a-z0-9][a-z0-9_-]{1,63}")
SHA256_PATTERN = re.compile(r"[a-f0-9]{64}")
PROVENANCE_BYTE_LIMIT = 4096

# datatype code -> (manifest dtype name, bits); mirrors InstalledNiftiSourceStore
_DTYPE_BY_CODE = {
    2: ("uint8", 8),
    4: ("int16", 16),
    8: ("int32", 32),
    512: ("uint16", 16),
    16: ("float32", 32),
}


def _fail(message: str) -> NoReturn:
    raise ValueError(f"source context preparation: {message}")


def _is_native_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _check_no_symlinks(path: Path, label: str) -> None:
    if path.is_symlink():
        _fail(f"{label} is a symlink: {path}")
    for parent in path.parents:
        if parent.is_symlink():
            _fail(f"{label} ancestor is a symlink: {parent}")


def _finite_affine_rows(rows: list[list[float]]) -> list[list[float]]:
    if len(rows) != 4 or any(len(row) != 4 for row in rows):
        _fail("affine must be a 4x4 matrix")
    matrix = [[float(value) for value in row] for row in rows]
    for row in matrix:
        for value in row:
            if not math.isfinite(value):
                _fail("affine values must be finite")
    if matrix[3] != [0.0, 0.0, 0.0, 1.0]:
        _fail("affine last row must be homogeneous [0, 0, 0, 1]")
    a, b, c = matrix[0][:3], matrix[1][:3], matrix[2][:3]
    det = (
        a[0] * (b[1] * c[2] - b[2] * c[1])
        - a[1] * (b[0] * c[2] - b[2] * c[0])
        + a[2] * (b[0] * c[1] - b[1] * c[0])
    )
    if det == 0.0 or not math.isfinite(det):
        _fail("affine is singular")
    return matrix


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _validate_source_header(raw: bytes) -> tuple[str, list[int], list[list[float]]]:
    """Struct-level NIfTI-1 validation before any array materialization."""
    if len(raw) < 352:
        _fail("NIfTI decompressed size below header length")
    endian = "<" if struct.unpack_from("<i", raw)[0] == 348 else ">"
    if struct.unpack_from(endian + "i", raw)[0] != 348 or raw[344:348] != b"n+1\x00":
        _fail("source must be a single-file NIfTI-1")
    dims = struct.unpack_from(endian + "8h", raw, 40)
    if dims[0] != 3:
        _fail("source must be a 3D grid")
    shape = [int(dims[i]) for i in (1, 2, 3)]
    if any(axis <= 0 or axis > AXIS_LIMIT for axis in shape):
        _fail(f"source grid axes must be within 1..{AXIS_LIMIT}")
    if math.prod(shape) > GRID_VOXEL_LIMIT:
        _fail(f"source grid exceeds {GRID_VOXEL_LIMIT} voxels")
    datatype, bits = struct.unpack_from(endian + "2h", raw, 70)
    if datatype not in _DTYPE_BY_CODE or bits != _DTYPE_BY_CODE[datatype][1]:
        _fail("source dtype not in the allowed installed-source list")
    if raw[123] & 7 != 2:
        _fail("source header spatial units must be explicitly mm")
    slope, inter = struct.unpack_from(endian + "2f", raw, 112)
    disabled = slope == 0.0 or not math.isfinite(slope)
    effective_slope, effective_inter = (1.0, 0.0) if disabled else (slope, inter)
    if effective_slope != 1.0 or effective_inter != 0.0:
        _fail("nonidentity ArrayProxy scaling is rejected; source must be slope 1 / intercept 0")
    if struct.unpack_from(endian + "h", raw, 254)[0] <= 0:
        _fail("source requires an explicit sform; qform-only sources are rejected")
    srows = [struct.unpack_from(endian + "4f", raw, 280 + i * 16) for i in range(3)]
    affine = _finite_affine_rows([list(srows[i]) for i in range(3)] + [[0.0, 0.0, 0.0, 1.0]])
    offset = struct.unpack_from(endian + "f", raw, 108)[0]
    if not math.isfinite(offset) or offset < 352 or offset != int(offset):
        _fail("invalid NIfTI voxel offset")
    count = math.prod(shape)
    if int(offset) + count * bits // 8 != len(raw):
        _fail("NIfTI payload length does not match native grid")
    return _DTYPE_BY_CODE[datatype][0], shape, affine


def prepare_source_context(
    input_path: Path | str,
    output_dir: Path | str,
    *,
    expected_sha256: str,
    source_id: str,
    start_voxels: list[int],
    size_voxels: list[int],
    source_provenance: dict[str, Any],
    selection_basis: str,
) -> dict[str, Any]:
    """Prepare an admitted bounded native-grid source-context crop bundle."""
    import nibabel as nib
    import numpy as np

    if not isinstance(expected_sha256, str) or SHA256_PATTERN.fullmatch(expected_sha256) is None:
        _fail("expected_sha256 must be a lowercase 64-hex digest")
    if not isinstance(source_id, str) or SOURCE_ID_PATTERN.fullmatch(source_id) is None:
        _fail("source_id must match the installed-source registry pattern")
    if not isinstance(selection_basis, str) or not (1 <= len(selection_basis.strip()) <= 200):
        _fail("selection_basis must be nonempty text of at most 200 characters")
    if not isinstance(source_provenance, dict):
        _fail("source_provenance must be a JSON object")
    provenance = json.loads(json.dumps(source_provenance, allow_nan=False))
    provenance_bytes = json.dumps(provenance, separators=(",", ":")).encode("utf-8")
    if len(provenance_bytes) > PROVENANCE_BYTE_LIMIT:
        _fail("source_provenance exceeds the bounded JSON size")
    upstream = provenance.get("upstream_image_sha256")
    if not isinstance(upstream, str) or SHA256_PATTERN.fullmatch(upstream) is None:
        _fail("source_provenance must carry upstream_image_sha256")
    if upstream != expected_sha256:
        _fail("upstream_image_sha256 must match the exact full source bytes")
    for key in provenance:
        if not isinstance(key, str) or len(key) > 64:
            _fail("source_provenance keys must be bounded text")

    src = Path(input_path)
    _check_no_symlinks(src, "source file")
    if not src.is_file():
        _fail(f"source file not found: {src}")
    source_size = src.stat().st_size
    if source_size <= 0 or source_size > COMPRESSED_LIMIT:
        _fail("source file byte size out of bounds")
    with src.open("rb") as stream:
        payload = stream.read(COMPRESSED_LIMIT + 1)
    if len(payload) != source_size or len(payload) > COMPRESSED_LIMIT:
        _fail("source file changed or exceeds the compressed bound")
    if hashlib.sha256(payload).hexdigest() != expected_sha256:
        _fail("source sha256 does not match the pinned expected_sha256")
    try:
        if payload[:2] == b"\x1f\x8b":
            with gzip.GzipFile(fileobj=io.BytesIO(payload)) as stream:
                raw = stream.read(DECOMPRESSED_LIMIT + 1)
        else:
            raw = payload
    except (OSError, EOFError) as exc:
        _fail(f"invalid compressed NIfTI: {exc}")
    if len(raw) > DECOMPRESSED_LIMIT:
        _fail("decompressed source exceeds the byte bound")

    dtype_name, shape, affine = _validate_source_header(raw)
    image = nib.Nifti1Image.from_bytes(raw)
    # NiBabel consumes scaling into the proxy when decoding; the loaded header
    # alone no longer describes the effective scalar transform.
    proxy = cast(Any, image.dataobj)
    if proxy.slope != 1.0 or proxy.inter != 0.0:
        _fail("nonidentity ArrayProxy scaling is rejected; source must be slope 1 / intercept 0")

    if len(start_voxels) != 3 or any(not _is_native_int(v) or v < 0 for v in start_voxels):
        _fail("start_voxels must be three nonnegative integers without coercion")
    if len(size_voxels) != 3 or any(not _is_native_int(v) or v <= 0 for v in size_voxels):
        _fail("size_voxels must be three positive integers without coercion")
    if any(size_voxels[i] > MAX_CROP_AXIS for i in range(3)):
        _fail(f"each crop axis must be at most {MAX_CROP_AXIS}")
    if math.prod(size_voxels) > MAX_CROP_VOXELS:
        _fail(f"crop voxel count exceeds {MAX_CROP_VOXELS}")
    if any(start_voxels[i] + size_voxels[i] > shape[i] for i in range(3)):
        _fail("crop window exceeds the native source grid; no auto-clamping is performed")

    translation = np.eye(4)
    translation[:3, 3] = start_voxels
    crop_affine = affine @ translation
    slices = tuple(slice(start_voxels[i], start_voxels[i] + size_voxels[i]) for i in range(3))
    crop_data = np.asanyarray(proxy[slices])
    if not np.isfinite(crop_data).all():
        _fail("cropped source scalars must be finite")
    if crop_data.dtype != np.dtype(dtype_name):
        crop_data = crop_data.astype(np.dtype(dtype_name))
    crop_data = np.ascontiguousarray(crop_data)

    out_img = nib.Nifti1Image(crop_data, np.asarray(crop_affine))
    out_img.set_sform(np.asarray(crop_affine), code=1)
    out_img.header.set_xyzt_units("mm", "unknown")
    out_img.set_data_dtype(np.dtype(dtype_name))
    serialized = out_img.to_bytes()
    image_bytes = gzip.compress(serialized, mtime=0)
    if len(image_bytes) > IMAGE_BYTE_LIMIT:
        _fail("serialized crop image exceeds the stored output byte cap")

    # Authoritative readback of the serialized bytes.
    readback = nib.Nifti1Image.from_bytes(serialized)
    readback_affine = np.asarray(readback.affine)
    if not np.allclose(readback_affine, crop_affine, atol=AFFINE_ABS_TOL, rtol=0.0):
        _fail("serialized readback affine diverges from the source-world transform")
    if not np.array_equal(np.asanyarray(readback.dataobj), crop_data):
        _fail("serialized readback scalars diverge from the cropped native grid")
    for corner in [
        (0, 0, 0),
        (size_voxels[0] - 1, 0, 0),
        (0, size_voxels[1] - 1, 0),
        (0, 0, size_voxels[2] - 1),
    ]:
        native = [start_voxels[i] + corner[i] for i in range(3)]
        full_world = np.asarray(affine) @ np.array([*native, 1.0])
        crop_world = readback_affine @ np.array([*corner, 1.0])
        if not np.allclose(full_world, crop_world, atol=AFFINE_ABS_TOL, rtol=0.0):
            _fail("crop corner world mapping diverges from the native source transform")

    out = Path(output_dir)
    _check_no_symlinks(out, "output directory")
    if out.exists():
        _fail(f"output directory must not pre-exist: {out}")
    out.mkdir(mode=0o700)
    manifest = {
        "version": 1,
        "clinical_validation": False,
        "source_id": source_id,
        "source_image_sha256": expected_sha256,
        "image": {
            "filename": IMAGE_FILENAME,
            "bytes": len(image_bytes),
            "sha256": hashlib.sha256(image_bytes).hexdigest(),
            "dtype": dtype_name,
            "shape_xyz": list(size_voxels),
            "spatial_units": "mm",
            "affine_ras": [[float(v) for v in row] for row in readback_affine],
        },
        "crop": {
            "start_voxels": list(start_voxels),
            "size_voxels": list(size_voxels),
        },
        "source_provenance": provenance,
        "selection_basis": selection_basis.strip(),
    }
    manifest_bytes = json.dumps(manifest, indent=2, allow_nan=False).encode("utf-8")
    if len(manifest_bytes) > MANIFEST_BYTE_LIMIT:
        _fail("manifest exceeds the stored output byte cap")

    created: list[Path] = []
    try:
        for name, blob in ((IMAGE_FILENAME, image_bytes), ("manifest.json", manifest_bytes)):
            target = out / name
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            created.append(target)
            with os.fdopen(fd, "wb") as stream:
                stream.write(blob)
        _check_no_symlinks(src, "source file")
        with src.open("rb") as stream:
            reread = stream.read(COMPRESSED_LIMIT + 1)
        if hashlib.sha256(reread).hexdigest() != expected_sha256:
            _fail("source file changed during preparation")
        from planner.image_source import InstalledNiftiSourceStore

        InstalledNiftiSourceStore(out, source_id=source_id).load()
    except BaseException:
        # Remove only files successfully created by this invocation. An unexpected
        # occupant is never globbed or recursively removed, even on failure.
        for target in reversed(created):
            try:
                target.unlink()
            except OSError:
                pass
        try:
            out.rmdir()
        except OSError:
            pass
        raise
    return manifest
