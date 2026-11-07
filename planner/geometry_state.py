"""Materialized mask geometry, separately persisted from manual point-pairs.

This stores software geometry estimates, never clinical validation. No arrays,
models or filesystem paths are accepted by the ledger.
"""

import hashlib
import json
import secrets
from contextlib import closing

from planner.geometry_contract import CALCULATION_VERSION
from planner.workspace import _connect, _update_with_revision

_SCHEMA = """
CREATE TABLE IF NOT EXISTS geometry_inputs (
 case_id TEXT PRIMARY KEY REFERENCES cases(case_id),
 image_sha256 TEXT NOT NULL, source_revision TEXT NOT NULL,
 operator_sha256 TEXT NOT NULL, operator_inputs TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS geometry_results (
 result_id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(case_id),
 dependencies TEXT NOT NULL, result TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""


class GeometryConflict(ValueError):
    """Missing or changed case geometry dependencies."""


def _encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


class GeometryLedger:
    def __init__(self, db_path):
        self.db_path = db_path
        with closing(_connect(db_path)) as conn, conn:
            conn.executescript(_SCHEMA)

    @staticmethod
    def _case(conn, case_id):
        case = conn.execute("SELECT * FROM cases WHERE case_id=?", (case_id,)).fetchone()
        if case is None:
            raise GeometryConflict("Case not found")
        return case

    def save_inputs(self, case_id, artifact_version, source_revision, operator_inputs):
        raw = _encoded(operator_inputs)
        digest = hashlib.sha256(raw.encode()).hexdigest()
        with closing(_connect(self.db_path)) as conn, conn:
            conn.execute("BEGIN IMMEDIATE")
            case = self._case(conn, case_id)
            ok, error = _update_with_revision(conn, case_id, artifact_version)
            if not ok:
                raise GeometryConflict(error)
            conn.execute(
                "INSERT INTO geometry_inputs VALUES (?,?,?,?,?) "
                "ON CONFLICT(case_id) DO UPDATE SET image_sha256=excluded.image_sha256, "
                "source_revision=excluded.source_revision, operator_sha256=excluded.operator_sha256, "
                "operator_inputs=excluded.operator_inputs",
                (case_id, case["image_sha256"], source_revision, digest, raw),
            )
            return str(int(artifact_version) + 1)

    def _capture(self, conn, case_id, source_revision):
        case = self._case(conn, case_id)
        if case["spatial_units"] != "mm":
            raise GeometryConflict("Confirmed millimeter source geometry is required")
        inputs = conn.execute(
            "SELECT * FROM geometry_inputs WHERE case_id=?", (case_id,)
        ).fetchone()
        if inputs is None:
            raise GeometryConflict("Operator geometry inputs are missing")
        if (
            inputs["image_sha256"] != case["image_sha256"]
            or inputs["source_revision"] != source_revision
        ):
            raise GeometryConflict("Operator inputs belong to another image or source revision")
        masks = {}
        for role in ("vessel", "aneurysm"):
            entry = conn.execute(
                "SELECT * FROM segmentation_candidates WHERE case_id=? AND role=? "
                "AND status='accepted' ORDER BY segmentation_revision DESC LIMIT 1",
                (case_id, role),
            ).fetchone()
            if entry is None:
                raise GeometryConflict("Current accepted three-dimensional masks are required")
            if (
                entry["image_sha256"] != case["image_sha256"]
                or entry["reference_revision"] != source_revision
            ):
                raise GeometryConflict("Accepted mask belongs to another image or source revision")
            if role == "aneurysm" and not self._volumetric_aneurysm(conn, entry):
                raise GeometryConflict("A three-dimensional aneurysm model lineage is required")
            masks[role] = {
                key: entry[key]
                for key in (
                    "candidate_id",
                    "mask_sha256",
                    "segmentation_revision",
                )
            }
        return {
            "case_id": case_id,
            "image_sha256": case["image_sha256"],
            "artifact_version": str(case["artifact_version"]),
            "source_revision": source_revision,
            "operator_sha256": inputs["operator_sha256"],
            "masks": masks,
            "calculation_version": CALCULATION_VERSION,
        }

    @staticmethod
    def _volumetric_aneurysm(conn, entry):
        """An initialized edit must ultimately descend from a full-context model.

        Merely embedding one prompted slice in a 3D NIfTI is not volumetric
        sac evidence. Historical superseded bases remain immutable ledger rows.
        """
        seen = set()
        for _ in range(200):
            if entry["candidate_id"] in seen or entry["role"] != "aneurysm":
                return False
            seen.add(entry["candidate_id"])
            if entry["producer"] == "aneurysm_model":
                return True
            if entry["producer"] != "sam2_prompted_slice":
                return False
            metadata = json.loads(entry["provenance"])
            base = metadata.get("correction_base")
            if metadata.get(
                "segmentation_extent"
            ) != "single_slice_edit_of_existing_mask" or not isinstance(base, dict):
                return False
            previous = conn.execute(
                "SELECT * FROM segmentation_candidates WHERE case_id=? AND candidate_id=?",
                (entry["case_id"], base.get("candidate_id")),
            ).fetchone()
            if previous is None or previous["status"] not in ("accepted", "superseded"):
                return False
            if (
                previous["mask_sha256"] != base.get("mask_sha256")
                or previous["image_sha256"] != entry["image_sha256"]
                or previous["reference_revision"] != entry["reference_revision"]
            ):
                return False
            entry = previous
        return False

    def snapshot(self, case_id, artifact_version, source_revision):
        with closing(_connect(self.db_path)) as conn:
            snapshot = self._capture(conn, case_id, source_revision)
        if snapshot["artifact_version"] != artifact_version:
            raise GeometryConflict("Case revision changed")
        return snapshot

    def inputs(self, case_id, source_revision=None):
        with closing(_connect(self.db_path)) as conn:
            conn.execute("BEGIN")
            case = self._case(conn, case_id)
            row = conn.execute(
                "SELECT * FROM geometry_inputs WHERE case_id=?", (case_id,)
            ).fetchone()
            if row is None or row["image_sha256"] != case["image_sha256"]:
                return None
            if source_revision is not None and row["source_revision"] != source_revision:
                return None
            return json.loads(row["operator_inputs"])

    def store(self, case_id, dependencies, result):
        result_id = secrets.token_urlsafe(16)
        with closing(_connect(self.db_path)) as conn, conn:
            conn.execute("BEGIN IMMEDIATE")
            if self._capture(conn, case_id, dependencies["source_revision"]) != dependencies:
                raise GeometryConflict("Geometry dependencies changed during calculation")
            conn.execute(
                "INSERT INTO geometry_results(result_id,case_id,dependencies,result) VALUES(?,?,?,?)",
                (result_id, case_id, _encoded(dependencies), _encoded(result)),
            )
        return self.current(case_id, dependencies["source_revision"])

    def current(self, case_id, source_revision):
        with closing(_connect(self.db_path)) as conn:
            conn.execute("BEGIN")
            self._case(conn, case_id)
            row = conn.execute(
                "SELECT * FROM geometry_results WHERE case_id=? ORDER BY rowid DESC LIMIT 1",
                (case_id,),
            ).fetchone()
            if row is not None:
                dependencies = json.loads(row["dependencies"])
                try:
                    current = self._capture(conn, case_id, source_revision)
                except GeometryConflict:
                    current = None
                if current != dependencies:
                    return {
                        "status": "stale",
                        "result_id": row["result_id"],
                        "result": None,
                        "stale_reasons": ["geometry_dependencies_changed"],
                    }
        if row is None:
            return {"status": "not_computed", "result": None}
        return {
            "status": "current",
            "result_id": row["result_id"],
            "dependencies": json.loads(row["dependencies"]),
            "result": json.loads(row["result"]),
        }
