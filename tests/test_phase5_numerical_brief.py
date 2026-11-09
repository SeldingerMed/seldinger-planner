"""Actual default-app composition of source-bound numerical scalars into export."""

from test_geometry_server import metrics
from test_phase5_scenario_brief import configured, current_geometry
from test_physics_server import rod_output


def numerical_case(tmp_path, monkeypatch):
    from planner import physics_server

    client, case, reference, db = configured(tmp_path, monkeypatch, lambda job: metrics())
    geometry = current_geometry(client, case, reference)
    monkeypatch.setattr(physics_server, "default_runner", lambda: lambda job, **_: rod_output(job))
    body = {
        "artifact_version": geometry["artifact_version"],
        "reference_revision": reference,
        "geometry_result_id": geometry["current"]["result_id"],
        "parameters": {
            "radius_mm": 0.2,
            "ea_n": 1.0,
            "ei_n_mm2": 0.01,
            "contact_stiffness_n_per_mm": 1000.0,
        },
    }
    return client, case["case_id"], f"/api/cases/{case['case_id']}/physics/rod-deployment", body, db


def test_brief_includes_validated_anatomy_parameter_run_not_device_attribution(
    tmp_path, monkeypatch
):
    client, cid, route, body, _db = numerical_case(tmp_path, monkeypatch)
    saved = client.post(route, json=body)
    assert saved.status_code == 200, saved.text
    read = client.get(route)
    assert read.status_code == 200, read.text
    response = client.get(f"/api/cases/{cid}/local-brief")
    assert response.status_code == 200, response.text
    runs = response.json().get("numerical_runs")
    assert isinstance(runs, list) and len(runs) == 2
    rod = next(row for row in runs if row["kind"] == "rod-deployment")
    assert rod["status"] == "current"
    assert rod["scope"] == "anatomy_operator_parameters"
    assert rod.get("geometry_result_id") == body["geometry_result_id"]
    assert rod["result_id"] == read.json()["current"]["result_id"]
    assert rod["parameters_sha256"] == read.json()["current"]["parameters_sha256"]
    assert rod["energy_final_n_mm"] == 0.5
    assert "points_ras" not in rod and "device_id" not in rod
    assert next(row for row in runs if row["kind"] == "stokes-flow")["status"] == "not_computed"
    markdown = response.json()["markdown"]
    assert "## Numerical runs on this anatomy" in markdown
    assert rod["result_id"] in markdown and rod["parameters_sha256"] in markdown
    assert "independent of the saved device alternatives" in markdown
    assert response.headers["cache-control"] == "no-store"


def test_replacement_run_during_projection_is_a_conflict_even_without_case_change(
    tmp_path, monkeypatch
):
    from planner import local_brief
    from planner.physics_state import PhysicsLedger

    client, cid, route, body, db = numerical_case(tmp_path, monkeypatch)
    assert client.post(route, json=body).status_code == 200
    original = local_brief.project_numerical
    replacements = []

    def interleaved(identity, kind, envelope, geometry):
        projected = original(identity, kind, envelope, geometry)
        if not replacements:
            current = envelope["current"]
            replacement = PhysicsLedger(db).store(
                cid,
                body["reference_revision"],
                kind,
                current["dependencies"],
                current["parameters"],
                current["result"],
            )
            replacements.append(replacement["result_id"])
        return projected

    monkeypatch.setattr(local_brief, "project_numerical", interleaved)
    response = client.get(f"/api/cases/{cid}/local-brief")
    assert response.status_code == 409, response.text
    assert "markdown" not in response.json() and "numerical_runs" not in response.json()
    assert client.get(f"/api/cases/{cid}").json()["artifact_version"] == body["artifact_version"]
    recovered = client.get(f"/api/cases/{cid}/local-brief")
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["numerical_runs"][0]["result_id"] == replacements[0]


def test_stale_run_does_not_export_old_parameters_or_diagnostics(tmp_path, monkeypatch):
    client, cid, route, body, _db = numerical_case(tmp_path, monkeypatch)
    assert client.post(route, json=body).status_code == 200
    bumped = client.patch(
        f"/api/cases/{cid}/notes",
        json={"artifact_version": body["artifact_version"], "notes": "Synthetic revision"},
    )
    assert bumped.status_code == 200, bumped.text
    computed = client.post(
        f"/api/cases/{cid}/morphometry",
        json={
            "artifact_version": bumped.json()["artifact_version"],
            "reference_revision": body["reference_revision"],
        },
    )
    assert computed.status_code == 200, computed.text
    response = client.get(f"/api/cases/{cid}/local-brief")
    assert response.status_code == 200, response.text
    run = response.json()["numerical_runs"][0]
    assert run == {
        "scope": "anatomy_operator_parameters",
        "kind": "rod-deployment",
        "status": "stale",
    }
    section = response.json()["markdown"].split("## Numerical runs on this anatomy", 1)[1]
    assert "energy_final_n_mm" not in section and "radius_mm" not in section


def test_corrupt_numerical_provider_cannot_escape_through_brief_composition(tmp_path, monkeypatch):
    import sqlite3

    client, cid, route, body, db = numerical_case(tmp_path, monkeypatch)
    assert client.post(route, json=body).status_code == 200
    with sqlite3.connect(db) as conn:
        conn.execute(
            "UPDATE numerical_results SET result=?", ('{"private_path":"/private/never-export"}',)
        )
    response = client.get(f"/api/cases/{cid}/local-brief")
    assert response.status_code == 503, response.text
    assert "never-export" not in response.text and "markdown" not in response.json()
