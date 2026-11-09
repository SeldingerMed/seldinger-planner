"""Optional-runtime anatomy proposal job adapter. No imaging imports here.

``compute_proposal_job`` is a pure job function: it re-verifies the exact
source and mask bytes against their declared SHA-256 identities, decodes them
through the shared bounded native loader, runs the existing anatomy proposal
helper on the admitted calibrated source, and re-verifies every byte again
before returning. The proposal is an operator-confirmation-required numerical
starting point — never a validated clinical measurement. The parent API and
physics supervisor own admission, lineage, and subprocess execution; paths
are trusted server configuration, never request values.
"""

import hashlib
import json
import re
from pathlib import Path
from typing import Any, cast

from planner.physics_contract import encoded

PROPOSAL_VERSION = "anatomy-input-proposal-v1"

_ID_PATTERN = r"[A-Za-z0-9_-]{1,80}"
_HASH_PATTERN = r"[a-f0-9]{64}"
_DEP_KEYS = {
    "case_id",
    "image_sha256",
    "artifact_version",
    "source_revision",
    "masks",
    "calculation_version",
}
_MASK_KEYS = {"candidate_id", "mask_sha256", "segmentation_revision"}


def _freeze(value):
    """Freeze an independent finite JSON snapshot, preserving the wire DTO."""
    return json.loads(encoded(value))


def _identity_text(value, label, limit=80):
    if not isinstance(value, str) or not 0 < len(value) <= limit:
        raise ValueError(f"{label} identity is not a bounded string")
    return value


def compute_proposal_job(job, *, blob_dir):
    """Verify native bytes and return one source-bound anatomy proposal."""
    import math

    import numpy as np

    from planner.anatomy_proposals import propose_aneurysm_inputs
    from planner.image_source import _validate_installed_nifti
    from planner.native_inputs import decode_bytes, verified_bytes
    from planner.segmentation_worker import _source_bundle

    if not isinstance(job, dict):
        raise TypeError("Job must be a JSON object")
    if set(job) != {
        "kind",
        "case_id",
        "image_sha256",
        "artifact_version",
        "reference_revision",
        "source_id",
        "dependencies",
        "target_ras",
    }:
        raise ValueError("Unexpected anatomy proposal job shape")
    if job.get("kind") != "anatomy-proposal":
        raise ValueError("Unsupported anatomy worker job kind")
    case_id = _identity_text(job.get("case_id"), "Case")
    if re.fullmatch(_ID_PATTERN, case_id) is None:
        raise ValueError("Case identity is not a bounded identifier")
    image_sha256 = _identity_text(job.get("image_sha256"), "Image hash", limit=64)
    if re.fullmatch(_HASH_PATTERN, image_sha256) is None:
        raise ValueError("Image identity is not a SHA-256 digest")
    artifact_version = _identity_text(job.get("artifact_version"), "Artifact")
    reference_revision = _identity_text(job.get("reference_revision"), "Reference")
    source_id = _identity_text(job.get("source_id"), "Source", limit=64)
    if re.fullmatch(r"[1-9][0-9]{0,19}", artifact_version) is None:
        raise ValueError("Invalid artifact version")
    if re.fullmatch(_HASH_PATTERN, reference_revision) is None:
        raise ValueError("Invalid source revision identity")
    if re.fullmatch(r"[a-z0-9][a-z0-9_-]{1,63}", source_id) is None:
        raise ValueError("Invalid registered source identity")
    target_ras = job.get("target_ras")
    if target_ras is not None:
        if not isinstance(target_ras, (list, tuple)) or len(target_ras) != 3:
            raise ValueError("Operator target must be three coordinates or absent")
        if any(
            type(value) not in (int, float)
            or not -1e308 <= value <= 1e308
            or not math.isfinite(value)
            for value in target_ras
        ):
            raise ValueError("Operator target must be three finite actual numbers")

    deps = job.get("dependencies")
    if not isinstance(deps, dict) or set(deps) != _DEP_KEYS:
        raise ValueError("Anatomy proposal dependency envelope shape mismatch")
    if (
        deps["case_id"] != case_id
        or deps["image_sha256"] != image_sha256
        or deps["artifact_version"] != artifact_version
        or deps["calculation_version"] != PROPOSAL_VERSION
        or _identity_text(deps["source_revision"], "Source revision", limit=128)
        != reference_revision
    ):
        raise ValueError("Anatomy proposal dependency identity mismatch")
    masks = deps["masks"]
    if not isinstance(masks, dict) or set(masks) != {"vessel", "aneurysm"}:
        raise ValueError("Unexpected anatomy proposal mask roles")
    mask_paths = {}
    for role in ("vessel", "aneurysm"):
        descriptor = masks[role]
        if not isinstance(descriptor, dict) or set(descriptor) != _MASK_KEYS:
            raise ValueError("Anatomy proposal mask descriptor shape mismatch")
        digest = descriptor["mask_sha256"]
        if not isinstance(digest, str) or re.fullmatch(_HASH_PATTERN, digest) is None:
            raise ValueError("Anatomy proposal mask identity mismatch")
        candidate_id = descriptor["candidate_id"]
        if not isinstance(candidate_id, str) or re.fullmatch(_ID_PATTERN, candidate_id) is None:
            raise ValueError("Anatomy proposal candidate identity mismatch")
        revision = descriptor["segmentation_revision"]
        if type(revision) is not int or revision < 1:
            raise ValueError("Anatomy proposal segmentation revision must be positive")
        mask_paths[role] = (
            Path(blob_dir) / "blobs" / f"{digest}.nii.gz",
            digest,
        )

    # Resolve only the registered opaque source identity; never job paths.
    data, revision, source_path, units = _source_bundle(job)
    manifest_image = data.get("image") if isinstance(data, dict) else None
    if (
        units != "mm"
        or not isinstance(manifest_image, dict)
        or manifest_image.get("sha256") != image_sha256
        or revision != reference_revision
    ):
        raise ValueError("Anatomy proposal source identity or units mismatch")
    source_payload = verified_bytes(source_path, image_sha256)
    _validate_installed_nifti(source_payload, manifest_image)
    source = decode_bytes(source_payload)
    affine = np.asarray(source.affine, dtype=float)
    if (
        len(source.shape) != 3
        or source.header.get_xyzt_units()[0] != "mm"
        or tuple(int(v) for v in source.shape) != tuple(manifest_image["shape_xyz"])
        or affine.shape != (4, 4)
        or not np.isfinite(affine).all()
        or not np.array_equal(affine[3], [0, 0, 0, 1])
        or not math.isfinite(float(np.linalg.det(affine)))
        or abs(float(np.linalg.det(affine))) < 1e-12
    ):
        raise ValueError("Invalid anatomy proposal source calibration or grid")

    arrays = {}
    for role in ("vessel", "aneurysm"):
        mask_path, digest = mask_paths[role]
        mask_payload = verified_bytes(mask_path, digest)
        mask = decode_bytes(mask_payload)
        if (
            mask.shape != source.shape
            or not np.array_equal(np.asarray(mask.affine, dtype=float), affine)
            or mask.header.get_xyzt_units() != source.header.get_xyzt_units()
            or mask.get_data_dtype() != np.uint8
            or cast(Any, mask.dataobj).slope != 1
            or cast(Any, mask.dataobj).inter != 0
        ):
            raise ValueError("Anatomy proposal mask grid, units or scaling mismatch")
        array = np.asanyarray(mask.dataobj)
        if not np.isin(array, [0, 1]).all():
            raise ValueError("Anatomy proposal mask is not binary")
        arrays[role] = array.copy()

    proposal = propose_aneurysm_inputs(
        arrays["vessel"],
        arrays["aneurysm"],
        affine,
        spatial_units="mm",
        target_ras=target_ras,
    )

    # A changed source or mask cannot publish under its old identity.
    verified_bytes(source_path, image_sha256)
    for role in ("vessel", "aneurysm"):
        mask_path, digest = mask_paths[role]
        verified_bytes(mask_path, digest)

    result = {
        key: proposal[key]
        for key in ("inputs", "diagnostics", "method", "operator_confirmation_required")
    }
    result.update(
        proposal_version=PROPOSAL_VERSION,
        dependencies=_freeze(deps),
        job_sha256=hashlib.sha256(encoded(job).encode()).hexdigest(),
    )
    encoded(result)
    return result
