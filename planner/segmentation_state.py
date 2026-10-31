"""Case-owned, revision-safe segmentation decisions, independent of ML runtime.

This ledger stores metadata only. Verified mask bytes and worker execution are
separate responsibilities. Geometry/sizing validity defaults false after edits;
no computed results or clinical validation are implied by an acceptance.
"""

import json
import re
import secrets
from contextlib import closing

from planner.workspace import _connect, _update_with_revision

_SCHEMA = """
CREATE TABLE IF NOT EXISTS segmentation_candidates (
 candidate_id TEXT PRIMARY KEY,
 case_id TEXT NOT NULL REFERENCES cases(case_id),
 image_sha256 TEXT NOT NULL,
 produced_artifact_version TEXT NOT NULL,
 reference_revision TEXT NOT NULL,
 producer TEXT NOT NULL,
 role TEXT NOT NULL,
 mask_sha256 TEXT NOT NULL,
 provenance TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'preview',
 segmentation_revision INTEGER,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 decided_at TEXT
);
CREATE INDEX IF NOT EXISTS segmentation_case ON segmentation_candidates(case_id);
"""


class SegmentationConflict(ValueError):
    """Case ownership, revision or final-decision guard failed."""


def _sha(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def _record(row, artifact_version=None):
    result = dict(row)
    result["provenance"] = json.loads(result["provenance"])
    result["derived_geometry_valid"] = False
    result["device_sizing_valid"] = False
    if artifact_version is not None:
        result["artifact_version"] = artifact_version
    return result


class SegmentationLedger:
    def __init__(self, db_path):
        self.db_path = db_path
        with closing(_connect(db_path)) as conn, conn:
            conn.executescript(_SCHEMA)

    @staticmethod
    def _case(conn, case_id, artifact_version=None):
        row = conn.execute("SELECT * FROM cases WHERE case_id=?", (case_id,)).fetchone()
        if row is None or (
            artifact_version is not None and str(row["artifact_version"]) != artifact_version
        ):
            raise SegmentationConflict("Case not found or case revision changed")
        return row

    @staticmethod
    def _entry(conn, case_id, candidate_id):
        row = conn.execute(
            "SELECT * FROM segmentation_candidates WHERE candidate_id=? AND case_id=?",
            (candidate_id, case_id),
        ).fetchone()
        if row is None:
            raise SegmentationConflict("Candidate not found for this case")
        return row

    def preview(
        self,
        case_id,
        artifact_version,
        *,
        reference_revision,
        producer,
        mask_sha256,
        provenance,
        role=None,
    ):
        if not _sha(mask_sha256) or not _sha(reference_revision):
            raise ValueError("Mask/reference identities must be SHA-256")
        if producer not in ("owned_vessel", "sam2_prompted_slice", "aneurysm_model"):
            raise ValueError("Unrecognized segmentation producer")
        role = role or ("vessel" if producer == "owned_vessel" else "aneurysm")
        if role not in ("vessel", "aneurysm") or (producer == "owned_vessel" and role != "vessel"):
            raise ValueError("Producer/role mismatch")
        if not isinstance(provenance, dict):
            raise TypeError("Provenance must be a JSON object")
        serialized = json.dumps(provenance, allow_nan=False)
        if len(serialized.encode()) > 32768:
            raise ValueError("Provenance exceeds metadata cap")
        candidate_id = secrets.token_urlsafe(16)
        with closing(_connect(self.db_path)) as conn, conn:
            conn.execute("BEGIN IMMEDIATE")
            case = self._case(conn, case_id, artifact_version)
            count = conn.execute("SELECT COUNT(*) FROM segmentation_candidates").fetchone()[0]
            if count >= 200:
                raise SegmentationConflict("Local candidate ledger capacity reached")
            conn.execute(
                "INSERT INTO segmentation_candidates "
                "(candidate_id,case_id,image_sha256,produced_artifact_version,reference_revision,"
                "producer,role,mask_sha256,provenance) VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    candidate_id,
                    case_id,
                    case["image_sha256"],
                    artifact_version,
                    reference_revision,
                    producer,
                    role,
                    mask_sha256,
                    serialized,
                ),
            )
            return _record(self._entry(conn, case_id, candidate_id))

    def entry(self, case_id, candidate_id):
        with closing(_connect(self.db_path)) as conn:
            self._case(conn, case_id)
            return _record(self._entry(conn, case_id, candidate_id))

    def current(self, case_id, *, role="aneurysm"):
        if role not in ("vessel", "aneurysm"):
            raise ValueError("Unrecognized segmentation role")
        with closing(_connect(self.db_path)) as conn:
            self._case(conn, case_id)
            row = conn.execute(
                "SELECT * FROM segmentation_candidates WHERE case_id=? AND role=? "
                "AND status='accepted' ORDER BY segmentation_revision DESC LIMIT 1",
                (case_id, role),
            ).fetchone()
            return _record(row) if row else None

    def decide(self, case_id, candidate_id, artifact_version, decision):
        if decision not in ("accept", "reject"):
            raise ValueError("Decision must be accept or reject")
        with closing(_connect(self.db_path)) as conn, conn:
            conn.execute("BEGIN IMMEDIATE")
            case = self._case(conn, case_id, artifact_version)
            row = self._entry(conn, case_id, candidate_id)
            if row["status"] != "preview" or row["image_sha256"] != case["image_sha256"]:
                raise SegmentationConflict("Candidate already decided or image changed")
            revision = None
            if decision == "accept":
                if row["produced_artifact_version"] != artifact_version:
                    raise SegmentationConflict("Candidate was produced for a stale case revision")
                revision = conn.execute(
                    "SELECT COALESCE(MAX(segmentation_revision),0)+1 "
                    "FROM segmentation_candidates WHERE case_id=?",
                    (case_id,),
                ).fetchone()[0]
                ok, error = _update_with_revision(conn, case_id, artifact_version)
                if not ok:
                    raise SegmentationConflict(error)
                conn.execute(
                    "UPDATE segmentation_candidates SET status='superseded' "
                    "WHERE case_id=? AND role=? AND status='accepted'",
                    (case_id, row["role"]),
                )
                artifact_version = str(int(artifact_version) + 1)
            conn.execute(
                "UPDATE segmentation_candidates SET status=?,segmentation_revision=?,"
                "decided_at=CURRENT_TIMESTAMP WHERE candidate_id=? AND case_id=?",
                (
                    "accepted" if decision == "accept" else "rejected",
                    revision,
                    candidate_id,
                    case_id,
                ),
            )
            return _record(self._entry(conn, case_id, candidate_id), artifact_version)
