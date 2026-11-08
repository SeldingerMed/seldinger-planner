"""Default-app brief snapshot changes and corrupt ledger fail-closed behavior."""

import json
import sqlite3

from test_territory_workflow_server import configured
from test_territory_workflows import tavr_inputs


def body(case, reference, revision):
    return {
        "artifact_version": case["artifact_version"],
        "reference_revision": reference,
        "workflow_revision": revision,
        "inputs": tavr_inputs(),
    }


def test_materialized_result_replacement_invalidates_brief_without_case_version_change(
    tmp_path, monkeypatch
):
    from planner import local_brief

    client, case, reference = configured(tmp_path, monkeypatch)
    base = f"/api/cases/{case['case_id']}"
    route = base + "/territory-workflows/tavr"
    first = client.put(route, json=body(case, reference, 0))
    assert first.status_code == 200
    project = local_brief.project_territory_context
    replaced = []

    def replace_while_projecting(identity, envelopes):
        context = project(identity, envelopes)
        if not replaced:
            response = client.put(route, json=body(case, reference, 1))
            assert response.status_code == 200, response.text
            replaced.append(response.json()["current"]["result_id"])
        return context

    monkeypatch.setattr(local_brief, "project_territory_context", replace_while_projecting)
    response = client.get(base + "/local-brief")
    assert response.status_code == 409, response.text
    assert "markdown" not in response.json()
    latest = client.get(route).json()
    assert latest["workflow_revision"] == 2 and latest["current"]["result_id"] == replaced[0]
    assert replaced[0] != first.json()["current"]["result_id"]
    assert client.get(base).json()["artifact_version"] == case["artifact_version"]
    recovered = client.get(base + "/local-brief")
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["territories"]["tavr"]["result_id"] == replaced[0]


def test_corrupt_saved_current_result_is_unavailable_not_silently_missing(tmp_path, monkeypatch):
    client, case, reference = configured(tmp_path, monkeypatch)
    base = f"/api/cases/{case['case_id']}"
    route = base + "/territory-workflows/tavr"
    response = client.put(route, json=body(case, reference, 0))
    assert response.status_code == 200
    with sqlite3.connect(tmp_path.resolve() / "case.sqlite3") as conn:
        result = json.loads(
            conn.execute("SELECT result FROM territory_workflow_results").fetchone()[0]
        )
        result["area_mm2"] = None
        conn.execute("UPDATE territory_workflow_results SET result=?", (json.dumps(result),))
    rejected = client.get(base + "/local-brief")
    assert rejected.status_code == 503, rejected.text
    assert set(rejected.json()) == {"detail"}
    assert "area_mm2" not in rejected.text
