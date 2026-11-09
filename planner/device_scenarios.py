"""Immutable device-scenario sets with a per-case revision ledger.

Software bookkeeping over operator-entered procedural device geometry
mirroring web/src/devices/scenarios.ts placement shape. This layer infers
no clinical validity and no device selection; it only freezes and
invalidates bounded scenario batches against current case geometry.
"""

import hashlib
import json
import math
import re
import secrets
from contextlib import closing
from typing import TypeGuard

from planner.geometry_state import GeometryConflict, GeometryLedger
from planner.workspace import _connect

DEVICE_SCENARIOS_VERSION = "device-scenario-sets-v1"

_IDENTITY_KEYS = {
    "case_id",
    "image_sha256",
    "artifact_version",
    "reference_revision",
    "geometry_result_id",
    "catalog_version",
}
_SHA_PATTERN = re.compile(r"[a-f0-9]{64}")
_ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{10,80}")
_CONTROL_PATTERN = re.compile(r"[\x00-\x1f\x7f]")

_MAX_SCENARIO_BYTES = 128 * 1024
_MAX_COORDINATE_TRIPLES = 2048
_MAX_BATCH = 12
_MAX_TEXT_ID = 100
_MAX_DIMENSION = 1000.0
_MAX_COORDINATE = 100000.0


class DeviceScenarioConflict(ValueError):
    """Missing or changed case/scenario dependencies."""


def _encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _finite_number(value: object) -> TypeGuard[int | float]:
    """Reject booleans and numeric strings; require finite real numbers."""
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and -1e308 <= value <= 1e308
        and math.isfinite(value)
    )


def _require_text(value, label, max_length=None):
    if not isinstance(value, str) or not value:
        raise ValueError(f"Identity requires a {label}")
    if max_length is not None and len(value) > max_length:
        raise ValueError(f"Identity {label} is too long")
    return value


def validate_identity(identity):
    if not isinstance(identity, dict) or set(identity) != _IDENTITY_KEYS:
        raise ValueError(f"Identity requires exactly {sorted(_IDENTITY_KEYS)}")
    case_id = _require_text(identity["case_id"], "case_id", _MAX_TEXT_ID)
    if re.fullmatch(r"[A-Za-z0-9_-]{1,100}", case_id) is None:
        raise ValueError("Invalid case identity")
    for key in ("image_sha256", "reference_revision", "catalog_version"):
        _require_text(identity[key], key)
        if _SHA_PATTERN.fullmatch(identity[key]) is None:
            raise ValueError(f"Identity {key} must be lowercase 64-hex")
    version = _require_text(identity["artifact_version"], "artifact_version")
    if re.fullmatch(r"[1-9][0-9]{0,19}", version) is None:
        raise ValueError("Identity artifact_version must be a bounded positive numeric string")
    geometry_id = _require_text(identity["geometry_result_id"], "geometry_result_id", _MAX_TEXT_ID)
    if re.fullmatch(r"[A-Za-z0-9_-]{1,100}", geometry_id) is None:
        raise ValueError("Invalid geometry result identity")
    return dict(identity)


def _validate_triple(value, label):
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise ValueError(f"Placement {label} must be a 3-tuple")
    for coordinate in value:
        if not _finite_number(coordinate) or abs(coordinate) >= _MAX_COORDINATE:
            raise ValueError(f"Placement {label} coordinates must be finite and bounded")
    return [float(coordinate) for coordinate in value]


_PLACEMENT_DIMENSIONS = ("diameter", "length", "height", "coilLength")


def validate_placement(raw):
    if not isinstance(raw, dict):
        raise ValueError("Placement must be an object")  # noqa: TRY004
    allowed = {
        "deviceId",
        "diameter",
        "length",
        "height",
        "center",
        "axis",
        "path",
        "offset",
        "roll",
        "coilLength",
        "braidAngle",
    }
    if set(raw) - allowed or not {
        "deviceId",
        *(_PLACEMENT_DIMENSIONS),
        "center",
        "axis",
        "path",
        "offset",
        "roll",
    } <= set(raw):
        raise ValueError("Placement keys are invalid")
    device_id = raw["deviceId"]
    if not isinstance(device_id, str) or not device_id or len(device_id) >= 100:
        raise ValueError("Placement requires a bounded deviceId string")
    for key in _PLACEMENT_DIMENSIONS:
        value = raw[key]
        if not _finite_number(value) or not 0 < value <= _MAX_DIMENSION:
            raise ValueError(f"Placement {key} must be a positive number <= 1000")
    for key in ("offset", "roll"):
        value = raw[key]
        if not _finite_number(value) or abs(value) > (100 if key == "offset" else 360):
            raise ValueError(f"Placement {key} is out of range")
    center = _validate_triple(raw["center"], "center")
    axis = _validate_triple(raw["axis"], "axis")
    if math.sqrt(sum(component * component for component in axis)) <= 1e-6:
        raise ValueError("Placement axis must be a nonzero direction")
    path = raw["path"]
    if not isinstance(path, (list, tuple)) or not 2 <= len(path) <= 64:
        raise ValueError("Placement path must hold 2..64 triples")
    placement = {
        "deviceId": device_id,
        "diameter": float(raw["diameter"]),
        "length": float(raw["length"]),
        "height": float(raw["height"]),
        "center": center,
        "axis": axis,
        "path": [_validate_triple(point, "path point") for point in path],
        "offset": float(raw["offset"]),
        "roll": float(raw["roll"]),
        "coilLength": float(raw["coilLength"]),
    }
    braid_angle = raw.get("braidAngle")
    if "braidAngle" in raw:
        if not _finite_number(braid_angle) or not 35 <= braid_angle <= 75:
            raise ValueError("Placement braidAngle must be 35..75 when present")
        placement["braidAngle"] = float(braid_angle)
    return placement


def validate_scenarios(raw):
    """Validate a 0..12 scenario batch and return its frozen canonical form."""
    if not isinstance(raw, (list, tuple)):
        raise ValueError("Scenarios must be a list")  # noqa: TRY004
    if len(raw) > _MAX_BATCH:
        raise ValueError(f"At most {_MAX_BATCH} scenarios per batch")
    frozen = []
    triples = 0
    seen_ids = set()
    for entry in raw:
        if not isinstance(entry, dict) or set(entry) != {"id", "name", "placement"}:
            raise ValueError("Scenario requires exactly id, name and placement")
        scenario_id = entry["id"]
        if not isinstance(scenario_id, str) or _ID_PATTERN.fullmatch(scenario_id) is None:
            raise ValueError("Scenario id must match [A-Za-z0-9_-]{10,80}")
        if scenario_id in seen_ids:
            raise ValueError("Scenario ids must be unique per batch")
        seen_ids.add(scenario_id)
        name = entry["name"]
        if not isinstance(name, str) or not 1 <= len(name) <= 80:
            raise ValueError("Scenario name must be 1..80 characters")
        if _CONTROL_PATTERN.search(name) is not None:
            raise ValueError("Scenario name must not contain control characters")
        placement = validate_placement(entry["placement"])
        triples += 2 + len(placement["path"])
        frozen.append({"id": scenario_id, "name": name, "placement": placement})
    if triples > _MAX_COORDINATE_TRIPLES:
        raise ValueError(f"At most {_MAX_COORDINATE_TRIPLES} coordinate triples per batch")
    try:
        encoded = _encoded(frozen)
    except (TypeError, ValueError) as error:
        raise ValueError(f"Scenarios must be finite JSON: {error}") from error
    if len(encoded.encode("utf-8")) > _MAX_SCENARIO_BYTES:
        raise ValueError(f"Scenarios exceed {_MAX_SCENARIO_BYTES // 1024}KiB")
    return json.loads(encoded)


def _validate_stored_scenarios(raw, digest):
    """Latest-row integrity check: corrupt JSON/digest/shape is ValueError."""
    if not isinstance(raw, str) or not isinstance(digest, str):
        raise ValueError("Corrupt stored device scenarios")  # noqa: TRY004
    if hashlib.sha256(raw.encode("utf-8")).hexdigest() != digest:
        raise ValueError("Stored device scenario digest mismatch")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ValueError("Corrupt stored device scenario JSON") from error
    return validate_scenarios(parsed)


_SCHEMA = """
CREATE TABLE IF NOT EXISTS device_scenario_sets (
 set_id TEXT PRIMARY KEY,
 case_id TEXT NOT NULL REFERENCES cases(case_id),
 identity TEXT NOT NULL,
 dependencies TEXT NOT NULL,
 scenario_revision INTEGER NOT NULL,
 scenarios TEXT NOT NULL,
 scenarios_sha256 TEXT NOT NULL,
 scenarios_version TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""


class DeviceScenarioLedger:
    """Immutable per-case scenario sets; independent monotonically
    increasing per-case scenario revision."""

    def __init__(self, db_path):
        self.db_path = db_path
        self.geometry = GeometryLedger(db_path)
        with closing(_connect(db_path)) as conn, conn:
            conn.executescript(_SCHEMA)

    def _latest_row(self, conn, case_id):
        return conn.execute(
            "SELECT * FROM device_scenario_sets WHERE case_id=? ORDER BY rowid DESC LIMIT 1",
            (case_id,),
        ).fetchone()

    def _live_identity(self, conn, identity):
        """Reverify case and latest materialized geometry inside the
        caller's transaction, mirroring GeometryLedger._capture."""
        case = self.geometry._case(conn, identity["case_id"])
        if case["image_sha256"] != identity["image_sha256"]:
            raise DeviceScenarioConflict("Case image changed")
        if str(case["artifact_version"]) != identity["artifact_version"]:
            raise DeviceScenarioConflict("Case artifact version changed")
        try:
            capture = self.geometry._capture(
                conn, identity["case_id"], identity["reference_revision"]
            )
        except GeometryConflict as error:
            raise DeviceScenarioConflict(str(error)) from error
        row = conn.execute(
            "SELECT * FROM geometry_results WHERE case_id=? ORDER BY rowid DESC LIMIT 1",
            (identity["case_id"],),
        ).fetchone()
        if (
            row is None
            or row["result_id"] != identity["geometry_result_id"]
            or json.loads(row["dependencies"]) != capture
        ):
            raise DeviceScenarioConflict("Current materialized geometry result is required")
        return capture

    def store(self, identity, expected_revision, scenarios):
        frozen_identity = validate_identity(identity)
        if not isinstance(expected_revision, int) or isinstance(expected_revision, bool):
            raise ValueError("expected_revision must be an integer")  # noqa: TRY004
        if expected_revision < 0:
            raise ValueError("expected_revision must not be negative")
        frozen_scenarios = validate_scenarios(scenarios)
        payload = _encoded(frozen_scenarios)
        digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
        set_id = secrets.token_urlsafe(16)
        with closing(_connect(self.db_path)) as conn, conn:
            conn.execute("BEGIN IMMEDIATE")
            capture = self._live_identity(conn, frozen_identity)
            latest = self._latest_row(conn, frozen_identity["case_id"])
            current_revision = latest["scenario_revision"] if latest is not None else 0
            if current_revision != expected_revision:
                raise DeviceScenarioConflict("Scenario revision changed during persistence")
            conn.execute(
                "INSERT INTO device_scenario_sets(set_id,case_id,identity,dependencies,"
                "scenario_revision,scenarios,scenarios_sha256,scenarios_version) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (
                    set_id,
                    frozen_identity["case_id"],
                    _encoded(frozen_identity),
                    _encoded(capture),
                    expected_revision + 1,
                    payload,
                    digest,
                    DEVICE_SCENARIOS_VERSION,
                ),
            )
        return {
            "scenario_revision": expected_revision + 1,
            "current": {
                "status": "current",
                "set_id": set_id,
                "dependencies": capture,
                "scenarios_sha256": digest,
                "scenarios": frozen_scenarios,
            },
        }

    def read(self, identity):
        frozen_identity = validate_identity(identity)
        with closing(_connect(self.db_path)) as conn:
            conn.execute("BEGIN")
            row = self._latest_row(conn, frozen_identity["case_id"])
            if row is None:
                return {"scenario_revision": 0, "current": {"status": "not_computed"}}
            if row["scenarios_version"] != DEVICE_SCENARIOS_VERSION:
                raise ValueError("Unsupported stored device scenario schema")
            stored_identity = validate_identity(json.loads(row["identity"]))
            try:
                scenarios = _validate_stored_scenarios(row["scenarios"], row["scenarios_sha256"])
            except ValueError as error:
                raise ValueError(f"Corrupt latest device scenario set: {error}") from error
            if stored_identity != frozen_identity:
                return {
                    "scenario_revision": row["scenario_revision"],
                    "current": {
                        "status": "stale",
                        "set_id": row["set_id"],
                        "scenarios": None,
                        "stale_reasons": ["device_scenario_identity_changed"],
                    },
                }
            try:
                capture = self._live_identity(conn, frozen_identity)
            except DeviceScenarioConflict:
                capture = None
            if capture is None or capture != json.loads(row["dependencies"]):
                # Never resurrect older matching rows after dependency change.
                return {
                    "scenario_revision": row["scenario_revision"],
                    "current": {
                        "status": "stale",
                        "set_id": row["set_id"],
                        "scenarios": None,
                        "stale_reasons": ["device_scenario_dependencies_changed"],
                    },
                }
            return {
                "scenario_revision": row["scenario_revision"],
                "current": {
                    "status": "current",
                    "set_id": row["set_id"],
                    "dependencies": capture,
                    "scenarios_sha256": row["scenarios_sha256"],
                    "scenarios": scenarios,
                },
            }
