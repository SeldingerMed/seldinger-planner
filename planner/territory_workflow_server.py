"""Bounded, source-bound territory workflow routes."""

import math
import sqlite3

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import Field, StrictInt, ValidationError
from starlette.concurrency import run_in_threadpool

from planner.native_grid import native_voxel, trusted_grid
from planner.planning_context import freeze
from planner.territory_workflow_state import TerritoryWorkflowLedger, WorkflowConflict
from planner.territory_workflows import (
    Mode,
    StrictModel,
    compute_workflow,
    input_points,
    validate_inputs,
)

MAX_BODY_BYTES = 1_000_000
MAX_ANNOTATION_POINTS = 8192


class WorkflowRequest(StrictModel):
    artifact_version: str = Field(pattern=r"^[0-9]{1,20}$")
    reference_revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    workflow_revision: StrictInt = Field(ge=0, le=1_000_000_000)
    inputs: dict


def register_territory_workflow_routes(app, db_path, sources, read_case):
    ledger = TerritoryWorkflowLedger(db_path)

    def bound(case_id):
        case = freeze(read_case(case_id))
        if case["spatial_units"] != "mm":
            raise HTTPException(409, "A calibrated millimeter source is required")
        bundle = sources.load_for_case(case)
        identity = {k: case[k] for k in ("case_id", "image_sha256", "artifact_version")}
        identity["reference_revision"] = bundle[1]
        return identity, trusted_grid(bundle)

    def validate_points(inputs, grid):
        points = list(input_points(inputs))
        if len(points) > MAX_ANNOTATION_POINTS:
            raise HTTPException(422, "Annotation point count exceeds its bound")
        for point in points:
            native = native_voxel(grid["affine"], point)
            if any(
                not math.isfinite(v) or v < -1e-5 or v > n - 1 + 1e-5
                for v, n in zip(native, grid["shape"], strict=True)
            ):
                raise HTTPException(422, "Annotation is outside the source image")

    def read(case_id, mode):
        try:
            identity, grid = bound(case_id)
            revision, current = ledger.current(identity, mode)
            if current["status"] == "current":
                try:
                    validate_points(current["inputs"], grid)
                except HTTPException:
                    raise HTTPException(
                        503, "Saved workflow annotations failed integrity checks"
                    ) from None
            after, _ = bound(case_id)
            second_revision, second = ledger.current(after, mode)
            if after != identity or second_revision != revision or second != current:
                raise HTTPException(409, "Workflow changed; reload saved state")
            return {**identity, "mode": mode, "workflow_revision": revision, "current": current}
        except WorkflowConflict:
            raise HTTPException(409, "Case or workflow changed; reload saved state") from None
        except HTTPException:
            raise
        except (sqlite3.Error, ValueError, TypeError, KeyError, OSError, OverflowError) as exc:
            raise HTTPException(
                503, "Workflow evidence is unavailable; reload saved state"
            ) from exc

    def save(case_id, mode, payload):
        try:
            identity, grid = bound(case_id)
            if (
                identity["artifact_version"] != payload.artifact_version
                or identity["reference_revision"] != payload.reference_revision
            ):
                raise HTTPException(409, "Case or source changed; reload saved state")
            try:
                inputs = validate_inputs(mode, payload.inputs)
                validate_points(inputs, grid)
                result = compute_workflow(mode, inputs)
            except (ValueError, TypeError, KeyError, OverflowError):
                raise HTTPException(422, "Invalid workflow annotations") from None
            after, _ = bound(case_id)
            if after != identity:
                raise HTTPException(409, "Source changed; reload saved state")
            result_id, revision = ledger.save(
                identity, mode, payload.workflow_revision, inputs, result
            )
            response = read(case_id, mode)
            if (
                response["workflow_revision"] != revision
                or response["current"].get("result_id") != result_id
                or response["current"]["status"] != "current"
            ):
                raise HTTPException(409, "Workflow acknowledgement changed; reload saved state")
            return response
        except WorkflowConflict:
            raise HTTPException(409, "Case or workflow changed; reload saved state") from None
        except HTTPException:
            raise
        except (sqlite3.Error, ValueError, TypeError, KeyError, OSError, OverflowError) as exc:
            raise HTTPException(
                503, "Workflow acknowledgement unavailable; reload saved state"
            ) from exc

    @app.get("/api/cases/{case_id}/territory-workflows/{mode}")
    def get_workflow(case_id: str, mode: Mode):
        return JSONResponse(read(case_id, mode), headers={"Cache-Control": "no-store"})

    @app.put("/api/cases/{case_id}/territory-workflows/{mode}")
    async def put_workflow(case_id: str, mode: Mode, request: Request):
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > MAX_BODY_BYTES:
                raise HTTPException(413, "Workflow request exceeds its bound")
        try:
            payload = WorkflowRequest.model_validate_json(bytes(raw))
        except (ValidationError, ValueError):
            raise HTTPException(422, "Invalid workflow request") from None
        response = await run_in_threadpool(save, case_id, mode, payload)
        return JSONResponse(response, headers={"Cache-Control": "no-store"})

    return read
