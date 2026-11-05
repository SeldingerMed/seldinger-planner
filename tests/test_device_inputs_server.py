"""Device-input HTTP tracer on synthetic metadata, never real CTA measurements."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from test_device_inputs_state import SOURCE, fixture

from planner.device_inputs_server import register_device_input_routes


def setup_api(tmp_path):
    workspace, case, _masks, geometry, inputs, snapshot = fixture(tmp_path)
    section = {
        "method": "operator_path_normal_native_mask_section",
        "spatial_units": "mm",
        "validated_morphometry": False,
        "min_diameter": 2.0,
        "max_diameter": 3.0,
        "equivalent_diameter": 2.6,
        "area": 5.3,
    }
    geometry.store(
        case["case_id"],
        snapshot,
        {
            "image_sha256": case["image_sha256"],
            "reference_revision": SOURCE,
            "spatial_units": "mm",
            "validated_morphometry": False,
            "clinical_validation": False,
            "proximal_parent": section,
            "distal_parent": section,
        },
    )

    def read_geometry(cid):
        current = workspace.get(f"/api/cases/{cid}").json()
        return {
            "case_id": cid,
            "image_sha256": current["image_sha256"],
            "reference_revision": SOURCE,
            "artifact_version": current["artifact_version"],
            "current": geometry.current(cid, SOURCE),
        }

    app = FastAPI()
    register_device_input_routes(app, inputs, read_geometry)
    return TestClient(app), case, inputs, snapshot, workspace, read_geometry


def test_put_saves_only_explicit_reported_values_without_case_bump(tmp_path):
    client, case, inputs, snapshot, workspace, _reader = setup_api(tmp_path)
    payload = {
        "artifact_version": case["artifact_version"],
        "reference_revision": SOURCE,
        "expected_input_revision": None,
        "measurements": {"neck_coverage_length": 8.0},
        "provenance": {"kind": "operator_reported", "note": "Synthetic metadata only"},
    }
    response = client.put(f"/api/cases/{case['case_id']}/device-sizing-inputs", json=payload)
    assert response.status_code == 200
    saved = response.json()["inputs"]
    assert saved["measurements"]["neck_coverage_length"] == 8.0
    assert saved["measurements"]["average_sac_diameter"] is None
    assert saved == inputs.inputs(case["case_id"], SOURCE)
    assert (
        workspace.get(f"/api/cases/{case['case_id']}").json()["artifact_version"]
        == snapshot["artifact_version"]
    )


@pytest.mark.parametrize(
    "field,value",
    [
        ("artifact_version", "wrong"),
        ("reference_revision", "f" * 64),
        ("expected_input_revision", "wrong-revision"),
    ],
)
def test_put_refuses_stale_case_source_or_input_revision(tmp_path, field, value):
    client, case, inputs, _snapshot, _workspace, _reader = setup_api(tmp_path)
    payload = {
        "artifact_version": case["artifact_version"],
        "reference_revision": SOURCE,
        "expected_input_revision": None,
        "measurements": {},
        "provenance": {"kind": "operator_reported", "note": "Synthetic data"},
    }
    payload[field] = value
    response = client.put(f"/api/cases/{case['case_id']}/device-sizing-inputs", json=payload)
    assert response.status_code == 409
    assert inputs.inputs(case["case_id"], SOURCE)["status"] == "not_saved"


@pytest.mark.parametrize("mode", ["units", "validation", "method", "case"])
def test_provider_mismatch_suppresses_input_numbers(tmp_path, mode):
    import copy

    _client, case, inputs, snapshot, _workspace, reader = setup_api(tmp_path)
    from test_device_inputs_state import MEASUREMENTS, PROVENANCE

    inputs.save_inputs(case["case_id"], snapshot, MEASUREMENTS, PROVENANCE, None)
    bad = copy.deepcopy(reader(case["case_id"]))
    if mode == "units":
        bad["current"]["result"]["spatial_units"] = "unknown"
    if mode == "validation":
        bad["current"]["result"]["clinical_validation"] = True
    if mode == "method":
        bad["current"]["result"]["proximal_parent"]["method"] = "unknown"
    if mode == "case":
        bad["case_id"] = "another-case"
    app = FastAPI()
    register_device_input_routes(app, inputs, lambda _: bad)
    response = TestClient(app).get(f"/api/cases/{case['case_id']}/device-sizing-inputs")
    assert response.status_code == 503 and "measurements" not in response.json()


def test_get_rejects_changed_case_instead_of_mixing_envelope_and_inputs(tmp_path, monkeypatch):
    client, case, inputs, _snapshot, workspace, _reader = setup_api(tmp_path)
    original = inputs.inputs

    def raced(*args):
        out = original(*args)
        workspace.patch(
            f"/api/cases/{case['case_id']}/notes",
            json={"artifact_version": case["artifact_version"], "notes": "Synthetic race"},
        )
        return out

    monkeypatch.setattr(inputs, "inputs", raced)
    assert client.get(f"/api/cases/{case['case_id']}/device-sizing-inputs").status_code == 409


@pytest.mark.parametrize("method", ["GET", "PUT"])
def test_routes_reject_query_selectors(tmp_path, method):
    client, case, _inputs, _snapshot, _workspace, _reader = setup_api(tmp_path)
    payload = {
        "artifact_version": case["artifact_version"],
        "reference_revision": SOURCE,
        "expected_input_revision": None,
        "measurements": {},
        "provenance": {"kind": "operator_reported", "note": "Synthetic data"},
    }
    response = client.request(
        method, f"/api/cases/{case['case_id']}/device-sizing-inputs?path=untrusted", json=payload
    )
    assert response.status_code == 422


@pytest.mark.parametrize(
    "content,content_type,status",
    [
        (b" " * 8193, "application/json", 413),
        (b"{}", "text/plain", 415),
        (b"invalid", "application/json", 422),
    ],
)
def test_put_body_is_bounded_json_before_state_access(tmp_path, content, content_type, status):
    client, case, inputs, _snapshot, _workspace, _reader = setup_api(tmp_path)
    response = client.put(
        f"/api/cases/{case['case_id']}/device-sizing-inputs",
        content=content,
        headers={"Content-Type": content_type},
    )
    assert response.status_code == status
    assert inputs.inputs(case["case_id"], SOURCE)["status"] == "not_saved"


def test_oversized_decimal_length_header_is_rejected_before_integer_conversion(tmp_path):
    client, case, _inputs, _snapshot, _workspace, _reader = setup_api(tmp_path)
    response = client.put(
        f"/api/cases/{case['case_id']}/device-sizing-inputs",
        content=b"{}",
        headers={"Content-Type": "application/json", "Content-Length": "9" * 5000},
    )
    assert response.status_code == 413


def test_postcommit_source_conflict_requires_reload_even_when_record_was_written(
    tmp_path, monkeypatch
):
    from planner.workspace import _connect

    client, case, inputs, _snapshot, workspace, _reader = setup_api(tmp_path)
    original = inputs.save_inputs
    acknowledgements = []

    def saved_then_changed(*args):
        saved = original(*args)
        acknowledgements.append(saved)
        changed = workspace.patch(
            f"/api/cases/{case['case_id']}/notes",
            json={
                "artifact_version": case["artifact_version"],
                "notes": "Synthetic postcommit mutation",
            },
        )
        assert changed.status_code == 200
        return saved

    monkeypatch.setattr(inputs, "save_inputs", saved_then_changed)
    payload = {
        "artifact_version": case["artifact_version"],
        "reference_revision": SOURCE,
        "expected_input_revision": None,
        "measurements": {"neck_coverage_length": 8.0},
        "provenance": {"kind": "operator_reported", "note": "Synthetic input"},
    }
    path = f"/api/cases/{case['case_id']}/device-sizing-inputs"
    response = client.put(path, json=payload)
    assert response.status_code == 409 and "reload" in response.json()["detail"]
    stale = inputs.inputs(case["case_id"], SOURCE)
    assert stale["status"] == "stale" and stale["measurements"] is None
    assert stale["input_revision"] == acknowledgements[0]["input_revision"]
    assert client.put(path, json=payload).status_code == 409
    with _connect(inputs.db_path) as conn:
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM device_inputs WHERE case_id=?", (case["case_id"],)
            ).fetchone()[0]
            == 1
        )


def test_not_saved_input_get_is_case_bound_and_has_no_numbers(tmp_path):
    client, case, _inputs, _snapshot, _workspace, _reader = setup_api(tmp_path)
    response = client.get(f"/api/cases/{case['case_id']}/device-sizing-inputs")
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    data = response.json()
    assert (
        data["case_id"] == case["case_id"] and data["artifact_version"] == case["artifact_version"]
    )
    assert data["inputs"]["status"] == "not_saved" and data["inputs"]["measurements"] is None
    assert data["clinical_suitability_established"] is False
    assert data["geometry_status"] == "current"


def test_default_application_composes_input_routes_and_preserves_source_guards(tmp_path):
    from planner.server import build_app

    app = build_app(tmp_path / "default.sqlite3", inference_results_dir=tmp_path / "results")
    client = TestClient(app)
    path = "/api/cases/{case_id}/device-sizing-inputs"
    assert {"get", "put"} <= set(app.openapi()["paths"][path])
    missing = client.get("/api/cases/not-installed/device-sizing-inputs")
    assert missing.status_code == 404
    assert missing.headers.get("cache-control") == "no-store"
