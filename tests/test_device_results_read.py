"""Sizing result GET tracer on synthetic metadata, never real CTA numbers."""

import copy

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from test_device_inputs_server import setup_api
from test_device_inputs_state import MEASUREMENTS, PROVENANCE, SOURCE

from planner.device_calculation import (
    DEVICE_SIZING_CALCULATION_VERSION,
    calculate_reported_sizing,
)
from planner.device_checks import device_catalog
from planner.device_results_read import register_device_result_read_routes
from planner.device_results_state import DeviceResultsLedger


def _bind(inputs, case, snapshot):
    saved = inputs.save_inputs(case["case_id"], snapshot, MEASUREMENTS, PROVENANCE, None)
    catalog = device_catalog()
    geometry_current = inputs.geometry.current(case["case_id"], SOURCE)
    report = calculate_reported_sizing(MEASUREMENTS, PROVENANCE)
    report["binding_status"] = "case_bound_calculation"
    dependencies = {
        "geometry": geometry_current["dependencies"],
        "geometry_result_id": geometry_current["result_id"],
        "input_revision": saved["input_revision"],
        "inputs_sha256": saved["inputs_sha256"],
        "catalog_version": catalog["catalog_version"],
        "calculation_version": DEVICE_SIZING_CALCULATION_VERSION,
    }
    ledger = DeviceResultsLedger(inputs.db_path)
    ledger.store(case["case_id"], dependencies, report)
    return ledger, dependencies, report


def _client(inputs, read_geometry):
    results = DeviceResultsLedger(inputs.db_path)
    app = FastAPI()
    read_report = register_device_result_read_routes(app, inputs, results, read_geometry)
    return TestClient(app), read_report


def _get(client, case_id, params=None):
    return client.get(f"/api/cases/{case_id}/device-sizing", params=params or {})


def test_get_current_full_roundtrip_shape_and_no_store(tmp_path):
    _client_unused, case, inputs, snapshot, _workspace, read_geometry = setup_api(tmp_path)
    ledger, dependencies, report = _bind(inputs, case, snapshot)
    http, read_report = _client(inputs, read_geometry)
    response = _get(http, case["case_id"])
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert set(body) == {
        "case_id",
        "image_sha256",
        "reference_revision",
        "artifact_version",
        "geometry_status",
        "geometry_result_id",
        "geometry_dependencies",
        "catalog_version",
        "calculation_version",
        "inputs",
        "current",
        "clinical_suitability_established",
        "validated_sizing",
    }
    assert body["geometry_status"] == "current"
    assert body["geometry_result_id"] == dependencies["geometry_result_id"]
    assert body["geometry_dependencies"] == dependencies["geometry"]
    assert body["catalog_version"] == dependencies["catalog_version"]
    assert body["calculation_version"] == DEVICE_SIZING_CALCULATION_VERSION
    assert body["clinical_suitability_established"] is False
    assert body["validated_sizing"] is False
    assert body["inputs"]["status"] == "current"
    assert body["current"]["status"] == "current"
    assert (
        body["current"]["result_id"]
        == ledger.current(case["case_id"], SOURCE, dependencies["catalog_version"])["result_id"]
    )
    assert body["current"]["result"]["pipeline"] == report["pipeline"]
    assert read_report(case["case_id"]) == body


def test_get_not_computed_before_any_store(tmp_path):
    _client_unused, case, inputs, _snapshot, _workspace, read_geometry = setup_api(tmp_path)
    http, _read_report = _client(inputs, read_geometry)
    response = _get(http, case["case_id"])
    assert response.status_code == 200
    body = response.json()
    assert body["inputs"]["status"] == "not_saved"
    assert body["inputs"]["measurements"] is None
    assert body["current"] == {"status": "not_computed", "result": None}
    assert body["current"]["status"] == "not_computed"


def test_get_suppresses_numbers_after_input_replacement(tmp_path):
    _client_unused, case, inputs, snapshot, _workspace, read_geometry = setup_api(tmp_path)
    _ledger, _deps, _report = _bind(inputs, case, snapshot)
    first = inputs.inputs(case["case_id"], SOURCE)
    inputs.save_inputs(
        case["case_id"],
        snapshot,
        {"neck_coverage_length": 9.0},
        PROVENANCE,
        first["input_revision"],
    )
    http, _read_report = _client(inputs, read_geometry)
    body = _get(http, case["case_id"]).json()
    assert body["inputs"]["status"] == "current"
    assert body["inputs"]["measurements"]["neck_coverage_length"] == 9.0
    assert body["current"] == {
        "status": "stale",
        "result_id": body["current"]["result_id"],
        "result": None,
        "stale_reasons": ["device_sizing_dependencies_changed"],
    }
    assert body["current"]["result"] is None


def test_get_race_between_input_reads_returns_409(tmp_path):
    _client_unused, case, inputs, snapshot, _workspace, read_geometry = setup_api(tmp_path)
    _bind(inputs, case, snapshot)
    http, _read_report = _client(inputs, read_geometry)
    original = inputs.inputs
    envelopes = iter([original(case["case_id"], SOURCE), {"status": "not_saved", "result": None}])
    inputs.inputs = lambda cid, rev: next(envelopes)
    try:
        response = _get(http, case["case_id"])
    finally:
        inputs.inputs = original
    assert response.status_code == 409
    assert "measurements" not in response.text


def test_get_projects_the_frozen_geometry_not_mutable_provider_alias(tmp_path):
    _, case, inputs, _snapshot, _, read_geometry = setup_api(tmp_path)
    shared = read_geometry(case["case_id"])
    original = inputs.inputs
    calls = 0

    def changing_inputs(cid, revision):
        nonlocal calls
        calls += 1
        if calls == 2:
            shared["artifact_version"] = "999"
        return original(cid, revision)

    inputs.inputs = changing_inputs
    http, _ = _client(inputs, lambda _cid: shared)
    response = _get(http, case["case_id"])
    assert response.status_code == 200
    assert response.json()["artifact_version"] == case["artifact_version"]


def test_get_rejects_current_inputs_from_different_geometry(tmp_path):
    _, case, inputs, snapshot, _, read_geometry = setup_api(tmp_path)
    inputs.save_inputs(case["case_id"], snapshot, MEASUREMENTS, PROVENANCE, None)
    original = inputs.inputs

    def different_geometry(case_id, source_revision):
        envelope = original(case_id, source_revision)
        envelope["geometry_dependencies"]["unexpected_geometry"] = True
        return envelope

    inputs.inputs = different_geometry
    http, _ = _client(inputs, read_geometry)
    response = _get(http, case["case_id"])
    assert response.status_code == 409
    assert "measurements" not in response.text


def test_get_sanitizes_input_encoding_failures(tmp_path):
    _, case, inputs, _, _, read_geometry = setup_api(tmp_path)
    inputs.inputs = lambda case_id, source_revision: {"status": "not_saved", "bad": float("nan")}
    http, _ = _client(inputs, read_geometry)
    response = _get(TestClient(http.app, raise_server_exceptions=False), case["case_id"])
    assert response.status_code == 503
    assert response.headers["cache-control"] == "no-store"
    assert "nan" not in response.text.lower()


def test_default_app_composes_result_get(tmp_path):
    from planner.server import build_app

    response = TestClient(build_app(tmp_path / "default.sqlite3")).get(
        "/api/cases/missing/device-sizing"
    )
    assert response.status_code == 404
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["detail"] == "Case not found"


def test_get_freezes_result_before_later_provider_mutation(tmp_path):
    _, case, inputs, snapshot, _, read_geometry = setup_api(tmp_path)
    ledger, dependencies, _ = _bind(inputs, case, snapshot)
    shared = ledger.current(case["case_id"], SOURCE, dependencies["catalog_version"])
    ledger.current = lambda *args: shared
    original = inputs.inputs
    calls = 0

    def changing_inputs(case_id, source_revision):
        nonlocal calls
        calls += 1
        if calls == 2:
            shared["result"]["validated_sizing"] = True
        return original(case_id, source_revision)

    inputs.inputs = changing_inputs
    app = FastAPI()
    register_device_result_read_routes(app, inputs, ledger, read_geometry)
    response = _get(TestClient(app), case["case_id"])
    assert response.status_code == 200
    assert response.json()["current"]["result"]["validated_sizing"] is False


@pytest.mark.parametrize(
    "provider,bad",
    [
        ("inputs", None),
        ("results", None),
        ("inputs", {"status": "unknown", "measurements": None}),
        ("results", {"status": "stale", "result": {"unsafe": 123}}),
        ("results", {"status": "current", "result": None}),
    ],
)
def test_get_bad_store_envelopes_fail_closed_with_no_store(tmp_path, provider, bad):
    _, case, inputs, _, _, geometry = setup_api(tmp_path)
    results = DeviceResultsLedger(inputs.db_path)
    if provider == "inputs":
        inputs.inputs = lambda *args: bad
    else:
        results.current = lambda *args: bad
    app = FastAPI()
    register_device_result_read_routes(app, inputs, results, geometry)
    response = _get(TestClient(app, raise_server_exceptions=False), case["case_id"])
    assert response.status_code == 503
    assert response.headers["cache-control"] == "no-store"
    assert "123" not in response.text


@pytest.mark.parametrize("malformed,status", [(False, 409), (True, 503)])
def test_reread_distinguishes_valid_change_from_invalid_provider_data(tmp_path, malformed, status):
    _, case, inputs, _, _, geometry = setup_api(tmp_path)
    calls = 0

    def changing(case_id):
        nonlocal calls
        calls += 1
        envelope = copy.deepcopy(geometry(case_id))
        if calls > 1:
            if malformed:
                envelope["current"]["status"] = "stale"  # Invalid: retains numeric geometry.
            else:
                envelope["current"] = {
                    "status": "stale",
                    "result": None,
                    "stale_reasons": ["synthetic_context_change"],
                }
        return envelope

    http, _ = _client(inputs, changing)
    response = _get(http, case["case_id"])
    assert response.status_code == status
    assert response.headers["cache-control"] == "no-store"
    assert "measurements" not in response.text


def test_get_rejects_query_selectors(tmp_path):
    _client_unused, case, inputs, _snapshot, _workspace, read_geometry = setup_api(tmp_path)
    http, _read_report = _client(inputs, read_geometry)
    response = _get(http, case["case_id"], params={"verbose": "true"})
    assert response.status_code == 422
    assert response.headers["cache-control"] == "no-store"


def test_get_sanitizes_provider_failure(tmp_path):
    _client_unused, case, inputs, _snapshot, _workspace, _read_geometry = setup_api(tmp_path)
    _bind(inputs, case, _snapshot)

    def broken_reader(_cid):
        raise RuntimeError("provider exploded")

    http, _read_report = _client(inputs, broken_reader)
    response = _get(http, case["case_id"])
    assert response.status_code == 503
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {"detail": "Device sizing source is unavailable"}


def test_get_rejects_wrong_case_geometry_instead_of_mixing(tmp_path):
    _client0, case, inputs, snapshot, _workspace, read_geometry = setup_api(tmp_path)
    _bind(inputs, case, snapshot)
    forged = copy.deepcopy(read_geometry(case["case_id"]))
    forged["case_id"] = "another-case"
    http, _read_report = _client(inputs, lambda _cid: forged)
    response = _get(http, case["case_id"])
    assert response.status_code == 503
    assert "measurements" not in response.text
