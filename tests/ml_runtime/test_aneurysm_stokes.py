"""Exercised accepted-mask aneurysm Stokes/Brinkman prototype (scikit-fem, optional runtime).

PROTOTYPE DISCRETIZATION ONLY. This solves steady incompressible Stokes with a
scalar Brinkman drag slab on a voxel-bounded tetrahedral mesh built from a
synthetic accepted binary lumen mask, under HYPOTHETICAL boundary conditions
(fixed inlet speed, no-slip walls, natural traction outlet) and a HYPOTHETICAL
resistance parameter. It is NOT patient-specific validated CFD and NOT a
manufacturer-device-calibrated flow model. No clinical claims.

Run with:
  env -u PYTHONPATH -u PYTHONHOME SELDINGER_RUN_MODEL_TESTS=1 \
      .runtime/physics-runtime/bin/python -m pytest tests/ml_runtime/test_aneurysm_stokes.py -q
"""

import os

import pytest

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Requires isolated imaging runtime", allow_module_level=True)

import numpy as np


def _tube_masks(nx=6, ny=4, nz=4):
    """Synthetic straight duct along grid axis 0 with a mid-tube 'sac' region."""
    lumen = np.zeros((nx, ny, nz), dtype=np.uint8)
    lumen[:, 1:3, 1:3] = 1
    sac = np.zeros_like(lumen)
    sac[2:4, 1:3, 1:3] = 1
    return lumen, sac


def _solve(**overrides):
    from planner.aneurysm_stokes import solve_aneurysm_stokes

    lumen, sac = _tube_masks()
    kwargs = {
        "lumen_mask": lumen,
        "sac_mask": sac,
        "affine_ras": np.eye(4),
        "flow_axis": 0,
        "inlet_velocity_mm_s": 1.0,
        "viscosity_pa_s": 0.0035,
        "neck_origin": (2.5, 1.5, 1.5),
        "neck_normal": (1.0, 0.0, 0.0),
        "neck_thickness_mm": 1.0,
        "resistance_pa_s_per_mm2": 0.05,
        "spatial_units": "mm",
    }
    kwargs.update(overrides)
    return solve_aneurysm_stokes(**kwargs)


def test_no_slip_duct_has_positive_pressure_drop_and_nonrigid_flow():
    out = _solve(resistance_pa_s_per_mm2=0.0)
    assert out["pressure_drop_inlet_to_outlet_baseline_pa"] > 0
    assert 0 < out["sac_mean_speed_baseline_mm_s"] < 1.0
    assert out["inlet_flux_baseline_mm3_s"] > 0
    assert out["outlet_flux_baseline_mm3_s"] > 0


def test_resistance_is_applied_once_with_physical_coefficient_units():
    first = _solve(resistance_pa_s_per_mm2=1e-5)
    second = _solve(resistance_pa_s_per_mm2=2e-5)
    delta1 = (
        first["pressure_drop_inlet_to_outlet_treated_pa"]
        - first["pressure_drop_inlet_to_outlet_baseline_pa"]
    )
    delta2 = (
        second["pressure_drop_inlet_to_outlet_treated_pa"]
        - second["pressure_drop_inlet_to_outlet_baseline_pa"]
    )
    assert delta1 > 0
    assert delta2 / delta1 == pytest.approx(2.0, rel=0.03)


def test_rigid_world_transform_preserves_scalar_solution_and_flux():
    angle = 0.6
    rot = np.array(
        [[np.cos(angle), -np.sin(angle), 0.0], [np.sin(angle), np.cos(angle), 0.0], [0.0, 0.0, 1.0]]
    )
    affine = np.eye(4)
    affine[:3, :3], affine[:3, 3] = rot, [3.0, -4.0, 9.0]
    baseline = _solve()
    transformed = _solve(
        affine_ras=affine,
        neck_origin=rot @ np.array([2.5, 1.5, 1.5]) + affine[:3, 3],
        neck_normal=rot @ np.array([1.0, 0.0, 0.0]),
    )
    for field in (
        "sac_mean_speed_baseline_mm_s",
        "sac_mean_speed_treated_mm_s",
        "inlet_flux_baseline_mm3_s",
        "pressure_drop_inlet_to_outlet_treated_pa",
    ):
        assert transformed[field] == pytest.approx(baseline[field], rel=1e-7, abs=1e-9)


def test_native_bbox_offset_and_affine_translation_are_not_lost():
    lumen, sac = _tube_masks()
    shifted_lumen = np.zeros((12, 10, 9), dtype=np.uint8)
    shifted_sac = np.zeros_like(shifted_lumen)
    shifted_lumen[3:9, 2:6, 1:5], shifted_sac[3:9, 2:6, 1:5] = lumen, sac
    affine = np.eye(4)
    affine[:3, 3] = [-3.0, -2.0, -1.0]
    expected = _solve()
    result = _solve(lumen_mask=shifted_lumen, sac_mask=shifted_sac, affine_ras=affine)
    assert result["sac_mean_speed_treated_mm_s"] == pytest.approx(
        expected["sac_mean_speed_treated_mm_s"], rel=1e-8
    )


def test_nonrectangular_lumen_has_no_unused_pressure_or_velocity_nodes():
    lumen, sac = _tube_masks()
    lumen[2:4, 3, 1:3] = 1
    sac[2:4, 3, 1:3] = 1
    out = _solve(lumen_mask=lumen, sac_mask=sac)
    assert out["sac_mean_speed_baseline_mm_s"] > 0
    assert out["stokes_residual_rel_baseline"] < 1e-8
    assert out["flux_imbalance_baseline_pct"] < 1e-6


def test_unprojected_divergence_norm_matches_known_affine_field():
    from skfem import Basis, ElementTetP2, ElementVector, MeshTet

    from planner.aneurysm_stokes import _divergence_l2

    mesh = MeshTet.init_tensor(np.array([0.0, 1.0]), np.array([0.0, 1.0]), np.array([0.0, 1.0]))
    basis = Basis(mesh, ElementVector(ElementTetP2()), intorder=4)
    coefficients = np.zeros(basis.N)
    ix = basis.split_indices()[0]
    coefficients[ix] = basis.doflocs[0, ix]
    assert _divergence_l2(basis, coefficients) == pytest.approx(1.0, abs=1e-12)


def test_weak_continuity_does_not_hide_elementwise_divergence():
    from scipy.linalg import null_space
    from skfem import Basis, ElementTetP1, ElementTetP2, ElementVector, MeshTet, asm
    from skfem.models.general import divergence

    from planner.aneurysm_stokes import _divergence_l2

    mesh = MeshTet.init_tensor(np.array([0.0, 1.0]), np.array([0.0, 1.0]), np.array([0.0, 1.0]))
    velocity = Basis(mesh, ElementVector(ElementTetP2()), intorder=4)
    pressure = Basis(mesh, ElementTetP1(), intorder=4)
    continuity = asm(divergence, velocity, pressure).toarray()
    null = null_space(continuity)
    norms = [_divergence_l2(velocity, null[:, i]) for i in range(null.shape[1])]
    candidate = null[:, int(np.argmax(norms))]
    assert np.linalg.norm(continuity @ candidate) < 1e-12
    assert _divergence_l2(velocity, candidate) > 0.1


def test_momentum_and_continuity_diagnostics_are_separate():
    out = _solve()
    assert 0 <= out["momentum_residual_relative_baseline"] < 1e-8
    assert out["divergence_l2_baseline"] >= 0
    assert out["divergence_residual_baseline"] < 1e-8


@pytest.mark.parametrize(
    "overrides",
    [
        {"flow_axis": True},
        {"inlet_velocity_mm_s": True},
        {"viscosity_pa_s": "0.0035"},
        {"resistance_pa_s_per_mm2": False},
    ],
)
def test_direct_solver_rejects_coercible_non_numeric_parameters(overrides):
    from planner.aneurysm_stokes import AneurysmStokesError

    with pytest.raises(AneurysmStokesError):
        _solve(**overrides)


def test_boundary_bookkeeping_rejects_an_interior_facet(monkeypatch):
    from planner import aneurysm_stokes as module

    original = module._facet_sets

    def corrupt(tets, *args):
        faces, inlet, outlet = original(tets, *args)
        all_faces = np.concatenate(
            [tets[[1, 2, 3]], tets[[0, 2, 3]], tets[[0, 1, 3]], tets[[0, 1, 2]]], axis=1
        )
        unique, counts = np.unique(np.sort(all_faces, axis=0).T, axis=0, return_counts=True)
        faces[:, 0] = unique[counts == 2][0]
        return faces, inlet, outlet

    monkeypatch.setattr(module, "_facet_sets", corrupt)
    with pytest.raises(module.AneurysmStokesError, match="boundary facet bookkeeping"):
        _solve()


def test_input_grid_budget_is_checked_before_mask_conversion(monkeypatch):
    from planner import aneurysm_stokes as module

    monkeypatch.setattr(module, "MAX_GRID_VOXELS", 1, raising=False)
    with pytest.raises(module.AneurysmStokesError, match="grid.*budget"):
        _solve()


def test_module_exports_solve_aneurysm_stokes():
    import planner.aneurysm_stokes as mod

    assert callable(mod.solve_aneurysm_stokes)


def test_tracer_finite_diagnostics_on_real_mesh():
    out = _solve()
    scalar_keys = [
        "sac_mean_speed_baseline_mm_s",
        "sac_mean_speed_treated_mm_s",
        "sac_mean_speed_relative_change_pct",
        "inlet_flux_baseline_mm3_s",
        "outlet_flux_baseline_mm3_s",
        "flux_imbalance_baseline_pct",
        "pressure_drop_inlet_to_outlet_baseline_pa",
        "pressure_drop_inlet_to_outlet_treated_pa",
        "stokes_residual_rel_baseline",
        "divergence_residual_baseline",
        "n_fluid_voxels",
        "n_tets",
        "n_velocity_dofs",
        "n_pressure_dofs",
    ]
    for key in scalar_keys:
        assert key in out, key
        assert np.isfinite(out[key]), key
    assert out["sac_mean_speed_baseline_mm_s"] > 0.0
    assert out["sac_mean_speed_treated_mm_s"] > 0.0
    assert out["n_fluid_voxels"] == 24
    assert out["n_tets"] == 24 * 6
    # incompressibility: flux in ~= flux out on the baseline run
    assert out["flux_imbalance_baseline_pct"] < 5.0
    # algebraic and PDE residual diagnostics are small relative numbers
    assert out["stokes_residual_rel_baseline"] < 1e-8
    assert out["divergence_residual_baseline"] < 1e-6
    assert json_serializable_finite(out)


def json_serializable_finite(out):
    import json

    try:
        json.dumps(out)
    except (TypeError, ValueError):
        return False
    return True


def test_flags_state_prototype_limitations():
    out = _solve()
    flags = out["flags"]
    assert flags["prototype_discretization"] is True
    assert flags["hypothetical_boundary_conditions"] is True
    assert flags["hypothetical_resistance_model"] is True
    assert flags["not_patient_specific_validated_cfd"] is True
    assert flags["not_manufacturer_device_calibrated"] is True
    assert out["units"]["velocity"] == "mm/s"
    assert out["units"]["pressure"] == "Pa"
    assert out["units"]["viscosity"] == "Pa*s"
    assert out["units"]["length"] == "mm"


def test_zero_resistance_treated_equals_baseline():
    base = _solve(resistance_pa_s_per_mm2=0.0)
    treated = base
    assert treated["sac_mean_speed_relative_change_pct"] == 0.0
    assert treated["sac_mean_speed_treated_mm_s"] == treated["sac_mean_speed_baseline_mm_s"]


def test_inlet_velocity_linearity_known_value():
    """Stokes is linear: doubling inlet speed doubles every velocity diagnostic."""
    out1 = _solve(inlet_velocity_mm_s=1.0)
    out2 = _solve(inlet_velocity_mm_s=2.0)
    ratio = out2["sac_mean_speed_baseline_mm_s"] / out1["sac_mean_speed_baseline_mm_s"]
    assert abs(ratio - 2.0) < 1e-8
    pratio = (
        out2["pressure_drop_inlet_to_outlet_baseline_pa"]
        / out1["pressure_drop_inlet_to_outlet_baseline_pa"]
    )
    assert abs(pratio - 2.0) < 1e-8
