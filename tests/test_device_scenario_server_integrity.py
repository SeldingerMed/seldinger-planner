"""Scope, upstream-result replacement and postcommit acknowledgement regressions."""

import hashlib
import json

import pytest
from test_device_scenario_server import routes
from test_device_scenarios import scenario

from planner.device_checks import device_catalog, encoded
from planner.workspace import _connect


def request_body(client, case):
    url = f"/api/cases/{case['case_id']}/device-scenarios"
    before = client.get(url)
    assert before.status_code == 200, before.text
    data = before.json()
    body = {
        key: data[key]
        for key in (
            "image_sha256",
            "artifact_version",
            "reference_revision",
            "geometry_result_id",
            "catalog_version",
        )
    }
    return url, {
        **body,
        "confirmed": True,
        "scenario_revision": data["scenario_revision"],
        "scenarios": [scenario()],
    }


def count(ledger):
    with _connect(ledger.db_path) as conn:
        return conn.execute("SELECT COUNT(*) FROM device_scenario_sets").fetchone()[0]


@pytest.mark.parametrize(
    "patch",
    [
        {"confirmed": 1},
        {"confirmed": False},
        {"confirmed": "true"},
        {"scenario_revision": True},
        {"path": "/arbitrary/source"},
    ],
)
def test_malformed_confirmations_and_selectors_are_prewrite_422(tmp_path, patch):
    client, case, _, ledger, _ = routes(tmp_path)
    url, body = request_body(client, case)
    response = client.put(url, json={**body, **patch})
    assert response.status_code == 422
    assert count(ledger) == 0


def test_new_materialized_geometry_same_case_revision_refuses_old_expected_id_before_write(
    tmp_path,
):
    client, case, geometry, ledger, identity = routes(tmp_path)
    url, body = request_body(client, case)
    deps = geometry.snapshot(
        case["case_id"], case["artifact_version"], identity["reference_revision"]
    )
    geometry.store(case["case_id"], deps, {"synthetic_geometry_result": True})
    assert client.put(url, json=body).status_code == 409
    assert count(ledger) == 0


def test_postcommit_case_change_is_ambiguous_not_a_rollback(tmp_path, monkeypatch):
    client, case, _, ledger, _ = routes(tmp_path)
    url, body = request_body(client, case)
    original = ledger.store

    def store(*args):
        saved = original(*args)
        response = client.patch(
            f"/api/cases/{case['case_id']}/notes",
            json={
                "artifact_version": case["artifact_version"],
                "notes": "Synthetic postcommit concurrent edit",
            },
        )
        assert response.status_code == 200
        return saved

    monkeypatch.setattr(ledger, "store", store)
    assert client.put(url, json=body).status_code == 409
    assert count(ledger) == 1


def test_oversized_stream_is_rejected_before_any_write(tmp_path):
    client, case, _, ledger, _ = routes(tmp_path)
    url, body = request_body(client, case)
    response = client.put(
        url,
        content=json.dumps(body).encode() + b" " * (128 * 1024),
        headers={"content-type": "application/json"},
    )
    assert response.status_code == 413
    assert count(ledger) == 0


def test_read_catalog_race_is_409_but_bad_catalog_is_503(tmp_path):
    calls = 0

    def changing():
        nonlocal calls
        calls += 1
        value = device_catalog()
        if calls > 1:
            value.pop("catalog_version")
            value["rules"]["pipeline_coverage_margin_mm"] += 1
            value["catalog_version"] = hashlib.sha256(encoded(value).encode()).hexdigest()
        return value

    client, case, _, _, _ = routes(tmp_path / "race", catalog_provider=changing)
    url = f"/api/cases/{case['case_id']}/device-scenarios"
    assert client.get(url).status_code == 409

    def corrupt():
        value = device_catalog()
        value["catalog_version"] = "0" * 64
        return value

    client, case, _, _, _ = routes(tmp_path / "corrupt", catalog_provider=corrupt)
    assert client.get(f"/api/cases/{case['case_id']}/device-scenarios").status_code == 503


def test_default_application_registers_both_scenario_routes(tmp_path):
    from planner.server import build_app

    app = build_app(tmp_path / "workspace.sqlite3")
    methods = set()
    for route in app.routes:
        if getattr(route, "path", None) == "/api/cases/{case_id}/device-scenarios":
            methods.update(getattr(route, "methods", set()))
    assert {"GET", "PUT"} <= methods
