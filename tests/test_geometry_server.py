"""CI-safe HTTP contracts. Injected masks/runners are explicitly synthetic."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from test_source_registry import CALIBRATED_HASH, Provider
from test_source_registry import case as source_case

from planner.segmentation_state import SegmentationLedger
from planner.server import build_app


def metrics():
    from test_morphometry import polygonal_prism

    from planner.morphometry_selection import clipped_sac_metrics, selected_section_metrics

    mesh = polygonal_prism(8, 2.0, -2.0, 2.0)
    section = selected_section_metrics(mesh, [0, 0, 0], [0, 0, 1], spatial_units="mm")
    return {
        "spatial_units": "mm",
        "clinical_validation": False,
        "validated_morphometry": False,
        "sac": clipped_sac_metrics(mesh, [0, 0, 0], [0, 0, 1], spatial_units="mm"),
        "neck": section,
        "proximal_parent": section,
        "distal_parent": section,
        "synthetic_fixture": True,
    }


def configured(tmp_path, runner=None):
    db = tmp_path / "case.sqlite3"
    directory = tmp_path / "inference-results"
    app = build_app(
        db,
        reference_dir=tmp_path / "missing",
        calibrated_source_store=Provider(CALIBRATED_HASH, "mm"),
        inference_results_dir=directory,
        geometry_runner=runner,
    )
    client = TestClient(app)
    seed = source_case()
    seed.pop("case_id")
    state = client.post("/api/cases", json={"title": "Synthetic geometry HTTP", **seed}).json()
    ledger = SegmentationLedger(db)
    for role, producer, digest in [
        ("vessel", "owned_vessel", "c" * 64),
        ("aneurysm", "aneurysm_model", "d" * 64),
    ]:
        entry = ledger.preview(
            state["case_id"],
            state["artifact_version"],
            reference_revision="b" * 64,
            producer=producer,
            role=role,
            mask_sha256=digest,
            provenance={"synthetic_fixture": True},
        )
        ledger.decide(state["case_id"], entry["candidate_id"], state["artifact_version"], "accept")
        state = client.get(f"/api/cases/{state['case_id']}").json()
    return client, state, directory


def input_body(version):
    return {
        "artifact_version": version,
        "reference_revision": "b" * 64,
        "inputs": {
            "neck_origin": [0.0, 0.0, 0.0],
            "neck_normal": [0.0, 0.0, 1.0],
            "aneurysm_seed": [0.0, 0.0, 1.0],
            "parent_path": [[0.0, 0.0, z] for z in (0.0, 1.0, 2.0, 3.0)],
            "proximal_index": 1,
            "distal_index": 2,
        },
    }


def test_get_does_not_mix_old_case_envelope_with_new_geometry(tmp_path, monkeypatch):
    from planner.geometry_state import GeometryLedger

    client, route, body, _directory = ready(tmp_path, lambda job: metrics())
    assert client.post(route, json=body).status_code == 200
    original = GeometryLedger.current
    changed = False

    def interleaved(ledger, case_id, source_revision):
        nonlocal changed
        if not changed:
            changed = True
            version = ledger.save_inputs(
                case_id,
                body["artifact_version"],
                source_revision,
                input_body(body["artifact_version"])["inputs"],
            )
            snapshot = ledger.snapshot(case_id, version, source_revision)
            ledger.store(case_id, snapshot, metrics())
        return original(ledger, case_id, source_revision)

    monkeypatch.setattr(GeometryLedger, "current", interleaved)
    response = client.get(route)
    assert response.status_code == 409, response.text


def test_default_runtime_receives_only_server_configured_blob_directory(tmp_path, monkeypatch):
    from planner import geometry_server

    seen = []

    def default(job, *, blob_dir):
        seen.append((job, blob_dir))
        return metrics()

    monkeypatch.setattr(geometry_server, "default_geometry_runner", lambda: default)
    client, state, directory = configured(tmp_path)
    route = f"/api/cases/{state['case_id']}/morphometry"
    saved = client.put(route + "-inputs", json=input_body(state["artifact_version"]))
    assert saved.status_code == 200, saved.text
    response = client.post(
        route,
        json={"artifact_version": saved.json()["artifact_version"], "reference_revision": "b" * 64},
    )
    assert response.status_code == 200, response.text
    assert Path(seen[0][1]) == directory
    assert seen[0][0]["source_id"] == "zenodo-case006-calibrated"
    assert "blob_dir" not in seen[0][0]
    assert response.json()["current"]["status"] == "current"
    assert client.get(route).json()["current"]["result"]["sac"]["height"] == 2.0


@pytest.mark.parametrize("bad_index", [0, 3, 100])
def test_invalid_path_station_is_a_request_error_not_server_crash(tmp_path, bad_index):
    client, state, _directory = configured(tmp_path, lambda job: metrics())
    payload = input_body(state["artifact_version"])
    payload["inputs"]["proximal_index"] = bad_index
    response = client.put(f"/api/cases/{state['case_id']}/morphometry-inputs", json=payload)
    assert response.status_code == 422, response.text


def test_large_finite_normal_does_not_overflow_request_validation(tmp_path):
    client, state, _directory = configured(tmp_path, lambda job: metrics())
    payload = input_body(state["artifact_version"])
    payload["inputs"]["neck_normal"] = [1e308, 0.0, 0.0]
    response = client.put(f"/api/cases/{state['case_id']}/morphometry-inputs", json=payload)
    assert response.status_code in (200, 422), response.text


def test_saved_input_read_failure_never_falls_back_to_unbound_coordinates():
    from fastapi import HTTPException

    from planner.geometry_server import _saved_inputs
    from planner.geometry_state import GeometryLedger

    class FailingLedger(GeometryLedger):
        def __init__(self):
            pass

        legacy_called = False

        def inputs(self, case_id, source_revision=None):
            if source_revision is not None:
                raise TypeError("revision-aware read failed")
            self.legacy_called = True
            return {"wrong_source_coordinates": [1, 2, 3]}

    ledger = FailingLedger()
    with pytest.raises(HTTPException) as error:
        _saved_inputs(ledger, "case", "b" * 64)
    assert error.value.status_code == 503
    assert ledger.legacy_called is False


def ready(tmp_path, runner):
    client, state, directory = configured(tmp_path, runner)
    route = f"/api/cases/{state['case_id']}/morphometry"
    saved = client.put(route + "-inputs", json=input_body(state["artifact_version"]))
    assert saved.status_code == 200, saved.text
    return (
        client,
        route,
        {"artifact_version": saved.json()["artifact_version"], "reference_revision": "b" * 64},
        directory,
    )


@pytest.mark.parametrize("field", ["source_id", "blob_dir", "image_path", "mask_sha256"])
def test_client_cannot_select_geometry_source_or_paths(tmp_path, field):
    calls = []
    client, route, body, _directory = ready(tmp_path, lambda job: calls.append(job) or metrics())
    assert client.post(route, json=body | {field: "untrusted"}).status_code == 422
    assert calls == []


@pytest.mark.parametrize("bad", ["nonfinite", "clinical_claim", "oversize", "missing", "units"])
def test_invalid_worker_output_is_sanitized_not_persisted(tmp_path, bad):
    def runner(job):
        result = metrics()
        if bad == "nonfinite":
            result["sac"]["height"] = float("nan")
        elif bad == "clinical_claim":
            result["clinical_validation"] = True
        elif bad == "oversize":
            result["extra"] = "x" * 1048576
        elif bad == "missing":
            result.pop("neck")
        else:
            result["spatial_units"] = "unknown"
        return result

    client, route, body, _directory = ready(tmp_path, runner)
    response = client.post(route, json=body)
    assert response.status_code == 503
    assert client.get(route).json()["current"]["result"] is None


def test_shared_busy_gate_refuses_geometry_without_running_worker(tmp_path):
    from planner.segmentation_server import _INFERENCE_GATE

    calls = []
    client, route, body, _directory = ready(tmp_path, lambda job: calls.append(job) or metrics())
    assert _INFERENCE_GATE.acquire(blocking=False)
    try:
        assert client.post(route, json=body).status_code == 429
    finally:
        _INFERENCE_GATE.release()
    assert calls == []


def test_case_edit_during_geometry_job_cannot_persist_old_numbers(tmp_path):
    from planner.workspace import _connect

    def runner(job):
        with _connect(tmp_path / "case.sqlite3") as conn:
            conn.execute(
                "UPDATE cases SET artifact_version=artifact_version+1 WHERE case_id=?",
                (job["case_id"],),
            )
        return metrics()

    client, route, body, _directory = ready(tmp_path, runner)
    assert client.post(route, json=body).status_code == 409
    assert client.get(route).json()["current"]["result"] is None
