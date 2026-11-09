"""Expose already-coherent scalar evidence for the guided frontend."""

from test_geometry_server import metrics
from test_phase5_scenario_brief import configured, current_geometry


def test_brief_contains_exact_coherent_planning_projection(tmp_path, monkeypatch):
    client, case, reference, _ = configured(tmp_path, monkeypatch, lambda job: metrics())
    computed = current_geometry(client, case, reference)
    route = f"/api/cases/{case['case_id']}"
    expected = client.get(route + "/planning-context")
    assert expected.status_code == 200, expected.text
    brief = client.get(route + "/local-brief")
    assert brief.status_code == 200, brief.text
    assert brief.json().get("planning") == expected.json()
    assert (
        brief.json()["planning"]["morphometry_summary"]["result_id"]
        == computed["current"]["result_id"]
    )


def test_brief_admits_documented_short_provider_ids(tmp_path, monkeypatch):
    from types import SimpleNamespace

    from planner import geometry_state, segmentation_state

    candidates = iter(("v", "a"))
    # Declared synthetic token factories exercise the wire schema. Production
    # factories currently generate 22-character tokens, not these short IDs.
    monkeypatch.setattr(
        segmentation_state, "secrets", SimpleNamespace(token_urlsafe=lambda _: next(candidates))
    )
    monkeypatch.setattr(geometry_state, "secrets", SimpleNamespace(token_urlsafe=lambda _: "g"))
    client, case, reference, _ = configured(tmp_path, monkeypatch, lambda job: metrics())
    current_geometry(client, case, reference)
    response = client.get(f"/api/cases/{case['case_id']}/local-brief")
    assert response.status_code == 200, response.text
    planning = response.json()["planning"]
    assert {s["candidate_id"] for s in planning["segmentation_summary"]} == {"v", "a"}
    assert planning["morphometry_summary"]["result_id"] == "g"


def test_conflict_inside_scenario_reader_is_already_guarded_as_409(tmp_path, monkeypatch):
    from test_device_scenarios import scenario
    from test_phase5_scenario_brief import save_alternatives

    from planner.device_scenarios import DeviceScenarioLedger

    client, case, reference, db = configured(tmp_path, monkeypatch, lambda job: metrics())
    current_geometry(client, case, reference)
    _, saved = save_alternatives(client, case, None)
    original = DeviceScenarioLedger.read
    ledger = DeviceScenarioLedger(db)
    reads = 0

    def interleaved(self, identity):
        nonlocal reads
        reads += 1
        if reads == 2:
            ledger.store(
                identity,
                saved["scenario_revision"],
                [scenario(id="replacement00", name="Replacement")],
            )
        return original(self, identity)

    monkeypatch.setattr(DeviceScenarioLedger, "read", interleaved)
    response = client.get(f"/api/cases/{case['case_id']}/local-brief")
    assert response.status_code == 409, response.text
    assert response.headers["cache-control"] == "no-store"
    assert "markdown" not in response.json()
    assert reads == 2
