"""Synthetic boundary tests for trusted segmentation blob-store configuration."""

import io
import json
from types import SimpleNamespace

from test_segmentation_server import make_case, make_client, make_runner, post_request


def test_default_api_runner_gets_server_configured_blob_directory(tmp_path, monkeypatch):
    from planner import segmentation_server

    observed = []

    def runner(job, output_dir, *, blob_dir):
        observed.append(blob_dir)
        assert "blob_dir" not in job
        return make_runner()(job, output_dir)

    monkeypatch.setattr(segmentation_server, "default_runner", lambda: runner)
    client, _, manifest, results = make_client(tmp_path, None)
    case = make_case(client, manifest)
    response = post_request(client, case)
    assert response.status_code == 200, response.text
    assert observed == [results / "blobs"]
    rejected = post_request(client, case, blob_dir="/client-selected-path")
    assert rejected.status_code == 422
    assert len(observed) == 1


def test_supervisor_passes_blob_configuration_outside_job_json(tmp_path, monkeypatch):
    from planner import segmentation_worker as worker

    observed = []
    blobs = tmp_path / "configured-blobs"

    def run(command, **kwargs):
        observed.append(command)
        assert "blob_dir" not in json.loads(kwargs["input"])
        assert command[-2:] == ["--blob-dir", str(blobs)]
        (tmp_path / "mask.nii.gz").write_bytes(b"declared synthetic boundary bytes")
        (tmp_path / "metadata.json").write_text("{}")
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(worker.subprocess, "run", run)
    worker.run_local_model({"kind": "sam2"}, tmp_path, blob_dir=blobs)
    assert len(observed) == 1


def test_child_cli_passes_trusted_blob_directory_to_worker(tmp_path, monkeypatch):
    from planner import segmentation_worker as worker

    calls = []
    monkeypatch.setattr(worker.sys, "stdin", io.StringIO('{"kind":"sam2"}'))
    monkeypatch.setattr(
        worker, "_run_job", lambda job, output, **kwargs: calls.append((job, output, kwargs))
    )
    blobs = tmp_path / "blobs"
    assert worker.main([str(tmp_path), "--blob-dir", str(blobs)]) == 0
    assert calls == [({"kind": "sam2"}, tmp_path, {"blob_dir": blobs})]
