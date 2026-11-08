"""Native synthetic bytes only, no trained models or clinical records."""

import hashlib
import importlib.util
import json
import os
import time

import pytest

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Requires isolated imaging runtime", allow_module_level=True)

import nibabel as nib
import numpy as np


def installed_job(tmp_path, monkeypatch):
    from planner import image_source
    from planner.physics_contract import ALGORITHM_VERSION, encoded
    from planner.segmentation_worker import _source_bundle

    root = tmp_path / "installed" / "synthetic-physics-source"
    root.mkdir(parents=True)
    monkeypatch.setattr(image_source, "INSTALLED_SOURCES_ROOT", root.parent)
    vessel = np.zeros((22, 23, 24), dtype=np.uint8)
    vessel[6:11, 7:12, 2:21] = 1
    sac = np.zeros_like(vessel)
    sac[5:12, 6:13, 8:16] = 1

    def save(array, path):
        obj = nib.Nifti1Image(array, np.eye(4))
        obj.header.set_xyzt_units("mm", "sec")
        nib.save(obj, path)
        return hashlib.sha256(path.read_bytes()).hexdigest()

    path = root / "context-cta.nii.gz"
    sha = save(np.zeros_like(vessel, dtype=np.int16), path)
    manifest = {
        "clinical_validation": False,
        "source_provenance": {"scope": "synthetic"},
        "image": {
            "filename": path.name,
            "sha256": sha,
            "bytes": path.stat().st_size,
            "shape_xyz": list(vessel.shape),
            "dtype": "int16",
            "spatial_units": "mm",
            "affine_ras": np.eye(4).tolist(),
        },
    }
    (root / "manifest.json").write_text(json.dumps(manifest))
    _, revision, _, _ = _source_bundle({"source_id": root.name})
    blobs = tmp_path / "results" / "blobs"
    blobs.mkdir(parents=True)
    masks = {}
    for role, array in [("vessel", vessel), ("aneurysm", sac)]:
        path = tmp_path / f"{role}.nii.gz"
        digest = save(array, path)
        path.rename(blobs / f"{digest}.nii.gz")
        masks[role] = {"candidate_id": role, "mask_sha256": digest, "segmentation_revision": 1}
    operator = {
        "neck_origin": [8.0, 9.0, 9.2],
        "neck_normal": [0.0, 0.0, 1.0],
        "aneurysm_seed": [8.0, 9.0, 11.0],
        "parent_path": [[8.0, 9.0, z] for z in (4.2, 6.2, 18.2, 19.2)],
        "proximal_index": 1,
        "distal_index": 2,
    }
    deps = {
        "case_id": "synthetic",
        "image_sha256": sha,
        "artifact_version": "3",
        "source_revision": revision,
        "algorithm_version": ALGORITHM_VERSION,
        "geometry_result_id": "synthetic-geometry",
        "masks": masks,
        "geometry_dependencies": {
            "operator_sha256": hashlib.sha256(encoded(operator).encode()).hexdigest()
        },
    }
    job = {
        "kind": "rod-deployment",
        "case_id": "synthetic",
        "artifact_version": "3",
        "image_sha256": sha,
        "reference_revision": revision,
        "source_id": root.name,
        "dependencies": deps,
        "operator_inputs": operator,
        "parameters": {
            "radius_mm": 0.2,
            "ea_n": 1.0,
            "ei_n_mm2": 0.01,
            "contact_stiffness_n_per_mm": 1000.0,
            "rest_points_ras": None,
        },
    }
    return job, blobs.parent, root, vessel, sac


def test_loader_decodes_verified_native_synthetic_masks(tmp_path, monkeypatch):
    assert importlib.util.find_spec("planner.native_inputs") is not None
    from planner.native_inputs import load_native_masks

    job, directory, _root, vessel, sac = installed_job(tmp_path, monkeypatch)
    arrays, affine = load_native_masks(job, blob_dir=directory)
    assert np.array_equal(arrays["vessel"], vessel)
    assert np.array_equal(arrays["aneurysm"], sac)
    assert np.array_equal(affine, np.eye(4))


def test_real_native_rod_compute_uses_verified_mask_and_solver(tmp_path, monkeypatch):
    assert importlib.util.find_spec("planner.physics_worker") is not None
    from planner.physics_contract import encoded
    from planner.physics_worker import compute_job

    job, directory, _root, _vessel, _sac = installed_job(tmp_path, monkeypatch)
    result = compute_job(job, blob_dir=directory)
    assert result["job_sha256"] == hashlib.sha256(encoded(job).encode()).hexdigest()
    assert result["method"] == "discrete_elastic_rod_native_lumen"
    assert result["clinical_validation"] is False
    assert result["device_calibrated"] is False
    assert result["energy_final_n_mm"] <= result["energy_initial_n_mm"] + 1e-8
    assert result["max_penetration_mm"] == 0
    assert result["minimum_nodal_wall_clearance_mm"] > 0
    assert np.asarray(result["points_ras"]).shape == (4, 3)


def test_real_native_centerline_worker_preserves_proposal_boundary(tmp_path, monkeypatch):
    from planner.physics_worker import compute_job

    job, directory, _source, vessel, _sac = installed_job(tmp_path, monkeypatch)
    job["kind"] = "centerline"
    job["parameters"] = {
        "start_ras": [8.0, 9.0, 4.2],
        "end_ras": [8.0, 9.0, 19.2],
        "max_points": 32,
    }
    job["operator_inputs"] = None
    job["dependencies"] = {
        k: v
        for k, v in job["dependencies"].items()
        if k not in {"geometry_result_id", "geometry_dependencies"}
    }
    job["dependencies"]["masks"] = {"vessel": job["dependencies"]["masks"]["vessel"]}
    result = compute_job(job, blob_dir=directory)
    assert result["operator_confirmation_required"] is True
    assert result["clinical_validation"] is False
    assert result["method"] == "native_skeleton_path_proposal"
    assert 4 <= len(result["path_ras"]) <= 32
    for point in result["path_ras"]:
        assert vessel[tuple(round(v) for v in point)] == 1


def test_real_native_flow_worker_solves_union_lumen_and_preserves_signed_change(
    tmp_path, monkeypatch
):
    from planner.physics_worker import compute_job

    job, directory, _source, vessel, sac = installed_job(tmp_path, monkeypatch)
    job["kind"] = "stokes-flow"
    job["parameters"] = {
        "flow_axis": 2,
        "inlet_velocity_mm_s": 1.0,
        "viscosity_pa_s": 0.0035,
        "neck_thickness_mm": 1.0,
        "resistance_pa_s_per_mm2": 0.01,
    }
    result = compute_job(job, blob_dir=directory)
    assert result["method"] == "taylor_hood_native_voxel_stokes_brinkman"
    assert result["baseline_mean_sac_speed_mm_s"] > 0
    assert result["relative_sac_speed_change_pct"] == pytest.approx(
        100
        * (result["treated_mean_sac_speed_mm_s"] - result["baseline_mean_sac_speed_mm_s"])
        / result["baseline_mean_sac_speed_mm_s"]
    )
    assert result["mesh_diagnostics"]["fluid_voxels"] == int(np.logical_or(vessel, sac).sum())
    assert result["solver_diagnostics"]["baseline"]["divergence_l2"] >= 0
    assert result["flow_diagnostics"]["baseline"]["flux_imbalance_pct"] < 1e-5
    assert result["clinical_validation"] is False and result["device_calibrated"] is False


def test_proposed_native_path_supports_geometry_after_explicit_station_review(
    tmp_path, monkeypatch
):
    from planner.centerline import propose_centerline
    from planner.geometry_worker import compute_native_geometry

    job, _directory, _source, vessel, sac = installed_job(tmp_path, monkeypatch)
    proposal = propose_centerline(
        vessel, np.eye(4), [8.0, 9.0, 4.2], [8.0, 9.0, 19.2], spatial_units="mm", max_points=32
    )
    operator = job["operator_inputs"] | {
        "parent_path": proposal["path_ras"],
        "proximal_index": 2,
        "distal_index": len(proposal["path_ras"]) - 2,
    }
    for i in (operator["proximal_index"], operator["distal_index"]):
        assert sac[tuple(round(x) for x in operator["parent_path"][i])] == 0
    result = compute_native_geometry(sac, vessel, np.eye(4), operator)
    assert result["proximal_parent"]["area"] > 0
    assert result["distal_parent"]["area"] > 0
    assert result["proximal_parent"]["plane_origin"] == tuple(operator["parent_path"][2])


def test_cli_sanitizes_decoder_failure_families(monkeypatch, capsys):
    import io
    import sys
    from types import SimpleNamespace

    from planner import physics_worker

    for failure_type in (
        EOFError,
        nib.filebasedimages.ImageFileError,
        nib.spatialimages.HeaderDataError,
        nib.spatialimages.HeaderTypeError,
    ):

        def broken(*args, failure_type=failure_type, **kwargs):
            raise failure_type("private /data/sensitive/image.nii.gz")

        monkeypatch.setattr(physics_worker, "compute_job", broken)
        monkeypatch.setattr(
            sys, "stdin", SimpleNamespace(buffer=io.BytesIO(b'{"job":{},"blob_dir":"internal"}'))
        )
        with pytest.raises(SystemExit) as failure:
            physics_worker.main()
        assert failure.value.code == 1
        output = capsys.readouterr()
        assert output.out == ""
        assert output.err == f"Native numerical computation failed: {failure_type.__name__}\n"
        assert "Traceback" not in output.err and "/data" not in output.err


def _bounded_supervisor_env(tmp_path, monkeypatch, flood_stream=None):
    """Copy a minimal planner stub into tmp_path so the fixed runtime child
    floods one stream or stays silent, and poison-free supervisor env."""
    from planner import physics_worker

    checkout = tmp_path / "stub-root"
    (checkout / "planner").mkdir(parents=True)
    (checkout / "planner" / "__init__.py").write_text("")
    (checkout / "planner" / "physics_contract.py").write_text(
        "def encoded(value):\n    import json\n    return json.dumps(value, separators=(',', ':'))\n"
    )
    statement = {
        "stdout": 'sys.stdout.write("x" * 65536)',
        "stderr": 'sys.stderr.write("x" * 65536)',
        "silence": "time.sleep(600)",
    }[flood_stream or "silence"]
    body = "\n".join(
        "    " + line
        for line in ([statement] * 200 if flood_stream in ("stdout", "stderr") else [statement])
    )
    (checkout / "planner" / "physics_worker.py").write_text(
        "import sys, time\n"
        "def main():\n"
        "    open('started_marker.txt', 'w').write('started')\n"
        f"{body}\n"
        "    open('exit_marker.txt', 'w').write('exited')\n"
        "if __name__ == '__main__':\n"
        "    main()\n"
    )
    compile((checkout / "planner/physics_worker.py").read_text(), "worker-stub", "exec")
    monkeypatch.setattr(physics_worker, "ROOT", checkout)
    monkeypatch.setattr(physics_worker, "MAX_OUTPUT_BYTES", 1024)
    monkeypatch.setattr(physics_worker, "DEADLINE_SECONDS", 2.0)
    return checkout, physics_worker


def test_supervisor_terminates_runaway_stdout_flood_before_exit(tmp_path, monkeypatch):
    """Oversized stdout must be caught during execution and the owned child
    killed and reaped, never buffered unboundedly."""
    checkout, physics_worker = _bounded_supervisor_env(tmp_path, monkeypatch, "stdout")
    start = time.monotonic()
    with pytest.raises(RuntimeError, match="output bound"):
        physics_worker.run_local_physics({"kind": "bogus"}, blob_dir=tmp_path)
    assert time.monotonic() - start < 15
    assert (checkout / "started_marker.txt").exists(), "fixture did not execute"
    assert not (checkout / "exit_marker.txt").exists(), "child was not killed"


def test_supervisor_terminates_runaway_stderr_flood_before_exit(tmp_path, monkeypatch):
    checkout, physics_worker = _bounded_supervisor_env(tmp_path, monkeypatch, "stderr")
    start = time.monotonic()
    with pytest.raises(RuntimeError, match="output bound"):
        physics_worker.run_local_physics({"kind": "bogus"}, blob_dir=tmp_path)
    assert time.monotonic() - start < 15
    assert (checkout / "started_marker.txt").exists(), "fixture did not execute"
    assert not (checkout / "exit_marker.txt").exists(), "child was not killed"


def test_supervisor_enforces_total_deadline_on_silent_child(tmp_path, monkeypatch):
    checkout, physics_worker = _bounded_supervisor_env(tmp_path, monkeypatch, "silence")
    start = time.monotonic()
    with pytest.raises(RuntimeError, match="deadline"):
        # Larger than Linux's common pipe capacity; the silent child never
        # reads stdin, so a blocking upfront write would defeat the deadline.
        physics_worker.run_local_physics(
            {"kind": "bogus", "padding": "x" * 12000}, blob_dir=tmp_path
        )
    elapsed = time.monotonic() - start
    assert elapsed < 10, elapsed
    assert (checkout / "started_marker.txt").exists(), "fixture did not execute"
    assert not (checkout / "exit_marker.txt").exists(), "child was not killed"


@pytest.mark.parametrize("kind", ["rod-deployment", "centerline", "stokes-flow"])
def test_actual_fixed_runtime_supervisor_runs_isolated_source_checkout(tmp_path, monkeypatch, kind):
    """The supervisor must strip inherited PYTHON* state and resolve the
    planner package and installed sources only from its own ROOT."""
    import shutil

    from planner import physics_worker
    from planner.physics_contract import encoded

    job, directory, source, _vessel, _sac = installed_job(tmp_path, monkeypatch)
    job["kind"] = kind
    if kind == "stokes-flow":
        job["parameters"] = {
            "flow_axis": 2,
            "inlet_velocity_mm_s": 1.0,
            "viscosity_pa_s": 0.0035,
            "neck_thickness_mm": 1.0,
            "resistance_pa_s_per_mm2": 0.01,
        }
    elif kind == "centerline":
        job["parameters"] = {
            "start_ras": [8.0, 9.0, 4.2],
            "end_ras": [8.0, 9.0, 19.2],
            "max_points": 32,
        }
        job["operator_inputs"] = None
        for key in ("geometry_result_id", "geometry_dependencies"):
            job["dependencies"].pop(key)
        job["dependencies"]["masks"] = {"vessel": job["dependencies"]["masks"]["vessel"]}
    # Isolated source checkout under tmp_path: copy only the planner package
    # (no __pycache__) and install the synthetic source into the copy's
    # .runtime/installed-sources. The real NATIVE_PYTHON is kept, so a pass
    # proves cwd/PYTHONPATH resolve the copied ROOT and the child discovers
    # only tmp_path/.runtime/installed-sources.
    checkout = tmp_path / "isolated-root"
    shutil.copytree(
        physics_worker.ROOT / "planner",
        checkout / "planner",
        ignore=shutil.ignore_patterns("__pycache__"),
    )
    installed = checkout / ".runtime" / "installed-sources" / source.name
    installed.parent.mkdir(parents=True)
    shutil.copytree(source, installed)
    monkeypatch.setattr(physics_worker, "ROOT", checkout)
    # Poison the parent environment with interpreter-selecting state that the
    # supervisor must never inherit into the fixed-runtime child.
    monkeypatch.setenv("PYTHONHOME", str(tmp_path / "poisoned-pythonhome"))
    monkeypatch.setenv("PYTHONPATH", "/unrelated-host-packages")
    monkeypatch.setenv("PYTHONUSERBASE", str(tmp_path / "poisoned-user-site"))
    monkeypatch.setenv("PYTHONSTARTUP", str(tmp_path / "poisoned-startup.py"))
    monkeypatch.setenv("PYTHONOPTIMIZE", "2")
    (tmp_path / "poisoned-startup.py").write_text("raise RuntimeError('leaked')\n")
    import subprocess

    forbidden_env = (
        "LD_PRELOAD",
        "LD_LIBRARY_PATH",
        "LD_AUDIT",
        "DYLD_INSERT_LIBRARIES",
        "DYLD_LIBRARY_PATH",
        "DYLD_FRAMEWORK_PATH",
        "DYLD_FALLBACK_LIBRARY_PATH",
        "SHLIB_PATH",
        "_PYTHON_SYSCONFIGDATA_NAME",
        "_PYTHON_PROJECT_BASE",
        "__PYVENV_LAUNCHER__",
        "API_PRIVATE_SENTINEL",
    )
    for key in forbidden_env:
        monkeypatch.setenv(key, str(tmp_path / "poisoned-loader"))
    actual_run = subprocess.Popen
    calls = []

    def observed_run(*args, **kwargs):
        # Assert before spawning: never ask the OS to load the poisoned paths.
        leaked_names = sorted(set(forbidden_env) & set(kwargs["env"]))
        assert leaked_names == []
        calls.append((args, kwargs))
        return actual_run(*args, **kwargs)

    monkeypatch.setattr(subprocess, "Popen", observed_run)
    result = physics_worker.run_local_physics(job, blob_dir=directory)
    assert len(calls) == 1
    command, options = calls[0]
    assert command[0][0] == str(physics_worker.NATIVE_PYTHON)
    assert options["cwd"] == checkout
    assert {k for k in options["env"] if k.startswith("PYTHON")} == {"PYTHONPATH"}
    assert options["env"]["PYTHONPATH"] == str(checkout)
    assert result["job_sha256"] == hashlib.sha256(encoded(job).encode()).hexdigest()
    assert result["clinical_validation"] is False
    if kind == "rod-deployment":
        assert result["max_penetration_mm"] == 0
    elif kind == "centerline":
        assert result["operator_confirmation_required"] is True
    else:
        assert result["baseline_mean_sac_speed_mm_s"] > 0
