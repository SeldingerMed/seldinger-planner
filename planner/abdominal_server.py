"""Routes for the aorta and iliac model and its bone line-up over a frame.

Both records are bound to the case's scan, artifact version and reference
revision, like the vessel registrations of Steps C1 to C4, which these
routes do not read or change.
"""

import math
import sqlite3

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from planner.abdominal_registration import (
    MAX_MODEL_BYTES,
    BoneLineupRequest,
    LineupLedger,
    ModelLedger,
    ModelRequest,
    check_plane,
    summarize,
    validate_lineup,
    validate_model,
)
from planner.frame_source import find_frame
from planner.native_grid import native_voxel, trusted_grid
from planner.planning_context import freeze
from planner.projection_plan import PlanConflict

MAX_LINEUP_BYTES = 65536
_FAILURES = (
    sqlite3.Error,
    ValueError,
    TypeError,
    KeyError,
    OSError,
    OverflowError,
    RecursionError,
)


def register_abdominal_routes(app, db_path, sources, read_case, frames):
    models = ModelLedger(db_path)
    lineups = LineupLedger(db_path)

    def bound(case_id):
        case = freeze(read_case(case_id))
        if case["spatial_units"] != "mm":
            raise HTTPException(409, "Millimeter source required")
        bundle = sources.load_for_case(case)
        return {
            **{key: case[key] for key in ("case_id", "image_sha256", "artifact_version")},
            "reference_revision": bundle[1],
        }, trusted_grid(bundle)

    def twice(read_once, case_id, what):
        try:
            before = freeze(read_once(case_id))
            after = freeze(read_once(case_id))
            if before != after:
                raise HTTPException(409, f"{what} or source changed; reload")
            return before
        except PlanConflict:
            raise HTTPException(409, "Case changed; reload") from None
        except HTTPException:
            raise
        except _FAILURES as exc:
            raise HTTPException(503, f"{what} is unavailable; reload") from exc

    async def body_of(request, bound_bytes, what):
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > bound_bytes:
                raise HTTPException(413, f"{what} request exceeds bound")
        return bytes(raw)

    # The model.

    def read_model_once(case_id):
        identity, _ = bound(case_id)
        revision, current = models.current(identity)
        return {**identity, "model_revision": revision, "current": current}

    def read_model(case_id):
        return twice(read_model_once, case_id, "Aorta and iliac model")

    def save_model(case_id, payload):
        try:
            identity, grid = bound(case_id)
            if (
                identity["artifact_version"] != payload.artifact_version
                or identity["reference_revision"] != payload.reference_revision
            ):
                raise PlanConflict("Primary source changed")
            try:
                export = validate_model(
                    payload.export.model_dump(mode="json"), identity["image_sha256"], grid
                )
            except (ValueError, TypeError, KeyError, OverflowError) as exc:
                message = str(exc) if str(exc).startswith("The model") else "Invalid model"
                raise HTTPException(422, message) from None
            after, _ = bound(case_id)
            if after != identity:
                raise PlanConflict("Primary source changed")
            record_id, revision = models.save(identity, payload.model_revision, export)
            result = read_model(case_id)
            if (
                result["model_revision"] != revision
                or result["current"].get("record_id") != record_id
            ):
                raise PlanConflict("Acknowledgement changed")
            return result
        except PlanConflict:
            raise HTTPException(409, "Model or source changed; reload before retrying") from None
        except HTTPException:
            raise
        except _FAILURES as exc:
            raise HTTPException(503, "Model save could not be confirmed; reload") from exc

    @app.get("/api/cases/{case_id}/aortoiliac-model")
    def get_model(case_id: str):
        return JSONResponse(read_model(case_id), headers={"Cache-Control": "no-store"})

    @app.put("/api/cases/{case_id}/aortoiliac-model")
    async def put_model(case_id: str, request: Request):
        raw = await body_of(request, MAX_MODEL_BYTES, "Model")
        try:
            payload = ModelRequest.model_validate_json(raw)
        except (ValidationError, ValueError):
            raise HTTPException(422, "Invalid model request") from None
        return JSONResponse(
            await run_in_threadpool(save_model, case_id, payload),
            headers={"Cache-Control": "no-store"},
        )

    # The line-up.

    def evidence(identity, grid, inputs):
        """Raise unless the model, the frames and the isocenter still back ``inputs``."""
        voxel = native_voxel(grid["affine"], inputs["isocenter"])
        if any(
            not math.isfinite(v) or v < -1e-5 or v > n - 1 + 1e-5
            for v, n in zip(voxel, grid["shape"], strict=True)
        ):
            raise ValueError("Isocenter is outside source")
        revision, model = models.current(identity)
        if (
            model["status"] != "current"
            or revision != inputs["model_revision"]
            or model["body_sha256"] != inputs["model_sha256"]
        ):
            raise ValueError("Aorta and iliac model changed")
        manifest, frame_revision = frames.load(inputs["frame_source_id"])
        if frame_revision != inputs["frame_manifest_revision"]:
            raise ValueError("Admitted frame changed")
        named = list(inputs["planes"])
        if inputs["second_view"]["status"] == "set_aside":
            named.append(inputs["second_view"])
        for entry in named:
            try:
                plane, frame = find_frame(manifest, entry["plane"], entry["frame_index"])
            except FileNotFoundError:
                # A frame the manifest does not list is the line-up's error,
                # not the store's.
                raise ValueError("Frame not in the admitted source") from None
            if frame["sha256"] != entry["frame_sha256"]:
                raise ValueError("Admitted frame changed")
            if "view" in entry:
                check_plane(entry, plane)
            frames.frame(inputs["frame_source_id"], entry["plane"], entry["frame_index"])

    def read_lineup_once(case_id):
        identity, grid = bound(case_id)
        revision, current = lineups.current(identity)
        if current["status"] == "current":
            inputs = current.pop("body")
            current = {**current, "inputs": inputs, "result": summarize(inputs)}
            try:
                evidence(identity, grid, inputs)
                current["evidence"] = "verified"
            except _FAILURES:
                current["evidence"] = "unavailable"
        return {**identity, "registration_revision": revision, "current": current}

    def read_lineup(case_id):
        return twice(read_lineup_once, case_id, "Bone line-up")

    def save_lineup(case_id, payload):
        try:
            identity, grid = bound(case_id)
            if (
                identity["artifact_version"] != payload.artifact_version
                or identity["reference_revision"] != payload.reference_revision
            ):
                raise PlanConflict("Primary source changed")
            try:
                inputs = validate_lineup(payload.inputs.model_dump(mode="json"))
            except (ValueError, TypeError, KeyError, OverflowError):
                raise HTTPException(422, "Invalid confirmed line-up") from None
            # A mismatch is the operator's to fix; a store that cannot be
            # read now is not, and falls through to "could not be confirmed".
            try:
                evidence(identity, grid, inputs)
            except (ValueError, TypeError, KeyError, OverflowError):
                raise HTTPException(
                    422, "Line-up does not match the admitted frames or the model"
                ) from None
            after, _ = bound(case_id)
            if after != identity:
                raise PlanConflict("Primary source changed")
            record_id, revision = lineups.save(identity, payload.registration_revision, inputs)
            result = read_lineup(case_id)
            if (
                result["registration_revision"] != revision
                or result["current"].get("record_id") != record_id
            ):
                raise PlanConflict("Acknowledgement changed")
            return result
        except PlanConflict:
            raise HTTPException(409, "Line-up or source changed; reload before retrying") from None
        except HTTPException:
            raise
        except _FAILURES as exc:
            raise HTTPException(503, "Line-up save could not be confirmed; reload") from exc

    @app.get("/api/cases/{case_id}/bone-lineup-registration")
    def get_lineup(case_id: str):
        return JSONResponse(read_lineup(case_id), headers={"Cache-Control": "no-store"})

    @app.put("/api/cases/{case_id}/bone-lineup-registration")
    async def put_lineup(case_id: str, request: Request):
        raw = await body_of(request, MAX_LINEUP_BYTES, "Line-up")
        try:
            payload = BoneLineupRequest.model_validate_json(raw)
        except (ValidationError, ValueError):
            raise HTTPException(422, "Invalid line-up request") from None
        return JSONResponse(
            await run_in_threadpool(save_lineup, case_id, payload),
            headers={"Cache-Control": "no-store"},
        )

    return read_lineup
