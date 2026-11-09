"""Read-only source-bound anatomy input proposals, never implicit confirmations."""

import hashlib
import math
import sqlite3
from contextlib import closing
from pathlib import Path

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictFloat,
    StrictInt,
    ValidationError,
    field_validator,
    model_validator,
)
from starlette.concurrency import run_in_threadpool

from planner.geometry_server import GeometryComputeRequest, OperatorGeometryInputs
from planner.geometry_state import GeometryConflict, GeometryLedger
from planner.native_grid import native_voxel, trusted_grid
from planner.native_inputs import verified_bytes
from planner.physics_contract import encoded
from planner.planning_context import freeze
from planner.workspace import _connect

PROPOSAL_VERSION = "anatomy-input-proposal-v1"
_NO_STORE = {"Cache-Control": "no-store"}


class AnatomyProposalRequest(GeometryComputeRequest):
    target_ras: tuple[StrictFloat, StrictFloat, StrictFloat] | None = None

    @field_validator("target_ras")
    @classmethod
    def finite_target(cls, value):
        if value is not None and not all(math.isfinite(x) for x in value):
            raise ValueError("Target must be a finite physical point")
        return value


class ProposalDiagnostics(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    aneurysm_component_voxels: StrictInt = Field(ge=1, le=8_000_000)
    interface_voxel_count: StrictInt = Field(ge=3, le=100_000)
    neck_plane_rms_residual_mm: StrictFloat = Field(ge=0)
    parent_point_count: StrictInt = Field(ge=4, le=32)
    parent_length_mm: StrictFloat = Field(gt=0)
    target_component_selected: StrictBool
    grid_shape: tuple[StrictInt, StrictInt, StrictInt]

    @model_validator(mode="after")
    def consistent_counts(self):
        if (
            any(not 1 <= n <= 2048 for n in self.grid_shape)
            or math.prod(self.grid_shape) > 8_000_000
            or self.interface_voxel_count > self.aneurysm_component_voxels
        ):
            raise ValueError("Contradictory proposal grid or component counts")
        return self


def default_anatomy_runner():
    from planner.physics_worker import run_local_physics

    return run_local_physics


def register_anatomy_routes(app, db_path, sources, read_case, results_dir, runner=None):
    geometry = GeometryLedger(db_path)
    results_dir = Path(results_dir)

    def capture(case_id):
        case = freeze(read_case(case_id))
        bundle = sources.load_for_case(case)
        if case["spatial_units"] != "mm" or bundle[0]["spatial_units"] != "mm":
            raise HTTPException(409, "Confirmed millimeter CTA source is required")
        grid = trusted_grid(bundle)
        if grid["shape"] != case["dimensions"]:
            raise ValueError("Contradictory source dimensions")
        with closing(_connect(db_path)) as conn:
            conn.execute("BEGIN")
            current_case = geometry._case(conn, case_id)
            if (
                str(current_case["artifact_version"]) != case["artifact_version"]
                or current_case["image_sha256"] != case["image_sha256"]
            ):
                raise GeometryConflict("Case changed during anatomy snapshot")
            masks = {}
            for role in ("vessel", "aneurysm"):
                entry = conn.execute(
                    "SELECT * FROM segmentation_candidates WHERE case_id=? AND role=? "
                    "AND status='accepted' ORDER BY segmentation_revision DESC LIMIT 1",
                    (case_id, role),
                ).fetchone()
                if (
                    entry is None
                    or entry["image_sha256"] != case["image_sha256"]
                    or entry["reference_revision"] != bundle[1]
                ):
                    raise GeometryConflict("Accept current vessel and aneurysm masks first")
                if role == "aneurysm" and not geometry._volumetric_aneurysm(conn, entry):
                    raise GeometryConflict("A three-dimensional aneurysm model lineage is required")
                masks[role] = {
                    key: entry[key]
                    for key in ("candidate_id", "mask_sha256", "segmentation_revision")
                }
        # Freeze database metadata first, then perform bounded blob I/O without
        # retaining the snapshot's read lock. The worker and post-run capture
        # independently recheck the exact bytes and dependencies.
        for mask in masks.values():
            verified_bytes(
                results_dir / "blobs" / f"{mask['mask_sha256']}.nii.gz", mask["mask_sha256"]
            )
        identity = {key: case[key] for key in ("case_id", "image_sha256", "artifact_version")}
        identity["reference_revision"] = bundle[1]
        dependencies = {
            **{key: identity[key] for key in ("case_id", "image_sha256", "artifact_version")},
            "source_revision": bundle[1],
            "masks": masks,
            "calculation_version": PROPOSAL_VERSION,
        }
        return identity, dependencies, bundle[0]["source_id"], grid

    def generate(case_id, payload):
        from planner.segmentation_server import _INFERENCE_GATE

        before = capture(case_id)
        identity, dependencies, source_id, grid = before
        if (
            identity["artifact_version"] != payload.artifact_version
            or identity["reference_revision"] != payload.reference_revision
        ):
            raise GeometryConflict("Source changed before proposal")
        if payload.target_ras is not None:
            voxel = native_voxel(grid["affine"], payload.target_ras)
            if any(
                not math.isfinite(v) or not 0 <= v <= n - 1
                for v, n in zip(voxel, grid["shape"], strict=True)
            ):
                raise HTTPException(422, "Anatomy target is outside the source")
        job = {
            "kind": "anatomy-proposal",
            **identity,
            "source_id": source_id,
            "dependencies": dependencies,
            "target_ras": list(payload.target_ras) if payload.target_ras is not None else None,
        }
        if not _INFERENCE_GATE.acquire(blocking=False):
            raise HTTPException(429, "Another anatomy or geometry operation is running")
        try:
            raw = runner(job) if runner else default_anatomy_runner()(job, blob_dir=results_dir)
            result = freeze(raw)
            if len(encoded(result).encode()) > 32768:
                raise ValueError("Proposal output exceeds bound")
            required = {
                "inputs",
                "diagnostics",
                "method",
                "operator_confirmation_required",
                "proposal_version",
                "dependencies",
                "job_sha256",
            }
            if not isinstance(result, dict) or set(result) != required:
                raise ValueError("Invalid proposal envelope")
            if (
                result["operator_confirmation_required"] is not True
                or result["proposal_version"] != PROPOSAL_VERSION
                or result["dependencies"] != dependencies
                or result["method"] != "accepted_mask_anatomy_geometry_proposal"
                or result["job_sha256"] != hashlib.sha256(encoded(job).encode()).hexdigest()
            ):
                raise ValueError("Contradictory proposal evidence")
            inputs = OperatorGeometryInputs.model_validate(result["inputs"]).model_dump(mode="json")
            for point in (inputs["neck_origin"], inputs["aneurysm_seed"], *inputs["parent_path"]):
                voxel = native_voxel(grid["affine"], point)
                if any(
                    not math.isfinite(v) or not -1e-5 <= v <= n - 1 + 1e-5
                    for v, n in zip(voxel, grid["shape"], strict=True)
                ):
                    raise ValueError("Proposal point lies outside its source")
            diagnostics = ProposalDiagnostics.model_validate(result["diagnostics"]).model_dump(
                mode="json"
            )
            if (
                diagnostics["grid_shape"] != grid["shape"]
                or diagnostics["parent_point_count"] != len(inputs["parent_path"])
                or diagnostics["target_component_selected"] != (payload.target_ras is not None)
            ):
                raise ValueError("Proposal diagnostics contradict its source or inputs")
            result["inputs"] = inputs
            result["diagnostics"] = diagnostics
            if capture(case_id) != before:
                raise GeometryConflict("Anatomy changed during proposal")
            return {
                **identity,
                "proposal_id": hashlib.sha256(encoded(result).encode()).hexdigest(),
                "proposal": result,
            }
        finally:
            _INFERENCE_GATE.release()

    def guarded(case_id, payload):
        try:
            return generate(case_id, payload)
        except GeometryConflict:
            raise HTTPException(
                409, "Anatomy or source changed; reload before generating", headers=_NO_STORE
            ) from None
        except HTTPException:
            raise
        except (
            ValueError,
            TypeError,
            KeyError,
            OSError,
            RuntimeError,
            OverflowError,
            sqlite3.Error,
        ):
            raise HTTPException(
                503, "Anatomy proposal is unavailable; no inputs were confirmed", headers=_NO_STORE
            ) from None

    @app.post("/api/cases/{case_id}/anatomy-proposal")
    async def anatomy_proposal(case_id: str, request: Request):
        if request.query_params:
            raise HTTPException(422, "Anatomy proposals accept no source selectors")
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > 8192:
                raise HTTPException(413, "Anatomy proposal request exceeds bound")
        try:
            payload = AnatomyProposalRequest.model_validate_json(bytes(raw))
        except (ValueError, ValidationError):
            raise HTTPException(422, "Invalid anatomy proposal request") from None
        return JSONResponse(await run_in_threadpool(guarded, case_id, payload), headers=_NO_STORE)
