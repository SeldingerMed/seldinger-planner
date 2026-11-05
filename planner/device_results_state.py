"""Materialized device sizing results: immutable state tracer.

Pure software bookkeeping over already-validated operator inputs, geometry
and catalog identity. This layer infers no clinical validity and no device
selection; it only records and invalidates cached calculation envelopes.
"""

import json
import re
import secrets
from contextlib import closing

from planner.device_calculation import DEVICE_SIZING_CALCULATION_VERSION
from planner.device_inputs_state import DeviceInputsConflict, DeviceInputsLedger
from planner.geometry_state import GeometryConflict
from planner.workspace import _connect

DEVICE_RESULTS_VERSION = "materialized-device-results-v1"

_DEPENDENCY_KEYS = {
    "geometry",
    "geometry_result_id",
    "input_revision",
    "inputs_sha256",
    "catalog_version",
    "calculation_version",
}

_MAX_DEPENDENCIES_BYTES = 16 * 1024
_MAX_RESULT_BYTES = 64 * 1024

_SCHEMA = """
CREATE TABLE IF NOT EXISTS device_results (
 result_id TEXT PRIMARY KEY,
 case_id TEXT NOT NULL REFERENCES cases(case_id),
 dependencies TEXT NOT NULL,
 result TEXT NOT NULL,
 results_version TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""


class DeviceResultsConflict(ValueError):
    """Missing or changed case/device-result dependencies."""


def _encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _freeze(value, label, cap):
    """Canonical encode then re-parse so nothing later aliases caller state."""
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object")  # noqa: TRY004
    try:
        raw = _encoded(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} must be finite JSON: {error}") from error
    if len(raw.encode("utf-8")) > cap:
        raise ValueError(f"{label} exceeds {cap // 1024}KiB")
    return json.loads(raw)


def _require_text(value, label):
    if not isinstance(value, str) or not value:
        raise ValueError(f"Dependencies require a {label}")
    return value


def _normalize_dependencies(dependencies):
    frozen = _freeze(dependencies, "Dependencies", _MAX_DEPENDENCIES_BYTES)
    if set(frozen) != _DEPENDENCY_KEYS:
        raise ValueError(f"Dependencies require exactly {sorted(_DEPENDENCY_KEYS)}")
    geometry = frozen["geometry"]
    if (
        not isinstance(geometry, dict)
        or not isinstance(geometry.get("source_revision"), str)
        or not geometry["source_revision"]
    ):
        raise ValueError("Dependencies require geometry with a source_revision")
    _require_text(frozen["geometry_result_id"], "geometry_result_id")
    _require_text(frozen["input_revision"], "input_revision")
    _require_text(frozen["inputs_sha256"], "inputs_sha256")
    _require_text(frozen["catalog_version"], "catalog_version")
    _require_text(frozen["calculation_version"], "calculation_version")
    for key in ("catalog_version", "inputs_sha256"):
        if re.fullmatch(r"[a-f0-9]{64}", frozen[key]) is None:
            raise ValueError("Invalid data hash format")
    if frozen["calculation_version"] != DEVICE_SIZING_CALCULATION_VERSION:
        raise ValueError("Unsupported sizing calculation version")
    return frozen


def _validate_result(result, dependencies):
    frozen = _freeze(result, "Result", _MAX_RESULT_BYTES)
    if frozen.get("clinical_suitability_established") is not False:
        raise ValueError(
            "Result requires clinical_suitability_established == False; "
            "no clinical validity is established here"
        )
    if frozen.get("validated_sizing") is not False:
        raise ValueError("Result requires validated_sizing == False; sizing is not validated here")
    if frozen.get("binding_status") != "case_bound_calculation":
        raise ValueError('Result requires binding_status == "case_bound_calculation"')
    if any(
        frozen.get(key) != dependencies[key] for key in ("catalog_version", "calculation_version")
    ):
        raise ValueError("Sizing result metadata contradicts its dependencies")
    return frozen


def _empty_envelope(status):
    return {"status": status, "result": None}


class DeviceResultsLedger:
    """Immutable history of materialized device sizing results per case."""

    def __init__(self, db_path):
        self.db_path = db_path
        self.inputs = DeviceInputsLedger(db_path)
        self.geometry = self.inputs.geometry
        with closing(_connect(db_path)) as conn, conn:
            conn.executescript(_SCHEMA)

    def _live_dependencies(
        self, conn, case_id, source_revision, catalog_version, calculation_version
    ):
        """Recompute every dependency inside the caller's transaction."""
        try:
            capture = self.geometry._capture(conn, case_id, source_revision)
            row = conn.execute(
                "SELECT * FROM geometry_results WHERE case_id=? ORDER BY rowid DESC LIMIT 1",
                (case_id,),
            ).fetchone()
        except GeometryConflict as error:
            raise DeviceResultsConflict(str(error)) from error
        if row is None or json.loads(row["dependencies"]) != capture:
            raise DeviceResultsConflict("Current materialized geometry result is required")
        try:
            inputs = self.inputs.read_in_transaction(conn, case_id, source_revision)
        except DeviceInputsConflict as error:
            raise DeviceResultsConflict(str(error)) from error
        if (
            not isinstance(inputs, dict)
            or inputs.get("status") != "current"
            or inputs.get("geometry_dependencies") != capture
        ):
            raise DeviceResultsConflict("Current operator inputs are required")
        return {
            "geometry": capture,
            "geometry_result_id": row["result_id"],
            "input_revision": inputs["input_revision"],
            "inputs_sha256": inputs["inputs_sha256"],
            "catalog_version": catalog_version,
            "calculation_version": calculation_version,
        }

    def store(self, case_id, dependencies, result):
        deps = _normalize_dependencies(dependencies)
        frozen_result = _validate_result(result, deps)
        with closing(_connect(self.db_path)) as conn, conn:
            conn.execute("BEGIN IMMEDIATE")
            live = self._live_dependencies(
                conn,
                case_id,
                deps["geometry"]["source_revision"],
                deps["catalog_version"],
                deps["calculation_version"],
            )
            if live != deps:
                raise DeviceResultsConflict("Device result dependencies changed during persistence")
            result_id = secrets.token_urlsafe(16)
            conn.execute(
                "INSERT INTO device_results(result_id,case_id,dependencies,result,"
                "results_version) VALUES(?,?,?,?,?)",
                (
                    result_id,
                    case_id,
                    _encoded(deps),
                    _encoded(frozen_result),
                    DEVICE_RESULTS_VERSION,
                ),
            )
        return {
            "status": "current",
            "result_id": result_id,
            "dependencies": deps,
            "result": frozen_result,
        }

    def current(
        self,
        case_id,
        source_revision,
        catalog_version,
        calculation_version=DEVICE_SIZING_CALCULATION_VERSION,
    ):
        with closing(_connect(self.db_path)) as conn:
            conn.execute("BEGIN")
            try:
                self.geometry._case(conn, case_id)
            except GeometryConflict as error:
                raise DeviceResultsConflict(str(error)) from error
            row = conn.execute(
                "SELECT * FROM device_results WHERE case_id=? ORDER BY rowid DESC LIMIT 1",
                (case_id,),
            ).fetchone()
            if row is None:
                return _empty_envelope("not_computed")
            try:
                live = self._live_dependencies(
                    conn, case_id, source_revision, catalog_version, calculation_version
                )
            except DeviceResultsConflict:
                live = None
            if live is None or live != json.loads(row["dependencies"]):
                # Never resurrect older matching history rows, never expose old
                # numbers or dependencies after any dependency change.
                return {
                    "status": "stale",
                    "result_id": row["result_id"],
                    "result": None,
                    "stale_reasons": ["device_sizing_dependencies_changed"],
                }
            if row["results_version"] != DEVICE_RESULTS_VERSION:
                raise ValueError("Unsupported stored sizing result schema")
            return {
                "status": "current",
                "result_id": row["result_id"],
                "dependencies": _normalize_dependencies(json.loads(row["dependencies"])),
                "result": _validate_result(
                    json.loads(row["result"]), json.loads(row["dependencies"])
                ),
            }
