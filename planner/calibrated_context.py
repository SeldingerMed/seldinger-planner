"""Operator-only calibrated public context preparation (internal data layer).

No product endpoint, no model execution, no clinical claim, no application
installation. Source is the explicitly authorized deidentified public Zenodo
case 006 (CC BY 4.0). NumPy/NiBabel imports are function-local so the base
environment (no NumPy) can still import this module.

This layer selects reference-informed candidate context only. It does not
perform independent lesion localization and does not validate the STL
coordinate frame, units or registration.
"""

import hashlib
import json
import math
from pathlib import Path

__all__ = ["prepare_calibrated_context"]

_HASH_LENGTH = 64
_SOURCE_VOXEL_CEILING = 100_000_000
_CONTEXT_VOXEL_CAP = 8_000_000
_IMAGE_FILENAME = "context-cta.nii.gz"
_MANIFEST_FILENAME = "manifest.json"
_MAX_PROVENANCE_BYTES = 8192
_REQUIRED_MANIFEST_FLAGS = ("clinical_validation", "application_installation")


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _validate_sha256(value):
    if not isinstance(value, str) or len(value) != _HASH_LENGTH:
        raise ValueError("expected_sha256 must be a 64-character hex string")
    if any(character not in "0123456789abcdefABCDEF" for character in value):
        raise ValueError("expected_sha256 must be ASCII hexadecimal")
    return value.lower()


def _sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _validate_int_vector(value, name):
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise ValueError(f"{name} must be a sequence of 3 integers")
    out = []
    for component in value:
        if isinstance(component, bool) or not isinstance(component, int):
            # Contract: every malformed coordinate is a ValueError, including
            # wrong types.
            raise ValueError(  # noqa: TRY004
                f"{name} must contain native integers only, got {component!r}"
            )
        out.append(component)
    return out


def _json_finite_bounded(value, label, depth=0):
    """Validate that a caller-supplied structure is bounded and JSON-finite."""
    if depth > 6:
        raise ValueError(f"{label} nesting too deep")
    if isinstance(value, dict):
        _require(len(value) <= 64, f"{label} too large")
        for key, item in value.items():
            _require(isinstance(key, str) and len(key) <= 128, f"{label} key invalid")
            _json_finite_bounded(item, f"{label}.{key}", depth + 1)
    elif isinstance(value, list):
        _require(len(value) <= 256, f"{label} too large")
        for index, item in enumerate(value):
            _json_finite_bounded(item, f"{label}[{index}]", depth + 1)
    elif isinstance(value, bool) or value is None:
        return
    elif isinstance(value, int):
        _require(abs(value) <= 10**18, f"{label} out of range")
    elif isinstance(value, float):
        _require(math.isfinite(value), f"{label} must be finite")
    elif isinstance(value, str):
        _require(len(value) <= 2048, f"{label} string too long")
    else:
        raise ValueError(f"{label} contains unsupported type {type(value).__name__}")


def _load_source_image(source_path):
    """Validate the source header/geometry before materializing voxels."""
    import nibabel as nib
    import numpy as np

    img = nib.load(str(source_path))
    _require(len(img.shape) == 3, "source must be a 3D image")
    _require(all(dim > 0 for dim in img.shape), "source has invalid dimensions")
    _require(
        math.prod(img.shape) <= _SOURCE_VOXEL_CEILING,
        "source exceeds the source voxel ceiling",
    )
    units = img.header.get_xyzt_units()
    _require(units[0] == "mm", f"source spatial units must be declared mm, got {units[0]!r}")
    affine = np.asarray(img.affine, dtype=np.float64)
    _require(affine.shape == (4, 4) and np.all(np.isfinite(affine)), "source affine invalid")
    _require(
        np.array_equal(affine[3], [0.0, 0.0, 0.0, 1.0])
        and np.linalg.matrix_rank(affine[:3, :3]) == 3,
        "source affine must be homogeneous and nonsingular",
    )
    _require(
        img.dataobj.slope == 1.0 and img.dataobj.inter == 0.0,
        "nonidentity NIfTI scalar scaling is unsupported; preserve source dtype and physical values",
    )
    return img, affine


def prepare_calibrated_context(
    source_path,
    output_dir,
    *,
    expected_sha256,
    start_xyz,
    size_xyz,
    provenance,
):
    """Prepare a version-1 calibrated public context crop with readback.

    Operator-only preparation of an explicitly authorized public source.
    Returns ``{"image_path": Path, "manifest_path": Path, "manifest": dict}``
    only after the saved artifact is read back and independently verified.
    Never mutates the raw input and never manufactures physical units.
    """
    import nibabel as nib
    import numpy as np

    expected_sha256 = _validate_sha256(expected_sha256)
    start = _validate_int_vector(start_xyz, "start_xyz")
    size = _validate_int_vector(size_xyz, "size_xyz")

    _json_finite_bounded(provenance, "provenance")
    encoded = json.dumps(provenance, sort_keys=True)
    _require(len(encoded.encode("utf-8")) <= _MAX_PROVENANCE_BYTES, "provenance too large")

    source = Path(source_path)
    _require(source.is_file(), "source path is not a regular file")
    _require(not source.is_symlink(), "symlinked source rejected")
    _require(not source.resolve().is_symlink(), "resolved symlinked source rejected")

    actual_hash = _sha256_file(source)
    _require(actual_hash == expected_sha256, "source SHA-256 mismatch")

    img, source_affine = _load_source_image(source)

    source_shape = [int(dim) for dim in img.shape]
    for axis in range(3):
        _require(0 <= start[axis], f"start_xyz below bounds on axis {axis}")
        _require(size[axis] >= 1, f"size_xyz must be positive on axis {axis}")
        _require(
            start[axis] + size[axis] <= source_shape[axis],
            f"crop bounds exceed source shape on axis {axis}",
        )
    context_voxels = int(np.prod(size))
    _require(context_voxels <= _CONTEXT_VOXEL_CAP, "context exceeds the 8,000,000-voxel cap")

    # Crop without rescaling: original dtype and original scalar values only.
    slices = tuple(slice(start[axis], start[axis] + size[axis]) for axis in range(3))
    source_data = np.asanyarray(img.dataobj)
    crop = np.ascontiguousarray(source_data[slices])
    del source_data
    _require(crop.dtype == img.get_data_dtype(), "crop dtype changed")
    _require(crop.shape == tuple(size), "crop shape mismatch")
    _require(np.all(np.isfinite(crop)), "crop scalar values must be finite")

    output = Path(output_dir)
    _require(not output.is_symlink(), "symlinked output rejected")
    _require(not output.exists() or output.is_dir(), "output path must be a directory")
    _require(not output.exists() or not any(output.iterdir()), "pre-existing output artifact")
    output.mkdir(parents=True, exist_ok=True)
    image_path = output / _IMAGE_FILENAME
    manifest_path = output / _MANIFEST_FILENAME
    _require(not image_path.exists() and not manifest_path.exists(), "pre-existing output artifact")

    units = img.header.get_xyzt_units()
    translation = np.eye(4)
    translation[:3, 3] = np.asarray(start, dtype=np.float64)
    crop_affine = source_affine @ translation
    _require(np.all(np.isfinite(crop_affine)), "composed affine not finite")

    header = img.header.copy()
    header.set_data_dtype(crop.dtype)
    header.set_xyzt_units(units[0], units[1])
    out_img = nib.Nifti1Image(crop, crop_affine, header=header)
    nib.save(out_img, str(image_path))

    image_sha256 = _sha256_file(image_path)
    image_bytes = image_path.stat().st_size

    # Independent readback: nonpadding source->saved voxel probes and
    # serialization-appropriate world-coordinate round trips.
    saved = nib.load(str(image_path))
    saved_data = np.asanyarray(saved.dataobj)
    _require(saved_data.dtype == crop.dtype, "saved dtype mismatch")
    _require(saved_data.shape == tuple(size), "saved shape mismatch")
    _require(np.array_equal(saved_data, crop), "saved voxel values differ from crop")
    _require(np.all(np.isfinite(saved.affine)), "saved affine not finite")
    _require(
        np.allclose(saved.affine, crop_affine, atol=1e-4),
        "saved affine differs after float32 serialization",
    )
    probe_indices = sorted(
        {
            (0, 0, 0),
            (size[0] - 1, size[1] - 1, size[2] - 1),
            (size[0] // 2, size[1] // 2, size[2] // 2),
        }
    )
    for probe in probe_indices:
        source_index = [start[axis] + probe[axis] for axis in range(3)]
        source_world = (source_affine @ np.array([*source_index, 1.0]))[:3]
        saved_world = (np.asarray(saved.affine, dtype=np.float64) @ np.array([*probe, 1.0]))[:3]
        _require(
            np.allclose(source_world, saved_world, atol=1e-3),
            f"world-coordinate round trip failed at probe {probe}",
        )
        _require(
            saved_data[probe] == source_data_ref_check(img, source_index),
            f"nonpadding voxel probe differs at source index {source_index}",
        )
    del saved_data

    manifest = {
        "version": 1,
        "image": {
            "filename": _IMAGE_FILENAME,
            "sha256": image_sha256,
            "bytes": image_bytes,
            "shape_xyz": [int(dim) for dim in size],
            "dtype": str(np.dtype(crop.dtype)),
            "spatial_units": units[0],
            "affine_ras": [[float(v) for v in row] for row in saved.affine],
        },
        "source_image_sha256": actual_hash,
        "crop": {"start_voxels": [int(v) for v in start], "size_voxels": [int(v) for v in size]},
        "source_provenance": json.loads(encoded),
        "clinical_validation": False,
        "application_installation": False,
        "selection_and_evidence_limits": {
            "selection": "reference-informed candidate context",
            "independent_localization": False,
            "stl_frame_units_validated": False,
            "stl_registration_validated": False,
            "annotation_validated_anatomy": False,
            "notes": [
                (
                    "Source calibration and selection provenance are supplied "
                    "by the trusted operator, not established by this function. "
                    "Declared units and voxel/world consistency do not validate "
                    "anatomy, STL units/frame or annotation registration."
                ),
                (
                    "This crop is not independent lesion localization and the "
                    "annotation is not validated anatomy."
                ),
            ],
        },
    }
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
        handle.write("\n")
    with open(manifest_path, encoding="utf-8") as handle:
        _require(json.load(handle) == manifest, "saved manifest readback differs")

    return {"image_path": image_path, "manifest_path": manifest_path, "manifest": manifest}


def source_data_ref_check(img, source_index):
    """Re-read one source voxel directly from disk (independent of crop)."""
    import numpy as np

    probe = np.asanyarray(img.dataobj[tuple(slice(int(i), int(i) + 1) for i in source_index)])
    return probe.reshape(()).item()
