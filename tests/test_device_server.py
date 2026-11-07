"""HTTP conformance with the real geometry producer shape, no pixels/models."""

import copy
import json
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from planner.device_server import register_device_routes


def test_projection_uses_the_frozen_snapshot_even_if_shared_provider_reverts(monkeypatch):
    import planner.device_server as server

    original = server.case_device_checks
    shared = geometry()
    expected = shared["current"]["result"]["proximal_parent"]["max_diameter"]

    def project(snapshot, catalog):
        shared["current"]["result"]["proximal_parent"]["max_diameter"] = 99.0
        try:
            return original(snapshot, catalog)
        finally:
            shared["current"]["result"]["proximal_parent"]["max_diameter"] = expected

    monkeypatch.setattr(server, "case_device_checks", project)
    app = FastAPI()
    register_device_routes(app, lambda _: shared)
    result = TestClient(app).get(f"/api/cases/{shared['case_id']}/device-checks")
    assert result.status_code == 200
    assert (
        result.json()["checks"]["pipeline"]["parent_sections"]["proximal_parent"]["max_diameter_mm"]
        == expected
    )


def test_real_app_composition_preserves_case_and_source_guards(tmp_path):
    from planner.server import build_app

    client = TestClient(build_app(tmp_path / "workspace.sqlite3"))
    assert client.get("/api/device-catalog").status_code == 200
    assert client.get("/api/cases/does-not-exist/device-checks").status_code == 404
    created = client.post(
        "/api/cases",
        json={
            "title": "Synthetic unknown-unit case",
            "image_sha256": "0" * 64,
            "source_url": None,
            "dimensions": [2, 2, 2],
            "spacing_mm": [1, 1, 1],
            "spatial_units": "unknown",
        },
    )
    assert created.status_code == 200
    response = client.get(f"/api/cases/{created.json()['case_id']}/device-checks")
    # This synthetic hash has no installed source, rejected before the unit gate.
    assert response.status_code == 404
    assert "checks" not in response.json()


def geometry():
    return json.loads(
        (Path(__file__).parents[1] / "web/src/fixtures/geometry-current-metadata.json").read_text()
    )


def test_catalog_and_current_case_use_default_catalog_and_bound_reader():
    app = FastAPI()
    env = geometry()
    calls = []

    def read(case_id):
        calls.append(case_id)
        return copy.deepcopy(env)

    register_device_routes(app, read)
    client = TestClient(app)
    catalog = client.get("/api/device-catalog")
    assert catalog.status_code == 200
    assert catalog.headers["cache-control"] == "no-store"
    response = client.get(f"/api/cases/{env['case_id']}/device-checks")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    result = response.json()
    assert result["catalog_version"] == catalog.json()["catalog_version"]
    assert result["status"] == "partial_inputs"
    assert calls == [env["case_id"], env["case_id"]]


@pytest.mark.parametrize("change", ["case", "source", "result", "numbers", "stale"])
def test_geometry_interleaving_never_returns_mixed_numbers(change):
    app = FastAPI()
    env = geometry()
    calls = 0

    def read(_case_id):
        nonlocal calls
        calls += 1
        if calls == 2:
            if change == "case":
                env["artifact_version"] = "changed"
            elif change == "source":
                env["reference_revision"] = "changed"
            elif change == "result":
                env["current"]["result_id"] = "changed"
            elif change == "numbers":
                env["current"]["result"]["proximal_parent"]["max_diameter"] = 4.0
            else:
                env["current"] = {"status": "stale", "result": None}
        return env  # Deliberately shared object: token must be frozen before the second read.

    register_device_routes(app, read)
    response = TestClient(app).get(f"/api/cases/{env['case_id']}/device-checks")
    assert response.status_code == 409
    assert "checks" not in response.json()


def test_catalog_race_and_provider_failures_are_closed():
    import hashlib

    from planner.device_checks import device_catalog, encoded

    initial = device_catalog()
    updated = copy.deepcopy(initial)
    updated["pipeline"]["source"]["revision"] = "different installed edition"
    updated["catalog_version"] = hashlib.sha256(
        encoded({k: v for k, v in updated.items() if k != "catalog_version"}).encode()
    ).hexdigest()
    versions = iter([initial, updated])
    app = FastAPI()
    register_device_routes(app, lambda _: geometry(), catalog_provider=lambda: next(versions))
    assert (
        TestClient(app).get(f"/api/cases/{geometry()['case_id']}/device-checks").status_code == 409
    )


@pytest.mark.parametrize("where", ["catalog", "geometry"])
def test_provider_error_is_sanitized(where):
    def broken(*_):
        raise OSError("/private/server/path")

    app = FastAPI()
    if where == "catalog":
        register_device_routes(app, lambda _: geometry(), catalog_provider=broken)
    else:
        register_device_routes(app, broken)
    client = TestClient(app, raise_server_exceptions=False)
    url = "/api/device-catalog" if where == "catalog" else "/api/cases/test/device-checks"
    response = client.get(url)
    assert response.status_code == 503
    assert "/private" not in response.text


def test_underlying_binding_error_and_selector_refusal():
    def read(_):
        raise HTTPException(409, "Confirmed millimeter source geometry is required")

    app = FastAPI()
    register_device_routes(app, read)
    client = TestClient(app)
    assert client.get("/api/cases/test/device-checks").status_code == 409
    assert client.get("/api/cases/test/device-checks?path=/etc/passwd").status_code == 422
    assert client.get("/api/device-catalog?source=other").status_code == 422
