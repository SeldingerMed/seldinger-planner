"""Confirmed, source-bound device alternatives with coherent local readback."""

import json
import sqlite3
from typing import Literal

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictInt, ValidationError, field_validator
from starlette.concurrency import run_in_threadpool

from planner.device_checks import encoded, validate_catalog
from planner.device_scenario_catalog import scenario_catalog
from planner.device_scenarios import DeviceScenarioConflict, validate_identity, validate_scenarios
from planner.geometry_state import GeometryConflict

_NO_STORE = {"Cache-Control": "no-store"}
_ERRORS = (ValueError, TypeError, KeyError, OSError, OverflowError, sqlite3.Error)


class ScenarioRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    image_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    artifact_version: str = Field(pattern=r"^[1-9][0-9]{0,19}$")
    reference_revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    geometry_result_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,100}$")
    catalog_version: str = Field(pattern=r"^[a-f0-9]{64}$")
    confirmed: Literal[True]
    scenario_revision: StrictInt = Field(ge=0, le=9223372036854775806)
    scenarios: list[dict] = Field(max_length=12)

    @field_validator("confirmed", mode="before")
    @classmethod
    def actual_confirmation(cls, value):
        if value is not True:
            raise ValueError("Explicit confirmation is required")
        return value


def register_device_scenario_routes(
    app, ledger, read_geometry, *, catalog_provider=scenario_catalog
):
    """Providers and catalog are trusted configuration, never request selectors."""

    def capture(case_id):
        # Independent parse prevents provider aliases changing while projected.
        geometry_token = encoded(read_geometry(case_id))
        geometry = json.loads(geometry_token)
        catalog_token = encoded(catalog_provider())
        catalog = json.loads(catalog_token)
        validate_catalog(catalog)
        current = geometry["current"]
        if current["status"] in ("not_computed", "stale"):
            raise HTTPException(409, "Confirm and compute current measurements first")
        if current["status"] != "current":
            raise ValueError("Unrecognized geometry readiness")
        identity = validate_identity(
            {
                **{
                    key: geometry[key]
                    for key in ("case_id", "image_sha256", "artifact_version", "reference_revision")
                },
                "geometry_result_id": current["result_id"],
                "catalog_version": catalog["catalog_version"],
            }
        )
        if identity["case_id"] != case_id:
            raise ValueError("Contradictory geometry identity")
        dependencies = current["dependencies"]
        expected = {
            "case_id": case_id,
            "image_sha256": identity["image_sha256"],
            "artifact_version": identity["artifact_version"],
            "source_revision": identity["reference_revision"],
        }
        if any(dependencies.get(key) != value for key, value in expected.items()):
            raise ValueError("Contradictory geometry dependencies")
        return identity, geometry_token, catalog_token

    def read(case_id):
        before = capture(case_id)
        state = json.loads(encoded(ledger.read(before[0])))
        after = capture(case_id)
        latest = json.loads(encoded(ledger.read(after[0])))
        if before != after or state != latest:
            raise DeviceScenarioConflict("Scenario or upstream source changed during read")
        return {**before[0], **state}

    def save(case_id, payload):
        before = capture(case_id)
        expected = {
            key: before[0][key]
            for key in (
                "image_sha256",
                "artifact_version",
                "reference_revision",
                "geometry_result_id",
                "catalog_version",
            )
        }
        if any(getattr(payload, key) != value for key, value in expected.items()):
            raise DeviceScenarioConflict("Scenario source changed before save")
        try:
            scenarios = validate_scenarios(payload.scenarios)
        except (ValueError, TypeError, OverflowError):
            # This 422 is definitively before persistence; later failures are not.
            raise HTTPException(422, "Invalid device alternative geometry") from None
        if capture(case_id) != before:
            raise DeviceScenarioConflict("Scenario source changed before persistence")
        saved = ledger.store(before[0], payload.scenario_revision, scenarios)
        result = read(case_id)
        if (
            any(result[key] != value for key, value in before[0].items())
            or result["scenario_revision"] != saved["scenario_revision"]
            or result["current"]["status"] != "current"
            or result["current"]["set_id"] != saved["current"]["set_id"]
            or result["current"]["scenarios_sha256"] != saved["current"]["scenarios_sha256"]
        ):
            raise DeviceScenarioConflict("Saved alternative acknowledgement changed")
        return result

    def guarded(function, *args):
        try:
            return function(*args)
        except (DeviceScenarioConflict, GeometryConflict):
            raise HTTPException(
                409, "Alternatives or source changed; reload before retrying", headers=_NO_STORE
            ) from None
        except HTTPException:
            raise
        except _ERRORS:
            raise HTTPException(
                503, "Device alternatives could not be confirmed; reload", headers=_NO_STORE
            ) from None

    def read_catalog():
        def snapshot():
            catalog = json.loads(encoded(catalog_provider()))
            if not isinstance(catalog, dict):
                raise TypeError("Invalid scenario catalog envelope")
            validate_catalog(catalog)
            return catalog

        before = snapshot()
        after = snapshot()
        if before != after:
            raise DeviceScenarioConflict("Device catalog changed during metadata read")
        return before

    @app.get("/api/device-scenario-catalog")
    def get_device_scenario_catalog(request: Request):
        """Authoritative renderer metadata handshake; trusted configuration only."""
        if request.query_params:
            raise HTTPException(
                422, "Device scenario catalog accepts no selectors", headers=_NO_STORE
            )
        return JSONResponse(guarded(read_catalog), headers=_NO_STORE)

    @app.get("/api/cases/{case_id}/device-scenarios")
    def get_scenarios(case_id: str, request: Request):
        if request.query_params:
            raise HTTPException(422, "Device alternatives accept no selectors")
        return JSONResponse(guarded(read, case_id), headers=_NO_STORE)

    @app.put("/api/cases/{case_id}/device-scenarios")
    async def put_scenarios(case_id: str, request: Request):
        if request.query_params:
            raise HTTPException(422, "Device alternatives accept no selectors")
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > 128 * 1024:
                raise HTTPException(413, "Device alternative request exceeds bound")
        try:
            payload = ScenarioRequest.model_validate_json(bytes(raw))
        except (ValidationError, ValueError):
            raise HTTPException(422, "Invalid confirmed device alternatives request") from None
        return JSONResponse(
            await run_in_threadpool(guarded, save, case_id, payload), headers=_NO_STORE
        )

    return lambda case_id: guarded(read, case_id)
