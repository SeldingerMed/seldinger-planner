"""Actual default-app workflow routes using generated NIfTI bytes."""

import gzip
import hashlib
import json
import struct

import pytest
from fastapi.testclient import TestClient
from test_native_grid import header_bytes
from test_territory_workflows import tavr_inputs

from planner.server import build_app


def configured(tmp_path, monkeypatch, *, voxel_payload=None):
    from planner import image_source

    root = tmp_path.resolve()
    sources = root / "sources"
    directory = sources / "phase3-synthetic"
    directory.mkdir(parents=True)
    affine = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
    raw = bytearray(header_bytes([32, 32, 32], affine[:3]))
    struct.pack_into("<2h", raw, 70, 4, 16)
    struct.pack_into("<8f", raw, 76, 1, 1, 1, 1, 1, 1, 1, 1)
    struct.pack_into("<2f", raw, 112, 1, 0)
    voxels = bytes(32 * 32 * 32 * 2) if voxel_payload is None else voxel_payload
    assert len(voxels) == 32 * 32 * 32 * 2
    payload = gzip.compress(bytes(raw) + voxels, mtime=0)
    path = directory / "context-cta.nii.gz"
    path.write_bytes(payload)
    digest = hashlib.sha256(payload).hexdigest()
    manifest = {
        "clinical_validation": False,
        "source_provenance": {"scope": "synthetic"},
        "image": {
            "filename": path.name,
            "sha256": digest,
            "bytes": len(payload),
            "shape_xyz": [32, 32, 32],
            "dtype": "int16",
            "spatial_units": "mm",
            "affine_ras": affine,
        },
    }
    (directory / "manifest.json").write_text(json.dumps(manifest))
    monkeypatch.setattr(image_source, "INSTALLED_SOURCES_ROOT", sources)
    app = build_app(
        root / "case.sqlite3",
        reference_dir=root / "missing-reference",
        sample_dir=root / "missing-sample",
        client_factory=lambda: (_ for _ in ()).throw(
            RuntimeError("Model calls disabled in synthetic tests")
        ),
        inference_results_dir=root / "results",
    )
    client = TestClient(app)
    response = client.post(
        "/api/cases",
        json={
            "title": "Generated territory source",
            "image_sha256": digest,
            "dimensions": [32, 32, 32],
            "spacing_mm": [1, 1, 1],
            "spatial_units": "mm",
        },
    )
    assert response.status_code == 200, response.text
    case = response.json()
    metadata = client.get(f"/api/cases/{case['case_id']}/image-source")
    assert metadata.status_code == 200, metadata.text
    return client, case, metadata.json()["reference_revision"]


def test_modes_have_independent_revisions_and_real_geometry_roundtrips(tmp_path, monkeypatch):
    from test_territory_profiles import access_payload, aortic_inputs, coronary_inputs

    from planner.territory_workflows import input_points

    client, case, revision = configured(tmp_path, monkeypatch)
    entries = {
        "tavr": tavr_inputs(),
        "coronary_pci": coronary_inputs(),
        "aortic_peripheral": aortic_inputs(left_access=access_payload()),
    }
    for mode, inputs in entries.items():
        if mode != "tavr":
            for point in input_points(inputs):
                point[:] = [point[k] * 0.1 + [5, 16, 16][k] for k in range(3)]
        route = f"/api/cases/{case['case_id']}/territory-workflows/{mode}"
        body = {
            "artifact_version": case["artifact_version"],
            "reference_revision": revision,
            "workflow_revision": 0,
            "inputs": inputs,
        }
        response = client.put(route, json=body)
        assert response.status_code == 200, response.text
        saved = response.json()
        assert saved["mode"] == mode and saved["workflow_revision"] == 1
        assert saved["current"]["dependencies"]["reference_revision"] == revision
        assert saved["current"]["dependencies"]["mode"] == mode
        assert client.get(route).json() == saved
        assert client.put(route, json=body).status_code == 409
        if mode == "coronary_pci":
            assert saved["current"]["result"]["lesion_length_mm"] == pytest.approx(4)
        if mode == "aortic_peripheral":
            assert saved["current"]["result"]["neck_length_mm"] == pytest.approx(4)
            assert saved["current"]["result"]["left_access"]["length_mm"] == pytest.approx(5)
    assert (
        client.get(f"/api/cases/{case['case_id']}").json()["artifact_version"]
        == case["artifact_version"]
    )


def test_concurrent_real_requests_create_one_immutable_revision(tmp_path, monkeypatch):
    import sqlite3
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    client, case, revision = configured(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/territory-workflows/tavr"
    body = {
        "artifact_version": case["artifact_version"],
        "reference_revision": revision,
        "workflow_revision": 0,
        "inputs": tavr_inputs(),
    }
    barrier = Barrier(4)

    def save(_):
        barrier.wait(timeout=5)
        return client.put(route, json=body).status_code

    with ThreadPoolExecutor(max_workers=4) as pool:
        statuses = sorted(pool.map(save, range(4)))
    assert statuses == [200, 409, 409, 409]
    assert client.get(route).json()["workflow_revision"] == 1
    with sqlite3.connect(tmp_path / "case.sqlite3") as conn:
        assert conn.execute("SELECT COUNT(*) FROM territory_workflow_results").fetchone()[0] == 1


def test_read_rejects_a_changed_workflow_snapshot_then_reload_finds_it(tmp_path, monkeypatch):
    from planner.territory_workflow_state import TerritoryWorkflowLedger
    from planner.territory_workflows import compute_workflow, validate_inputs

    client, _case, route, _body, _saved = saved_tavr(tmp_path, monkeypatch)
    actual = TerritoryWorkflowLedger.current
    changed = False

    def raced(self, identity, mode):
        nonlocal changed
        revision, current = actual(self, identity, mode)
        if not changed:
            changed = True
            inputs = tavr_inputs()
            inputs["left_ostium"] = [5, 5, 16]
            inputs = validate_inputs(mode, inputs)
            self.save(identity, mode, revision, inputs, compute_workflow(mode, inputs))
        return revision, current

    monkeypatch.setattr(TerritoryWorkflowLedger, "current", raced)
    assert client.get(route).status_code == 409
    response = client.get(route)
    assert response.status_code == 200 and response.json()["workflow_revision"] == 2
    assert response.json()["current"]["result"]["left_coronary_height_mm"] == 6


def test_changed_case_suppresses_old_inputs_and_results(tmp_path, monkeypatch):
    import sqlite3

    client, _case, route, _body, _saved = saved_tavr(tmp_path, monkeypatch)
    with sqlite3.connect(tmp_path / "case.sqlite3") as conn:
        conn.execute("UPDATE cases SET artifact_version=artifact_version+1")
    response = client.get(route)
    assert response.status_code == 200
    data = response.json()
    assert data["artifact_version"] == "2" and data["workflow_revision"] == 1
    assert (
        data["current"]["status"] == "stale"
        and data["current"]["inputs"] is None
        and data["current"]["result"] is None
    )


def test_poststore_acknowledgement_race_returns409_despite_committed_rows(tmp_path, monkeypatch):
    import sqlite3

    from planner.territory_workflow_state import TerritoryWorkflowLedger
    from planner.territory_workflows import compute_workflow, validate_inputs

    client, case, revision = configured(tmp_path, monkeypatch)
    actual = TerritoryWorkflowLedger.save

    def raced(self, identity, mode, expected, inputs, result):
        result_id, stored_revision = actual(self, identity, mode, expected, inputs, result)
        changed = tavr_inputs()
        changed["left_ostium"] = [5, 5, 16]
        changed = validate_inputs(mode, changed)
        actual(self, identity, mode, stored_revision, changed, compute_workflow(mode, changed))
        return result_id, stored_revision

    monkeypatch.setattr(TerritoryWorkflowLedger, "save", raced)
    route = f"/api/cases/{case['case_id']}/territory-workflows/tavr"
    response = client.put(
        route,
        json={
            "artifact_version": case["artifact_version"],
            "reference_revision": revision,
            "workflow_revision": 0,
            "inputs": tavr_inputs(),
        },
    )
    assert response.status_code == 409
    with sqlite3.connect(tmp_path / "case.sqlite3") as conn:
        assert conn.execute("SELECT COUNT(*) FROM territory_workflow_results").fetchone()[0] == 2
    current = client.get(route)
    assert current.status_code == 200
    assert current.json()["workflow_revision"] == 2
    assert current.json()["current"]["result"]["left_coronary_height_mm"] == 6


def saved_tavr(tmp_path, monkeypatch):
    client, case, revision = configured(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/territory-workflows/tavr"
    body = {
        "artifact_version": case["artifact_version"],
        "reference_revision": revision,
        "workflow_revision": 0,
        "inputs": tavr_inputs(),
    }
    saved = client.put(route, json=body)
    assert saved.status_code == 200, saved.text
    return client, case, route, body, saved.json()


def test_invalid_or_outside_annotations_never_create_a_result(tmp_path, monkeypatch):
    import sqlite3

    client, case, revision = configured(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/territory-workflows/tavr"
    body = {
        "artifact_version": case["artifact_version"],
        "reference_revision": revision,
        "workflow_revision": 0,
        "inputs": tavr_inputs(),
    }
    body["inputs"]["left_ostium"] = [999, 5, 15]
    assert client.put(route, json=body).status_code == 422
    body["workflow_revision"] = True
    assert client.put(route, json=body).status_code == 422
    assert client.put(route, content=b" " * 1_000_001).status_code == 413
    with sqlite3.connect(tmp_path / "case.sqlite3") as conn:
        assert conn.execute("SELECT COUNT(*) FROM territory_workflow_results").fetchone()[0] == 0


def test_consistently_tampered_outside_saved_point_is_an_integrity_failure(tmp_path, monkeypatch):
    import sqlite3

    from planner.physics_contract import encoded
    from planner.territory_workflow_state import digest
    from planner.territory_workflows import validate_inputs

    client, _case, route, body, _saved = saved_tavr(tmp_path, monkeypatch)
    body["inputs"]["left_ostium"] = [99, 5, 15]
    inputs = validate_inputs("tavr", body["inputs"])
    # Signed height remains5, so result recomputation alone cannot catch this.
    with sqlite3.connect(tmp_path / "case.sqlite3") as conn:
        conn.execute(
            "UPDATE territory_workflow_results SET inputs=?,input_sha256=?",
            (encoded(inputs), digest(inputs)),
        )
    response = client.get(route)
    assert response.status_code == 503, response.text
    assert "99" not in response.text


def test_postcommit_sqlite_failure_is_ambiguous_and_reload_finds_saved_row(tmp_path, monkeypatch):
    import sqlite3

    from planner.territory_workflow_state import TerritoryWorkflowLedger

    client, case, revision = configured(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/territory-workflows/tavr"
    actual = TerritoryWorkflowLedger.save

    def interrupted(self, *args, **kwargs):
        actual(self, *args, **kwargs)
        raise sqlite3.OperationalError("private /data/workspace.sqlite3")

    monkeypatch.setattr(TerritoryWorkflowLedger, "save", interrupted)
    response = client.put(
        route,
        json={
            "artifact_version": case["artifact_version"],
            "reference_revision": revision,
            "workflow_revision": 0,
            "inputs": tavr_inputs(),
        },
    )
    assert response.status_code == 503 and "/data" not in response.text
    loaded = client.get(route)
    assert loaded.status_code == 200 and loaded.json()["workflow_revision"] == 1
    assert loaded.json()["current"]["status"] == "current"


def test_tavr_save_reload_and_same_revision_conflict(tmp_path, monkeypatch):
    client, case, revision = configured(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/territory-workflows/tavr"
    initial = client.get(route)
    assert initial.status_code == 200, initial.text
    assert initial.json()["workflow_revision"] == 0
    assert initial.json()["current"]["status"] == "not_computed"
    body = {
        "artifact_version": case["artifact_version"],
        "reference_revision": revision,
        "workflow_revision": 0,
        "inputs": tavr_inputs(),
    }
    saved = client.put(route, json=body)
    assert saved.status_code == 200, saved.text
    data = saved.json()
    assert data["workflow_revision"] == 1
    assert data["current"]["result"]["area_mm2"] == 3 * 2
    assert data["current"]["result"]["right_coronary_height_mm"] == -2
    assert client.get(route).json() == data
    assert client.put(route, json=body).status_code == 409
    assert client.get(route).json() == data
