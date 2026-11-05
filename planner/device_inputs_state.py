"""Operator-reported device measurements: immutable persistence tracer.

Software input bookkeeping only. These are unvalidated operator-reported
values, never verified measurements, and no clinical validity is implied.
Current CTA geometry does not supply these independent scalar dimensions;
there is deliberately no automatic fallback to geometry-derived numbers.
"""

import hashlib
import json
import math
import secrets
from contextlib import closing

from planner.geometry_state import GeometryConflict, GeometryLedger
from planner.workspace import _connect

DEVICE_INPUTS_VERSION = "operator-reported-device-inputs-v1"

MEASUREMENT_KEYS = (
    "proximal_parent",
    "distal_parent",
    "neck_coverage_length",
    "average_sac_diameter",
    "smallest_sac_height",
    "dome_diameter",
)

# Prototype software-input cap in millimeters, not clinical eligibility.
_MAX_MM = 100.0
_MAX_NOTE_CHARS = 512
_MAX_SCOPE_BYTES = 16 * 1024

_SCHEMA = """
CREATE TABLE IF NOT EXISTS device_inputs (
 input_id TEXT PRIMARY KEY,
 case_id TEXT NOT NULL REFERENCES cases(case_id),
 dependencies TEXT NOT NULL,
 measurements TEXT NOT NULL,
 provenance TEXT NOT NULL,
 inputs_sha256 TEXT NOT NULL,
 inputs_version TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""


class DeviceInputsConflict(ValueError):
    """Missing or changed case/device-input dependencies."""


def _encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _normalize_measurements(measurements):
    if measurements is None:
        measurements = {}
    if not isinstance(measurements, dict):
        raise ValueError("Measurements must be an object or None")  # noqa: TRY004
    unknown = set(measurements) - set(MEASUREMENT_KEYS)
    if unknown:
        raise ValueError(f"Unknown measurement keys: {sorted(unknown)}")
    normalized: dict = {key: None for key in MEASUREMENT_KEYS}
    for key, value in measurements.items():
        if value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(  # noqa: TRY004
                f"Measurement {key} must be a number, null or omitted"
            )
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError(f"Measurement {key} must be finite")
        # Reject arbitrary-size integers before any float conversion.
        if value <= 0 or value > _MAX_MM:
            raise ValueError(
                f"Measurement {key} must be > 0 and <= {_MAX_MM:g} mm "
                "(software-input cap, not clinical eligibility)"
            )
        normalized[key] = float(value)
    return normalized


def _normalize_provenance(provenance):
    if not isinstance(provenance, dict) or set(provenance) != {"kind", "note"}:
        raise ValueError('Provenance must be exactly {"kind", "note"}')
    if provenance["kind"] != "operator_reported":
        raise ValueError('Provenance kind must be "operator_reported"')
    note = provenance["note"]
    if not isinstance(note, str) or not note.strip():
        raise ValueError("Provenance note must be a nonblank plain string")
    if len(note) > _MAX_NOTE_CHARS:
        raise ValueError(f"Provenance note must be <= {_MAX_NOTE_CHARS} characters")
    return {"kind": "operator_reported", "note": note}


def _empty_envelope(status, input_revision=None):
    return {
        "status": status,
        "input_revision": input_revision,
        "inputs_sha256": None,
        "measurements": None,
        "provenance": None,
        "inputs_version": DEVICE_INPUTS_VERSION,
    }


class DeviceInputsLedger:
    """Immutable history of operator-reported measurements per case."""

    def __init__(self, db_path):
        self.db_path = db_path
        self.geometry = GeometryLedger(db_path)
        with closing(_connect(db_path)) as conn, conn:
            conn.executescript(_SCHEMA)

    def save_inputs(
        self, case_id, geometry_dependencies, measurements, provenance, expected_revision
    ):
        normalized = _normalize_measurements(measurements)
        provenance = _normalize_provenance(provenance)
        if not isinstance(geometry_dependencies, dict):
            raise ValueError("Geometry dependencies must be an object")  # noqa: TRY004
        source_revision = geometry_dependencies.get("source_revision")
        if not isinstance(source_revision, str) or not source_revision:
            raise ValueError("Geometry dependencies require a source_revision")
        scope = {
            "inputs_version": DEVICE_INPUTS_VERSION,
            "geometry_dependencies": geometry_dependencies,
            "measurements": normalized,
            "provenance": provenance,
        }
        try:
            raw_scope = _encoded(scope)
        except (TypeError, ValueError) as error:
            raise ValueError(f"Malformed scope data: {error}") from error
        if len(raw_scope.encode("utf-8")) > _MAX_SCOPE_BYTES:
            raise ValueError("Serialized input scope exceeds 16KiB")
        # Validate and persist the same immutable snapshot whose bytes were hashed.
        geometry_dependencies = json.loads(raw_scope)["geometry_dependencies"]
        source_revision = geometry_dependencies["source_revision"]
        digest = hashlib.sha256(raw_scope.encode("utf-8")).hexdigest()
        with closing(_connect(self.db_path)) as conn, conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                capture = self.geometry._capture(conn, case_id, source_revision)
            except GeometryConflict as error:
                raise DeviceInputsConflict(str(error)) from error
            if capture != geometry_dependencies:
                raise DeviceInputsConflict("Geometry dependencies changed")
            row = conn.execute(
                "SELECT input_id FROM device_inputs WHERE case_id=? ORDER BY rowid DESC LIMIT 1",
                (case_id,),
            ).fetchone()
            latest = row["input_id"] if row is not None else None
            if latest != expected_revision:
                raise DeviceInputsConflict(
                    "Input revision conflict; expected None only before any record"
                )
            input_revision = secrets.token_urlsafe(16)
            conn.execute(
                "INSERT INTO device_inputs(input_id,case_id,dependencies,measurements,"
                "provenance,inputs_sha256,inputs_version) VALUES(?,?,?,?,?,?,?)",
                (
                    input_revision,
                    case_id,
                    _encoded(geometry_dependencies),
                    _encoded(normalized),
                    _encoded(provenance),
                    digest,
                    DEVICE_INPUTS_VERSION,
                ),
            )
            return self.read_in_transaction(conn, case_id, source_revision)

    def inputs(self, case_id, source_revision):
        with closing(_connect(self.db_path)) as conn:
            conn.execute("BEGIN")
            return self.read_in_transaction(conn, case_id, source_revision)

    def read_in_transaction(self, conn, case_id, source_revision):
        """Use the caller's transaction without closing or committing it."""
        try:
            self.geometry._case(conn, case_id)
        except GeometryConflict as error:
            raise DeviceInputsConflict(str(error)) from error
        row = conn.execute(
            "SELECT * FROM device_inputs WHERE case_id=? ORDER BY rowid DESC LIMIT 1",
            (case_id,),
        ).fetchone()
        if row is None:
            return _empty_envelope("not_saved")
        try:
            current = self.geometry._capture(conn, case_id, source_revision)
        except GeometryConflict:
            current = None
        input_revision = row["input_id"]
        if current is None or current != json.loads(row["dependencies"]):
            return _empty_envelope("stale", input_revision)
        if row["inputs_version"] != DEVICE_INPUTS_VERSION:
            raise ValueError("Unsupported stored input version")
        measurements = json.loads(row["measurements"])
        provenance = json.loads(row["provenance"])
        if measurements != _normalize_measurements(
            measurements
        ) or provenance != _normalize_provenance(provenance):
            raise ValueError("Invalid stored operator input data")
        raw = _encoded(
            {
                "inputs_version": DEVICE_INPUTS_VERSION,
                "geometry_dependencies": current,
                "measurements": measurements,
                "provenance": provenance,
            }
        )
        if (
            len(raw.encode()) > _MAX_SCOPE_BYTES
            or hashlib.sha256(raw.encode()).hexdigest() != row["inputs_sha256"]
        ):
            raise ValueError("Stored operator input integrity mismatch")
        return {
            "status": "current",
            "input_revision": input_revision,
            "inputs_sha256": row["inputs_sha256"],
            "geometry_dependencies": json.loads(row["dependencies"]),
            "measurements": json.loads(row["measurements"]),
            "provenance": json.loads(row["provenance"]),
            "inputs_version": row["inputs_version"],
        }
