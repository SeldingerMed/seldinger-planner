"""Supervisor contract only; fake subprocess output is explicitly synthetic."""

import json
import subprocess
from types import SimpleNamespace

import pytest

from planner import geometry_worker as worker


def test_geometry_supervisor_uses_fixed_runtime_and_bounds(tmp_path, monkeypatch):
    runtime = tmp_path / "fixed-python"
    runtime.write_text("synthetic executable marker")
    monkeypatch.setattr(worker, "ML_PYTHON", runtime, raising=False)
    seen = []

    def fake(command, **kwargs):
        seen.append((command, kwargs))
        return SimpleNamespace(
            returncode=0, stdout=json.dumps({"synthetic_fixture": True}), stderr=""
        )

    monkeypatch.setattr(subprocess, "run", fake)
    result = worker.run_local_geometry({"synthetic_job": True}, blob_dir=tmp_path)
    assert result == {"synthetic_fixture": True}
    command, options = seen[0]
    assert command == [str(runtime), "-m", "planner.geometry_worker"]
    assert options["timeout"] == 60 and options["shell"] is False
    assert options["env"]["OMP_NUM_THREADS"] == "4"
    payload = json.loads(options["input"])
    assert payload["blob_dir"] == str(tmp_path)
    assert payload["job"] == {"synthetic_job": True}


@pytest.mark.parametrize("failure", ["timeout", "exit", "oversize", "bad_json"])
def test_geometry_supervisor_failure_does_not_return_plausible_metrics(
    tmp_path, monkeypatch, failure
):
    runtime = tmp_path / "fixed-python"
    runtime.touch()
    monkeypatch.setattr(worker, "ML_PYTHON", runtime, raising=False)

    def fake(*args, **kwargs):
        if failure == "timeout":
            raise subprocess.TimeoutExpired("worker", 60)
        return SimpleNamespace(
            returncode=1 if failure == "exit" else 0,
            stdout="x" * 1048577 if failure == "oversize" else "not JSON",
            stderr="private-path-sentinel",
        )

    monkeypatch.setattr(subprocess, "run", fake)
    with pytest.raises(RuntimeError) as exc:
        worker.run_local_geometry({}, blob_dir=tmp_path)
    assert "private-path-sentinel" not in str(exc.value)
