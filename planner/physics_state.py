"""Dependency-bound local numerical results, never clinical validation."""

import hashlib
import json
from contextlib import closing

from planner.geometry_state import GeometryConflict, GeometryLedger
from planner.physics_contract import ALGORITHM_VERSION, KINDS, encoded
from planner.workspace import _connect

_SCHEMA = """
CREATE TABLE IF NOT EXISTS numerical_results (
 result_id TEXT PRIMARY KEY,
 case_id TEXT NOT NULL REFERENCES cases(case_id),
 kind TEXT NOT NULL,
 dependencies TEXT NOT NULL,
 parameters TEXT NOT NULL,
 result TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS numerical_result_case_kind ON numerical_results(case_id,kind);
"""


class PhysicsLedger:
    def __init__(self, db_path):
        self.db_path = db_path
        self.geometry = GeometryLedger(db_path)
        with closing(_connect(db_path)) as conn, conn:
            conn.executescript(_SCHEMA)

    def _capture(self, conn, case_id, source_revision, kind):
        if kind not in KINDS:
            raise ValueError("Unknown numerical computation kind")
        case = self.geometry._case(conn, case_id)
        if case["spatial_units"] != "mm":
            raise GeometryConflict("Confirmed millimeter source geometry is required")
        base = {
            "case_id": case_id,
            "image_sha256": case["image_sha256"],
            "artifact_version": str(case["artifact_version"]),
            "source_revision": source_revision,
            "algorithm_version": ALGORITHM_VERSION,
        }
        if kind == "centerline":
            row = conn.execute(
                "SELECT * FROM segmentation_candidates WHERE case_id=? AND role='vessel' "
                "AND status='accepted' ORDER BY segmentation_revision DESC LIMIT 1",
                (case_id,),
            ).fetchone()
            if (
                row is None
                or row["image_sha256"] != case["image_sha256"]
                or row["reference_revision"] != source_revision
            ):
                raise GeometryConflict("A current accepted vessel mask is required")
            return base | {
                "masks": {
                    "vessel": {
                        k: row[k] for k in ("candidate_id", "mask_sha256", "segmentation_revision")
                    }
                }
            }
        geometry = self.geometry._capture(conn, case_id, source_revision)
        row = conn.execute(
            "SELECT * FROM geometry_results WHERE case_id=? ORDER BY rowid DESC LIMIT 1",
            (case_id,),
        ).fetchone()
        if row is None or json.loads(row["dependencies"]) != geometry:
            raise GeometryConflict("Current accepted-mask geometry is required")
        return base | {
            "geometry_result_id": row["result_id"],
            "geometry_dependencies": geometry,
            "masks": geometry["masks"],
        }

    def snapshot(self, case_id, source_revision, kind):
        with closing(_connect(self.db_path)) as conn:
            conn.execute("BEGIN")
            return self._capture(conn, case_id, source_revision, kind)

    def store(self, case_id, source_revision, kind, snapshot, parameters, result):
        import secrets

        result_id = secrets.token_urlsafe(16)
        raw_parameters, raw_result = encoded(parameters), encoded(result)
        with closing(_connect(self.db_path)) as conn, conn:
            conn.execute("BEGIN IMMEDIATE")
            if self._capture(conn, case_id, source_revision, kind) != snapshot:
                raise GeometryConflict("Numerical dependencies changed during computation")
            conn.execute(
                "INSERT INTO numerical_results(result_id,case_id,kind,dependencies,parameters,result) VALUES(?,?,?,?,?,?)",
                (result_id, case_id, kind, encoded(snapshot), raw_parameters, raw_result),
            )
        # Return the exact newly stored row, not whichever result wins a later read.
        return {
            "status": "current",
            "result_id": result_id,
            "dependencies": snapshot,
            "parameters": json.loads(raw_parameters),
            "parameters_sha256": hashlib.sha256(raw_parameters.encode()).hexdigest(),
            "result": json.loads(raw_result),
        }

    def current(self, case_id, source_revision, kind):
        with closing(_connect(self.db_path)) as conn:
            conn.execute("BEGIN")
            self.geometry._case(conn, case_id)
            row = conn.execute(
                "SELECT * FROM numerical_results WHERE case_id=? AND kind=? ORDER BY rowid DESC LIMIT 1",
                (case_id, kind),
            ).fetchone()
            if row is None:
                return {"status": "not_computed", "result": None}
            try:
                snapshot = self._capture(conn, case_id, source_revision, kind)
            except GeometryConflict:
                snapshot = None
            if snapshot != json.loads(row["dependencies"]):
                return {"status": "stale", "result_id": row["result_id"], "result": None}
            parameters = json.loads(row["parameters"])
            return {
                "status": "current",
                "result_id": row["result_id"],
                "dependencies": snapshot,
                "parameters": parameters,
                "parameters_sha256": hashlib.sha256(encoded(parameters).encode()).hexdigest(),
                "result": json.loads(row["result"]),
            }
