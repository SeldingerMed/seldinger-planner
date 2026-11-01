"""Case-bound sizing HTTP using SYNTHETIC metadata, never real CTA values."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from test_device_inputs_server import setup_api
from test_device_inputs_state import PROVENANCE

from planner.device_calculation import DEVICE_SIZING_CALCULATION_VERSION
from planner.device_checks import device_catalog
from planner.device_results_read import register_device_result_read_routes
from planner.device_results_server import register_device_calculation_routes
from planner.device_results_state import DeviceResultsLedger
from planner.server import build_app

SYNTHETIC_VALUES = {
    "proximal_parent": 3.0,
    "distal_parent": 3.5,
    "neck_coverage_length": 8.0,
    "average_sac_diameter": 6.0,
    "smallest_sac_height": 5.0,
    "dome_diameter": 6.5,
}


def setup_calculation(tmp_path, measurements=None, **kwargs):
    _, case, inputs, snapshot, workspace, geometry = setup_api(tmp_path)
    inputs.save_inputs(
        case["case_id"],
        snapshot,
        SYNTHETIC_VALUES if measurements is None else measurements,
        PROVENANCE,
        None,
    )
    results = DeviceResultsLedger(inputs.db_path)
    app = FastAPI()
    reader = register_device_result_read_routes(app, inputs, results, geometry)
    register_device_calculation_routes(app, results, reader, **kwargs)
    report = reader(case["case_id"])
    payload = {
        k: report[k]
        for k in (
            "artifact_version",
            "reference_revision",
            "geometry_result_id",
            "catalog_version",
            "calculation_version",
        )
    }
    payload.update({k: report["inputs"][k] for k in ("input_revision", "inputs_sha256")})
    return TestClient(app), case, inputs, results, reader, payload, workspace, snapshot


def test_post_calculates_persists_and_reopens_bound_synthetic_values(tmp_path):
    http, case, _inputs, _results, reader, payload, workspace, _ = setup_calculation(tmp_path)
    response = http.post(f"/api/cases/{case['case_id']}/device-sizing", json=payload)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["current"]["status"] == "current"
    report = body["current"]["result"]
    assert report["binding_status"] == "case_bound_calculation"
    assert report["pipeline"]["minimum_labeled_coverage_length_mm"] == 14.0
    assert report["web"]["nominal_target_diameter_mm"] == 7.0
    assert report["web"]["nominal_target_height_mm"] == 4.0
    assert report["validated_sizing"] is False
    assert body == reader(case["case_id"])
    assert (
        workspace.get(f"/api/cases/{case['case_id']}").json()["artifact_version"]
        == case["artifact_version"]
    )


@pytest.mark.parametrize(
    "field,value",
    [
        ("artifact_version", "999"),
        ("reference_revision", "e" * 64),
        ("geometry_result_id", "superseded"),
        ("input_revision", "superseded"),
        ("inputs_sha256", "e" * 64),
        ("catalog_version", "e" * 64),
        ("calculation_version", "old-version"),
    ],
)
def test_post_rejects_stale_expected_context_without_persistence(tmp_path, field, value):
    http, case, _, _, reader, payload, _, _ = setup_calculation(tmp_path)
    payload[field] = value
    response = http.post(f"/api/cases/{case['case_id']}/device-sizing", json=payload)
    assert response.status_code == 409
    assert response.headers["cache-control"] == "no-store"
    assert reader(case["case_id"])["current"]["status"] == "not_computed"


def test_post_input_replacement_during_calculation_rejects_without_result(tmp_path, monkeypatch):
    from test_device_inputs_state import SOURCE

    import planner.device_results_server as server
    from planner.device_calculation import calculate_reported_sizing

    http, case, inputs, _, reader, payload, _, snapshot = setup_calculation(tmp_path)

    def racing_calculator(measurements, provenance):
        current = inputs.inputs(case["case_id"], SOURCE)
        inputs.save_inputs(
            case["case_id"],
            snapshot,
            {**SYNTHETIC_VALUES, "neck_coverage_length": 9.0},
            PROVENANCE,
            current["input_revision"],
        )
        return calculate_reported_sizing(measurements, provenance)

    monkeypatch.setattr(server, "calculate_reported_sizing", racing_calculator)
    response = TestClient(http.app, raise_server_exceptions=False).post(
        f"/api/cases/{case['case_id']}/device-sizing", json=payload
    )
    assert response.status_code == 409
    assert response.headers["cache-control"] == "no-store"
    assert reader(case["case_id"])["current"]["status"] == "not_computed"


@pytest.mark.parametrize(
    "mode,status",
    [
        ("query", 422),
        ("extra", 422),
        ("bool", 422),
        ("missing", 422),
        ("text", 415),
        ("oversize", 413),
        ("giant_length", 413),
        ("negative_length", 400),
    ],
)
def test_post_bounded_metadata_only_protocol(tmp_path, mode, status):
    http, case, _, _, reader, payload, _, _ = setup_calculation(tmp_path)
    kwargs = {"json": payload}
    if mode == "query":
        kwargs["params"] = {"source": "other"}
    elif mode == "extra":
        payload["measurements"] = {"neck_coverage_length": 99}
    elif mode == "bool":
        payload["artifact_version"] = True
    elif mode == "missing":
        kwargs["json"] = {}
    elif mode == "text":
        kwargs = {"content": "not json", "headers": {"Content-Type": "text/plain"}}
    elif mode == "oversize":
        kwargs = {"content": b" " * 4097, "headers": {"Content-Type": "application/json"}}
    elif mode == "giant_length":
        kwargs["headers"] = {"Content-Length": "9" * 5000}
    elif mode == "negative_length":
        kwargs["headers"] = {"Content-Length": "-1"}
    response = TestClient(http.app, raise_server_exceptions=False).post(
        f"/api/cases/{case['case_id']}/device-sizing", **kwargs
    )
    assert response.status_code == status
    assert response.headers["cache-control"] == "no-store"
    assert reader(case["case_id"])["current"]["status"] == "not_computed"


def test_post_commit_then_input_change_requires_reload_not_false_success(tmp_path):
    from contextlib import closing

    from test_device_inputs_state import SOURCE

    from planner.workspace import _connect

    http, case, inputs, results, reader, payload, _, snapshot = setup_calculation(tmp_path)
    original = results.store

    def changed_after_commit(case_id, dependencies, result):
        stored = original(case_id, dependencies, result)
        current = inputs.inputs(case_id, SOURCE)
        inputs.save_inputs(case_id, snapshot, {}, PROVENANCE, current["input_revision"])
        return stored

    results.store = changed_after_commit
    response = http.post(f"/api/cases/{case['case_id']}/device-sizing", json=payload)
    assert response.status_code == 409
    assert response.headers["cache-control"] == "no-store"
    assert reader(case["case_id"])["current"]["result"] is None
    assert http.post(f"/api/cases/{case['case_id']}/device-sizing", json=payload).status_code == 409
    with closing(_connect(inputs.db_path)) as conn:
        assert conn.execute("SELECT count(*) FROM device_results").fetchone()[0] == 1


@pytest.mark.parametrize("stage", ["calculator", "store"])
def test_post_sanitizes_execution_failure(tmp_path, monkeypatch, stage):
    import planner.device_results_server as server

    http, case, _, results, reader, payload, _, _ = setup_calculation(tmp_path)

    def broken(*args):
        raise RuntimeError("private-path-provider-diagnostic")

    if stage == "calculator":
        monkeypatch.setattr(server, "calculate_reported_sizing", broken)
    else:
        results.store = broken
    response = TestClient(http.app, raise_server_exceptions=False).post(
        f"/api/cases/{case['case_id']}/device-sizing", json=payload
    )
    assert response.status_code == 503
    assert response.headers["cache-control"] == "no-store"
    assert "private-path" not in response.text
    assert reader(case["case_id"])["current"]["status"] == "not_computed"


def test_default_app_composes_sizing_post(tmp_path):
    response = TestClient(build_app(tmp_path / "default.sqlite3")).post(
        "/api/cases/missing/device-sizing",
        json={
            "artifact_version": "1",
            "reference_revision": "a" * 64,
            "geometry_result_id": "missing",
            "input_revision": "missing",
            "inputs_sha256": "a" * 64,
            "catalog_version": device_catalog()["catalog_version"],
            "calculation_version": DEVICE_SIZING_CALCULATION_VERSION,
        },
    )
    assert response.status_code == 404
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["detail"] == "Case not found"
