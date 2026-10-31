"""Synthetic route fixtures for case-bound segmentation endpoints.

Every runner here is explicitly synthetic: it writes fixture bytes and never
pretends to run a real model. No real model weights or clinical claims.
"""

import hashlib
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from test_reference_server import install_fixture

MASK_BYTES = b"synthetic segmentation mask bytes, not a model output"


def make_client(tmp_path, runner, **kwargs):
    from planner.server import build_app

    tmp_path.mkdir(parents=True, exist_ok=True)
    root = tmp_path / "reference"
    manifest = install_fixture(root)
    manifest["crop"]["size_voxels"] = [10, 10, 10]
    (root / "manifest.json").write_text(json.dumps(manifest))
    results_dir = tmp_path / "inference-results"
    app = build_app(
        tmp_path / "workspace.sqlite3",
        reference_dir=root,
        inference_runner=runner,
        inference_results_dir=results_dir,
        **kwargs,
    )
    return TestClient(app), root, manifest, results_dir


def make_case(client, manifest, image_sha=None):
    return client.post(
        "/api/cases",
        json={
            "title": "Synthetic case",
            "image_sha256": image_sha or manifest["image"]["sha256"],
            "dimensions": [10, 10, 10],
            "spacing_mm": [1, 1, 1],
            "spatial_units": "unknown",
        },
    ).json()


def make_runner(*, metadata=None, job_log=None, **overrides):
    def runner(job, output_dir: Path):
        if job_log is not None:
            job_log.append(job)
        path = output_dir / "mask.nii.gz"
        path.write_bytes(overrides.get("mask_bytes", MASK_BYTES))
        return {
            "mask_path": path,
            "metadata": overrides.get("metadata", metadata)
            or {
                "producer": "synthetic_route_fixture",
                "foreground_count": 3,
                "note": "explicitly synthetic, not a model result",
            },
        }

    return runner


def post_request(client, case, artifact_version=None, **overrides):
    body = {
        "artifact_version": artifact_version or case["artifact_version"],
        "reference_revision": overrides.pop("reference_revision", None) or _revision(client),
        "kind": "vessel",
        "role": "vessel",
    }
    body.update(overrides)
    return client.post(f"/api/cases/{case['case_id']}/segmentations", json=body)


def _revision(client):
    return client.get("/api/reference").json()["reference_revision"]


def _post_json(client, url, body):
    """Send bodies that may contain NaN/Infinity sentinels verbatim."""
    return client.post(url, content=json.dumps(body), headers={"content-type": "application/json"})


def _stage(tmp_path, **runner_kwargs):
    runner = make_runner(**runner_kwargs)
    client, root, manifest, results_dir = make_client(tmp_path, runner)
    case = make_case(client, manifest)
    return client, case, results_dir, root


def test_post_accept_reject_and_mask_roundtrip(tmp_path):
    client, case, results_dir, _ = _stage(tmp_path)
    response = post_request(client, case)
    assert response.status_code == 200, response.text
    entry = response.json()
    assert entry["status"] == "preview"
    assert entry["producer"] == "owned_vessel"
    assert entry["role"] == "vessel"
    assert entry["case_id"] == case["case_id"]
    assert entry["image_sha256"] == case["image_sha256"]
    expected_sha = hashlib.sha256(MASK_BYTES).hexdigest()
    assert entry["mask_sha256"] == expected_sha
    assert entry["mask_url"] == (
        f"/api/cases/{case['case_id']}/segmentations/{entry['candidate_id']}/mask"
    )
    blob = results_dir / "blobs" / f"{expected_sha}.nii.gz"
    assert blob.is_file() and blob.read_bytes() == MASK_BYTES
    assert not list((results_dir / ".staging").rglob("mask.nii.gz"))

    mask = client.get(entry["mask_url"])
    assert mask.status_code == 200
    assert mask.content == MASK_BYTES

    listing = client.get(f"/api/cases/{case['case_id']}/segmentations").json()
    assert listing["current"] == {"vessel": None, "aneurysm": None}

    decision = client.post(
        f"/api/cases/{case['case_id']}/segmentations/{entry['candidate_id']}/decision",
        json={
            "artifact_version": case["artifact_version"],
            "reference_revision": entry["reference_revision"],
            "decision": "accept",
        },
    )
    assert decision.status_code == 200, decision.text
    decided = decision.json()
    assert decided["status"] == "accepted"
    assert decided["segmentation_revision"] == 1
    assert decided["artifact_version"] == str(int(case["artifact_version"]) + 1)
    assert decided["mask_url"] == entry["mask_url"]

    listing = client.get(f"/api/cases/{case['case_id']}/segmentations").json()
    assert listing["current"]["vessel"]["candidate_id"] == entry["candidate_id"]
    assert listing["current"]["aneurysm"] is None


def test_reject_keeps_revision_and_hides_mask(tmp_path):
    client, case, _, _ = _stage(tmp_path)
    entry = post_request(client, case).json()
    response = client.post(
        f"/api/cases/{case['case_id']}/segmentations/{entry['candidate_id']}/decision",
        json={
            "artifact_version": case["artifact_version"],
            "reference_revision": entry["reference_revision"],
            "decision": "reject",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "rejected"
    assert body["artifact_version"] == case["artifact_version"]
    assert "segmentation_revision" not in body or body["segmentation_revision"] is None
    assert client.get(entry["mask_url"]).status_code == 404
    listing = client.get(f"/api/cases/{case['case_id']}/segmentations").json()
    assert listing["current"] == {"vessel": None, "aneurysm": None}


def test_sam2_requires_finite_point_and_maps_producer(tmp_path):
    client, case, _, _ = _stage(tmp_path)
    assert post_request(client, case, kind="sam2", role="aneurysm").status_code == 422
    ok = post_request(client, case, kind="sam2", role="aneurysm", point_ras=[1.0, 2.0, 3.0])
    assert ok.status_code == 200
    assert ok.json()["producer"] == "sam2_prompted_slice"
    url = f"/api/cases/{case['case_id']}/segmentations"
    for bad in ([float("nan"), 0, 0], [1.0, 2.0], [1.0, 2.0, 3.0, 4.0], ["a", "b", "c"]):
        body = {
            "artifact_version": case["artifact_version"],
            "reference_revision": _revision(client),
            "kind": "sam2",
            "role": "aneurysm",
            "point_ras": bad,
        }
        assert _post_json(client, url, body).status_code == 422


@pytest.mark.parametrize(
    "overrides",
    [
        {"checkpoint_path": "/not-allowed"},
        {"kind": "other"},
        {"role": "aneurysm"},
        {"radius_voxels": 1},
        {"radius_voxels": 41},
        {"radius_voxels": 2.5},
        {"radius_voxels": True},
        {"radius_voxels": "12"},
        {"display_window": [False, 600]},
        {"reference_revision": "not-a-sha"},
    ],
)
def test_request_validation_rejects_bad_bodies(tmp_path, overrides):
    client, case, _, _ = _stage(tmp_path)
    assert post_request(client, case, **overrides).status_code == 422


@pytest.mark.parametrize("value", [[float("nan"), 600], [600, 0], [0, 600, 1]])
def test_nonfinite_and_bad_windows_fail_closed(tmp_path, value):
    client, case, _, _ = _stage(tmp_path)
    body = {
        "artifact_version": case["artifact_version"],
        "reference_revision": _revision(client),
        "kind": "vessel",
        "role": "vessel",
        "display_window": value,
    }
    assert (
        _post_json(client, f"/api/cases/{case['case_id']}/segmentations", body).status_code == 422
    )


def test_non_reference_case_fails_explicitly(tmp_path):
    runner = make_runner()
    client, _root, manifest, _ = make_client(tmp_path, runner)
    other = make_case(client, manifest, image_sha="b" * 64)
    response = post_request(client, other)
    assert response.status_code == 404
    assert "reference" in response.json()["detail"].lower()


def test_stale_case_and_reference_before_runner(tmp_path):
    client, case, _, _ = _stage(tmp_path)
    stale_artifact = post_request(client, case, artifact_version="999")
    assert stale_artifact.status_code == 409
    stale_reference = post_request(client, case, reference_revision="0" * 64)
    assert stale_reference.status_code == 409
    stale_reference = post_request(client, case, reference_revision="not-a-sha")
    assert stale_reference.status_code == 422


def test_stale_preview_mask_cannot_be_downloaded_after_case_edit(tmp_path):
    client, case, _, _ = _stage(tmp_path)
    entry = post_request(client, case).json()
    client.patch(
        f"/api/cases/{case['case_id']}/notes",
        json={"artifact_version": "1", "notes": "Changed after preview"},
    )
    assert client.get(entry["mask_url"]).status_code == 409


def test_case_dimensions_must_match_the_installed_source(tmp_path):
    client, _, manifest, _ = make_client(tmp_path, make_runner())
    case = client.post(
        "/api/cases",
        json={
            "title": "Synthetic wrong metadata",
            "image_sha256": manifest["image"]["sha256"],
            "dimensions": [11, 10, 10],
            "spacing_mm": [1, 1, 1],
            "spatial_units": "unknown",
        },
    ).json()
    assert post_request(client, case).status_code == 409


def test_reference_change_during_runner_yields_no_candidate(tmp_path):
    root = tmp_path / "reference"

    def mutating_runner(job, output_dir):
        manifest = json.loads((root / "manifest.json").read_text())
        manifest["revision_note"] = "changed under the runner"
        (root / "manifest.json").write_text(json.dumps(manifest))
        return make_runner()(job, output_dir)

    client2, _, manifest, _ = make_client(tmp_path, mutating_runner)
    case2 = make_case(client2, manifest)
    response = post_request(client2, case2)
    assert response.status_code == 409
    listing = client2.get(f"/api/cases/{case2['case_id']}/segmentations").json()
    assert listing["current"] == {"vessel": None, "aneurysm": None}


def test_case_edit_between_final_readback_and_preview_is_a_conflict(tmp_path, monkeypatch):
    from planner.segmentation_state import SegmentationLedger

    client, case, _, _ = _stage(tmp_path)
    original = SegmentationLedger.preview

    def edit_before_preview(self, case_id, artifact_version, **kwargs):
        result = client.patch(
            f"/api/cases/{case_id}/notes",
            json={"artifact_version": artifact_version, "notes": "Concurrent saved edit"},
        )
        assert result.status_code == 200
        return original(self, case_id, artifact_version, **kwargs)

    monkeypatch.setattr(SegmentationLedger, "preview", edit_before_preview)
    assert post_request(client, case).status_code == 409
    assert client.get(f"/api/cases/{case['case_id']}/segmentations").json()["current"] == {
        "vessel": None,
        "aneurysm": None,
    }


def test_runner_failure_is_sanitized_and_changes_nothing(tmp_path):
    def failing_runner(job, output_dir):
        raise RuntimeError(f"boom wrote {output_dir} trace")

    client, _, manifest, results_dir = make_client(tmp_path, failing_runner)
    case = make_case(client, manifest)
    response = post_request(client, case)
    assert response.status_code == 503
    assert "boom" not in response.text
    assert str(results_dir) not in response.text
    assert client.get(f"/api/cases/{case['case_id']}/segmentations").json()["current"] == {
        "vessel": None,
        "aneurysm": None,
    }
    assert not any((results_dir / "blobs").iterdir()) if (results_dir / "blobs").exists() else True


@pytest.mark.parametrize(
    "behavior",
    ["wrong_path", "empty", "oversize", "symlink", "bad_metadata", "nonfinite_metadata"],
)
def test_invalid_runner_output_refused_and_staging_cleaned(tmp_path, behavior):
    def runner(job, output_dir: Path):
        if behavior == "wrong_path":
            path = output_dir / "other.nii.gz"
            path.write_bytes(MASK_BYTES)
            return {"mask_path": path, "metadata": {}}
        path = output_dir / "mask.nii.gz"
        if behavior == "empty":
            path.write_bytes(b"")
        elif behavior == "oversize":
            path.write_bytes(b"x" * (16 * 1024 * 1024 + 1))
        elif behavior == "symlink":
            outside = tmp_path / "outside.bin"
            outside.write_bytes(MASK_BYTES)
            path.symlink_to(outside)
        else:
            path.write_bytes(MASK_BYTES)
        return {
            "mask_path": path,
            "metadata": (
                ["not", "an", "object"]
                if behavior == "bad_metadata"
                else {"x": float("inf")}
                if behavior == "nonfinite_metadata"
                else {"ok": True}
            ),
        }

    client, _root, manifest, results_dir = make_client(tmp_path, runner)
    case = make_case(client, manifest)
    assert post_request(client, case).status_code == 503
    assert client.get(f"/api/cases/{case['case_id']}/segmentations").json()["current"] == {
        "vessel": None,
        "aneurysm": None,
    }
    assert not (results_dir / "blobs").exists() or not any((results_dir / "blobs").iterdir())
    staging = results_dir / ".staging"
    assert not staging.exists() or not any(staging.iterdir())


def test_concurrent_inference_is_busy_limited(tmp_path):
    from planner.segmentation_server import _INFERENCE_GATE

    client, case, _, _ = _stage(tmp_path)
    assert _INFERENCE_GATE.acquire(blocking=False)
    try:
        response = post_request(client, case)
        assert response.status_code == 429
    finally:
        _INFERENCE_GATE.release()


def test_foreign_candidate_decision_is_refused_without_disclosure(tmp_path):
    client, case, _, _ = _stage(tmp_path)
    entry = post_request(client, case).json()
    client2, _root2, manifest2, _ = make_client(tmp_path / "second", make_runner())
    other = make_case(client2, manifest2)
    for client_for, case_for in ((client2, other),):
        response = client_for.post(
            f"/api/cases/{case_for['case_id']}/segmentations/{entry['candidate_id']}/decision",
            json={
                "artifact_version": case_for["artifact_version"],
                "reference_revision": entry["reference_revision"],
                "decision": "accept",
            },
        )
        assert response.status_code in (404, 409)
        assert entry["candidate_id"] not in response.text


def test_decision_body_validation_and_stale_guards(tmp_path):
    client, case, _, _ = _stage(tmp_path)
    entry = post_request(client, case).json()
    url = f"/api/cases/{case['case_id']}/segmentations/{entry['candidate_id']}/decision"
    base = {
        "artifact_version": case["artifact_version"],
        "reference_revision": entry["reference_revision"],
        "decision": "accept",
    }
    assert client.post(url, json={**base, "extra": 1}).status_code == 422
    assert client.post(url, json={**base, "decision": "maybe"}).status_code == 422
    assert client.post(url, json={**base, "reference_revision": "0" * 64}).status_code == 409
    assert client.post(url, json={**base, "artifact_version": "999"}).status_code == 409


def test_mask_route_identity_and_status_guards(tmp_path):
    client, case, _, root = _stage(tmp_path)
    entry = post_request(client, case).json()
    manifest = json.loads((root / "manifest.json").read_text())
    manifest["revision_note"] = "reference changed after preview"
    (root / "manifest.json").write_text(json.dumps(manifest))
    assert client.get(entry["mask_url"]).status_code == 409

    client3, case3, _, _ = _stage(tmp_path / "third")
    post_request(client3, case3)
    response = client3.get(
        f"/api/cases/{case3['case_id']}/segmentations/{entry['candidate_id']}/mask"
    )
    assert response.status_code in (404, 409)
    assert client.get(
        f"/api/cases/{case['case_id']}/segmentations/missing-candidate/mask"
    ).status_code in (404, 409)


def test_tampered_blob_fails_closed(tmp_path):
    client, case, results_dir, _ = _stage(tmp_path)
    entry = post_request(client, case).json()
    blob = results_dir / "blobs" / f"{entry['mask_sha256']}.nii.gz"
    blob.write_bytes(b"tampered")
    assert client.get(entry["mask_url"]).status_code == 503


def test_metadata_responses_never_expose_paths_or_mask_bytes(tmp_path):
    client, case, results_dir, _ = _stage(tmp_path)
    entry = post_request(client, case).json()
    listing = client.get(f"/api/cases/{case['case_id']}/segmentations").json()
    text = json.dumps(entry) + json.dumps(listing)
    assert str(results_dir) not in text
    assert "mask.nii.gz" not in text
    assert MASK_BYTES.decode() not in text
    for key in (
        "candidate_id",
        "case_id",
        "image_sha256",
        "produced_artifact_version",
        "reference_revision",
        "producer",
        "role",
        "mask_sha256",
        "status",
        "segmentation_revision",
        "provenance",
        "mask_url",
    ):
        assert key in entry


def test_build_app_does_not_import_ml_worker_module(tmp_path):
    from planner.server import build_app

    root = tmp_path / "reference"
    install_fixture(root)
    sys.modules.pop("planner.segmentation_worker", None)
    build_app(tmp_path / "ws.sqlite3", reference_dir=root)
    assert "planner.segmentation_worker" not in sys.modules


def test_aneurysm_kind_produces_aneurysm_model_preview_and_keeps_vessel(tmp_path):
    job_log = []
    client, case, _, _ = _stage(tmp_path, job_log=job_log)
    vessel = post_request(client, case).json()
    client.post(
        f"/api/cases/{case['case_id']}/segmentations/{vessel['candidate_id']}/decision",
        json={
            "artifact_version": case["artifact_version"],
            "reference_revision": vessel["reference_revision"],
            "decision": "accept",
        },
    )
    case = client.get(f"/api/cases/{case['case_id']}").json()
    response = post_request(client, case, kind="aneurysm", role="aneurysm")
    assert response.status_code == 200, response.text
    entry = response.json()
    assert entry["producer"] == "aneurysm_model"
    assert entry["role"] == "aneurysm"
    assert entry["status"] == "preview"
    job = job_log[-1]
    assert job["kind"] == "aneurysm" and job["role"] == "aneurysm"
    assert job["point_ras"] is None
    assert job["image_sha256"] == case["image_sha256"]
    listing = client.get(f"/api/cases/{case['case_id']}/segmentations").json()
    assert client.get(entry["mask_url"]).status_code == 200
    decision = client.post(
        f"/api/cases/{case['case_id']}/segmentations/{entry['candidate_id']}/decision",
        json={
            "artifact_version": case["artifact_version"],
            "reference_revision": entry["reference_revision"],
            "decision": "accept",
        },
    )
    assert decision.status_code == 200, decision.text
    listing = client.get(f"/api/cases/{case['case_id']}/segmentations").json()
    assert listing["current"]["vessel"]["candidate_id"] == vessel["candidate_id"]
    assert listing["current"]["aneurysm"]["candidate_id"] == entry["candidate_id"]


def test_aneurysm_kind_rejects_wrong_role_and_none_point_rules(tmp_path):
    client, case, _, _ = _stage(tmp_path)
    wrong = post_request(client, case, kind="aneurysm", role="vessel", point_ras=[1.0, 2.0, 3.0])
    assert wrong.status_code == 422
    ok = post_request(client, case, kind="aneurysm", role="aneurysm")
    assert ok.status_code == 200
