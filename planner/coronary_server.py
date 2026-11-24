"""Routes for the CT coronary tree and its confirmed correspondence with a
paired cine. Both records are bound to the case's scan, artifact version
and reference revision; these routes read and change no other record."""

import sqlite3

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from planner.coronary_correspondence import (
    MAX_CORRESPONDENCE_BYTES,
    MAX_TREE_BYTES,
    CorrespondenceLedger,
    CorrespondenceRequest,
    TreeLedger,
    TreeRequest,
    check_against_tree,
    summarize,
    validate_correspondence,
    validate_tree,
)
from planner.native_grid import trusted_grid
from planner.planning_context import freeze
from planner.projection_plan import PlanConflict

_FAILURES = (
    sqlite3.Error,
    ValueError,
    TypeError,
    KeyError,
    OSError,
    OverflowError,
    RecursionError,
)
_NO_STORE = {"Cache-Control": "no-store"}


def register_coronary_routes(app, db_path, sources, read_case):
    trees = TreeLedger(db_path)
    records = CorrespondenceLedger(db_path)

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

    def same_source(identity, payload):
        if (
            identity["artifact_version"] != payload.artifact_version
            or identity["reference_revision"] != payload.reference_revision
        ):
            raise PlanConflict("Primary source changed")

    # The tree.

    def read_tree_once(case_id):
        identity, _ = bound(case_id)
        revision, current = trees.current(identity)
        return {**identity, "tree_revision": revision, "current": current}

    def read_tree(case_id):
        return twice(read_tree_once, case_id, "Coronary tree")

    def save_tree(case_id, payload):
        try:
            identity, grid = bound(case_id)
            same_source(identity, payload)
            try:
                export = validate_tree(
                    payload.export.model_dump(mode="json"), identity["image_sha256"], grid
                )
            except (ValueError, TypeError, KeyError, OverflowError) as exc:
                message = str(exc) if str(exc).startswith(("The tree", "A branch")) else None
                raise HTTPException(422, message or "Invalid tree") from None
            after, _ = bound(case_id)
            if after != identity:
                raise PlanConflict("Primary source changed")
            record_id, revision = trees.save(identity, payload.tree_revision, export)
            result = read_tree(case_id)
            if (
                result["tree_revision"] != revision
                or result["current"].get("record_id") != record_id
            ):
                raise PlanConflict("Acknowledgement changed")
            return result
        except PlanConflict:
            raise HTTPException(409, "Tree or source changed; reload before retrying") from None
        except HTTPException:
            raise
        except _FAILURES as exc:
            raise HTTPException(503, "Tree save could not be confirmed; reload") from exc

    @app.get("/api/cases/{case_id}/coronary-tree")
    def get_tree(case_id: str):
        return JSONResponse(read_tree(case_id), headers=_NO_STORE)

    @app.put("/api/cases/{case_id}/coronary-tree")
    async def put_tree(case_id: str, request: Request):
        raw = await body_of(request, MAX_TREE_BYTES, "Tree")
        try:
            payload = TreeRequest.model_validate_json(raw)
        except (ValidationError, ValueError):
            raise HTTPException(422, "Invalid tree") from None
        return JSONResponse(await run_in_threadpool(save_tree, case_id, payload), headers=_NO_STORE)

    # The confirmed correspondence.

    def evidence(identity, inputs):
        revision, tree = trees.current(identity)
        check_against_tree(inputs, revision, tree)

    def read_record_once(case_id):
        identity, _ = bound(case_id)
        revision, current = records.current(identity)
        if current["status"] == "current":
            inputs = current.pop("body")
            current = {**current, "inputs": inputs, "result": summarize(inputs)}
            try:
                evidence(identity, inputs)
                current["evidence"] = "verified"
            except _FAILURES:
                current["evidence"] = "unavailable"
        return {**identity, "correspondence_revision": revision, "current": current}

    def read_record(case_id):
        return twice(read_record_once, case_id, "Coronary correspondence")

    def save_record(case_id, payload):
        try:
            identity, _ = bound(case_id)
            same_source(identity, payload)
            try:
                inputs = validate_correspondence(payload.inputs.model_dump(mode="json"))
            except (ValueError, TypeError, KeyError, OverflowError):
                raise HTTPException(422, "Invalid confirmed correspondence") from None
            try:
                evidence(identity, inputs)
            except (ValueError, TypeError, KeyError, OverflowError):
                raise HTTPException(422, "Correspondence does not match the current tree") from None
            after, _ = bound(case_id)
            if after != identity:
                raise PlanConflict("Primary source changed")
            record_id, revision = records.save(identity, payload.correspondence_revision, inputs)
            result = read_record(case_id)
            if (
                result["correspondence_revision"] != revision
                or result["current"].get("record_id") != record_id
            ):
                raise PlanConflict("Acknowledgement changed")
            return result
        except PlanConflict:
            raise HTTPException(
                409, "Correspondence or source changed; reload before retrying"
            ) from None
        except HTTPException:
            raise
        except _FAILURES as exc:
            raise HTTPException(503, "Correspondence save could not be confirmed; reload") from exc

    @app.get("/api/cases/{case_id}/coronary-correspondence")
    def get_record(case_id: str):
        return JSONResponse(read_record(case_id), headers=_NO_STORE)

    @app.put("/api/cases/{case_id}/coronary-correspondence")
    async def put_record(case_id: str, request: Request):
        raw = await body_of(request, MAX_CORRESPONDENCE_BYTES, "Correspondence")
        try:
            payload = CorrespondenceRequest.model_validate_json(raw)
        except (ValidationError, ValueError):
            raise HTTPException(422, "Invalid confirmed correspondence") from None
        return JSONResponse(
            await run_in_threadpool(save_record, case_id, payload), headers=_NO_STORE
        )

    return read_record
