"""Projection tests for planner.numerical_projection against real HTTP producers.

Envelope fixtures come from the actual GET /physics/{kind} routes with the same
injected-runner TestClient composition used by tests/test_physics_server.py;
the geometry input is the actual planning-context morphometry_summary. The
projection itself is pure: it never touches HTTP, ledgers or files.
"""

import copy

import pytest
from test_physics_server import compute_fixture, flow_output

from planner.numerical_projection import IDENTITY_KEYS, project_numerical

FLOW_PARAMETERS = {
    "flow_axis": 2,
    "inlet_velocity_mm_s": 1.0,
    "viscosity_pa_s": 0.0035,
    "neck_thickness_mm": 1.0,
    "resistance_pa_s_per_mm2": 0.01,
}


def stored_rod_envelope(tmp_path, monkeypatch):
    client, cid, route, body = compute_fixture(tmp_path, monkeypatch)
    assert client.post(route, json=body).status_code == 200, route
    envelope = client.get(route).json()
    context = client.get(f"/api/cases/{cid}/planning-context").json()
    return envelope, context["morphometry_summary"]


def identity_of(envelope):
    return {key: envelope[key] for key in IDENTITY_KEYS}


def stored_flow_envelope(tmp_path, monkeypatch):
    client, cid, _route, body = compute_fixture(
        tmp_path, monkeypatch, lambda job, **_: flow_output(job)
    )
    body["parameters"] = FLOW_PARAMETERS
    route = f"/api/cases/{cid}/physics/stokes-flow"
    assert client.post(route, json=body).status_code == 200
    envelope = client.get(route).json()
    context = client.get(f"/api/cases/{cid}/planning-context").json()
    return envelope, context["morphometry_summary"]


def test_rod_envelope_projects_current_scalars_without_points(tmp_path, monkeypatch):
    envelope, geometry = stored_rod_envelope(tmp_path, monkeypatch)
    projected = project_numerical(identity_of(envelope), "rod-deployment", envelope, geometry)
    assert projected["scope"] == "anatomy_operator_parameters"
    assert projected["status"] == "current"
    assert projected["result_id"] == envelope["current"]["result_id"]
    assert projected["parameters_sha256"] == envelope["current"]["parameters_sha256"]
    assert projected["parameters"] == envelope["current"]["parameters"]
    assert projected["method"] == "discrete_elastic_rod_native_lumen"
    assert projected["device_calibrated"] is False and projected["clinical_validation"] is False
    assert projected["optimizer_success"] is True
    assert projected["iterations"] == 1
    assert projected["energy_final_n_mm"] == 0.5
    assert projected["minimum_nodal_wall_clearance_mm"] == 1.0
    assert "points_ras" not in projected
    assert set(projected) == {
        "scope",
        "kind",
        "status",
        "result_id",
        "geometry_result_id",
        "parameters_sha256",
        "parameters",
        "method",
        "device_calibrated",
        "clinical_validation",
        "optimizer_success",
        "iterations",
        "energy_initial_n_mm",
        "energy_final_n_mm",
        "max_penetration_mm",
        "minimum_nodal_wall_clearance_mm",
    }


def test_flow_envelope_projects_current_scalar_diagnostics(tmp_path, monkeypatch):
    envelope, geometry = stored_flow_envelope(tmp_path, monkeypatch)
    projected = project_numerical(identity_of(envelope), "stokes-flow", envelope, geometry)
    assert projected["scope"] == "anatomy_operator_parameters"
    assert projected["status"] == "current"
    assert projected["method"] == "taylor_hood_native_voxel_stokes_brinkman"
    assert projected["relative_sac_speed_change_pct"] == -20.0
    assert projected["solver_diagnostics"]["baseline"]["momentum_residual_relative"] == 1e-12
    assert projected["flow_diagnostics"]["treated"]["pressure_drop_pa"] == 0.02
    assert projected["mesh_diagnostics"]["tetrahedra"] == 144
    assert projected["units"]["velocity"] == "mm/s"
    assert projected["device_calibrated"] is False and projected["clinical_validation"] is False


def test_stale_envelope_projects_status_only(tmp_path, monkeypatch):
    envelope, geometry = stored_rod_envelope(tmp_path, monkeypatch)
    stale = copy.deepcopy(envelope)
    stale["current"] = {
        "status": "stale",
        "result_id": envelope["current"]["result_id"],
        "result": None,
    }
    projected = project_numerical(identity_of(envelope), "rod-deployment", stale, geometry)
    assert projected == {
        "scope": "anatomy_operator_parameters",
        "kind": "rod-deployment",
        "status": "stale",
    }


def test_not_computed_envelope_projects_status_only():
    envelope = {
        "case_id": "c",
        "image_sha256": "a" * 64,
        "artifact_version": "1",
        "reference_revision": "b" * 64,
        "kind": "stokes-flow",
        "current": {"status": "not_computed", "result": None},
    }
    projected = project_numerical(identity_of(envelope), "stokes-flow", envelope, None)
    assert projected == {
        "scope": "anatomy_operator_parameters",
        "kind": "stokes-flow",
        "status": "not_computed",
    }


def test_current_without_geometry_summary_is_not_promoted(tmp_path, monkeypatch):
    envelope, _geometry = stored_rod_envelope(tmp_path, monkeypatch)
    with pytest.raises(ValueError):
        project_numerical(identity_of(envelope), "rod-deployment", envelope, None)


def test_identity_mismatch_with_envelope_is_rejected(tmp_path, monkeypatch):
    envelope, geometry = stored_rod_envelope(tmp_path, monkeypatch)
    identity = identity_of(envelope)
    wrong = identity | {"artifact_version": "999"}
    with pytest.raises(ValueError):
        project_numerical(wrong, "rod-deployment", envelope, geometry)


def test_extra_identity_key_is_rejected(tmp_path, monkeypatch):
    envelope, geometry = stored_rod_envelope(tmp_path, monkeypatch)
    identity = identity_of(envelope) | {"operator": "x"}
    with pytest.raises(ValueError):
        project_numerical(identity, "rod-deployment", envelope, geometry)


def test_unknown_envelope_key_is_rejected(tmp_path, monkeypatch):
    envelope, geometry = stored_rod_envelope(tmp_path, monkeypatch)
    padded = envelope | {"extra": True}
    with pytest.raises(ValueError):
        project_numerical(identity_of(envelope), "rod-deployment", padded, geometry)


def test_tampered_parameters_hash_is_rejected(tmp_path, monkeypatch):
    envelope, geometry = stored_rod_envelope(tmp_path, monkeypatch)
    tampered = copy.deepcopy(envelope)
    tampered["current"]["parameters_sha256"] = "0" * 64
    with pytest.raises(ValueError):
        project_numerical(identity_of(envelope), "rod-deployment", tampered, geometry)


def test_nonfinite_parameter_is_rejected(tmp_path, monkeypatch):
    envelope, geometry = stored_rod_envelope(tmp_path, monkeypatch)
    tampered = copy.deepcopy(envelope)
    tampered["current"]["parameters"]["radius_mm"] = float("nan")
    with pytest.raises(ValueError):
        project_numerical(identity_of(envelope), "rod-deployment", tampered, geometry)


def test_geometry_result_id_mismatch_is_rejected(tmp_path, monkeypatch):
    envelope, geometry = stored_rod_envelope(tmp_path, monkeypatch)
    tampered = copy.deepcopy(envelope)
    tampered["current"]["dependencies"]["geometry_result_id"] = "other"
    with pytest.raises(ValueError):
        project_numerical(identity_of(envelope), "rod-deployment", tampered, geometry)


def test_source_revision_mismatch_is_rejected(tmp_path, monkeypatch):
    envelope, geometry = stored_rod_envelope(tmp_path, monkeypatch)
    tampered = copy.deepcopy(envelope)
    tampered["current"]["dependencies"]["source_revision"] = "f" * 64
    with pytest.raises(ValueError):
        project_numerical(identity_of(envelope), "rod-deployment", tampered, geometry)


def test_unvalidated_claim_in_result_is_rejected(tmp_path, monkeypatch):
    envelope, geometry = stored_rod_envelope(tmp_path, monkeypatch)
    tampered = copy.deepcopy(envelope)
    tampered["current"]["result"]["clinical_validation"] = True
    with pytest.raises(ValueError):
        project_numerical(identity_of(envelope), "rod-deployment", tampered, geometry)


def test_nonfinite_result_scalar_is_rejected(tmp_path, monkeypatch):
    envelope, geometry = stored_rod_envelope(tmp_path, monkeypatch)
    tampered = copy.deepcopy(envelope)
    tampered["current"]["result"]["energy_final_n_mm"] = float("inf")
    with pytest.raises(ValueError):
        project_numerical(identity_of(envelope), "rod-deployment", tampered, geometry)


def test_unknown_result_method_is_rejected(tmp_path, monkeypatch):
    envelope, geometry = stored_rod_envelope(tmp_path, monkeypatch)
    tampered = copy.deepcopy(envelope)
    tampered["current"]["result"]["method"] = "other"
    with pytest.raises(ValueError):
        project_numerical(identity_of(envelope), "rod-deployment", tampered, geometry)


@pytest.mark.parametrize("mutation", ["unknown_status", "nested_case", "optimizer_type"])
def test_closed_current_variant_cannot_be_promoted_with_contradictions(
    tmp_path, monkeypatch, mutation
):
    envelope, geometry = stored_rod_envelope(tmp_path, monkeypatch)
    bad = copy.deepcopy(envelope)
    if mutation == "unknown_status":
        bad["current"]["status"] = "unknown"
    elif mutation == "nested_case":
        bad["current"]["dependencies"]["case_id"] = "different-case"
    else:
        bad["current"]["result"]["optimizer_success"] = 1
    with pytest.raises(ValueError):
        project_numerical(identity_of(envelope), "rod-deployment", bad, geometry)


def test_not_computed_suppresses_only_a_truly_absent_result(tmp_path, monkeypatch):
    envelope, geometry = stored_rod_envelope(tmp_path, monkeypatch)
    envelope["current"] = {"status": "not_computed", "result": {"unexpected": 1}}
    with pytest.raises(ValueError):
        project_numerical(identity_of(envelope), "rod-deployment", envelope, geometry)


def test_custom_rest_shape_is_hash_bound_without_exporting_coordinate_arrays(tmp_path, monkeypatch):
    import hashlib

    from planner.physics_contract import encoded

    client, cid, route, body = compute_fixture(tmp_path, monkeypatch)
    points = client.get(f"/api/cases/{cid}/morphometry").json()["operator_inputs"]["parent_path"]
    body["parameters"]["rest_points_ras"] = points
    response = client.post(route, json=body)
    assert response.status_code == 200, response.text
    envelope = client.get(route).json()
    geometry = client.get(f"/api/cases/{cid}/planning-context").json()["morphometry_summary"]
    projected = project_numerical(identity_of(envelope), "rod-deployment", envelope, geometry)
    assert "rest_points_ras" not in projected["parameters"]
    assert projected["rest_shape_summary"] == {
        "point_count": len(points),
        "sha256": hashlib.sha256(encoded(points).encode()).hexdigest(),
    }
    assert projected["parameters_sha256"] == envelope["current"]["parameters_sha256"]


def test_flow_projection_rejects_unknown_nested_numeric_metadata(tmp_path, monkeypatch):
    envelope, geometry = stored_flow_envelope(tmp_path, monkeypatch)
    envelope["current"]["result"]["solver_diagnostics"]["baseline"]["unrecognized_number"] = 12
    with pytest.raises(ValueError):
        project_numerical(identity_of(envelope), "stokes-flow", envelope, geometry)


def test_unknown_centerline_kind_is_rejected(tmp_path, monkeypatch):
    envelope, geometry = stored_rod_envelope(tmp_path, monkeypatch)
    with pytest.raises(ValueError):
        project_numerical(identity_of(envelope), "centerline", envelope, geometry)
