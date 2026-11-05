"""Case-bound sizing calculation routes, no image/model or external I/O."""

import sqlite3

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictStr
from starlette.concurrency import run_in_threadpool

from planner.device_calculation import calculate_reported_sizing
from planner.device_results_state import DeviceResultsConflict

_NO_STORE = {"Cache-Control": "no-store"}
_BODY_CAP = 4096
_ERRORS = (OSError, RuntimeError, ValueError, TypeError, KeyError, AttributeError, sqlite3.Error)


class DeviceCalculationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    artifact_version: StrictStr = Field(pattern=r"^[1-9][0-9]{0,19}$")
    reference_revision: StrictStr = Field(pattern=r"^[a-f0-9]{64}$")
    geometry_result_id: StrictStr = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    input_revision: StrictStr = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    inputs_sha256: StrictStr = Field(pattern=r"^[a-f0-9]{64}$")
    catalog_version: StrictStr = Field(pattern=r"^[a-f0-9]{64}$")
    calculation_version: StrictStr = Field(min_length=1, max_length=64)


async def _body(request):
    if request.query_params:
        raise HTTPException(422, "Device sizing accepts no selectors", headers=_NO_STORE)
    if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
        raise HTTPException(415, "JSON input is required", headers=_NO_STORE)
    length = request.headers.get("content-length")
    if length is not None:
        if not length.isascii() or not length.isdigit():
            raise HTTPException(400, "Invalid content length", headers=_NO_STORE)
        if len(length) > 20 or int(length) > _BODY_CAP:
            raise HTTPException(413, "Sizing request exceeds the byte cap", headers=_NO_STORE)
    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > _BODY_CAP:
            raise HTTPException(413, "Sizing request exceeds the byte cap", headers=_NO_STORE)
        raw.extend(chunk)
    try:
        return DeviceCalculationRequest.model_validate_json(raw).model_dump()
    except (ValueError, TypeError, OverflowError):
        raise HTTPException(422, "Invalid sizing calculation request", headers=_NO_STORE) from None


def register_device_calculation_routes(app, results, read_report):
    def calculate_impl(case_id: str, payload: dict):
        before = read_report(case_id)
        inputs = before["inputs"]
        expected = {
            k: before[k]
            for k in (
                "artifact_version",
                "reference_revision",
                "geometry_result_id",
                "catalog_version",
                "calculation_version",
            )
        }
        expected.update({k: inputs.get(k) for k in ("input_revision", "inputs_sha256")})
        if payload != expected:
            raise HTTPException(
                409, "Sizing context changed; reload saved state", headers=_NO_STORE
            )
        result = calculate_reported_sizing(inputs["measurements"], inputs["provenance"])
        result["binding_status"] = "case_bound_calculation"
        dependencies = {
            "geometry": before["geometry_dependencies"],
            "geometry_result_id": before["geometry_result_id"],
            "input_revision": inputs["input_revision"],
            "inputs_sha256": inputs["inputs_sha256"],
            "catalog_version": before["catalog_version"],
            "calculation_version": before["calculation_version"],
        }
        try:
            saved = results.store(case_id, dependencies, result)
        except DeviceResultsConflict:
            raise HTTPException(
                409, "Sizing dependencies changed; reload saved state", headers=_NO_STORE
            ) from None
        confirmed = read_report(case_id)
        if (
            confirmed["current"]["status"] != "current"
            or confirmed["current"].get("result_id") != saved["result_id"]
        ):
            raise HTTPException(
                409, "Sizing save could not be confirmed; reload saved state", headers=_NO_STORE
            )
        return JSONResponse(confirmed, headers=_NO_STORE)

    @app.post("/api/cases/{case_id}/device-sizing")
    async def calculate(case_id: str, request: Request):
        payload = await _body(request)
        try:
            return await run_in_threadpool(calculate_impl, case_id, payload)
        except HTTPException as error:
            raise HTTPException(
                error.status_code, error.detail, headers={**(error.headers or {}), **_NO_STORE}
            ) from None
        except _ERRORS:
            raise HTTPException(
                503,
                "Sizing calculation could not be confirmed; reload saved state",
                headers=_NO_STORE,
            ) from None
