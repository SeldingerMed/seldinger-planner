"""HTTP tracer using actual temporary SQLite producers and synthetic geometry."""

from test_device_scenarios import scenario, seeded


def routes(tmp_path, **kwargs):
    from planner.device_scenario_server import register_device_scenario_routes

    tmp_path.mkdir(parents=True, exist_ok=True)
    client, case, geometry, ledger, _, identity = seeded(tmp_path)

    def read_geometry(case_id):
        state = client.get(f"/api/cases/{case_id}").json()
        return {
            **{key: state[key] for key in ("case_id", "image_sha256", "artifact_version")},
            "reference_revision": identity["reference_revision"],
            "operator_inputs": geometry.inputs(case_id, identity["reference_revision"]),
            "current": geometry.current(case_id, identity["reference_revision"]),
        }

    register_device_scenario_routes(client.app, ledger, read_geometry, **kwargs)
    return client, case, geometry, ledger, identity


def test_confirm_save_reload_exact_source_bound_alternatives(tmp_path):
    client, case, _, _, _ = routes(tmp_path)
    url = f"/api/cases/{case['case_id']}/device-scenarios"
    initial = client.get(url)
    assert initial.status_code == 200, initial.text
    before = initial.json()
    assert before["scenario_revision"] == 0
    assert before["current"]["status"] == "not_computed"
    payload = {
        key: before[key]
        for key in (
            "image_sha256",
            "artifact_version",
            "reference_revision",
            "geometry_result_id",
            "catalog_version",
        )
    }
    payload.update(
        confirmed=True,
        scenario_revision=0,
        scenarios=[scenario(), scenario(id="second-123456", name="Second")],
    )
    saved = client.put(url, json=payload)
    assert saved.status_code == 200, saved.text
    assert saved.json()["scenario_revision"] == 1
    assert saved.json()["current"]["status"] == "current"
    assert len(saved.json()["current"]["scenarios"]) == 2
    reloaded = client.get(url)
    assert reloaded.json() == saved.json()
    assert reloaded.headers["cache-control"] == "no-store"
    assert (
        client.get(f"/api/cases/{case['case_id']}").json()["artifact_version"]
        == case["artifact_version"]
    )
