"""Real default-app C-arm working-view confirmations on a generated native source."""

import json
import math
import sqlite3
from contextlib import closing

import pytest
from test_territory_workflow_server import configured

VIEW = {
    "name": "Working LAO",
    "primary_deg": 30.0,
    "secondary_deg": 20.0,
    "source_detector_mm": 1200.0,
    "source_isocenter_mm": 750.0,
    "detector_width_mm": 200.0,
    "detector_height_mm": 200.0,
}


def plan_inputs(**change):
    return {
        "confirmed": True,
        "isocenter": [10.0, 16.0, 16.0],
        "target_path": [[5.0, 16.0, 16.0], [10.0, 16.0, 16.0], [10.0, 21.0, 16.0]],
        "views": [dict(VIEW)],
        **change,
    }


def request_body(case, reference, revision=0, **change):
    return {
        "artifact_version": case["artifact_version"],
        "reference_revision": reference,
        "plan_revision": revision,
        "inputs": plan_inputs(**change),
    }


def test_confirmed_views_roundtrip_with_known_values(tmp_path, monkeypatch):
    client, case, reference = configured(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-plan"
    empty = client.get(route)
    assert empty.status_code == 200, empty.text
    assert empty.json()["plan_revision"] == 0
    assert empty.json()["current"] == {"status": "not_confirmed"}
    ap = {**VIEW, "name": "AP", "primary_deg": 0.0, "secondary_deg": 0.0}
    lateral = {**VIEW, "name": "Lateral", "primary_deg": 90.0, "secondary_deg": 0.0}
    body = request_body(case, reference, views=[ap, lateral])
    response = client.put(route, json=body)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["plan_revision"] == 1 and result["current"]["status"] == "current"
    assert response.headers["Cache-Control"] == "no-store"
    summary = result["current"]["result"]
    assert summary["version"] == "step-a-carm-views-v1"
    assert summary["convention"] == "dicom_xa_patient_longitude_latitude_ras_v1"
    assert summary["target_length_mm"] == 10 and summary["target_point_count"] == 3
    by_name = {view["name"]: view for view in summary["views"]}
    # AP looks along the patient anterior axis: the 5 mm anterior leg is end-on.
    assert math.isclose(by_name["AP"]["foreshortening_percent"], 50.0, abs_tol=1e-9)
    # Lateral looks along the left-right axis: the 5 mm lateral leg is end-on.
    assert math.isclose(by_name["Lateral"]["foreshortening_percent"], 50.0, abs_tol=1e-9)
    assert by_name["AP"]["magnification_at_isocenter"] == 1.6
    assert by_name["AP"]["target_in_field"] is True
    assert result["current"]["inputs"] == body["inputs"]
    assert client.get(route).json() == result
    assert client.put(route, json=body).status_code == 409
    assert (
        client.get(f"/api/cases/{case['case_id']}").json()["artifact_version"]
        == case["artifact_version"]
    )


def test_confirmation_and_shape_rejections_do_not_store(tmp_path, monkeypatch):
    client, case, reference = configured(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-plan"
    assert client.put(route, json=request_body(case, reference)).status_code == 200
    rejected = [
        {"confirmed": False},
        {"confirmed": 1},
        {"confirmed": "true"},
        {"views": []},
        {"views": [dict(VIEW)] * 2},  # duplicate names
        {"views": [{**VIEW, "name": f"V{i}"} for i in range(9)]},
        {"views": [{**VIEW, "name": "bad`name"}]},
        {"views": [{**VIEW, "name": "# heading"}]},
        {"views": [{**VIEW, "primary_deg": 181.0}]},
        {"views": [{**VIEW, "secondary_deg": -91.0}]},
        {"views": [{**VIEW, "source_isocenter_mm": 1200.0}]},
        {"views": [{**VIEW, "detector_width_mm": 10.0}]},
        # The detector plane would cut through the target path.
        {"views": [{**VIEW, "source_detector_mm": 301.0, "source_isocenter_mm": 300.0}]},
        {"views": [{**VIEW, "extra": 1}]},
        {"target_path": [[5.0, 16.0, 16.0]]},
        {"target_path": [[5.0, 16.0, 16.0], [5.0, 16.0, 16.0]]},
        {"target_path": [[5.0, 16.0, 16.0], [40.0, 16.0, 16.0]]},  # outside the 32 mm grid
        {"isocenter": [-1.0, 16.0, 16.0]},
        {"isocenter": [10.0, 16.0]},
    ]
    for change in rejected:
        response = client.put(route, json=request_body(case, reference, 1, **change))
        assert response.status_code == 422, (change, response.text)
        assert client.get(route).json()["plan_revision"] == 1
    oversized = json.dumps(request_body(case, reference, 1)) + " " * 70000
    assert (
        client.put(
            route, content=oversized, headers={"Content-Type": "application/json"}
        ).status_code
        == 413
    )
    assert client.get(route).json()["plan_revision"] == 1


def test_stale_source_binding_and_revision_conflicts(tmp_path, monkeypatch):
    client, case, reference = configured(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-plan"
    wrong_reference = request_body(case, "0" * 64)
    assert client.put(route, json=wrong_reference).status_code == 409
    wrong_version = request_body(case, reference)
    wrong_version["artifact_version"] = str(int(case["artifact_version"]) + 1)
    assert client.put(route, json=wrong_version).status_code == 409
    assert client.put(route, json=request_body(case, reference, 3)).status_code == 409
    assert client.get(route).json()["plan_revision"] == 0
    assert client.put(route, json=request_body(case, reference)).status_code == 200
    # A case revision makes the saved plan stale without exposing old numbers.
    note = client.patch(
        f"/api/cases/{case['case_id']}/notes",
        json={"artifact_version": case["artifact_version"], "notes": "revision"},
    )
    assert note.status_code == 200, note.text
    stale = client.get(route).json()
    assert stale["plan_revision"] == 1
    assert stale["current"]["status"] == "stale"
    assert stale["current"]["inputs"] is None and stale["current"]["result"] is None


def test_tampered_stored_plan_fails_closed(tmp_path, monkeypatch):
    client, case, reference = configured(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-plan"
    assert client.put(route, json=request_body(case, reference)).status_code == 200
    database = tmp_path.resolve() / "case.sqlite3"
    with closing(sqlite3.connect(database)) as conn, conn:
        stored = json.loads(conn.execute("SELECT result FROM projection_plans").fetchone()[0])
        stored["views"][0]["foreshortening_percent"] = 0.0
        conn.execute("UPDATE projection_plans SET result=?", (json.dumps(stored),))
    response = client.get(route)
    assert response.status_code == 503
    assert "foreshortening" not in response.text


@pytest.mark.parametrize("payload", [b"", b"[]", b"{", b'{"inputs": null}'])
def test_malformed_bodies_are_rejected_before_storage(tmp_path, monkeypatch, payload):
    client, case, _ = configured(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-plan"
    response = client.put(route, content=payload, headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    assert client.get(route).json()["plan_revision"] == 0


def test_local_brief_exports_confirmed_views_without_coordinates(tmp_path, monkeypatch):
    client, case, reference = configured(tmp_path, monkeypatch)
    base = f"/api/cases/{case['case_id']}"
    absent = client.get(base + "/local-brief").json()
    assert absent["projection_plan"] == {"status": "not_confirmed", "plan_revision": 0}
    assert "## C-arm working views" in absent["markdown"]
    assert "No current confirmed C-arm views are included." in absent["markdown"]
    saved = client.put(base + "/projection-plan", json=request_body(case, reference))
    assert saved.status_code == 200, saved.text
    response = client.get(base + "/local-brief")
    assert response.status_code == 200, response.text
    body = response.json()
    plan = body["projection_plan"]
    assert plan["status"] == "current" and plan["plan_revision"] == 1
    assert plan["plan_id"] == saved.json()["current"]["plan_id"]
    assert plan["input_sha256"] == saved.json()["current"]["input_sha256"]
    assert plan["views"][0]["angle_label"] == "LAO 30.0 / CRA 20.0"
    assert (
        plan["views"][0]["foreshortening_percent"]
        == saved.json()["current"]["result"]["views"][0]["foreshortening_percent"]
    )
    markdown = body["markdown"]
    assert "### `Working LAO`" in markdown
    assert "- Angles: LAO 30.0 / CRA 20.0 (primary 30.0, secondary 20.0 degrees)" in markdown
    assert "- Magnification at isocenter: 1.600" in markdown
    assert "no view is registered to an acquired angiogram" in markdown
    for forbidden in ('"isocenter"', '"target_path"', '"inputs"'):
        assert forbidden not in response.text
    # Closed scalar projection: a new key cannot reach the export unreviewed.
    assert set(plan) == {
        "status",
        "plan_revision",
        "plan_id",
        "input_sha256",
        "convention",
        "foreshortening_method",
        "target_point_count",
        "target_length_mm",
        "version",
        "view_source",
        "views",
    }
    assert all(
        set(view)
        == {
            "name",
            "angle_label",
            "primary_deg",
            "secondary_deg",
            "source_detector_mm",
            "source_isocenter_mm",
            "detector_width_mm",
            "detector_height_mm",
            "magnification_at_isocenter",
            "foreshortening_percent",
            "target_in_field",
        }
        for view in plan["views"]
    )
    notes = client.patch(
        base + "/notes", json={"notes": "changed", "artifact_version": case["artifact_version"]}
    )
    assert notes.status_code == 200, notes.text
    stale = client.get(base + "/local-brief").json()
    assert stale["projection_plan"] == {
        "status": "stale",
        "plan_revision": 1,
        "plan_id": plan["plan_id"],
    }
    assert "No current confirmed C-arm views are included." in stale["markdown"]
    assert "Working LAO" not in stale["markdown"]


def test_local_brief_fails_closed_on_a_tampered_plan(tmp_path, monkeypatch):
    client, case, reference = configured(tmp_path, monkeypatch)
    base = f"/api/cases/{case['case_id']}"
    assert (
        client.put(base + "/projection-plan", json=request_body(case, reference)).status_code == 200
    )
    with closing(sqlite3.connect(tmp_path.resolve() / "case.sqlite3")) as conn, conn:
        conn.execute("UPDATE projection_plans SET input_sha256=?", ("0" * 64,))
    response = client.get(base + "/local-brief")
    assert response.status_code == 503
    assert "markdown" not in response.json()
