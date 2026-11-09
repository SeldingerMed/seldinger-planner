"""Anatomy HTTP protocol on admitted synthetic NIfTI and real accepted-mask SQLite."""

import gzip
import hashlib
import json
import struct

from fastapi.testclient import TestClient
from test_installed_sources import install_source

from planner import image_source
from planner.geometry_server import OperatorGeometryInputs
from planner.physics_contract import encoded
from planner.segmentation_state import SegmentationLedger
from planner.server import build_app


def proposal_result(job):
    return {
        "inputs": {
            "neck_origin": [1.0, 1.0, 2.0],
            "neck_normal": [0.0, 1.0, 0.0],
            "aneurysm_seed": [1.0, 2.0, 2.0],
            "parent_path": [[1.0, 2.0, z] for z in (0.0, 1.0, 2.0, 3.0)],
            "proximal_index": 1,
            "distal_index": 2,
        },
        "diagnostics": {
            "aneurysm_component_voxels": 4,
            "interface_voxel_count": 3,
            "neck_plane_rms_residual_mm": 0.0,
            "parent_point_count": 4,
            "parent_length_mm": 3.0,
            "target_component_selected": job["target_ras"] is not None,
            "grid_shape": [4, 5, 6],
        },
        "method": "accepted_mask_anatomy_geometry_proposal",
        "operator_confirmation_required": True,
        "proposal_version": "anatomy-input-proposal-v1",
        "dependencies": json.loads(encoded(job["dependencies"])),
        "job_sha256": hashlib.sha256(encoded(job).encode()).hexdigest(),
    }


def configured(tmp_path, monkeypatch, runner=None):
    tmp_path.mkdir(parents=True, exist_ok=True)
    sources = tmp_path / "sources"
    sources.mkdir()
    source, manifest = install_source(sources)
    monkeypatch.setattr(image_source, "INSTALLED_SOURCES_ROOT", sources)
    db = tmp_path / "workspace.sqlite3"
    directory = tmp_path / "inference-results"
    app = build_app(
        db,
        reference_dir=tmp_path / "missing",
        inference_results_dir=directory,
        anatomy_runner=runner,
    )
    client = TestClient(app)
    case = client.post(
        "/api/cases",
        json={
            "title": "Synthetic anatomy protocol",
            "image_sha256": manifest["image"]["sha256"],
            "dimensions": [4, 5, 6],
            "spacing_mm": [1, 1, 1],
            "spatial_units": "mm",
        },
    ).json()
    revision = hashlib.sha256((source / "manifest.json").read_bytes()).hexdigest()
    ledger = SegmentationLedger(db)
    entries = {}
    (directory / "blobs").mkdir(mode=0o700)
    for role, producer in (("vessel", "rsna_vessel_model"), ("aneurysm", "aneurysm_model")):
        header = bytearray(gzip.decompress((source / "context-cta.nii.gz").read_bytes())[:352])
        struct.pack_into("<2h", header, 70, 2, 8)
        data = bytearray(4 * 5 * 6)
        for z in range(1, 5):
            data[1 + 4 * (2 if role == "vessel" else 1) + 20 * z] = 1
        payload = gzip.compress(bytes(header) + bytes(data), mtime=0)
        sha = hashlib.sha256(payload).hexdigest()
        (directory / "blobs" / f"{sha}.nii.gz").write_bytes(payload)
        entry = ledger.preview(
            case["case_id"],
            case["artifact_version"],
            reference_revision=revision,
            producer=producer,
            role=role,
            mask_sha256=sha,
            provenance={"synthetic_fixture": True},
        )
        ledger.decide(case["case_id"], entry["candidate_id"], case["artifact_version"], "accept")
        entries[role] = entry
        case = client.get(f"/api/cases/{case['case_id']}").json()
    return client, case, revision, directory, entries, source


def test_generate_is_source_bound_editable_and_never_silently_confirms_inputs(
    tmp_path, monkeypatch
):
    seen = []

    def runner(job):
        seen.append(job)
        return proposal_result(job)

    client, case, revision, _, entries, _ = configured(tmp_path, monkeypatch, runner)
    body = {"artifact_version": case["artifact_version"], "reference_revision": revision}
    route = f"/api/cases/{case['case_id']}/anatomy-proposal"
    response = client.post(route, json=body)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["case_id"] == case["case_id"] and result["image_sha256"] == case["image_sha256"]
    assert (
        result["artifact_version"] == case["artifact_version"]
        and result["reference_revision"] == revision
    )
    assert result["proposal"]["operator_confirmation_required"] is True
    OperatorGeometryInputs.model_validate(result["proposal"]["inputs"])
    assert len(result["proposal_id"]) == 64
    assert (
        seen[0]["dependencies"]["masks"]["vessel"]["candidate_id"]
        == entries["vessel"]["candidate_id"]
    )
    assert "blob_dir" not in seen[0] and "source_path" not in seen[0]
    assert (
        client.get(f"/api/cases/{case['case_id']}").json()["artifact_version"]
        == case["artifact_version"]
    )
    morphometry = client.get(f"/api/cases/{case['case_id']}/morphometry").json()
    assert (
        morphometry["operator_inputs"] is None
        and morphometry["current"]["status"] == "not_computed"
    )
