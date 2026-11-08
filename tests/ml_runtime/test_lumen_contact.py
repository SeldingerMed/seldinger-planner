"""Optional imaging-runtime coupling tests; no patient data."""

import importlib.util
import os

import pytest

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Requires isolated imaging runtime", allow_module_level=True)

import numpy as np

from planner.lumen_distance import build_lumen_wall_field
from planner.rod_contact import RodModel


def test_oblique_inset_uses_native_axis_rows_and_protects_real_ras_probes(monkeypatch):
    from planner import lumen_contact

    angle = np.deg2rad(87.0)
    affine = np.eye(4)
    affine[:3, :3] = np.array(
        [[np.cos(angle), -np.sin(angle), 0.0], [np.sin(angle), np.cos(angle), 0.0], [0.0, 0.0, 1.0]]
    ) @ np.diag([0.3, 20.0, 0.5])
    matrix = affine[:3, :3]
    inverse = np.linalg.inv(matrix)
    h = lumen_contact._FD_MM
    row_margin = 10 * h * np.abs(inverse).sum(axis=1) + 1e-8
    column_margin = 10 * h * np.abs(inverse).sum(axis=0) + 1e-8
    p = matrix @ np.array([4.0, 3.0, 4.0])
    observed = (((p + np.eye(3) * h) @ inverse.T - (p - np.eye(3) * h) @ inverse.T) / (2 * h)).T
    np.testing.assert_allclose(observed, inverse, atol=1e-7)
    assert not np.allclose(observed, inverse.T, atol=1e-7)
    mask = np.zeros((8, 8, 8), dtype=bool)
    mask[3:7, :, :] = True
    wall = build_lumen_wall_field(mask, affine)
    unsafe_q = np.array([column_margin[0], 3.0, 4.0])
    unsafe = matrix @ unsafe_q
    assert abs(inverse[0, 1]) * h > column_margin[0]
    with pytest.raises(ValueError, match="out of the source grid domain"):
        wall.distance(np.array([unsafe - [0.0, h, 0.0]]))
    initial_q = np.array(
        [
            [row_margin[0] * 1.1, 2.0, 3.0],
            [row_margin[0] * 1.1, 3.0, 3.0],
            [row_margin[0] * 1.1, 4.0, 3.0],
        ]
    )
    initial = initial_q @ matrix.T
    for point in initial:
        for shift in np.eye(3) * h:
            assert np.isfinite(wall.distance(np.array([point + shift, point - shift]))).all()
    actual = lumen_contact.minimize

    def inspect(*args, **kwargs):
        lower = np.asarray(kwargs["bounds"])[:, 0].reshape(-1, 3)
        np.testing.assert_allclose(lower, np.tile(row_margin, (3, 1)), atol=1e-15, rtol=0)
        return actual(*args, **kwargs)

    monkeypatch.setattr(lumen_contact, "minimize", inspect)
    rod = RodModel(initial, radius=0.1, ea=0.1, ei=0.01)
    result = lumen_contact.minimize_in_lumen_field(rod, initial, wall)
    assert result.success, result.message
    assert np.isfinite(result.energy_final) and np.isfinite(result.max_residual_normal)


def test_known_zero_energy_translation_stays_inside_finite_field():
    assert importlib.util.find_spec("planner.lumen_contact") is not None, (
        "Missing finite-grid rod solver"
    )
    from planner.lumen_contact import minimize_in_lumen_field

    mask = np.zeros((8, 8, 8), dtype=bool)
    mask[3:7, :, :] = True
    field = build_lumen_wall_field(mask, np.eye(4))
    rest = np.array([[4.0, 2.0, 3.0], [4.0, 3.0, 3.0], [4.0, 4.0, 3.0]])
    rod = RodModel(rest, radius=0.1, ea=0.1, ei=0.01)
    initial = rest - np.array([3.0, 0.0, 0.0])
    np.testing.assert_allclose(rod.contact_gaps(initial, field), -2.1)
    result = minimize_in_lumen_field(rod, initial, field)
    assert result.success, result.message
    assert result.nit <= 150
    assert result.energy_final < 1e-12
    assert result.max_residual_normal < 1e-8
    assert np.all((result.points > 0.0) & (result.points < 7.0))


def test_corner_contact_makes_real_progress_instead_of_false_convergence():
    from planner.lumen_contact import minimize_in_lumen_field

    mask = np.zeros((8, 8, 8), dtype=bool)
    mask[3:7, 3:7, 3:7] = True
    field = build_lumen_wall_field(mask, np.eye(4))
    rest = np.array([[4.0, 4.1, 4.1], [4.0, 4.3, 4.3], [4.0, 4.5, 4.5]])
    rod = RodModel(rest, radius=0.1, ea=0.1, ei=0.01)
    result = minimize_in_lumen_field(rod, rest - [0.0, 3.0, 3.0], field)
    assert result.energy_final < result.energy_initial * 0.01
    assert result.max_residual_normal < 1e-4


def test_collapsed_trial_is_rejected_without_nan_gradient(monkeypatch):
    from planner import lumen_contact

    actual = lumen_contact.minimize

    def inspect(energy, q0, **kwargs):
        # Real L-BFGS-B can clamp multiple adjacent nodes to the same box corner.
        collapsed = np.array([bound[1] for bound in kwargs["bounds"]])
        assert np.isposinf(energy(collapsed)), "Collapsed trial must be rejected, not return NaN"
        assert np.isfinite(kwargs["jac"](collapsed)).all()
        return actual(energy, q0, **kwargs)

    monkeypatch.setattr(lumen_contact, "minimize", inspect)
    mask = np.zeros((8, 8, 8), dtype=bool)
    mask[3:7, :, :] = True
    wall = build_lumen_wall_field(mask, np.eye(4))
    rest = np.array([[4.0, 2.0, 3.0], [4.0, 3.0, 3.0], [4.0, 4.0, 3.0]])
    rod = RodModel(rest, radius=0.1, ea=0.1, ei=0.01)
    assert lumen_contact.minimize_in_lumen_field(rod, rest - [3.0, 0.0, 0.0], wall).success


def test_oblique_reflected_anisotropic_chain_rule_and_solve(monkeypatch):
    from planner import lumen_contact

    angle = 0.61
    rotation = np.array(
        [[np.cos(angle), -np.sin(angle), 0.0], [np.sin(angle), np.cos(angle), 0.0], [0.0, 0.0, 1.0]]
    )
    affine = np.eye(4)
    affine[:3, :3] = rotation @ np.diag([-0.5, 1.25, 2.0])
    affine[:3, 3] = [20.0, -30.0, 10.0]
    mask = np.zeros((8, 8, 8), dtype=bool)
    mask[3:7, :, :] = True
    wall = build_lumen_wall_field(mask, affine)
    indices = np.array([[4.3, 2.2, 3.1], [4.3, 3.2, 3.3], [4.4, 4.2, 3.4]])
    world = lambda q: q @ affine[:3, :3].T + affine[:3, 3]
    rod = RodModel(world(indices), radius=0.1, ea=0.1, ei=0.01)
    actual = lumen_contact.minimize
    checked = []

    def inspect(energy, q0, **kwargs):
        h = 1e-5
        numeric = np.zeros_like(q0)
        for k in range(q0.size):
            step = np.zeros_like(q0)
            step[k] = h
            numeric[k] = (energy(q0 + step) - energy(q0 - step)) / (2 * h)
        np.testing.assert_allclose(kwargs["jac"](q0), numeric, rtol=5e-6, atol=2e-4)
        checked.append(True)
        return actual(energy, q0, **kwargs)

    monkeypatch.setattr(lumen_contact, "minimize", inspect)
    result = lumen_contact.minimize_in_lumen_field(rod, world(indices - [3.0, 0.0, 0.0]), wall)
    assert checked == [True]
    assert result.success, result.message
    assert result.max_residual_normal < 1e-6


def test_sub_fd_grid_spacing_is_ineligible_for_contact_optimization():
    from planner.lumen_contact import minimize_in_lumen_field

    # An invertible orthogonal matrix is not evidence of plausible CTA spacing.
    # The contact solver separately needs room for its RAS-mm FD probes.
    affine = np.diag([1e-12, 1.0, 1.0, 1.0])
    mask = np.zeros((8, 8, 8), dtype=bool)
    mask[3:7, :, :] = True
    wall = build_lumen_wall_field(mask, affine)
    points = np.array([[4e-12, 2.0, 3.0], [4e-12, 3.0, 3.0], [4e-12, 4.0, 3.0]])
    rod = RodModel(points, radius=0.1, ea=0.1, ei=0.01)
    with pytest.raises(ValueError, match="finite-grid optimization domain"):
        minimize_in_lumen_field(rod, points, wall)


def test_initial_outside_oblique_support_is_rejected_not_clipped():
    from planner.lumen_contact import minimize_in_lumen_field

    a = np.pi / 4
    affine = np.eye(4)
    affine[:2, :2] = [[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]]
    mask = np.zeros((8, 8, 8), dtype=bool)
    mask[3:7, :, :] = True
    wall = build_lumen_wall_field(mask, affine)
    points = np.array([[4.8, 0.1, 3.0], [4.8, 0.2, 3.0], [4.8, 0.3, 3.0]])
    corners = wall.source_grid_bounds_ras_mm()
    assert np.all(points > corners.min(axis=0)) and np.all(points < corners.max(axis=0))
    rod = RodModel(points, radius=0.1, ea=0.1, ei=0.01)
    with pytest.raises(ValueError, match="outside finite-grid"):
        minimize_in_lumen_field(rod, points, wall)
