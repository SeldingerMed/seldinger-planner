"""Synthetic HTTP/ledger tests. Injected runners are not numerical evidence."""

from test_phase1_context import ready

from planner.physics_state import encoded


def rod_output(job):
    import hashlib

    return {
        "job_sha256": hashlib.sha256(encoded(job).encode()).hexdigest(),
        "method": "discrete_elastic_rod_native_lumen",
        "clinical_validation": False,
        "device_calibrated": False,
        "optimizer_success": True,
        "iterations": 1,
        "energy_initial_n_mm": 1.0,
        "energy_final_n_mm": 0.5,
        "max_penetration_mm": 0.0,
        "minimum_nodal_wall_clearance_mm": 1.0,
        "points_ras": [[0.0, 0.0, float(i)] for i in range(4)],
    }


def test_real_route_persists_and_reopens_bound_rod_result(tmp_path, monkeypatch):
    from planner import physics_server

    seen = []

    def runner(job, *, blob_dir):
        seen.append((job, blob_dir))
        return rod_output(job)

    monkeypatch.setattr(physics_server, "default_runner", lambda: runner, raising=False)
    client, cid, version = ready(tmp_path)
    geometry = client.get(f"/api/cases/{cid}/morphometry").json()
    route = f"/api/cases/{cid}/physics/rod-deployment"
    payload = {
        "artifact_version": version,
        "reference_revision": "b" * 64,
        "geometry_result_id": geometry["current"]["result_id"],
        "parameters": {
            "radius_mm": 0.2,
            "ea_n": 1.0,
            "ei_n_mm2": 0.01,
            "contact_stiffness_n_per_mm": 1000.0,
        },
    }
    response = client.post(route, json=payload)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["current"]["status"] == "current"
    assert result["current"]["result"]["energy_final_n_mm"] == 0.5
    assert client.get(route).json()["current"] == result["current"]
    assert seen[0][0]["source_id"] == "zenodo-case006-calibrated"
    assert "blob_dir" not in seen[0][0]
    assert seen[0][1] == tmp_path / "inference-results"
    assert client.get(f"/api/cases/{cid}").json()["artifact_version"] == version


def compute_fixture(tmp_path, monkeypatch, runner=None):
    from planner import physics_server

    monkeypatch.setattr(
        physics_server, "default_runner", lambda: runner or (lambda job, **_: rod_output(job))
    )
    client, cid, version = ready(tmp_path)
    geometry = client.get(f"/api/cases/{cid}/morphometry").json()
    route = f"/api/cases/{cid}/physics/rod-deployment"
    body = {
        "artifact_version": version,
        "reference_revision": "b" * 64,
        "geometry_result_id": geometry["current"]["result_id"],
        "parameters": {
            "radius_mm": 0.2,
            "ea_n": 1.0,
            "ei_n_mm2": 0.01,
            "contact_stiffness_n_per_mm": 1000.0,
        },
    }
    return client, cid, route, body


def test_tampered_stored_numerical_output_fails_closed(tmp_path, monkeypatch):
    import sqlite3

    client, _cid, route, body = compute_fixture(tmp_path, monkeypatch)
    assert client.post(route, json=body).status_code == 200
    with sqlite3.connect(tmp_path / "case.sqlite3") as conn:
        conn.execute(
            "UPDATE numerical_results SET result=?", ('{"private_path":"/private/secret"}',)
        )
    response = client.get(route)
    assert response.status_code == 503
    assert "/private" not in response.text


def centerline_output(job):
    import hashlib

    result = {
        "job_sha256": hashlib.sha256(encoded(job).encode()).hexdigest(),
        "method": "native_skeleton_path_proposal",
        "clinical_validation": False,
        "device_calibrated": False,
        "operator_confirmation_required": True,
        "spatial_units": "mm",
        "path_ras": [[0.0, 0.0, float(i)] for i in range(4)],
        "proximal_index": 1,
        "distal_index": 2,
        "length_mm": 3.0,
        "point_count": 4,
        "skeleton_voxel_count": 4,
        "grid_shape": [4, 4, 4],
    }
    return result


def test_centerline_proposal_does_not_save_operator_geometry(tmp_path, monkeypatch):
    from planner import physics_server

    monkeypatch.setattr(
        physics_server, "default_runner", lambda: lambda job, **_: centerline_output(job)
    )
    client, cid, version = ready(tmp_path)
    before = client.get(f"/api/cases/{cid}/morphometry").json()
    route = f"/api/cases/{cid}/centerline-proposals"
    body = {
        "artifact_version": version,
        "reference_revision": "b" * 64,
        "parameters": {"start_ras": [0.0, 0.0, 0.0], "end_ras": [0.0, 0.0, 3.0], "max_points": 32},
    }
    response = client.post(route, json=body)
    assert response.status_code == 200, response.text
    assert response.json()["current"]["result"]["operator_confirmation_required"] is True
    assert client.get(f"/api/cases/{cid}/morphometry").json() == before
    assert client.get(route).json()["current"] == response.json()["current"]


def test_centerline_is_available_before_operator_geometry_is_saved(tmp_path, monkeypatch):
    from test_geometry_server import configured

    from planner import physics_server

    monkeypatch.setattr(
        physics_server, "default_runner", lambda: lambda job, **_: centerline_output(job)
    )
    client, case, _ = configured(tmp_path)
    response = client.post(
        f"/api/cases/{case['case_id']}/centerline-proposals",
        json={
            "artifact_version": case["artifact_version"],
            "reference_revision": "b" * 64,
            "parameters": {
                "start_ras": [0.0, 0.0, 0.0],
                "end_ras": [0.0, 0.0, 3.0],
                "max_points": 32,
            },
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["current"]["dependencies"]["masks"].keys() == {"vessel"}


def test_geometry_replacement_without_case_bump_stales_numerical_result(tmp_path, monkeypatch):
    client, cid, route, body = compute_fixture(tmp_path, monkeypatch)
    assert client.post(route, json=body).status_code == 200
    recomputed = client.post(
        f"/api/cases/{cid}/morphometry",
        json={k: body[k] for k in ("artifact_version", "reference_revision")},
    )
    assert recomputed.status_code == 200
    assert recomputed.json()["current"]["result_id"] != body["geometry_result_id"]
    current = client.get(route).json()["current"]
    assert current["status"] == "stale" and current["result"] is None
    assert client.post(route, json=body).status_code == 409


def test_replacement_during_solve_is_rejected_before_result_persistence(tmp_path, monkeypatch):
    from test_geometry_server import metrics

    from planner.geometry_state import GeometryLedger

    def runner(job, **_):
        ledger = GeometryLedger(tmp_path / "case.sqlite3")
        deps = ledger.snapshot(job["case_id"], job["artifact_version"], job["reference_revision"])
        ledger.store(job["case_id"], deps, metrics())
        return rod_output(job)

    client, _cid, route, body = compute_fixture(tmp_path, monkeypatch, runner)
    assert client.post(route, json=body).status_code == 409
    assert client.get(route).json()["current"]["status"] == "not_computed"


def test_busy_gate_prevents_numerical_execution(tmp_path, monkeypatch):
    from planner.segmentation_server import _INFERENCE_GATE

    called = []
    client, _cid, route, body = compute_fixture(
        tmp_path, monkeypatch, lambda *a, **k: called.append(True)
    )
    assert _INFERENCE_GATE.acquire(blocking=False)
    try:
        assert client.post(route, json=body).status_code == 429
    finally:
        _INFERENCE_GATE.release()
    assert called == []


def test_request_cannot_supply_asset_paths_or_non_numeric_materials(tmp_path, monkeypatch):
    called = []
    client, _cid, route, body = compute_fixture(
        tmp_path, monkeypatch, lambda *a, **k: called.append(True)
    )
    assert client.post(route, json=body | {"blob_dir": "/private"}).status_code == 422
    for bad in (True, "1", -1, 0):
        assert (
            client.post(
                route, json=body | {"parameters": body["parameters"] | {"radius_mm": bad}}
            ).status_code
            == 422
        )
    assert called == []


def test_bad_worker_identity_is_sanitized_and_never_stored(tmp_path, monkeypatch):
    client, _cid, route, body = compute_fixture(
        tmp_path, monkeypatch, lambda job, **_: rod_output(job) | {"job_sha256": "0" * 64}
    )
    response = client.post(route, json=body)
    assert response.status_code == 503
    assert client.get(route).json()["current"]["status"] == "not_computed"


def test_supervisor_uses_model_free_physics_runtime():
    from planner import physics_worker

    runtime = getattr(physics_worker, "NATIVE_PYTHON", None)
    assert runtime == physics_worker.ROOT / ".runtime/physics-runtime/bin/python"


def test_centerline_worker_cannot_exceed_requested_point_budget(tmp_path, monkeypatch):
    from planner import physics_server

    def runner(job, **_):
        return centerline_output(job) | {
            "path_ras": [[0.0, 0.0, z] for z in [0.0, 0.75, 1.5, 2.25, 3.0]],
            "point_count": 5,
            "skeleton_voxel_count": 5,
        }

    monkeypatch.setattr(physics_server, "default_runner", lambda: runner)
    client, cid, version = ready(tmp_path)
    response = client.post(
        f"/api/cases/{cid}/centerline-proposals",
        json={
            "artifact_version": version,
            "reference_revision": "b" * 64,
            "parameters": {
                "start_ras": [0.0, 0.0, 0.0],
                "end_ras": [0.0, 0.0, 3.0],
                "max_points": 4,
            },
        },
    )
    assert response.status_code == 503


def test_rod_worker_cannot_change_the_submitted_node_count(tmp_path, monkeypatch):
    client, _cid, route, body = compute_fixture(
        tmp_path,
        monkeypatch,
        lambda job, **_: rod_output(job) | {"points_ras": [[0.0, 0.0, float(i)] for i in range(5)]},
    )
    assert client.post(route, json=body).status_code == 503


def flow_output(job):
    # Injected HTTP-contract fixture, not evidence of a numerical solve.
    import hashlib

    from planner.physics_contract import encoded

    return {
        "job_sha256": hashlib.sha256(encoded(job).encode()).hexdigest(),
        "method": "taylor_hood_native_voxel_stokes_brinkman",
        "clinical_validation": False,
        "device_calibrated": False,
        "baseline_mean_sac_speed_mm_s": 1.0,
        "treated_mean_sac_speed_mm_s": 0.8,
        "relative_sac_speed_change_pct": -20.0,
        "solver_diagnostics": {
            p: {
                "momentum_residual_relative": 1e-12,
                "discrete_continuity_residual": 1e-12,
                "divergence_l2": 0.01,
            }
            for p in ("baseline", "treated")
        },
        "flow_diagnostics": {
            p: {
                "inlet_flux_mm3_s": 1.0,
                "outlet_flux_mm3_s": 1.0,
                "flux_imbalance_pct": 0.0,
                "pressure_drop_pa": 0.02,
            }
            for p in ("baseline", "treated")
        },
        "mesh_diagnostics": {
            "fluid_voxels": 24,
            "tetrahedra": 144,
            "velocity_dofs": 300,
            "pressure_dofs": 40,
        },
        "units": {
            "velocity": "mm/s",
            "pressure": "Pa",
            "flux": "mm^3/s",
            "divergence_l2": "mm^(3/2)/s",
        },
    }


def test_injected_flow_http_result_is_bound_persisted_and_read_back(tmp_path, monkeypatch):
    client, cid, _route, body = compute_fixture(
        tmp_path, monkeypatch, lambda job, **_: flow_output(job)
    )
    body["parameters"] = {
        "flow_axis": 2,
        "inlet_velocity_mm_s": 1.0,
        "viscosity_pa_s": 0.0035,
        "neck_thickness_mm": 1.0,
        "resistance_pa_s_per_mm2": 0.01,
    }
    route = f"/api/cases/{cid}/physics/stokes-flow"
    response = client.post(route, json=body)
    assert response.status_code == 200, response.text
    current = response.json()["current"]
    assert current["result"]["relative_sac_speed_change_pct"] == -20.0
    assert client.get(route).json()["current"] == current


def test_actual_workspace_projects_sql_integer_revision_before_numerical_routes(
    tmp_path, monkeypatch
):
    import sqlite3

    from planner import physics_server

    monkeypatch.setattr(
        physics_server, "default_runner", lambda: lambda job, **_: centerline_output(job)
    )
    client, cid, version = ready(tmp_path)
    with sqlite3.connect(tmp_path / "case.sqlite3") as conn:
        raw = conn.execute(
            "SELECT artifact_version, typeof(artifact_version) FROM cases WHERE case_id=?", (cid,)
        ).fetchone()
    assert type(raw[0]) is int and raw[1] == "integer"
    assert type(version) is str
    assert client.get(f"/api/cases/{cid}").json()["artifact_version"] == str(raw[0])
    response = client.post(
        f"/api/cases/{cid}/centerline-proposals",
        json={
            "artifact_version": version,
            "reference_revision": "b" * 64,
            "parameters": {
                "start_ras": [0.0, 0.0, 0.0],
                "end_ras": [0.0, 0.0, 3.0],
                "max_points": 32,
            },
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["artifact_version"] == str(raw[0])


def test_physics_read_returns_explicit_not_computed_for_current_geometry(tmp_path):
    client, cid, _version = ready(tmp_path)
    response = client.get(f"/api/cases/{cid}/physics/rod-deployment")
    assert response.status_code == 200, response.text
    assert response.json()["current"]["status"] == "not_computed"
    assert response.json()["current"]["result"] is None
