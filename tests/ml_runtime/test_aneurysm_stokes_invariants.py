"""Bounded verification of the accepted-mask Stokes solver (independent addendum).

Covers affine uniform scaling invariance with inversely-scaled resistance,
input rejections, and resource caps firing before skfem Basis allocation.
Run with:
  env -u PYTHONPATH SELDINGER_RUN_MODEL_TESTS=1 \
      .runtime/physics-runtime/bin/python -m pytest tests/ml_runtime/test_aneurysm_stokes_invariants.py -q
"""

import os

import pytest

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Requires isolated imaging runtime", allow_module_level=True)

import numpy as np

from planner.aneurysm_stokes import AneurysmStokesError, solve_aneurysm_stokes


def test_reordered_real_mesh_elements_are_rejected_before_sac_averaging(monkeypatch):
    import skfem

    actual = skfem.MeshTet

    def reordered(*args, **kwargs):
        mesh = actual(*args, **kwargs)
        # Preserve the physical mesh, but swap columns across voxel groups.
        mesh.t[:, [0, 6]] = mesh.t[:, [6, 0]]
        return mesh

    monkeypatch.setattr(skfem, "MeshTet", reordered)
    with pytest.raises(AneurysmStokesError, match="element-to-voxel"):
        _solve()


def _tube_masks(nx=6, ny=4, nz=4):
    lumen = np.zeros((nx, ny, nz), dtype=np.uint8)
    lumen[:, 1:3, 1:3] = 1
    sac = np.zeros_like(lumen)
    sac[2:4, 1:3, 1:3] = 1
    return lumen, sac


def _solve(**overrides):
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


def test_uniform_scaling_resistance_over_L2_preserves_speed_scales_flux_and_pressure():
    """x -> L x with alpha -> alpha / L^2: u invariant, flux ~ L^2, p ~ 1/L."""
    L = 2.0
    base = _solve()
    scaled = _solve(
        affine_ras=np.diag([L, L, L, 1.0]),
        neck_origin=tuple(L * np.array([2.5, 1.5, 1.5])),
        neck_thickness_mm=L * 1.0,
        resistance_pa_s_per_mm2=0.05 / L**2,
    )
    for key in ("sac_mean_speed_baseline_mm_s", "sac_mean_speed_treated_mm_s"):
        assert scaled[key] == pytest.approx(base[key], rel=1e-7, abs=1e-12)
    assert scaled["inlet_flux_baseline_mm3_s"] == pytest.approx(
        base["inlet_flux_baseline_mm3_s"] * L**2, rel=1e-7
    )
    assert scaled["outlet_flux_treated_mm3_s"] == pytest.approx(
        base["outlet_flux_treated_mm3_s"] * L**2, rel=1e-7
    )
    dp_base = base["pressure_drop_inlet_to_outlet_treated_pa"]
    dp_scaled = scaled["pressure_drop_inlet_to_outlet_treated_pa"]
    assert dp_base > 0
    assert dp_scaled == pytest.approx(dp_base / L, rel=2e-3)


def test_nonbinary_mask_rejected():
    lumen = _tube_masks()[0].astype(np.float64)
    lumen[0, 1, 1] = 0.5
    sac = _tube_masks()[1]
    with pytest.raises(AneurysmStokesError, match="binary"):
        _solve(lumen_mask=lumen, sac_mask=sac)


def test_disconnected_lumen_rejected():
    lumen, _sac = _tube_masks()
    gap = np.zeros_like(lumen)
    gap[0:2, 1:3, 1:3] = 1
    gap[4:6, 1:3, 1:3] = 1
    empty_sac = np.zeros_like(gap)
    empty_sac[0:2, 1:3, 1:3] = 1
    with pytest.raises(AneurysmStokesError, match="connected"):
        _solve(lumen_mask=gap, sac_mask=empty_sac)


def test_sac_not_subset_of_lumen_rejected():
    _lumen, sac = _tube_masks()
    sac = sac.copy()
    sac[0, 0, 0] = 1
    with pytest.raises(AneurysmStokesError, match="subset"):
        _solve(sac_mask=sac)


def test_unsupported_spatial_units_rejected():
    with pytest.raises(AneurysmStokesError, match="spatial_units"):
        _solve(spatial_units="cm")


def test_shear_affine_rejected():
    shear = np.eye(4)
    shear[0, 1] = 0.01
    with pytest.raises(AneurysmStokesError, match="shear"):
        _solve(affine_ras=shear)


def test_resource_cap_fires_before_skfem_basis_allocation(monkeypatch):
    """Exceeding MAX_FLUID_VOXELS must reject before any skfem Basis exists."""
    import skfem

    calls = []
    real_basis = skfem.Basis

    def spy(*args, **kwargs):
        calls.append(1)
        return real_basis(*args, **kwargs)

    monkeypatch.setattr(skfem, "Basis", spy)

    lumen = np.zeros((600, 2, 2), dtype=np.uint8)
    lumen[:, :, :] = 1  # 2400 fluid voxels > MAX_FLUID_VOXELS=1000, connected
    sac = np.zeros_like(lumen)
    sac[300:302] = 1
    with pytest.raises(AneurysmStokesError, match="budget"):
        solve_aneurysm_stokes(
            lumen_mask=lumen,
            sac_mask=sac,
            affine_ras=np.eye(4),
            flow_axis=0,
            inlet_velocity_mm_s=1.0,
            viscosity_pa_s=0.0035,
            neck_origin=(300.0, 0.5, 0.5),
            neck_normal=(1.0, 0.0, 0.0),
            neck_thickness_mm=1.0,
            resistance_pa_s_per_mm2=0.05,
        )
    assert not calls, "skfem.Basis was allocated despite a budget rejection"
