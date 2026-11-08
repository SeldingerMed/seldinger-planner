"""Fixed-runtime native numerical worker. No imaging imports in the API process."""

import hashlib
import json
from pathlib import Path

from planner.physics_contract import encoded

ROOT = Path(__file__).resolve().parents[1]
NATIVE_PYTHON = ROOT / ".runtime/physics-runtime/bin/python"
MAX_INPUT_BYTES = 16384
MAX_OUTPUT_BYTES = 65536
DEADLINE_SECONDS = 120


def compute_job(job, *, blob_dir):
    import numpy as np

    from planner.native_inputs import load_native_masks

    arrays, affine = load_native_masks(job, blob_dir=blob_dir)
    parameters = job["parameters"]
    if job["kind"] == "centerline":
        from planner.centerline import propose_centerline

        proposal = propose_centerline(
            arrays["vessel"],
            affine,
            parameters["start_ras"],
            parameters["end_ras"],
            spatial_units="mm",
            max_points=parameters["max_points"],
        )
        result = {
            key: proposal[key]
            for key in (
                "path_ras",
                "proximal_index",
                "distal_index",
                "operator_confirmation_required",
                "clinical_validation",
                "spatial_units",
                "length_mm",
                "point_count",
                "skeleton_voxel_count",
                "grid_shape",
            )
        }
        result.update(
            method="native_skeleton_path_proposal",
            device_calibrated=False,
            job_sha256=hashlib.sha256(encoded(job).encode()).hexdigest(),
        )
        encoded(result)
        return result
    if job["kind"] == "stokes-flow":
        from planner.aneurysm_stokes import solve_aneurysm_stokes

        # The accepted vessel and sac segmentations jointly define fluid;
        # the sac is also retained separately as the averaging region.
        raw = solve_aneurysm_stokes(
            np.logical_or(arrays["vessel"], arrays["aneurysm"]).astype(np.uint8),
            arrays["aneurysm"],
            affine,
            neck_origin=job["operator_inputs"]["neck_origin"],
            neck_normal=job["operator_inputs"]["neck_normal"],
            spatial_units="mm",
            **parameters,
        )
        result = {
            "method": "taylor_hood_native_voxel_stokes_brinkman",
            "job_sha256": hashlib.sha256(encoded(job).encode()).hexdigest(),
            "clinical_validation": False,
            "device_calibrated": False,
            "baseline_mean_sac_speed_mm_s": raw["sac_mean_speed_baseline_mm_s"],
            "treated_mean_sac_speed_mm_s": raw["sac_mean_speed_treated_mm_s"],
            "relative_sac_speed_change_pct": raw["sac_mean_speed_relative_change_pct"],
            "solver_diagnostics": {},
            "flow_diagnostics": {},
            "mesh_diagnostics": {
                "fluid_voxels": raw["n_fluid_voxels"],
                "tetrahedra": raw["n_tets"],
                "velocity_dofs": raw["n_velocity_dofs"],
                "pressure_dofs": raw["n_pressure_dofs"],
            },
            "units": {
                "velocity": "mm/s",
                "pressure": "Pa",
                "flux": "mm^3/s",
                "divergence_l2": "mm^(3/2)/s",
            },
        }
        for phase in ("baseline", "treated"):
            result["solver_diagnostics"][phase] = {
                "momentum_residual_relative": raw[f"momentum_residual_relative_{phase}"],
                "discrete_continuity_residual": raw[f"divergence_residual_{phase}"],
                "divergence_l2": raw[f"divergence_l2_{phase}"],
            }
            result["flow_diagnostics"][phase] = {
                "inlet_flux_mm3_s": raw[f"inlet_flux_{phase}_mm3_s"],
                "outlet_flux_mm3_s": raw[f"outlet_flux_{phase}_mm3_s"],
                "flux_imbalance_pct": raw[f"flux_imbalance_{phase}_pct"],
                "pressure_drop_pa": raw[f"pressure_drop_inlet_to_outlet_{phase}_pa"],
            }
        encoded(result)
        return result
    if job["kind"] != "rod-deployment":
        raise ValueError("Unknown numerical worker kind")
    from planner.lumen_contact import minimize_in_lumen_field
    from planner.lumen_distance import LumenWallField
    from planner.rod_contact import RodModel

    initial = np.asarray(job["operator_inputs"]["parent_path"], dtype=float)
    rest = parameters.get("rest_points_ras")
    rest = initial.copy() if rest is None else np.asarray(rest, dtype=float)
    if rest.shape != initial.shape or not 4 <= len(initial) <= 32:
        raise ValueError("Rest and initial rod paths must share four to thirty-two nodes")
    wall = LumenWallField(arrays["vessel"], affine, spatial_units="mm")
    rod = RodModel(
        points=rest,
        radius=parameters["radius_mm"],
        ea=parameters["ea_n"],
        ei=parameters["ei_n_mm2"],
    )
    solved = minimize_in_lumen_field(
        rod, initial, wall, stiffness=parameters["contact_stiffness_n_per_mm"]
    )
    clearances = rod.contact_gaps(solved.points, wall)
    result = {
        "job_sha256": hashlib.sha256(encoded(job).encode()).hexdigest(),
        "method": "discrete_elastic_rod_native_lumen",
        "clinical_validation": False,
        "device_calibrated": False,
        "optimizer_success": bool(solved.success),
        "iterations": int(solved.nit),
        "energy_initial_n_mm": float(solved.energy_initial),
        "energy_final_n_mm": float(solved.energy_final),
        "max_penetration_mm": float(solved.max_residual_normal),
        "minimum_nodal_wall_clearance_mm": float(clearances.min()),
        "points_ras": solved.points.tolist(),
    }
    encoded(result)  # Reject nonfinite diagnostics, never fabricate convergence.
    return result


def run_local_physics(job, *, blob_dir):
    import os
    import subprocess

    if not NATIVE_PYTHON.is_file():
        raise RuntimeError("Native numerical runtime is not installed")
    payload = encoded({"job": job, "blob_dir": str(Path(blob_dir).absolute())})
    if len(payload.encode()) > MAX_INPUT_BYTES:
        raise ValueError("Numerical job exceeds its input bound")
    env = {key: value for key, value in os.environ.items() if not key.startswith("PYTHON")}
    # Deliberate: only this interpreter-selecting PYTHONPATH survives.
    env["PYTHONPATH"] = str(ROOT)
    for key in (
        "OMP_NUM_THREADS",
        "OPENBLAS_NUM_THREADS",
        "MKL_NUM_THREADS",
        "VECLIB_MAXIMUM_THREADS",
    ):
        env[key] = "1"
    try:
        completed = subprocess.run(
            [str(NATIVE_PYTHON), "-m", "planner.physics_worker"],
            input=payload,
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            shell=False,
            timeout=DEADLINE_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError("Native numerical worker failed or exceeded its deadline") from None
    if completed.returncode != 0 or len(completed.stdout.encode()) > MAX_OUTPUT_BYTES:
        raise RuntimeError("Native numerical worker failed or exceeded its output bound")
    try:
        result = json.loads(completed.stdout)
        if not isinstance(result, dict):
            raise TypeError("Invalid numerical response")
        encoded(result)
    except (ValueError, TypeError):
        raise RuntimeError("Native numerical worker returned invalid evidence") from None
    return result


def main():
    import sys

    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            raise ValueError("Numerical input exceeds its bound")
        payload = json.loads(raw)
        result = encoded(compute_job(payload["job"], blob_dir=payload["blob_dir"]))
        if len(result.encode()) > MAX_OUTPUT_BYTES:
            raise ValueError("Numerical output exceeds its bound")
        print(result)
    except (OSError, ValueError, TypeError, KeyError, RuntimeError) as exc:
        print(f"Native numerical computation failed: {type(exc).__name__}", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
