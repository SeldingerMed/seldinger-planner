"""Local vessel-presence report API: explicit confirmation, bound to one registration."""

import sqlite3

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from planner.planning_context import IDENTITY_KEYS, freeze
from planner.projection_plan import PlanConflict
from planner.vessel_presence import (
    PresenceLedger,
    PresenceRequest,
    binding,
    bound_to,
    validate_presence,
)

# Two planes of 2000 segments, with their counts, fit well inside this.
MAX_BODY_BYTES = 1_048_576
_FAILURES = (
    sqlite3.Error,
    ValueError,
    TypeError,
    KeyError,
    OSError,
    OverflowError,
    # A stored row nested too deeply to decode.
    RecursionError,
)


def register_vessel_presence_routes(app, db_path, read_registration):
    """Operator-confirmed vessel-presence reports. No pixels or coordinates are accepted.

    ``read_registration(case_id)`` is the registration reader's envelope.
    """
    ledger = PresenceLedger(db_path)

    def read_once(case_id):
        registration = freeze(read_registration(case_id))
        identity = {key: registration[key] for key in IDENTITY_KEYS}
        revision, current = ledger.current(identity, binding(registration))
        return {
            **identity,
            "registration_revision": registration["registration_revision"],
            "report_revision": revision,
            "current": current,
        }

    def read(case_id):
        try:
            before = freeze(read_once(case_id))
            after = freeze(read_once(case_id))
            if before != after:
                raise HTTPException(409, "Vessel presence report or registration changed; reload")
            return before
        except HTTPException:
            raise
        except _FAILURES as exc:
            raise HTTPException(503, "Vessel presence report is unavailable; reload") from exc

    def save(case_id, payload):
        try:
            registration = freeze(read_registration(case_id))
            identity = {key: registration[key] for key in IDENTITY_KEYS}
            if (
                identity["artifact_version"] != payload.artifact_version
                or identity["reference_revision"] != payload.reference_revision
            ):
                raise PlanConflict("Primary source changed")
            # Validate before the write boundary. Later failures may follow commit.
            try:
                inputs = validate_presence(payload.inputs.model_dump(mode="json"))
            except (ValueError, TypeError, KeyError, OverflowError):
                raise HTTPException(422, "Invalid confirmed vessel presence report") from None
            if inputs["registration_revision"] != registration["registration_revision"]:
                raise PlanConflict("Projection registration changed")
            if not bound_to(inputs, binding(registration)):
                raise HTTPException(422, "Report does not match the current registration")
            # A report is computed from the frame and the mask. Without them
            # on hand it cannot have been computed from what the record names.
            if registration["current"].get("evidence") != "verified":
                raise HTTPException(422, "The registration's frame or mask is unavailable")
            report_id, revision = ledger.save(identity, payload.report_revision, inputs)
            result = read(case_id)
            if (
                result["report_revision"] != revision
                or result["current"]["status"] != "current"
                or result["current"].get("report_id") != report_id
            ):
                raise PlanConflict("Acknowledgement changed")
            return result
        except PlanConflict:
            raise HTTPException(
                409, "Vessel presence report or registration changed; reload before retrying"
            ) from None
        except HTTPException:
            raise
        except _FAILURES as exc:
            raise HTTPException(
                503, "Vessel presence report save could not be confirmed; reload"
            ) from exc

    @app.get("/api/cases/{case_id}/vessel-presence")
    def get_presence(case_id: str):
        return JSONResponse(read(case_id), headers={"Cache-Control": "no-store"})

    @app.put("/api/cases/{case_id}/vessel-presence")
    async def put_presence(case_id: str, request: Request):
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > MAX_BODY_BYTES:
                raise HTTPException(413, "Vessel presence request exceeds bound")
        try:
            payload = PresenceRequest.model_validate_json(bytes(raw))
        except (ValidationError, ValueError):
            raise HTTPException(422, "Invalid vessel presence request") from None
        return JSONResponse(
            await run_in_threadpool(save, case_id, payload), headers={"Cache-Control": "no-store"}
        )

    return read
