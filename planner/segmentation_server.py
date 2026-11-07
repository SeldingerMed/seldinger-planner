"""Case-bound local segmentation endpoints. Metadata decisions live in the ledger.

Inference is executed by an injected runner (default: lazily imported
``planner.segmentation_worker.run_local_model``, so this module never imports
ML libraries at load time). Mask bytes are verified, content-addressed, and
installed atomically; only ledger metadata is ever returned to clients.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictFloat, StrictInt, field_validator

from planner.segmentation_state import SegmentationConflict, SegmentationLedger

_INFERENCE_GATE = threading.BoundedSemaphore(1)
_MASK_CAP = 16 * 1024 * 1024
_METADATA_CAP = 32768
_KIND_ROLE = {"vessel": "vessel", "sam2": "aneurysm", "aneurysm": "aneurysm"}
_KIND_PRODUCER = {
    "vessel": "owned_vessel",
    "sam2": "sam2_prompted_slice",
    "aneurysm": "aneurysm_model",
}


def default_runner():
    """Lazily import the worker writer's real entry point; no ML imports here."""
    from planner.segmentation_worker import run_local_model

    return run_local_model


class SegmentationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    artifact_version: str = Field(min_length=1, max_length=20)
    reference_revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    kind: Literal["vessel", "sam2", "aneurysm"]
    role: Literal["vessel", "aneurysm"]
    point_ras: list[StrictFloat] | None = None
    radius_voxels: StrictInt = Field(default=12, ge=2, le=40)
    display_window: tuple[StrictFloat, StrictFloat] = (0.0, 600.0)
    # Only opaque identity/point polarity are product inputs. Blob paths and
    # hashes are selected from the current case-owned accepted ledger record.
    base_candidate_id: str | None = Field(
        default=None, min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_-]+$"
    )
    point_label: StrictInt = Field(default=1, ge=0, le=1)

    @field_validator("point_ras")
    @classmethod
    def _finite_point(cls, value):
        if value is None:
            return None
        if len(value) != 3 or not all(type(x) in (int, float) and math.isfinite(x) for x in value):
            raise ValueError("point_ras must be three finite numbers")
        return [float(x) for x in value]

    @field_validator("display_window")
    @classmethod
    def _increasing_window(cls, value):
        if not all(math.isfinite(x) for x in value) or not value[0] < value[1]:
            raise ValueError("display_window must be finite and increasing")
        return [float(value[0]), float(value[1])]


class SegmentationDecisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    artifact_version: str = Field(min_length=1, max_length=20)
    reference_revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    decision: Literal["accept", "reject"]


def _sha256_file(path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _with_mask_url(entry: dict, case_id: str) -> dict:
    if entry is not None:
        entry["mask_url"] = f"/api/cases/{case_id}/segmentations/{entry['candidate_id']}/mask"
    return entry


def _install_blob(results_dir, staging: object) -> str:
    """Verify staging mask, return SHA-256, atomically install content-addressed blob."""
    expected = staging / "mask.nii.gz"
    if (
        expected.is_symlink()
        or not expected.is_file()
        or not 0 < expected.stat().st_size <= _MASK_CAP
    ):
        raise ValueError("Runner mask output failed integrity checks")
    digest = _sha256_file(expected)
    blobs = results_dir / "blobs"
    blobs.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = blobs / f"{digest}.nii.gz"
    if not target.exists():
        handle, temp_name = tempfile.mkstemp(dir=blobs, suffix=".tmp")
        try:
            with os.fdopen(handle, "wb") as temp, open(expected, "rb") as source:
                shutil.copyfileobj(source, temp)
            os.replace(temp_name, target)
        except BaseException:
            try:
                os.unlink(temp_name)
            except OSError:
                pass
            raise
        os.chmod(target, 0o600)
    return digest


def _read_bundle(references, case):
    return references.load_for_case(case)


def register_segmentation_routes(
    app,
    ledger: SegmentationLedger,
    references,
    read_case,
    results_dir,
    runner=None,
):
    results_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    (results_dir / ".staging").mkdir(mode=0o700, exist_ok=True)

    def _bound_case(case_id):
        case = read_case(case_id)
        bundle = _read_bundle(references, case)
        if case["image_sha256"] != bundle[0]["image"]["sha256"]:
            raise HTTPException(404, "Segmentation inference requires the reference-bound image")
        if case.get("spatial_units") != bundle[0]["spatial_units"]:
            raise HTTPException(409, "Case units do not match the installed source")
        dimensions = bundle[0].get("crop", {}).get("size_voxels")
        if (
            not isinstance(dimensions, list)
            or len(dimensions) != 3
            or any(type(v) is not int or v <= 0 for v in dimensions)
        ):
            raise HTTPException(503, "Installed source dimensions are unavailable")
        if case["dimensions"] != dimensions:
            raise HTTPException(409, "Case dimensions do not match the installed source")
        return case, bundle

    def _entry_or_error(case_id, candidate_id):
        try:
            return _with_mask_url(ledger.entry(case_id, candidate_id), case_id)
        except SegmentationConflict:
            raise HTTPException(409, "Candidate not available for this case") from None

    @app.post("/api/cases/{case_id}/segmentations")
    def create_segmentation(case_id: str, payload: SegmentationRequest):
        if payload.role != _KIND_ROLE[payload.kind]:
            raise HTTPException(
                422,
                "Role must match kind: the vessel kind produces the vessel role; "
                "sam2 and aneurysm kinds produce aneurysm previews",
            )
        if payload.kind == "sam2" and payload.point_ras is None:
            raise HTTPException(422, "SAM requests require point_ras")
        if payload.kind != "sam2" and (
            payload.base_candidate_id is not None or payload.point_label != 1
        ):
            raise HTTPException(422, "Mask correction and point polarity require the sam2 kind")
        case, bundle = _bound_case(case_id)
        revision = bundle[1]
        if case["artifact_version"] != payload.artifact_version:
            raise HTTPException(409, "Case revision changed")
        if revision != payload.reference_revision:
            raise HTTPException(409, "Reference revision changed")
        base_mask = None
        if (
            payload.kind == "sam2"
            and payload.base_candidate_id is None
            and ledger.current(case_id, role="aneurysm") is not None
        ):
            raise HTTPException(422, "Use the current accepted mask as the SAM correction base")
        if payload.base_candidate_id is not None:
            current = ledger.current(case_id, role=payload.role)
            if (
                current is None
                or current["candidate_id"] != payload.base_candidate_id
                or current["image_sha256"] != case["image_sha256"]
                or current["reference_revision"] != revision
            ):
                raise HTTPException(409, "Correction base is not the current case-owned mask")
            blob = results_dir / "blobs" / f"{current['mask_sha256']}.nii.gz"
            if (
                blob.is_symlink()
                or not blob.is_file()
                or not 0 < blob.stat().st_size <= _MASK_CAP
                or _sha256_file(blob) != current["mask_sha256"]
            ):
                raise HTTPException(503, "Correction base failed integrity checks")
            base_mask = {
                key: current[key]
                for key in (
                    "candidate_id",
                    "mask_sha256",
                    "image_sha256",
                    "reference_revision",
                    "segmentation_revision",
                    "producer",
                )
            }
        if not _INFERENCE_GATE.acquire(blocking=False):
            raise HTTPException(429, "Another segmentation request is already running")
        staging = None
        try:
            staging = Path(tempfile.mkdtemp(dir=results_dir / ".staging", prefix="attempt-"))
            job = {
                "artifact_version": payload.artifact_version,
                "reference_revision": revision,
                "kind": payload.kind,
                "role": payload.role,
                "point_ras": payload.point_ras,
                "radius_voxels": payload.radius_voxels,
                "display_window": payload.display_window,
                "case_id": case_id,
                "image_sha256": case["image_sha256"],
                "source_id": bundle[0]["source_id"],
            }
            if base_mask is not None:
                job["base_mask"] = base_mask
            job["point_label"] = payload.point_label
            try:
                result = (runner or default_runner())(job, staging)
                mask_path = result["mask_path"]
                metadata = result["metadata"]
                if mask_path != staging / "mask.nii.gz" or not isinstance(metadata, dict):
                    raise ValueError("Runner result shape is invalid")
                if len(json.dumps(metadata, allow_nan=False).encode()) > _METADATA_CAP:
                    raise ValueError("Runner metadata exceeds cap")
                mask_sha = _install_blob(results_dir, staging)
            except HTTPException:
                raise
            except (OSError, RuntimeError, ValueError, TypeError, KeyError):
                raise HTTPException(
                    503, "Segmentation inference failed; no candidate was accepted"
                ) from None
            case_now = read_case(case_id)
            revision_now = _read_bundle(references, case_now)[1]
            if (
                case_now["artifact_version"] != payload.artifact_version
                or case_now["image_sha256"] != case["image_sha256"]
                or revision_now != revision
            ):
                raise HTTPException(409, "Case or reference changed during inference")
            try:
                entry = ledger.preview(
                    case_id,
                    payload.artifact_version,
                    reference_revision=revision,
                    producer=_KIND_PRODUCER[payload.kind],
                    role=payload.role,
                    mask_sha256=mask_sha,
                    provenance=metadata,
                )
            except SegmentationConflict:
                raise HTTPException(409, "Case changed before candidate persistence") from None
            return _with_mask_url(entry, case_id)
        finally:
            if staging is not None:
                shutil.rmtree(staging, ignore_errors=True)
            _INFERENCE_GATE.release()

    @app.get("/api/cases/{case_id}/segmentations")
    def list_segmentations(case_id: str):
        read_case(case_id)
        current = {}
        for role in ("vessel", "aneurysm"):
            try:
                entry = ledger.current(case_id, role=role)
            except SegmentationConflict:
                raise HTTPException(404, "Case not found") from None
            current[role] = _with_mask_url(entry, case_id)
        return {"current": current}

    @app.post("/api/cases/{case_id}/segmentations/{candidate_id}/decision")
    def decide_segmentation(case_id: str, candidate_id: str, payload: SegmentationDecisionRequest):
        case = read_case(case_id)
        entry = _entry_or_error(case_id, candidate_id)
        if case["artifact_version"] != payload.artifact_version:
            raise HTTPException(409, "Case revision changed")
        if entry["reference_revision"] != payload.reference_revision:
            raise HTTPException(409, "Candidate reference revision does not match request")
        if _read_bundle(references, case)[1] != payload.reference_revision:
            raise HTTPException(409, "Reference revision changed")
        try:
            decided = ledger.decide(
                case_id, candidate_id, payload.artifact_version, payload.decision
            )
        except SegmentationConflict:
            raise HTTPException(409, "Decision refused; candidate or case state changed") from None
        decided.setdefault("artifact_version", payload.artifact_version)
        return _with_mask_url(decided, case_id)

    @app.get("/api/cases/{case_id}/segmentations/{candidate_id}/mask")
    def segmentation_mask(case_id: str, candidate_id: str):
        case = read_case(case_id)
        entry = _entry_or_error(case_id, candidate_id)
        if entry["status"] not in ("preview", "accepted"):
            raise HTTPException(404, "Mask is not available for this candidate")
        if entry["image_sha256"] != case["image_sha256"]:
            raise HTTPException(409, "Case image changed")
        if (
            entry["status"] == "preview"
            and entry["produced_artifact_version"] != case["artifact_version"]
        ):
            raise HTTPException(409, "Case changed; preview is stale")
        if _read_bundle(references, case)[1] != entry["reference_revision"]:
            if entry["status"] == "preview":
                raise HTTPException(409, "Reference revision changed; preview is stale")
            raise HTTPException(409, "Reference revision no longer matches this mask")
        blob = results_dir / "blobs" / f"{entry['mask_sha256']}.nii.gz"
        if blob.is_symlink() or not blob.is_file() or not 0 < blob.stat().st_size <= _MASK_CAP:
            raise HTTPException(404, "Mask blob is not available")
        if _sha256_file(blob) != entry["mask_sha256"]:
            raise HTTPException(503, "Mask blob failed integrity checks")
        from fastapi.responses import FileResponse

        return FileResponse(blob, media_type="application/gzip", filename="mask.nii.gz")

    @app.get("/api/cases/{case_id}/segmentations/{candidate_id}/surface")
    def segmentation_surface(case_id: str, candidate_id: str):
        from fastapi.responses import Response

        from planner.device_surface import build_surface

        case = read_case(case_id)
        if case["spatial_units"] != "mm":
            raise HTTPException(422, "Millimeter-calibrated source required for device scene")
        entry = _entry_or_error(case_id, candidate_id)
        if entry["status"] != "accepted":
            raise HTTPException(409, "Accept the mask before creating its planning surface")
        # Reuse the existing source/role/version/hash-bound mask guard chain.
        mask_response = segmentation_mask(case_id, candidate_id)
        try:
            data = build_surface(Path(mask_response.path), entry["mask_sha256"])
        except (OSError, RuntimeError, ValueError, subprocess.SubprocessError):
            raise HTTPException(503, "Native mask surface unavailable") from None
        after = _entry_or_error(case_id, candidate_id)
        if (
            read_case(case_id)["artifact_version"] != case["artifact_version"]
            or after["status"] != "accepted"
            or after["mask_sha256"] != entry["mask_sha256"]
            or after["reference_revision"] != entry["reference_revision"]
        ):
            raise HTTPException(409, "Anatomy changed while preparing surface")
        return Response(
            data,
            media_type="model/stl",
            headers={
                "Cache-Control": "no-store",
                "X-Mask-Sha256": entry["mask_sha256"],
                "X-Surface-Sha256": hashlib.sha256(data).hexdigest(),
            },
        )
