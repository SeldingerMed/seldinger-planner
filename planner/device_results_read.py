"""Sizing result GET/read-service tracer on already-validated store envelopes."""

import json
import sqlite3

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from planner.device_calculation import DEVICE_SIZING_CALCULATION_VERSION
from planner.device_checks import case_device_checks, device_catalog, encoded, validate_catalog
from planner.device_inputs_state import DeviceInputsConflict
from planner.device_results_state import DeviceResultsConflict

_NO_STORE = {"Cache-Control": "no-store"}
_ERRORS = (OSError, RuntimeError, ValueError, TypeError, KeyError, AttributeError, sqlite3.Error)
_IDENTITY_KEYS = ("case_id", "image_sha256", "reference_revision", "artifact_version")


def _selectors(request):
    if request.query_params:
        raise HTTPException(422, "Device sizing accepts no selectors", headers=_NO_STORE)


def _conflict(detail):
    return HTTPException(409, detail, headers=_NO_STORE)


def _unavailable(detail):
    return HTTPException(503, detail, headers=_NO_STORE)


def register_device_result_read_routes(
    app, inputs, results, read_geometry, *, catalog_provider=device_catalog
):
    """Register GET /api/cases/{case_id}/device-sizing; return read_report(case_id)."""

    def read_frozen(case_id):
        try:
            geometry_token = encoded(read_geometry(case_id))
            geometry = json.loads(geometry_token)
            catalog = json.loads(encoded(catalog_provider()))
            validate_catalog(catalog)
            case_device_checks(geometry, catalog)
            if geometry["case_id"] != case_id:
                raise ValueError("Wrong provider case")
        except HTTPException as error:
            raise HTTPException(
                error.status_code, error.detail, headers={**(error.headers or {}), **_NO_STORE}
            ) from None
        except _ERRORS:
            raise _unavailable("Device sizing source is unavailable") from None
        return geometry, catalog, geometry_token, catalog["catalog_version"]

    def read_inputs(case_id, reference_revision):
        try:
            token = encoded(inputs.inputs(case_id, reference_revision))
            envelope = json.loads(token)
        except DeviceInputsConflict:
            raise _conflict("Input case changed") from None
        except _ERRORS:
            raise _unavailable("Stored operator inputs are unavailable") from None
        return envelope, encoded(envelope)

    def read_result(case_id, reference_revision, catalog_version):
        try:
            return json.loads(
                encoded(
                    results.current(
                        case_id,
                        reference_revision,
                        catalog_version,
                        DEVICE_SIZING_CALCULATION_VERSION,
                    )
                )
            )
        except DeviceResultsConflict:
            raise _conflict("Sizing result dependencies changed") from None
        except _ERRORS:
            raise _unavailable("Stored sizing result is unavailable") from None

    def compose(case_id, geometry, catalog, geometry_token, catalog_version):
        reference_revision = geometry["reference_revision"]
        inputs_envelope, inputs_token = read_inputs(case_id, reference_revision)
        result_envelope = read_result(case_id, reference_revision, catalog_version)
        if (
            not isinstance(inputs_envelope, dict)
            or inputs_envelope.get("status") not in ("current", "not_saved", "stale")
            or (
                inputs_envelope["status"] != "current"
                and inputs_envelope.get("measurements") is not None
            )
            or not isinstance(result_envelope, dict)
            or result_envelope.get("status") not in ("current", "not_computed", "stale")
            or (
                result_envelope["status"] != "current" and result_envelope.get("result") is not None
            )
        ):
            raise _unavailable("Stored sizing context is unavailable")
        current = geometry["current"]
        if inputs_envelope["status"] == "current" and (
            current["status"] != "current"
            or inputs_envelope["geometry_dependencies"] != current["dependencies"]
        ):
            raise _conflict("Operator input geometry changed; reload saved state")
        numeric_ready = (
            current["status"] == "current"
            and inputs_envelope["status"] == "current"
            and result_envelope["status"] == "current"
        )
        if result_envelope["status"] == "current":
            stored = result_envelope["result"]
            dependencies = result_envelope["dependencies"]
            expected = {
                "geometry": current["dependencies"],
                "geometry_result_id": current["result_id"],
                "input_revision": inputs_envelope["input_revision"],
                "inputs_sha256": inputs_envelope["inputs_sha256"],
                "catalog_version": catalog_version,
                "calculation_version": DEVICE_SIZING_CALCULATION_VERSION,
            }
            if not numeric_ready or any(dependencies.get(k) != v for k, v in expected.items()):
                raise _conflict("Sizing result context changed; reload saved state")
            if (
                stored.get("clinical_suitability_established") is not False
                or stored.get("validated_sizing") is not False
                or stored.get("binding_status") != "case_bound_calculation"
                or stored.get("catalog_version") != catalog_version
                or stored.get("calculation_version") != DEVICE_SIZING_CALCULATION_VERSION
            ):
                raise _unavailable("Stored sizing result is unavailable")
        # Reread the source/case and input context after reading the result so a
        # concurrent case/source/input change is rejected, never projected.
        _reread_geometry, reread_catalog, reread_geometry_token, reread_catalog_version = (
            read_frozen(case_id)
        )
        if (
            reread_geometry_token != geometry_token
            or reread_catalog_version != catalog_version
            or reread_catalog["catalog_version"] != catalog_version
        ):
            raise _conflict("Case or source changed; reload saved state")
        _, reread_inputs_token = read_inputs(case_id, reference_revision)
        if reread_inputs_token != inputs_token:
            raise _conflict("Operator inputs changed; reload saved state")
        return {
            **{key: geometry[key] for key in _IDENTITY_KEYS},
            "geometry_status": current["status"],
            "geometry_result_id": current["result_id"] if current["status"] == "current" else None,
            "geometry_dependencies": current["dependencies"]
            if current["status"] == "current"
            else None,
            "catalog_version": catalog_version,
            "calculation_version": DEVICE_SIZING_CALCULATION_VERSION,
            "inputs": inputs_envelope,
            "current": result_envelope,
            "clinical_suitability_established": False,
            "validated_sizing": False,
        }

    def read_report(case_id):
        try:
            geometry, catalog, geometry_token, catalog_version = read_frozen(case_id)
            return compose(case_id, geometry, catalog, geometry_token, catalog_version)
        except _ERRORS:
            raise _unavailable("Stored sizing context is unavailable") from None

    @app.get("/api/cases/{case_id}/device-sizing")
    def get_device_sizing(case_id: str, request: Request):
        _selectors(request)
        return JSONResponse(read_report(case_id), headers=_NO_STORE)

    return read_report
