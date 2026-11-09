"""Phase5 routing contracts with explicitly synthetic runner artifacts."""

from test_segmentation_server import _stage, post_request


def test_original_rsna_vessel_candidate_is_source_bound_unaccepted_then_accepts(tmp_path):
    client, case, _, _ = _stage(tmp_path)
    response = post_request(client, case, kind="rsna-vessel", role="vessel")
    assert response.status_code == 200, response.text
    entry = response.json()
    assert entry["producer"] == "rsna_vessel_model"
    assert entry["role"] == "vessel" and entry["status"] == "preview"
    assert entry["image_sha256"] == case["image_sha256"]
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
    current = client.get(f"/api/cases/{case['case_id']}/segmentations").json()["current"]
    assert current["vessel"]["candidate_id"] == entry["candidate_id"]
    assert current["aneurysm"] is None


def test_fixed_model_interpreter_drops_host_python_home(tmp_path, monkeypatch):
    import json
    from types import SimpleNamespace

    from planner import segmentation_worker as worker

    monkeypatch.setenv("PYTHONHOME", "/not/the/isolated/runtime")
    captured = {}

    def completed(command, **kwargs):
        captured.update(kwargs)
        (tmp_path / "mask.nii.gz").write_bytes(b"explicit synthetic runner output")
        (tmp_path / "metadata.json").write_text(json.dumps({"synthetic_fixture": True}))
        return SimpleNamespace(returncode=0, stdout=b"", stderr=b"")

    monkeypatch.setattr(worker.subprocess, "run", completed)
    worker.run_local_model({"kind": "rsna-vessel"}, tmp_path)
    assert "PYTHONHOME" not in captured["env"]
    assert captured["env"]["PYTHONPATH"] == str(worker._REPO_ROOT)
