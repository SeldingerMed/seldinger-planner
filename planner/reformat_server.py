"""Local reformat-scene API: explicit confirmation and source-bound rigid registration."""

import math
import sqlite3

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from planner.native_grid import native_voxel, trusted_grid
from planner.planning_context import freeze
from planner.reformat_scene import SceneConflict, SceneLedger, SceneRequest


def register_reformat_routes(app, db_path, sources, read_case):
    ledger = SceneLedger(db_path)

    def bound(case_id):
        case = freeze(read_case(case_id))
        if case["spatial_units"] != "mm":
            raise HTTPException(409, "Millimeter source required")
        bundle = sources.load_for_case(case)
        return {
            **{key: case[key] for key in ("case_id", "image_sha256", "artifact_version")},
            "reference_revision": bundle[1],
        }, trusted_grid(bundle)

    def path_in_grid(inputs, grid):
        for point in inputs["path"]:
            voxel = native_voxel(grid["affine"], point)
            if any(
                not math.isfinite(v) or v < -1e-5 or v > n - 1 + 1e-5
                for v, n in zip(voxel, grid["shape"], strict=True)
            ):
                raise HTTPException(422, "Path is outside source")

    def secondary_metadata(inputs):
        secondary = inputs.get("secondary")
        if secondary is None:
            return None
        bundle = sources.load_public(secondary["source_id"])
        if (
            bundle[1] != secondary["reference_revision"]
            or bundle[0]["image"]["sha256"] != secondary["image_sha256"]
        ):
            raise SceneConflict("Secondary source changed")
        return freeze(sources.provider(secondary["source_id"]).metadata(bundle))

    def read_once(case_id):
        identity, grid = bound(case_id)
        revision, current = ledger.current(identity)
        secondary = None
        if current["status"] == "current":
            try:
                path_in_grid(current["inputs"], grid)
                secondary = secondary_metadata(current["inputs"])
            except SceneConflict:
                current = {
                    "status": "stale",
                    "scene_id": current["scene_id"],
                    "inputs": None,
                    "result": None,
                }
            except HTTPException as exc:
                raise HTTPException(503, "Scene source evidence unavailable") from exc
        return {
            **identity,
            "scene_revision": revision,
            "current": current,
            "secondary_metadata": secondary,
        }

    def read(case_id):
        try:
            before = freeze(read_once(case_id))
            after = freeze(read_once(case_id))
            if before != after:
                raise HTTPException(409, "Scene or source changed; reload")
            return before
        except SceneConflict:
            raise HTTPException(409, "Case changed; reload") from None
        except HTTPException:
            raise
        except (sqlite3.Error, ValueError, TypeError, KeyError, OSError, OverflowError) as exc:
            raise HTTPException(503, "Reformat scene is unavailable; reload") from exc

    def save(case_id, payload):
        try:
            identity, grid = bound(case_id)
            if (
                identity["artifact_version"] != payload.artifact_version
                or identity["reference_revision"] != payload.reference_revision
            ):
                raise SceneConflict("Primary source changed")
            inputs = payload.inputs.model_dump(mode="json")
            path_in_grid(inputs, grid)
            secondary_metadata(inputs)
            # Validate before the write boundary. Later failures may follow commit.
            from planner.reformat_scene import validate_scene

            try:
                inputs = validate_scene(inputs)
            except (ValueError, TypeError, KeyError, OverflowError):
                raise HTTPException(422, "Invalid confirmed path or rigid registration") from None
            after, _ = bound(case_id)
            if after != identity:
                raise SceneConflict("Primary source changed")
            secondary_metadata(inputs)
            scene_id, revision = ledger.save(identity, payload.scene_revision, inputs)
            result = read(case_id)
            if (
                result["scene_revision"] != revision
                or result["current"]["status"] != "current"
                or result["current"].get("scene_id") != scene_id
            ):
                raise SceneConflict("Acknowledgement changed")
            return result
        except SceneConflict:
            raise HTTPException(409, "Scene or source changed; reload before retrying") from None
        except HTTPException:
            raise
        except (sqlite3.Error, ValueError, TypeError, KeyError, OSError, OverflowError) as exc:
            raise HTTPException(503, "Scene save could not be confirmed; reload") from exc

    @app.get("/api/cases/{case_id}/reformat-scene")
    def get_scene(case_id: str):
        return JSONResponse(read(case_id), headers={"Cache-Control": "no-store"})

    @app.put("/api/cases/{case_id}/reformat-scene")
    async def put_scene(case_id: str, request: Request):
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > 65536:
                raise HTTPException(413, "Scene request exceeds bound")
        try:
            payload = SceneRequest.model_validate_json(bytes(raw))
        except (ValidationError, ValueError):
            raise HTTPException(422, "Invalid scene request") from None
        return JSONResponse(
            await run_in_threadpool(save, case_id, payload), headers={"Cache-Control": "no-store"}
        )

    return read
