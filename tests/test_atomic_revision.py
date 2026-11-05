import sqlite3

from fastapi.testclient import TestClient

from planner.workspace import _update_with_revision, create_app


def test_revision_compare_and_swap_is_atomic_across_connections(tmp_path):
    path = tmp_path / "race.sqlite3"
    client = TestClient(create_app(path))
    case = client.post(
        "/api/cases",
        json={
            "title": "Synthetic race fixture",
            "image_sha256": "e" * 64,
            "dimensions": [10, 10, 10],
            "spacing_mm": [1, 1, 1],
        },
    ).json()
    first = sqlite3.connect(path)
    first.row_factory = sqlite3.Row

    class InterleavedConnection:
        def execute(self, sql, params):
            if sql.startswith("SELECT artifact_version"):
                rows = first.execute(sql, params).fetchall()
                # An independent worker wins between the legacy SELECT and UPDATE.
                with sqlite3.connect(path) as second:
                    second.execute(
                        "UPDATE cases SET artifact_version=2 WHERE case_id=?", (case["case_id"],)
                    )

                class Cursor:
                    def fetchone(self):
                        return rows[0] if rows else None

                return Cursor()
            return first.execute(sql, params)

    result = _update_with_revision(InterleavedConnection(), case["case_id"], "1")
    first.commit()
    revision = first.execute(
        "SELECT artifact_version FROM cases WHERE case_id=?", (case["case_id"],)
    ).fetchone()[0]
    first.close()
    # Either this CAS wins at 1->2, or the concurrent write makes it fail.
    # Two accepted writes from revision 1 must never produce revision 3.
    assert revision == 2
    assert isinstance(result[0], bool)
