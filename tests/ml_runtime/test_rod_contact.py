"""Synthetic discrete 3D elastic rod/contact kernel checks.

No patient data, no pixels, no device calibration: every fixture is an
analytic polyline against an analytic sphere wall. Units are mm and N.

Gate before heavy imports so the base suite never pays for SciPy.
"""

import os

import pytest

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Requires isolated ML runtime", allow_module_level=True)

import numpy as np

from planner.rod_contact import RodModel, sphere_wall_sdf


def straight_rod(n=6, length=50.0, radius=1.0, ea=1000.0, ei=5.0e5):
    """A straight rod along +x from the origin, centered at the origin."""
    x = np.linspace(-length / 2.0, length / 2.0, n)
    pts = np.stack([x, np.zeros(n), np.zeros(n)], axis=1)
    return RodModel(points=pts, radius=radius, ea=ea, ei=ei)


def test_tracer_compressed_rod_pushed_out_of_sphere_wall_converges():
    """Tracer: sphere wall (positive inside) pushes a compressed rod straight.

    The rod is bent by construction and penetrating the wall; a bounded
    minimization must lower the total energy and report solver diagnostics.
    """
    model = straight_rod(ea=1.0e6)  # stiff axially: cannot crumple into the wall
    wall = sphere_wall_sdf(center=np.zeros(3), radius=20.0)

    # Pre-bent middle node so the initial state is not the minimizer and
    # the ends penetrate the wall.
    x0 = model.rest_points.copy()
    x0[2, 1] = -4.0
    x0[3, 1] = -6.0

    result = model.minimize(x0, wall, rod_radius=model.radius)

    assert result.success
    assert result.nit <= 150
    assert result.energy_final < result.energy_initial
    assert result.max_residual_normal > 0.0  # contact actually engaged


def test_contact_energy_penetration_positive_and_free_negative():
    """Contact energy is strictly positive on penetration and exactly zero
    when the rod surface is strictly inside the wall."""
    model = straight_rod(n=5)
    # Radius 30 > rod half-length 25, so the rod fits fully inside.
    wall = sphere_wall_sdf(center=np.zeros(3), radius=30.0)

    # Shift along +x so the tip (x=35) lies outside the wall: penetrating.
    x = model.rest_points.copy()
    x[:, 0] += 10.0

    e_contact = model.contact_energy(x, wall, model.radius)
    assert e_contact > 0.0

    # Same rod unchanged: fully inside with margin, zero contact energy.
    y = model.rest_points.copy()
    assert model.contact_energy(y, wall, model.radius) == 0.0


def test_strain_energy_rigid_rotation_invariance():
    """Stretch + bending energy is unchanged by any rigid rotation
    (about any point); no world-frame curvature terms are used."""
    model = straight_rod(n=8)
    x = model.rest_points.copy()
    x[3, 1] = -3.0  # bend it

    rng = np.random.default_rng(7)
    q, _ = np.linalg.qr(rng.standard_normal((3, 3)))
    if np.linalg.det(q) < 0:
        q[:, 0] *= -1.0
    t = rng.standard_normal(3) * 10.0

    e0 = model.strain_energy(x)
    e1 = model.strain_energy(x @ q.T + t)
    assert np.isclose(e0, e1, rtol=1e-10, atol=1e-9)


def test_contact_energy_sphere_wall_rigid_rotation_invariance():
    """With a sphere wall, rotated configurations against the same wall
    cost the same contact energy (isotropic wall + invariant strain)."""
    model = straight_rod(n=8)
    wall = sphere_wall_sdf(center=np.zeros(3), radius=20.0)
    x = model.rest_points.copy()
    x[:, 0] += 10.0  # penetrating at the tip

    rng = np.random.default_rng(11)
    q, _ = np.linalg.qr(rng.standard_normal((3, 3)))
    if np.linalg.det(q) < 0:
        q[:, 0] *= -1.0

    e0 = model.contact_energy(x, wall, model.radius)
    e1 = model.contact_energy(x @ q.T, wall, model.radius)
    assert e0 > 0.0
    assert np.isclose(e0, e1, rtol=1e-10, atol=1e-9)


def test_unconstrained_rest_state_is_equilibrium():
    """A straight rod far from the wall is already at its minimizer:
    minimizing from rest changes the energy negligibly and leaves the
    nodes in place."""
    model = straight_rod(n=6)
    # Positive-inside wall: a large sphere surrounds the entire rest rod.
    wall = sphere_wall_sdf(center=np.zeros(3), radius=500.0)

    result = model.minimize(model.rest_points, wall, model.radius)

    assert result.success
    assert result.energy_final <= 1e-9
    assert np.max(np.abs(result.points - model.rest_points)) < 1e-3


def test_energy_gradient_matches_finite_differences():
    """Analytic total-energy gradient agrees with central differences on a
    bent, partially penetrating configuration."""
    model = straight_rod(n=7, ea=1.0e6)
    wall = sphere_wall_sdf(center=np.zeros(3), radius=20.0)
    x = model.rest_points.copy()
    x[3, 1] = -5.0

    g = model.total_energy_gradient(x, wall, model.radius)
    h = 1e-4  # avoids subtractive cancellation in this high-energy fixture
    flat = x.reshape(-1)
    finite_difference = np.zeros_like(flat)
    for k in range(flat.size):
        xp = flat.copy()
        xp[k] += h
        xm = flat.copy()
        xm[k] -= h
        finite_difference[k] = (
            model.total_energy(xp.reshape(-1, 3), wall, model.radius)
            - model.total_energy(xm.reshape(-1, 3), wall, model.radius)
        ) / (2 * h)
    np.testing.assert_allclose(g, finite_difference, rtol=1e-6, atol=1e-5)


def test_total_energy_decreases_and_stays_bounded():
    """Full energy (strain + contact) decreases monotonically in the
    tracer history and the solver stays inside its iteration bound."""
    model = straight_rod(n=6)
    wall = sphere_wall_sdf(center=np.zeros(3), radius=20.0)
    x0 = model.rest_points.copy()
    x0[2, 1] = -5.0

    result = model.minimize(x0, wall, model.radius)
    assert result.energy_history[0] == pytest.approx(result.energy_initial)
    assert result.energy_history[-1] == pytest.approx(result.energy_final)
    assert np.all(np.diff(result.energy_history) <= 1e-9)
    assert result.nit <= 150


def test_axial_gradient_uses_rest_segment_length_in_physical_units():
    model = RodModel(
        np.array([[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [4.0, 0.0, 0.0]]), radius=0.1, ea=12.0, ei=0.0
    )
    x = model.rest_points.copy()
    x[:, 0] *= 1.25
    wall = sphere_wall_sdf(np.zeros(3), 100.0)
    force = model.ea * (np.linalg.norm(x[1] - x[0]) - model.rest_lengths[0]) / model.rest_lengths[0]
    expected = np.zeros_like(x)
    expected[0, 0] = -force
    expected[-1, 0] = force
    assert model.total_energy_gradient(x, wall).reshape(x.shape) == pytest.approx(
        expected, abs=1e-12
    )


def test_curved_rest_shape_has_zero_strain_after_rigid_rotation():
    points = np.array([[-1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0], [2.0, -0.5, 0.25]])
    model = RodModel(points, radius=0.05, ea=17.0, ei=3.5)
    rotation = np.array([[0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]])
    x = points @ rotation.T + np.array([3.0, 2.0, 1.0])
    wall = sphere_wall_sdf(np.zeros(3), 100.0)
    assert model.strain_energy(x) == pytest.approx(0.0, abs=1e-12)
    assert np.linalg.norm(model.total_energy_gradient(x, wall)) < 1e-10


@pytest.mark.parametrize(
    "field,value",
    [
        ("radius", 0.0),
        ("radius", float("nan")),
        ("ea", 0.0),
        ("ea", -1.0),
        ("ei", -1.0),
        ("ei", float("inf")),
    ],
)
def test_model_rejects_nonphysical_or_nonfinite_material_inputs(field, value):
    points = np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [2.0, 0.0, 0.0]])
    options: dict[str, float] = {"radius": 0.1, "ea": 17.0, "ei": 3.5}
    options[field] = value
    with pytest.raises(ValueError):
        RodModel(points=points, **options)
