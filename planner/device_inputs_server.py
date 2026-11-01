"""Case-bound operator-reported sizing input HTTP routes, no image/model I/O."""

import json
import sqlite3

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictStr, field_validator
from starlette.concurrency import run_in_threadpool

from planner.device_checks import case_device_checks, device_catalog, encoded
from planner.device_inputs_state import (
    DeviceInputsConflict,
    _normalize_measurements,
    _normalize_provenance,
)

_NO_STORE = {"Cache-Control": "no-store"}
_ERRORS = (OSError, RuntimeError, ValueError, TypeError, KeyError, AttributeError, sqlite3.Error)
_BODY_CAP = 8192


def _selectors(request):
    if request.query_params:
        raise HTTPException(422, "Device inputs accept no selectors", headers=_NO_STORE)


async def _body(request):
    _selectors(request)
    if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
        raise HTTPException(415, "JSON input is required", headers=_NO_STORE)
    length = request.headers.get("content-length")
    if length is not None:
        if not length.isascii() or not length.isdigit():
            raise HTTPException(400, "Invalid content length", headers=_NO_STORE)
        if len(length) > 20 or int(length) > _BODY_CAP:
            raise HTTPException(413, "Device input exceeds the byte cap", headers=_NO_STORE)
    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > _BODY_CAP:
            raise HTTPException(413, "Device input exceeds the byte cap", headers=_NO_STORE)
        raw.extend(chunk)
    try:
        return DeviceInputWrite.model_validate_json(raw)
    except (ValueError, TypeError, OverflowError):
        raise HTTPException(422, "Invalid operator input request", headers=_NO_STORE) from None


class DeviceInputWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")
    artifact_version: StrictStr = Field(min_length=1, max_length=20)
    reference_revision: StrictStr = Field(pattern=r"^[a-f0-9]{64}$")
    expected_input_revision: StrictStr | None = Field(default=None, min_length=1, max_length=64)
    measurements: dict
    provenance: dict

    @field_validator("measurements")
    @classmethod
    def measurements_valid(cls, value):
        return _normalize_measurements(value)

    @field_validator("provenance")
    @classmethod
    def provenance_valid(cls, value):
        return _normalize_provenance(value)


def register_device_input_routes(app, ledger, read_geometry):
    def read_frozen(case_id):
        try:
            token = encoded(read_geometry(case_id))
            geometry = json.loads(token)
            case_device_checks(geometry, device_catalog())
            if geometry["case_id"] != case_id:
                raise ValueError("Wrong provider case")
        except HTTPException as error:
            raise HTTPException(
                error.status_code, error.detail, headers={**(error.headers or {}), **_NO_STORE}
            ) from None
        except _ERRORS:
            raise HTTPException(
                503, "Device input source is unavailable", headers=_NO_STORE
            ) from None
        return geometry, token

    def confirm(case_id, token):
        if read_frozen(case_id)[1] != token:
            raise HTTPException(
                409, "Case or source changed; reload saved state", headers=_NO_STORE
            )

    def response(geometry, inputs):
        return JSONResponse(
            {
                **{
                    k: geometry[k]
                    for k in ("case_id", "image_sha256", "reference_revision", "artifact_version")
                },
                "geometry_status": geometry["current"]["status"],
                "inputs": inputs,
                "clinical_suitability_established": False,
                "validated_sizing": False,
            },
            headers=_NO_STORE,
        )

    def save_inputs_impl(case_id: str, payload: DeviceInputWrite):
        geometry, token = read_frozen(case_id)
        if (
            payload.artifact_version != geometry["artifact_version"]
            or payload.reference_revision != geometry["reference_revision"]
        ):
            raise HTTPException(409, "Case or source revision changed", headers=_NO_STORE)
        if geometry["current"]["status"] != "current":
            raise HTTPException(409, "Current native-mask geometry is required", headers=_NO_STORE)
        try:
            saved = ledger.save_inputs(
                case_id,
                geometry["current"]["dependencies"],
                payload.measurements,
                payload.provenance,
                payload.expected_input_revision,
            )
        except DeviceInputsConflict:
            raise HTTPException(
                409, "Operator input dependencies changed; reload saved state", headers=_NO_STORE
            ) from None
        except _ERRORS:
            raise HTTPException(
                503,
                "Operator input save could not be confirmed; reload saved state",
                headers=_NO_STORE,
            ) from None
        confirm(case_id, token)
        return response(geometry, saved)

    @app.put("/api/cases/{case_id}/device-sizing-inputs")
    async def save_inputs(case_id: str, request: Request):
        payload = await _body(request)
        return await run_in_threadpool(save_inputs_impl, case_id, payload)

    @app.get("/api/cases/{case_id}/device-sizing-inputs")
    def get_inputs(case_id: str, request: Request):
        _selectors(request)
        geometry, token = read_frozen(case_id)
        try:
            inputs = ledger.inputs(case_id, geometry["reference_revision"])
        except DeviceInputsConflict:
            raise HTTPException(409, "Input case changed", headers=_NO_STORE) from None
        except _ERRORS:
            raise HTTPException(
                503, "Stored operator inputs are unavailable", headers=_NO_STORE
            ) from None
        confirm(case_id, token)
        return response(geometry, inputs)
