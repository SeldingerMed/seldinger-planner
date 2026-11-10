"""Local C-arm working-view API: explicit confirmation, bound to the case source."""

import math
import sqlite3

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from planner.native_grid import native_voxel, trusted_grid
from planner.planning_context import freeze
from planner.projection_plan import PlanConflict, PlanLedger, PlanRequest, validate_plan
from planner.projection_source import InstalledProjectionStore

MAX_BODY_BYTES = 65536


def register_projection_routes(app, db_path, sources, read_case):
    ledger = PlanLedger(db_path)

    def bound(case_id):
        case = freeze(read_case(case_id))
        if case["spatial_units"] != "mm":
            raise HTTPException(409, "Millimeter source required")
        bundle = sources.load_for_case(case)
        return {
            **{key: case[key] for key in ("case_id", "image_sha256", "artifact_version")},
            "reference_revision": bundle[1],
        }, trusted_grid(bundle)

    def in_grid(inputs, grid):
        for point in [inputs["isocenter"], *inputs["target_path"]]:
            voxel = native_voxel(grid["affine"], point)
            if any(
                not math.isfinite(v) or v < -1e-5 or v > n - 1 + 1e-5
                for v, n in zip(voxel, grid["shape"], strict=True)
            ):
                raise HTTPException(422, "Isocenter or target path is outside source")

    def read_once(case_id):
        identity, grid = bound(case_id)
        revision, current = ledger.current(identity)
        if current["status"] == "current":
            try:
                in_grid(current["inputs"], grid)
            except HTTPException as exc:
                raise HTTPException(503, "Projection plan source evidence unavailable") from exc
        return {**identity, "plan_revision": revision, "current": current}

    def read(case_id):
        try:
            before = freeze(read_once(case_id))
            after = freeze(read_once(case_id))
            if before != after:
                raise HTTPException(409, "Projection plan or source changed; reload")
            return before
        except PlanConflict:
            raise HTTPException(409, "Case changed; reload") from None
        except HTTPException:
            raise
        except (sqlite3.Error, ValueError, TypeError, KeyError, OSError, OverflowError) as exc:
            raise HTTPException(503, "Projection plan is unavailable; reload") from exc

    def save(case_id, payload):
        try:
            identity, grid = bound(case_id)
            if (
                identity["artifact_version"] != payload.artifact_version
                or identity["reference_revision"] != payload.reference_revision
            ):
                raise PlanConflict("Primary source changed")
            # Validate before the write boundary. Later failures may follow commit.
            try:
                inputs = validate_plan(payload.inputs.model_dump(mode="json"))
            except (ValueError, TypeError, KeyError, OverflowError):
                raise HTTPException(422, "Invalid confirmed C-arm views") from None
            in_grid(inputs, grid)
            after, _ = bound(case_id)
            if after != identity:
                raise PlanConflict("Primary source changed")
            plan_id, revision = ledger.save(identity, payload.plan_revision, inputs)
            result = read(case_id)
            if (
                result["plan_revision"] != revision
                or result["current"]["status"] != "current"
                or result["current"].get("plan_id") != plan_id
            ):
                raise PlanConflict("Acknowledgement changed")
            return result
        except PlanConflict:
            raise HTTPException(
                409, "Projection plan or source changed; reload before retrying"
            ) from None
        except HTTPException:
            raise
        except (sqlite3.Error, ValueError, TypeError, KeyError, OSError, OverflowError) as exc:
            raise HTTPException(503, "Projection plan save could not be confirmed; reload") from exc

    @app.get("/api/cases/{case_id}/projection-plan")
    def get_plan(case_id: str):
        return JSONResponse(read(case_id), headers={"Cache-Control": "no-store"})

    @app.put("/api/cases/{case_id}/projection-plan")
    async def put_plan(case_id: str, request: Request):
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > MAX_BODY_BYTES:
                raise HTTPException(413, "Projection plan request exceeds bound")
        try:
            payload = PlanRequest.model_validate_json(bytes(raw))
        except (ValidationError, ValueError):
            raise HTTPException(422, "Invalid projection plan request") from None
        return JSONResponse(
            await run_in_threadpool(save, case_id, payload), headers={"Cache-Control": "no-store"}
        )

    return read


def register_projection_series_routes(app, store=None):
    store = store or InstalledProjectionStore()

    @app.get("/api/projection-series/{source_id}")
    def projection_series(source_id: str):
        try:
            manifest, revision = store.load(source_id)
        except FileNotFoundError:
            raise HTTPException(404, "Projection series is not installed") from None
        except (OSError, ValueError, TypeError, KeyError, RecursionError):
            raise HTTPException(503, "Projection series failed integrity checks") from None
        return JSONResponse(
            {"source_id": source_id, "manifest_revision": revision, "manifest": manifest},
            headers={"Cache-Control": "no-store"},
        )

    return store
