"""Read-only historical catalog and case-bound label-range HTTP composition."""

import json

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from planner.device_checks import case_device_checks, device_catalog, encoded, validate_catalog

_NO_STORE = {"Cache-Control": "no-store"}
_PROVIDER_ERRORS = (
    AttributeError,
    KeyError,
    OSError,
    TypeError,
    ValueError,
    RuntimeError,
    OverflowError,
)


def register_device_routes(app, read_geometry, *, catalog_provider=device_catalog):
    """Reuse the trusted morphometry reader; no request may select paths/models."""

    def catalog():
        try:
            value = catalog_provider()
            validate_catalog(value)
            return value
        except _PROVIDER_ERRORS:
            raise HTTPException(503, "Device catalog is unavailable", headers=_NO_STORE) from None

    @app.get("/api/device-catalog")
    def get_catalog(request: Request):
        if request.query_params:
            raise HTTPException(422, "Device catalog accepts no selectors")
        return JSONResponse(catalog(), headers=_NO_STORE)

    @app.get("/api/cases/{case_id}/device-checks")
    def get_device_checks(case_id: str, request: Request):
        if request.query_params:
            raise HTTPException(422, "Device checks accept no selectors")
        try:
            installed = catalog()
            catalog_version = installed["catalog_version"]
            before = read_geometry(case_id)
            frozen = encoded(before)
            # Project the exact frozen value, never a provider's mutable alias.
            report = case_device_checks(json.loads(frozen), installed)
            after = read_geometry(case_id)
            installed_now = catalog()
            if encoded(after) != frozen or installed_now["catalog_version"] != catalog_version:
                raise HTTPException(
                    409,
                    "Geometry or catalog changed while reading device checks",
                    headers=_NO_STORE,
                )
            return JSONResponse(report, headers=_NO_STORE)
        except _PROVIDER_ERRORS:
            raise HTTPException(
                503, "Device checks are unavailable; no comparisons returned", headers=_NO_STORE
            ) from None
