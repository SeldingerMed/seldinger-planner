"""Scenario catalogue identity binds sizing rules and the authored visual catalogue."""

import hashlib
import json

import pytest

from planner.device_checks import device_catalog, encoded, validate_catalog


def test_scenario_catalog_binds_authored_catalogue_with_recomputed_version():
    from planner.device_scenario_catalog import scenario_catalog

    catalog = scenario_catalog()
    validate_catalog(catalog)
    raw = {k: v for k, v in catalog.items() if k != "catalog_version"}
    assert catalog["catalog_version"] == hashlib.sha256(encoded(raw).encode()).hexdigest()
    # The combined version is not the historical sizing-only version.
    assert catalog["catalog_version"] != device_catalog()["catalog_version"]


def test_visualization_metadata_matches_authored_frontend_bytes():

    from planner.device_scenario_catalog import authored_catalog_path

    raw_bytes = authored_catalog_path().read_bytes()
    from planner.device_scenario_catalog import scenario_catalog

    catalog = scenario_catalog()
    visualization = catalog["visualization"]
    assert set(visualization) == {
        "catalog_version",
        "source_sha256",
        "procedural_model_version",
    }
    assert visualization["source_sha256"] == hashlib.sha256(raw_bytes).hexdigest()
    authored = json.loads(raw_bytes)
    assert visualization["catalog_version"] == authored["catalogVersion"]
    assert visualization["procedural_model_version"] == "procedural-device-v2"
    assert catalog["procedural_model_version"] == "procedural-device-v2"
    # Exact authored catalogue content is bound, untransformed (null sizes stay null).
    assert catalog["authored_catalog"]["devices"] == authored["devices"]
    assert catalog["authored_catalog"]["catalog_version"] == authored["catalogVersion"]
    # No client filesystem paths are exposed.
    assert "web/src" not in encoded(catalog)


def test_combined_version_changes_when_authored_catalogue_changes(tmp_path, monkeypatch):
    from planner import device_scenario_catalog

    authored = {
        "catalogVersion": "synthetic-authored-fixture-v1",
        "devices": [
            {"id": "synthetic-a", "name": "Synthetic A", "sizes": None},
            {"id": "synthetic-b", "name": "Synthetic B", "sizes": [1]},
        ],
    }
    fixture = tmp_path / "catalog.json"
    fixture.write_bytes(json.dumps(authored).encode())
    monkeypatch.setattr(device_scenario_catalog, "AUTHORED_CATALOG_PATH", fixture, raising=True)
    first = device_scenario_catalog.scenario_catalog()
    assert first["visualization"]["catalog_version"] == "synthetic-authored-fixture-v1"
    authored["devices"][0]["name"] = "Changed"
    fixture.write_bytes(json.dumps(authored).encode())
    second = device_scenario_catalog.scenario_catalog()
    assert second["catalog_version"] != first["catalog_version"]


def test_combined_version_changes_when_base_sizing_catalog_changes(monkeypatch):
    from planner import device_scenario_catalog

    base = device_catalog()
    base["rules"]["pipeline_coverage_margin_mm"] = 0.75
    monkeypatch.setattr(device_scenario_catalog, "device_catalog", lambda: base, raising=True)
    altered = device_scenario_catalog.scenario_catalog()
    monkeypatch.undo()
    assert (
        altered["catalog_version"] != device_scenario_catalog.scenario_catalog()["catalog_version"]
    )


@pytest.mark.parametrize(
    "mutation",
    [
        lambda d: d.pop("devices"),
        lambda d: d["devices"].append({"id": "synthetic-a"}),
        lambda d: d["devices"].append(dict(d["devices"][0])),
    ],
)
def test_malformed_authored_catalogue_is_rejected(tmp_path, monkeypatch, mutation):
    from planner import device_scenario_catalog

    authored = {
        "catalogVersion": "synthetic-authored-fixture-v1",
        "devices": [{"id": "synthetic-a"}, {"id": "synthetic-b"}],
    }
    mutation(authored)
    fixture = tmp_path / "catalog.json"
    fixture.write_bytes(json.dumps(authored).encode())
    monkeypatch.setattr(device_scenario_catalog, "AUTHORED_CATALOG_PATH", fixture, raising=True)
    with pytest.raises(ValueError):
        device_scenario_catalog.scenario_catalog()


def test_metadata_route_returns_authoritative_renderer_metadata(tmp_path):
    from test_device_scenario_server import routes

    client, _case, _, _, _ = routes(tmp_path)
    response = client.get("/api/device-scenario-catalog")
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    from planner.device_scenario_catalog import scenario_catalog

    assert body == scenario_catalog()
    visualization = body["visualization"]
    assert set(visualization) == {
        "catalog_version",
        "source_sha256",
        "procedural_model_version",
    }


def test_metadata_route_accepts_no_selectors_and_sanitizes_errors(tmp_path):
    from test_device_scenario_server import routes

    client, _case, _, _, _ = routes(
        tmp_path, catalog_provider=lambda: (_ for _ in ()).throw(ValueError("provider broken"))
    )
    rejected = client.get("/api/device-scenario-catalog", params={"x": "1"})
    assert rejected.status_code == 422
    broken = client.get("/api/device-scenario-catalog")
    assert broken.status_code == 503
    assert broken.headers["cache-control"] == "no-store"
    assert "zero" not in broken.text.lower() and "division" not in broken.text.lower()


def test_scenarios_routes_use_default_scenario_catalog_provider(tmp_path):
    from test_device_scenario_server import routes

    client, case, _, _, _ = routes(tmp_path)
    catalog = client.get("/api/device-scenario-catalog").json()
    url = f"/api/cases/{case['case_id']}/device-scenarios"
    initial = client.get(url)
    assert initial.status_code == 200, initial.text
    payload = {
        key: initial.json()[key]
        for key in (
            "image_sha256",
            "artifact_version",
            "reference_revision",
            "geometry_result_id",
            "catalog_version",
        )
    }
    assert payload["catalog_version"] == catalog["catalog_version"]
    payload.update(
        confirmed=True,
        scenario_revision=0,
        scenarios=[],
    )
    saved = client.put(url, json=payload)
    assert saved.status_code == 200, saved.text
    assert saved.json()["catalog_version"] == catalog["catalog_version"]


def test_metadata_route_rejects_contradictory_provider_catalog(tmp_path):
    from test_device_scenario_server import routes

    bad = device_catalog()
    bad["rules"]["pipeline_coverage_margin_mm"] = 99
    client, *_ = routes(tmp_path, catalog_provider=lambda: bad)
    response = client.get("/api/device-scenario-catalog")
    assert response.status_code == 503, response.text
    assert "99" not in response.text


def test_metadata_route_conflicts_on_a_well_formed_changed_catalog(tmp_path):
    from copy import deepcopy

    from test_device_scenario_server import routes

    first = device_catalog()
    second = deepcopy(first)
    second["rules"]["pipeline_coverage_margin_mm"] = 0.75
    second["catalog_version"] = hashlib.sha256(
        encoded({k: v for k, v in second.items() if k != "catalog_version"}).encode()
    ).hexdigest()
    calls = []

    def provider():
        calls.append(True)
        return first if len(calls) == 1 else second

    client, *_ = routes(tmp_path, catalog_provider=provider)
    response = client.get("/api/device-scenario-catalog")
    assert response.status_code == 409, response.text
    assert "catalog_version" not in response.json()


def test_metadata_route_rejects_nonfinite_provider_before_serialization(tmp_path):
    from test_device_scenario_server import routes

    bad = device_catalog()
    bad["untrusted_number"] = float("inf")
    client, *_ = routes(tmp_path, catalog_provider=lambda: bad)
    response = client.get("/api/device-scenario-catalog")
    assert response.status_code == 503, response.text


def test_non_finite_authored_json_is_rejected(tmp_path, monkeypatch):
    from planner import device_scenario_catalog

    fixture = tmp_path / "catalog.json"
    fixture.write_bytes(b'{"catalogVersion":"v1","devices":[],"bad":NaN}')
    monkeypatch.setattr(device_scenario_catalog, "AUTHORED_CATALOG_PATH", fixture, raising=True)
    with pytest.raises(ValueError):
        device_scenario_catalog.scenario_catalog()
