"""Independent optimistic revisions for image-linked territory annotations."""

import hashlib
import json
import secrets
from contextlib import closing

from planner.physics_contract import encoded
from planner.territory_workflows import CALCULATION_VERSION, compute_workflow, validate_inputs
from planner.workspace import _connect

_SCHEMA = """
CREATE TABLE IF NOT EXISTS territory_workflow_results (
 result_id TEXT PRIMARY KEY,
 case_id TEXT NOT NULL REFERENCES cases(case_id), mode TEXT NOT NULL,
 workflow_revision INTEGER NOT NULL,
 dependencies TEXT NOT NULL, inputs TEXT NOT NULL, input_sha256 TEXT NOT NULL,
 result TEXT NOT NULL,
 UNIQUE(case_id, mode, workflow_revision)
);
"""


class WorkflowConflict(ValueError):
    pass


def digest(value):
    return hashlib.sha256(encoded(value).encode()).hexdigest()


class TerritoryWorkflowLedger:
    def __init__(self, db_path):
        self.db_path = db_path
        with closing(_connect(db_path)) as conn, conn:
            conn.executescript(_SCHEMA)

    @staticmethod
    def _latest(conn, case_id, mode):
        return conn.execute(
            "SELECT * FROM territory_workflow_results WHERE case_id=? AND mode=? "
            "ORDER BY workflow_revision DESC LIMIT 1",
            (case_id, mode),
        ).fetchone()

    @staticmethod
    def _case_matches(conn, identity):
        row = conn.execute("SELECT * FROM cases WHERE case_id=?", (identity["case_id"],)).fetchone()
        if (
            row is None
            or row["image_sha256"] != identity["image_sha256"]
            or str(row["artifact_version"]) != identity["artifact_version"]
            or row["spatial_units"] != "mm"
        ):
            raise WorkflowConflict("Case or source changed; reload saved state")

    def current(self, identity, mode):
        with closing(_connect(self.db_path)) as conn:
            conn.execute("BEGIN")
            self._case_matches(conn, identity)
            row = self._latest(conn, identity["case_id"], mode)
        if row is None:
            return 0, {"status": "not_computed"}
        revision = row["workflow_revision"]
        if type(revision) is not int or revision < 1:
            raise ValueError("Invalid workflow revision")
        expected = {**identity, "mode": mode, "calculation_version": CALCULATION_VERSION}
        if json.loads(row["dependencies"]) != expected:
            return revision, {
                "status": "stale",
                "result_id": row["result_id"],
                "inputs": None,
                "result": None,
            }
        inputs = validate_inputs(mode, json.loads(row["inputs"]))
        if digest(inputs) != row["input_sha256"]:
            raise ValueError("Saved annotation digest mismatch")
        result = json.loads(row["result"])
        if compute_workflow(mode, inputs) != result:
            raise ValueError("Saved territory measurement mismatch")
        return revision, {
            "status": "current",
            "result_id": row["result_id"],
            "dependencies": expected,
            "input_sha256": row["input_sha256"],
            "inputs": inputs,
            "result": result,
        }

    def save(self, identity, mode, expected_revision, inputs, result):
        dependencies = {**identity, "mode": mode, "calculation_version": CALCULATION_VERSION}
        result_id = secrets.token_urlsafe(16)
        with closing(_connect(self.db_path)) as conn, conn:
            conn.execute("BEGIN IMMEDIATE")
            self._case_matches(conn, identity)
            prior = self._latest(conn, identity["case_id"], mode)
            revision = prior["workflow_revision"] if prior else 0
            if revision != expected_revision:
                raise WorkflowConflict("Workflow changed; reload saved state")
            conn.execute(
                "INSERT INTO territory_workflow_results VALUES (?,?,?,?,?,?,?,?)",
                (
                    result_id,
                    identity["case_id"],
                    mode,
                    revision + 1,
                    encoded(dependencies),
                    encoded(inputs),
                    digest(inputs),
                    encoded(result),
                ),
            )
        return result_id, revision + 1
