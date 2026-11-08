"""Decode bounded native masks from the exact bytes whose hashes were verified.

No imaging imports occur until the fixed worker invokes this loader. Paths are
server-owned configuration, not request values. Calibration is not validation.
"""

import gzip
import hashlib
import io
import math
import re
from pathlib import Path

from planner.physics_contract import ALGORITHM_VERSION, encoded

MAX_STORED_BYTES = 16 * 1024 * 1024
MAX_VOXELS = 8_000_000
MAX_RAW_BYTES = MAX_VOXELS * 4 + 65536 + 352


def verified_bytes(path, sha256):
    path = Path(path)
    if not isinstance(sha256, str) or re.fullmatch(r"[a-f0-9]{64}", sha256) is None:
        raise ValueError("Invalid native artifact hash")
    if path.is_symlink() or any(p.is_symlink() for p in path.parents) or not path.is_file():
        raise ValueError("Native artifact must be a regular nonsymlink file")
    with path.open("rb") as stream:
        payload = stream.read(MAX_STORED_BYTES + 1)
    if not 0 < len(payload) <= MAX_STORED_BYTES or hashlib.sha256(payload).hexdigest() != sha256:
        raise ValueError("Native artifact hash or size mismatch")
    return payload


def decode_bytes(payload):
    import nibabel as nib

    if payload[:2] == b"\x1f\x8b":
        try:
            with gzip.GzipFile(fileobj=io.BytesIO(payload)) as stream:
                raw = stream.read(MAX_RAW_BYTES + 1)
        except (EOFError, OSError):
            raise ValueError("Native artifact decompression failed") from None
    else:
        raw = payload
    if not 352 <= len(raw) <= MAX_RAW_BYTES:
        raise ValueError("Native artifact decompression bound exceeded")
    # Check shape before accessing data; malformed headers must not allocate
    # an unbounded array even if the compressed file itself is small.
    image = nib.Nifti1Image.from_bytes(raw)
    if (
        len(image.shape) != 3
        or any(n < 1 or n > 2048 for n in image.shape)
        or math.prod(image.shape) > MAX_VOXELS
    ):
        raise ValueError("Native artifact grid exceeds its bound")
    return image


def load_native_masks(job, *, blob_dir):
    from typing import Any, cast

    import numpy as np

    from planner.image_source import _validate_installed_nifti
    from planner.segmentation_worker import _source_bundle

    deps = job["dependencies"]
    if (
        deps["algorithm_version"] != ALGORITHM_VERSION
        or any(deps[k] != job[k] for k in ("case_id", "image_sha256", "artifact_version"))
        or deps["source_revision"] != job["reference_revision"]
    ):
        raise ValueError("Native job dependency identity mismatch")
    if job["kind"] != "centerline":
        operator_sha = hashlib.sha256(encoded(job["operator_inputs"]).encode()).hexdigest()
        if operator_sha != deps["geometry_dependencies"]["operator_sha256"]:
            raise ValueError("Native operator input identity mismatch")
    data, revision, source_path, units = _source_bundle(job)
    if (
        units != "mm"
        or revision != job["reference_revision"]
        or data["image"]["sha256"] != job["image_sha256"]
    ):
        raise ValueError("Native source identity or units mismatch")
    payload = verified_bytes(source_path, job["image_sha256"])
    _validate_installed_nifti(payload, data["image"])
    source = decode_bytes(payload)
    affine = np.asarray(source.affine, dtype=float)
    if (
        source.header.get_xyzt_units()[0] != "mm"
        or affine.shape != (4, 4)
        or not np.isfinite(affine).all()
        or not np.array_equal(affine[3], [0, 0, 0, 1])
        or not math.isfinite(float(np.linalg.det(affine)))
        or abs(float(np.linalg.det(affine))) < 1e-12
    ):
        raise ValueError("Invalid native source calibration")
    required = {"vessel"} if job["kind"] == "centerline" else {"vessel", "aneurysm"}
    if set(deps["masks"]) != required:
        raise ValueError("Unexpected native mask roles")
    arrays = {}
    for role in sorted(required):
        digest = deps["masks"][role]["mask_sha256"]
        if not isinstance(digest, str) or re.fullmatch(r"[a-f0-9]{64}", digest) is None:
            raise ValueError("Invalid native mask identity")
        mask = decode_bytes(verified_bytes(Path(blob_dir) / "blobs" / f"{digest}.nii.gz", digest))
        if (
            mask.shape != source.shape
            or not np.array_equal(cast(np.ndarray, mask.affine), affine)
            or mask.header.get_xyzt_units() != source.header.get_xyzt_units()
            or mask.get_data_dtype() != np.uint8
            or cast(Any, mask.dataobj).slope != 1
            or cast(Any, mask.dataobj).inter != 0
        ):
            raise ValueError("Native mask calibration or scalar type mismatch")
        array = np.asanyarray(mask.dataobj)
        if not np.isin(array, [0, 1]).all():
            raise ValueError("Native mask is not binary")
        arrays[role] = array.copy()
    return arrays, affine.copy()
