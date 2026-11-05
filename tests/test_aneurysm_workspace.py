from fastapi.testclient import TestClient

from planner.workspace import create_app


def test_aneurysm_plan_is_saved_and_restored_with_source_unit_target(tmp_path):
    path = tmp_path / "workspace.sqlite3"
    client = TestClient(create_app(path))
    case = client.post(
        "/api/cases",
        json={
            "title": "Public-like synthetic metadata",
            "image_sha256": "c" * 64,
            "dimensions": [16, 16, 16],
            "spacing_mm": [1, 1, 1],
            "spatial_units": "unknown",
        },
    ).json()
    plan = {
        "lesion_label": "Operator target",
        "focus_ras": [-12, 8, 32],
        "location_note": "Location not independently confirmed",
        "options": ["coiling", "clipping"],
    }
    response = client.patch(
        f"/api/cases/{case['case_id']}/aneurysm-plan", json={"artifact_version": "1", "plan": plan}
    )
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["artifact_version"] == "2"
    assert saved["aneurysm_plan"]["focus_ras"] == [-12, 8, 32]
    assert saved["aneurysm_plan"]["rupture_status"] == "unknown"
    assert saved["aneurysm_evidence"]["linked_measurements"] == []
    reopened = TestClient(create_app(path)).get(f"/api/cases/{case['case_id']}").json()
    assert reopened == saved


def test_export_includes_saved_worksheet_and_its_evidence_boundary(tmp_path):
    client = TestClient(create_app(tmp_path / "workspace.sqlite3"))
    case = client.post(
        "/api/cases",
        json={
            "title": "Synthetic planning fixture",
            "image_sha256": "d" * 64,
            "dimensions": [16, 16, 16],
            "spacing_mm": [1, 1, 1],
            "spatial_units": "unknown",
        },
    ).json()
    response = client.patch(
        f"/api/cases/{case['case_id']}/aneurysm-plan",
        json={
            "artifact_version": "1",
            "plan": {
                "lesion_label": "Operator target",
                "focus_ras": [1, 2, 3],
                "options": ["coiling", "clipping"],
                "questions": "Which anatomical evidence is still needed?",
                "rupture_status": "unknown",
            },
        },
    )
    assert response.status_code == 200
    brief = client.get(f"/api/cases/{case['case_id']}/brief").text
    assert "## Aneurysm worksheet" in brief
    assert "Operator target" in brief and "coiling" in brief and "clipping" in brief
    assert "Which anatomical evidence is still needed?" in brief
    assert "RAS source units" in brief
    assert "not validated morphometry" in brief


def test_plan_evidence_is_case_bound_and_stale_writes_do_not_overwrite(tmp_path):
    client = TestClient(create_app(tmp_path / "workspace.sqlite3"))
    cases = [
        client.post(
            "/api/cases",
            json={
                "title": "Synthetic scope fixture",
                "image_sha256": ch * 64,
                "dimensions": [16, 16, 16],
                "spacing_mm": [1, 1, 1],
            },
        ).json()
        for ch in ("a", "b")
    ]
    own = cases[0]["case_id"]
    foreign = cases[1]["case_id"]

    def measure(cid):
        return client.post(
            f"/api/cases/{cid}/measurements",
            json={
                "artifact_version": "1",
                "label": "Manual test pair",
                "point_a_mm": [0, 0, 0],
                "point_b_mm": [0, 3, 4],
            },
        ).json()["measurements"][0]["measurement_id"]

    other_id = measure(foreign)
    rejected = client.patch(
        f"/api/cases/{own}/aneurysm-plan",
        json={"artifact_version": "1", "plan": {"measurement_links": {"neck_width": other_id}}},
    )
    assert rejected.status_code == 422
    assert "calibrated" not in rejected.json()["detail"]
    assert "same-case" in rejected.json()["detail"]
    assert client.get(f"/api/cases/{own}").json()["artifact_version"] == "1"
    own_id = measure(own)
    payload = {"artifact_version": "2", "plan": {"measurement_links": {"neck_width": own_id}}}
    saved = client.patch(f"/api/cases/{own}/aneurysm-plan", json=payload).json()
    assert saved["artifact_version"] == "3"
    linked = saved["aneurysm_evidence"]["linked_measurements"][0]
    assert linked["distance_mm"] == 5 and linked["validated_morphometry"] is False
    stale = client.patch(
        f"/api/cases/{own}/aneurysm-plan",
        json={**payload, "plan": {"lesion_label": "Must not overwrite"}},
    )
    assert stale.status_code == 409
    assert client.get(f"/api/cases/{own}").json() == saved
    duplicate = client.patch(
        f"/api/cases/{own}/aneurysm-plan",
        json={
            "artifact_version": "3",
            "plan": {"measurement_links": {"sac_width": own_id, "neck_width": own_id}},
        },
    )
    assert duplicate.status_code == 422
    assert client.get(f"/api/cases/{own}").json() == saved
