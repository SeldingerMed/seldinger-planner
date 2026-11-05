"""New FastAPI/SQLite planning workspace layer.

Owns case state persistence: cases, measurements, notes, brief.
Bounded contract per docs/plans/workspace-first-build.md; no legacy code.
"""

from __future__ import annotations

import json
import math
import pathlib
import re
import secrets
import sqlite3
import threading
from typing import Any, Literal

import fastapi
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field, field_validator

from planner.planning import AneurysmPlan, build_plan_evidence

_SCHEMA = """
CREATE TABLE IF NOT EXISTS cases (
    case_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    image_sha256 TEXT NOT NULL,
    source_url TEXT,
    dimensions TEXT NOT NULL,
    spacing_mm TEXT NOT NULL,
    spatial_units TEXT NOT NULL DEFAULT 'mm',
    artifact_version INTEGER NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    aneurysm_plan TEXT
);
CREATE TABLE IF NOT EXISTS measurements (
    measurement_id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(case_id),
    coordinate_system TEXT NOT NULL,
    label TEXT NOT NULL,
    point_a_mm TEXT NOT NULL,
    point_b_mm TEXT NOT NULL,
    distance_mm REAL NOT NULL
);
"""

_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_HTTPS = re.compile(r"^https://[^\s]+$")
_LOCK = threading.Lock()


class CaseIn(BaseModel):
    title: str = Field(min_length=1, max_length=100)
    image_sha256: str
    source_url: str | None = None
    dimensions: tuple[int, int, int]
    spacing_mm: tuple[float, float, float]
    spatial_units: Literal["mm", "unknown"] = "mm"

    @field_validator("image_sha256")
    @classmethod
    def _sha(cls, v: str) -> str:
        if not _HEX64.match(v):
            raise ValueError("must be 64 lowercase hex chars")
        return v

    @field_validator("source_url")
    @classmethod
    def _url(cls, v: str | None) -> str | None:
        if v is not None and not _HTTPS.match(v):
            raise ValueError("source_url must be an HTTPS URL")
        return v

    @field_validator("dimensions")
    @classmethod
    def _dims(cls, v: tuple[int, int, int]) -> tuple[int, int, int]:
        if not all(1 <= d <= 2048 for d in v):
            raise ValueError("dimensions must be positive ints <= 2048")
        return v

    @field_validator("spacing_mm")
    @classmethod
    def _spacing(cls, v: tuple[float, float, float]) -> tuple[float, float, float]:
        if not all(math.isfinite(s) and 0 < s <= 100 for s in v):
            raise ValueError("spacing_mm must be finite positive floats <= 100")
        return v


class MeasurementIn(BaseModel):
    artifact_version: str
    label: str = Field(min_length=1, max_length=80)
    point_a_mm: tuple[float, float, float]
    point_b_mm: tuple[float, float, float]

    @field_validator("point_a_mm", "point_b_mm")
    @classmethod
    def _finite(cls, v: tuple[float, float, float]) -> tuple[float, float, float]:
        if not all(math.isfinite(x) for x in v):
            raise ValueError("coordinates must be finite numbers")
        return v


class NotesIn(BaseModel):
    artifact_version: str
    notes: str = Field(max_length=8000)


class AneurysmPlanIn(BaseModel):
    artifact_version: str = Field(min_length=1, max_length=20)
    plan: AneurysmPlan


def _vec(text: str) -> list[float]:
    return [float(x) for x in text.split(",")]


def _row_to_case(conn: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
    measurements = [
        {
            "measurement_id": m["measurement_id"],
            "coordinate_system": m["coordinate_system"],
            "label": m["label"],
            "point_a_mm": _vec(m["point_a_mm"]),
            "point_b_mm": _vec(m["point_b_mm"]),
            "distance_mm": m["distance_mm"],
        }
        for m in conn.execute("SELECT * FROM measurements WHERE case_id = ?", (row["case_id"],))
    ]
    plan = AneurysmPlan.model_validate_json(row["aneurysm_plan"]) if row["aneurysm_plan"] else None
    return {
        "case_id": row["case_id"],
        "title": row["title"],
        "image_sha256": row["image_sha256"],
        "source_url": row["source_url"],
        "dimensions": [int(x) for x in row["dimensions"].split(",")],
        "spacing_mm": [float(x) for x in row["spacing_mm"].split(",")],
        "spatial_units": row["spatial_units"],
        "artifact_version": str(row["artifact_version"]),
        "notes": row["notes"],
        "measurements": measurements,
        "aneurysm_plan": plan.model_dump(mode="json") if plan else None,
        "aneurysm_evidence": build_plan_evidence(plan, measurements, row["spatial_units"])
        if plan
        else None,
    }


def _connect(db_path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _get_case(conn: sqlite3.Connection, case_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM cases WHERE case_id = ?", (case_id,)).fetchone()
    return _row_to_case(conn, row) if row else None


def _update_with_revision(
    conn: sqlite3.Connection, case_id: str, artifact_version: str
) -> tuple[bool, str]:
    """Atomically bump revision iff artifact_version matches. Returns (ok, error)."""
    updated = conn.execute(
        "UPDATE cases SET artifact_version = artifact_version + 1 "
        "WHERE case_id = ? AND CAST(artifact_version AS TEXT) = ?",
        (case_id, artifact_version),
    )
    if updated.rowcount == 1:
        return True, ""
    exists = conn.execute("SELECT 1 FROM cases WHERE case_id = ?", (case_id,)).fetchone()
    return False, "stale artifact_version" if exists else "case not found"


def create_app(db_path: pathlib.Path | str) -> fastapi.FastAPI:
    app = fastapi.FastAPI(title="Seldinger planning workspace")
    with _connect(db_path) as conn:
        conn.executescript(_SCHEMA)
        if "spatial_units" not in {r[1] for r in conn.execute("PRAGMA table_info(cases)")}:
            conn.execute("ALTER TABLE cases ADD COLUMN spatial_units TEXT NOT NULL DEFAULT 'mm'")
        if "aneurysm_plan" not in {r[1] for r in conn.execute("PRAGMA table_info(cases)")}:
            conn.execute("ALTER TABLE cases ADD COLUMN aneurysm_plan TEXT")

    @app.exception_handler(fastapi.exceptions.RequestValidationError)
    def _validation_error(request: fastapi.Request, exc: Exception) -> JSONResponse:
        return JSONResponse({"detail": "invalid request"}, status_code=422)

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/api/cases")
    def create_case(payload: CaseIn) -> Any:
        case_id = secrets.token_urlsafe(16)
        with _LOCK, _connect(db_path) as conn:
            conn.execute(
                "INSERT INTO cases (case_id, title, image_sha256, source_url,"
                " dimensions, spacing_mm, spatial_units, artifact_version, notes)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, 1, '')",
                (
                    case_id,
                    payload.title,
                    payload.image_sha256,
                    payload.source_url,
                    ",".join(str(d) for d in payload.dimensions),
                    ",".join(repr(s) for s in payload.spacing_mm),
                    payload.spatial_units,
                ),
            )
            return _get_case(conn, case_id)

    @app.get("/api/cases/{case_id}")
    def get_case(case_id: str) -> Any:
        with _connect(db_path) as conn:
            case = _get_case(conn, case_id)
        if case is None:
            return JSONResponse({"detail": "case not found"}, status_code=404)
        return case

    @app.post("/api/cases/{case_id}/measurements")
    def add_measurement(case_id: str, payload: MeasurementIn) -> Any:
        with _connect(db_path) as conn:
            current = _get_case(conn, case_id)
        if current is not None and current["spatial_units"] != "mm":
            raise fastapi.HTTPException(422, "Source spatial units are not confirmed as mm")
        distance = math.sqrt(
            sum((a - b) ** 2 for a, b in zip(payload.point_a_mm, payload.point_b_mm))
        )
        if distance == 0.0:
            raise fastapi.HTTPException(
                status_code=422, detail="coincident points have zero distance"
            )
        with _LOCK, _connect(db_path) as conn:
            ok, error = _update_with_revision(conn, case_id, payload.artifact_version)
            if not ok:
                if error == "case not found":
                    return JSONResponse({"detail": error}, status_code=404)
                return JSONResponse({"detail": error}, status_code=409)
            conn.execute(
                "INSERT INTO measurements (measurement_id, case_id, coordinate_system,"
                " label, point_a_mm, point_b_mm, distance_mm)"
                " VALUES (?, ?, 'RAS', ?, ?, ?, ?)",
                (
                    secrets.token_urlsafe(12),
                    case_id,
                    payload.label,
                    ",".join(repr(x) for x in payload.point_a_mm),
                    ",".join(repr(x) for x in payload.point_b_mm),
                    distance,
                ),
            )
            return _get_case(conn, case_id)

    @app.patch("/api/cases/{case_id}/notes")
    def set_notes(case_id: str, payload: NotesIn) -> Any:
        with _LOCK, _connect(db_path) as conn:
            ok, error = _update_with_revision(conn, case_id, payload.artifact_version)
            if not ok:
                if error == "case not found":
                    return JSONResponse({"detail": error}, status_code=404)
                return JSONResponse({"detail": error}, status_code=409)
            conn.execute(
                "UPDATE cases SET notes = ? WHERE case_id = ?",
                (payload.notes, case_id),
            )
            return _get_case(conn, case_id)

    @app.patch("/api/cases/{case_id}/aneurysm-plan")
    def set_aneurysm_plan(case_id: str, payload: AneurysmPlanIn) -> Any:
        with _LOCK, _connect(db_path) as conn:
            current = _get_case(conn, case_id)
            if current is None:
                return JSONResponse({"detail": "case not found"}, status_code=404)
            try:
                build_plan_evidence(payload.plan, current["measurements"], current["spatial_units"])
            except ValueError:
                raise fastapi.HTTPException(
                    422,
                    "Evidence links require millimeter units and distinct, same-case measurements",
                ) from None
            ok, error = _update_with_revision(conn, case_id, payload.artifact_version)
            if not ok:
                return JSONResponse({"detail": error}, status_code=409)
            conn.execute(
                "UPDATE cases SET aneurysm_plan = ? WHERE case_id = ?",
                (
                    json.dumps(payload.plan.model_dump(mode="json")),
                    case_id,
                ),
            )
            return _get_case(conn, case_id)

    @app.get("/api/cases/{case_id}/brief")
    def brief(case_id: str) -> Any:
        with _connect(db_path) as conn:
            case = _get_case(conn, case_id)
        if case is None:
            return JSONResponse({"detail": "case not found"}, status_code=404)
        lines = [
            f"# Planning brief: {case['title']}",
            "",
            f"- Case ID: `{case['case_id']}`",
            f"- Image SHA-256: `{case['image_sha256']}`",
            f"- Source: {case['source_url'] or 'not provided'}",
            f"- Artifact revision: {case['artifact_version']}",
            f"- Dimensions (voxels): {case['dimensions']}",
            f"- Spacing ({case['spatial_units']}): {case['spacing_mm']}",
            "",
            "## Measurements",
            "",
        ]
        if case["measurements"]:
            for m in case["measurements"]:
                lines.append(
                    f"- {m['label']} ({m['coordinate_system']}):"
                    f" {m['distance_mm']:.3f} mm"
                    f" from {m['point_a_mm']} to {m['point_b_mm']}"
                )
            lines += [
                (
                    "Method: point-to-point Euclidean distance in RAS physical mm."
                    " This is NOT validated neck, landing-zone, or device-sizing analysis."
                ),
                "",
            ]
        else:
            lines += ["(none)", ""]
        if case["aneurysm_plan"] is not None:
            plan = case["aneurysm_plan"]
            evidence = case["aneurysm_evidence"]
            units = "mm" if case["spatial_units"] == "mm" else "source units (unspecified)"
            lines += [
                "## Aneurysm worksheet",
                "",
                "Operator-entered target and clinical context, not inferred findings.",
                "",
                f"- Target: {plan['lesion_label']}",
                f"- Location / segment: {plan['location_note'] or 'not specified'}",
                f"- Rupture status (operator-entered): {plan['rupture_status']}",
                f"- Target RAS {units}: {plan['focus_ras'] or 'not marked'}",
                f"- Options for discussion, not endorsements: {', '.join(plan['options']) or 'none selected'}",
                "",
                "### Clinical context",
                "",
                plan["clinical_context"] or "(not provided)",
                "",
                "### User-assigned manual evidence",
                "",
                evidence["interpretation"],
                "",
            ]
            for item in evidence["linked_measurements"]:
                lines.append(
                    f"- {item['role']}: {item['distance_mm']:.3f} mm; manual_point_pair; measurement `{item['measurement_id']}`"
                )
            lines += [
                f"- Unfilled roles: {', '.join(evidence['missing_measurements']) or 'none'}",
                "",
                "### Planning questions",
                "",
                plan["questions"] or "(none)",
                "",
            ]
        lines += ["## User notes", "", case["notes"] or "(none)", ""]
        return PlainTextResponse("\n".join(lines), media_type="text/markdown")

    return app
