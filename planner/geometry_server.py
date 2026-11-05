"""Case-bound operator geometry HTTP layer.

Narrow vertical slice per docs/plans/geometry-http-contract.md: clients may
only supply case/source versions and explicit operator geometry. The server
selects the image source, masks, dependencies and paths; the expensive job
runs behind the shared segmentation gate with an injectable runner (default:
lazily imported ``planner.geometry_worker.run_local_geometry``, so no ML or
heavy runtime is imported here). All failures are sanitized.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

from fastapi import HTTPException
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictFloat,
    StrictInt,
    field_validator,
    model_validator,
)

from planner.geometry_state import GeometryConflict, GeometryLedger

_RESULT_BYTES_CAP = 1048576
_REQUIRED_SECTIONS = ("sac", "neck", "proximal_parent", "distal_parent")


def default_geometry_runner():
    """Lazily import the geometry worker; this module stays ML-free."""
    from planner.geometry_worker import run_local_geometry

    return run_local_geometry


def _finite_vector3(value, label):
    if len(value) != 3 or not all(math.isfinite(float(x)) for x in value):
        raise ValueError(f"{label} must be three finite numbers")
    return value


class OperatorGeometryInputs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    neck_origin: tuple[StrictFloat, StrictFloat, StrictFloat]
    neck_normal: tuple[StrictFloat, StrictFloat, StrictFloat]
    aneurysm_seed: tuple[StrictFloat, StrictFloat, StrictFloat]
    parent_path: list[tuple[StrictFloat, StrictFloat, StrictFloat]] = Field(
        min_length=4, max_length=32
    )
    proximal_index: StrictInt
    distal_index: StrictInt

    @field_validator("neck_origin", "aneurysm_seed")
    @classmethod
    def _finite_tuple(cls, value):
        return _finite_vector3(value, "geometry point")

    @field_validator("neck_normal")
    @classmethod
    def _nonzero_normal(cls, value):
        if not all(math.isfinite(float(x)) for x in value):
            raise ValueError("neck_normal must be three finite numbers")
        norm = math.hypot(*value)
        if not math.isfinite(norm) or norm <= 0.0:
            raise ValueError("neck_normal must be nonzero")
        return tuple(v / norm for v in value)

    @field_validator("parent_path")
    @classmethod
    def _finite_path(cls, value):
        for point in value:
            _finite_vector3(point, "parent path point")
        return value

    @model_validator(mode="after")
    def validate_indices(self):
        last = len(self.parent_path) - 1
        for name, index in (
            ("proximal_index", self.proximal_index),
            ("distal_index", self.distal_index),
        ):
            if not 0 < index < last:
                raise ValueError(f"{name} must be an interior parent path index")
        if self.proximal_index == self.distal_index:
            raise ValueError("parent station indices must be distinct")
        return self


class GeometryComputeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    artifact_version: str = Field(min_length=1, max_length=20)
    reference_revision: str = Field(pattern=r"^[a-f0-9]{64}$")


class GeometryInputsRequest(GeometryComputeRequest):
    model_config = ConfigDict(extra="forbid")

    inputs: OperatorGeometryInputs


def _validate_metrics(metrics) -> dict:
    if not isinstance(metrics, dict):
        raise TypeError("geometry runner output must be an object")
    if metrics.get("spatial_units") != "mm":
        raise ValueError("geometry result spatial_units must be mm")
    if metrics.get("validated_morphometry") is not False:
        raise ValueError("geometry result validated_morphometry must be false")
    if metrics.get("clinical_validation") is not False:
        raise ValueError("geometry result clinical_validation must be false")
    for name in _REQUIRED_SECTIONS:
        if not isinstance(metrics.get(name), dict):
            raise TypeError(f"geometry result section {name} is missing")
    try:
        raw = json.dumps(metrics, allow_nan=False)
    except (TypeError, ValueError):
        raise ValueError("geometry result must be finite JSON") from None
    if len(raw.encode()) > _RESULT_BYTES_CAP:
        raise ValueError("geometry result exceeds the byte cap")
    return metrics


def _saved_inputs(ledger: GeometryLedger, case_id: str, source_revision: str):
    """Read only revision-bound inputs; never fall back to unbound coordinates."""
    try:
        return ledger.inputs(case_id, source_revision)
    except GeometryConflict:
        return None
    except (TypeError, ValueError, OSError, KeyError):
        raise HTTPException(503, "Stored geometry inputs could not be read") from None


def register_geometry_routes(app, ledger, sources, read_case, results_dir, runner=None):
    results_dir = Path(results_dir)
    results_dir.mkdir(mode=0o700, parents=True, exist_ok=True)

    def _bound_mm_source(case_id):
        case = read_case(case_id)
        bundle = sources.load_for_case(case)
        if bundle[0].get("spatial_units") != "mm" or case.get("spatial_units") != "mm":
            raise HTTPException(409, "Confirmed millimeter source geometry is required")
        return case, bundle

    def _bind_identity(case, bundle):
        return {
            "case_id": case["case_id"],
            "image_sha256": case["image_sha256"],
            "reference_revision": bundle[1],
            "artifact_version": str(case["artifact_version"]),
        }

    @app.put("/api/cases/{case_id}/morphometry-inputs")
    def save_morphometry_inputs(case_id: str, payload: GeometryInputsRequest):
        case, bundle = _bound_mm_source(case_id)
        revision = bundle[1]
        if case["artifact_version"] != payload.artifact_version:
            raise HTTPException(409, "Case revision changed")
        if revision != payload.reference_revision:
            raise HTTPException(409, "Reference revision changed")
        inputs = payload.inputs

        try:
            new_version = ledger.save_inputs(
                case_id, payload.artifact_version, revision, inputs.model_dump()
            )
        except GeometryConflict:
            raise HTTPException(409, "Operator geometry inputs could not be saved") from None
        return {
            "case_id": case["case_id"],
            "image_sha256": case["image_sha256"],
            "reference_revision": revision,
            "artifact_version": new_version,
            "operator_inputs": inputs.model_dump(),
        }

    @app.get("/api/cases/{case_id}/morphometry")
    def get_morphometry(case_id: str):
        case, bundle = _bound_mm_source(case_id)
        identity = _bind_identity(case, bundle)
        current = ledger.current(case_id, identity["reference_revision"])
        operator_inputs = _saved_inputs(ledger, case_id, identity["reference_revision"])
        case_now, bundle_now = _bound_mm_source(case_id)
        if _bind_identity(case_now, bundle_now) != identity:
            raise HTTPException(409, "Case or source changed while reading geometry")
        if current["status"] == "current":
            dependencies = current["dependencies"]
            expected = {
                "case_id": identity["case_id"],
                "image_sha256": identity["image_sha256"],
                "artifact_version": identity["artifact_version"],
                "source_revision": identity["reference_revision"],
            }
            if any(dependencies.get(k) != v for k, v in expected.items()):
                raise HTTPException(409, "Geometry result does not match the case snapshot")
        return {
            **identity,
            "operator_inputs": operator_inputs,
            "current": current,
        }

    @app.post("/api/cases/{case_id}/morphometry")
    def compute_morphometry(case_id: str, payload: GeometryComputeRequest):
        case, bundle = _bound_mm_source(case_id)
        revision = bundle[1]
        if case["artifact_version"] != payload.artifact_version:
            raise HTTPException(409, "Case revision changed")
        if revision != payload.reference_revision:
            raise HTTPException(409, "Reference revision changed")
        try:
            snapshot = ledger.snapshot(case_id, payload.artifact_version, revision)
        except GeometryConflict as error:
            raise HTTPException(409, str(error)) from None
        operator_inputs = _saved_inputs(ledger, case_id, revision)
        if operator_inputs is None:
            raise HTTPException(409, "Operator geometry inputs are missing for this source")
        from planner.segmentation_server import _INFERENCE_GATE

        if not _INFERENCE_GATE.acquire(blocking=False):
            raise HTTPException(429, "Another segmentation or geometry job is already running")
        try:
            job = {
                "case_id": case_id,
                "image_sha256": case["image_sha256"],
                "reference_revision": revision,
                "source_id": bundle[0]["source_id"],
                "dependencies": snapshot,
                "operator_inputs": operator_inputs,
            }
            try:
                raw_metrics = (
                    runner(job) if runner else default_geometry_runner()(job, blob_dir=results_dir)
                )
                metrics = _validate_metrics(raw_metrics)
            except (OSError, RuntimeError, ValueError, TypeError, KeyError):
                raise HTTPException(
                    503, "Geometry computation failed; no result was stored"
                ) from None
            case_now = read_case(case_id)
            revision_now = sources.load_for_case(case_now)[1]
            if (
                case_now["artifact_version"] != payload.artifact_version
                or case_now["image_sha256"] != case["image_sha256"]
                or revision_now != revision
            ):
                raise HTTPException(409, "Case or source changed during geometry computation")
            try:
                current = ledger.store(case_id, snapshot, metrics)
            except GeometryConflict:
                raise HTTPException(
                    409, "Geometry dependencies changed before persistence"
                ) from None
            return {
                **_bind_identity(case_now, (None, revision_now)),
                "operator_inputs": operator_inputs,
                "current": current,
            }
        finally:
            _INFERENCE_GATE.release()

    # Shared coherent reader for downstream read-only projections.
    return get_morphometry
