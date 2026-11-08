"""Discrete 3D elastic centerline rod with normal-penalty wall contact.

Scope and explicit limitations
------------------------------
- Centerline-only isotropic elastic rod, unit tangents, no torsion and no shear.
  This is an uncalibrated discrete mechanical model, NOT a device model: no
  claim is made about force or deployment fidelity for any real device.
  Real coil/pushwire EA (N) and EI (N mm^2) for commercial products are
  unknown here; EA/EI are scenario inputs supplied by the caller.
- No friction, no adhesion. Contact is a one-sided normal penalty only.
- Units: geometry in mm, EA in N, EI in N mm^2. Lumped nodal contact
  stiffness k is in N/mm. Changing node count without rescaling contact
  stiffness changes this model. Contact is sampled at nodes, not along all
  segment interiors; no self-contact, catheter or release dynamics are solved.

Equations (discrete, rotation-invariant; all quantities use only
invariant pair distances and angles, never world-frame components):

Stretch (per segment j, rest length l0_j):
    e_j = |p_{j+1} - p_j| / l0_j - 1
    E_stretch = sum_j 0.5 * EA * l0_j * e_j^2            [N mm]

Bending (per interior node i, discrete angle hinge):
    dtheta_i = angle between consecutive unit segments t_{i-1}, t_i
    (computed as 2*arcsin(|t_{i-1} - t_i|/2); zero when straight)
    ds_i = 0.5 * (l_{i-1} + l_i)
    theta0_i = turning angle of the input rest centerline
    E_bend = sum_i 0.5 * EI * (dtheta_i-theta0_i)^2 / ds_i [N mm]
This hinge form depends only on the inter-node angle and lengths, so it
is invariant under rigid rotation (no world-frame curvature difference,
which would violate rotation invariance). Intrinsic angles preserve scalar
rest curvature only, not a proprietary 3D heat-set shape or material twist.

Contact (wall signed distance d(p) > 0 inside the wall, rod radius r
subtracted so the *surface* must stay inside):
    gap_i = d(p_i) - r
    E_contact = sum_{gap_i < 0} 0.5 * k * gap_i^2        [N mm]
Contact energy is strictly positive on penetration and exactly zero
when the rod surface is strictly inside.

Minimization: bounded L-BFGS-B (SciPy) on all node coordinates, finite
iteration bound (maxiter <= 150) and a loose box around the initial
configuration; analytic strain gradients and finite-difference wall gradients.
The returned success flag means optimizer convergence, not hard-contact
feasibility. Inspect the separately returned penetration depth in mm.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import cast

import numpy as np
from scipy.optimize import minimize

MAX_NODES = 96
MAX_MINIMIZER_ITERATIONS = 150


def sphere_wall_sdf(center, radius):
    """Signed distance to a sphere wall: positive inside, negative outside."""

    def sdf(points):
        d = np.asarray(points, dtype=float) - np.asarray(center, dtype=float)
        return radius - np.linalg.norm(d, axis=-1)

    return sdf


@dataclass
class RodModel:
    """Discrete centerline rod. `points` defines the rest configuration."""

    points: np.ndarray
    radius: float
    ea: float  # N
    ei: float  # N mm^2
    rest_points: np.ndarray = field(init=False)
    rest_lengths: np.ndarray = field(init=False)
    rest_angles: np.ndarray = field(init=False)

    def __post_init__(self):
        pts = np.asarray(self.points, dtype=float)
        if pts.ndim != 2 or pts.shape[1] != 3:
            raise ValueError("points must be (n, 3)")
        if pts.shape[0] < 3 or pts.shape[0] > MAX_NODES:
            raise ValueError(f"need 3..{MAX_NODES} nodes")
        for name, value, zero_allowed in (
            ("radius", self.radius, False),
            ("ea", self.ea, False),
            ("ei", self.ei, True),
        ):
            if (
                not np.isscalar(value)
                or not np.isfinite(value)
                or cast(float, value) < 0
                or (value == 0 and not zero_allowed)
            ):
                raise ValueError(f"{name} must be finite and physically admissible")
        self.rest_points = pts.copy()
        self.rest_lengths = np.linalg.norm(np.diff(pts, axis=0), axis=1)
        if np.any(self.rest_lengths <= 0.0):
            raise ValueError("rest segments must have positive length")
        rest_t = np.diff(pts, axis=0) / self.rest_lengths[:, None]
        self.rest_angles = 2.0 * np.arcsin(
            np.clip(0.5 * np.linalg.norm(rest_t[:-1] - rest_t[1:], axis=1), 0.0, 1.0)
        )

    # -- strain energy ------------------------------------------------

    def stretch_energy(self, pts):
        seg = np.diff(pts, axis=0)
        lengths = np.linalg.norm(seg, axis=1)
        strain = lengths / self.rest_lengths - 1.0
        return float(0.5 * self.ea * np.sum(self.rest_lengths * strain**2))

    def bending_energy(self, pts):
        seg = np.diff(pts, axis=0)
        lengths = np.linalg.norm(seg, axis=1)
        t = seg / lengths[:, None]
        # Angle between consecutive unit tangents, in a form that stays
        # well-conditioned for near-straight joints (arccos(1) is not):
        # dtheta_i = angle(t_{i-1}, t_i) = 2*arcsin(|t_{i-1} - t_i| / 2).
        dtheta = 2.0 * np.arcsin(np.clip(0.5 * np.linalg.norm(t[:-1] - t[1:], axis=1), 0.0, 1.0))
        ds = 0.5 * (lengths[:-1] + lengths[1:])
        return float(0.5 * self.ei * np.sum((dtheta - self.rest_angles) ** 2 / ds))

    def strain_energy(self, pts):
        pts = np.asarray(pts, dtype=float)
        return self.stretch_energy(pts) + self.bending_energy(pts)

    # -- contact ------------------------------------------------------

    def contact_gaps(self, pts, wall_sdf, rod_radius=None):
        r = self.radius if rod_radius is None else rod_radius
        return wall_sdf(np.asarray(pts, dtype=float)) - r

    def contact_energy(self, pts, wall_sdf, rod_radius=None, stiffness=1.0e3):
        gaps = self.contact_gaps(pts, wall_sdf, rod_radius)
        pen = np.minimum(gaps, 0.0)
        return float(0.5 * stiffness * np.sum(pen**2))

    def total_energy(self, x, wall_sdf, rod_radius=None, stiffness=1.0e3):
        pts = x.reshape(-1, 3)
        return self.strain_energy(pts) + self.contact_energy(pts, wall_sdf, rod_radius, stiffness)

    def total_energy_gradient(self, x, wall_sdf, rod_radius=None, stiffness=1.0e3, h=1e-7):
        """Analytic gradient of strain + penalty contact energy.

        Stretch and bending gradients are closed-form; the contact
        gradient uses finite differences of the (opaque) wall callable
        at penetrating nodes only: grad E_i = k * gap_i * grad sdf(p_i).
        """
        pts = np.asarray(x, dtype=float).reshape(-1, 3)
        n = pts.shape[0]
        grad = np.zeros_like(pts)

        # -- stretch: E_j = 0.5*EA*l0_j*e_j^2, e_j = l_j/l0_j - 1
        # dE/dp_end = EA*(l-l0)/(l0*l) * segment, in N.
        seg = np.diff(pts, axis=0)
        lengths = np.linalg.norm(seg, axis=1)
        coef = (self.ea * (lengths - self.rest_lengths) / (self.rest_lengths * lengths))[:, None]
        contrib = coef * seg
        grad[:-1] -= contrib
        grad[1:] += contrib

        # -- bending: E_i = 0.5*EI*(theta_i-theta0_i)^2/ds_i with
        # dtheta_i = 2*asin(d_i), d_i = 0.5*|t_- - t_+|.
        # dE/dd = 2*EI*(theta-theta0)/(ds*sqrt(1-d^2)) =: w
        # dd/da = +0.5*u, dd/db = -0.5*u with u = (a-b)/|a-b|;
        # dt/dp_endpoints = +-(I - t t^T)/l.
        if n >= 3:
            t = seg / lengths[:, None]
            for j in range(1, n - 1):
                a, b = t[j - 1], t[j]
                diff_ab = a - b
                norm_ab = np.linalg.norm(diff_ab)
                if norm_ab == 0.0:
                    continue
                d = 0.5 * norm_ab
                if d >= 1.0:
                    continue
                dtheta = 2.0 * np.arcsin(d)
                if dtheta == 0.0:
                    continue
                ds = 0.5 * (lengths[j - 1] + lengths[j])
                angle_strain = dtheta - self.rest_angles[j - 1]
                w = 2.0 * self.ei * angle_strain / (ds * np.sqrt(1.0 - d * d))
                u = diff_ab / norm_ab
                # endpoint derivative operators
                pa = (np.eye(3) - np.outer(a, a)) / lengths[j - 1]
                pb = (np.eye(3) - np.outer(b, b)) / lengths[j]
                gu = w * 0.5 * u
                # Differentiate both the angle and the deformed dual length.
                length_coefficient = -0.25 * self.ei * angle_strain**2 / ds**2
                left = gu @ pa + length_coefficient * a
                right = -gu @ pb + length_coefficient * b
                grad[j - 1] -= left
                grad[j] += left - right
                grad[j + 1] += right

        # -- contact: FD of the wall sdf at penetrating nodes only
        r = self.radius if rod_radius is None else rod_radius
        gaps = self.contact_gaps(pts, wall_sdf, rod_radius)
        for i in np.nonzero(gaps < 0.0)[0]:
            p = pts[i]
            gsdf = np.zeros(3)
            for k in range(3):
                pp = p.copy()
                pp[k] += h
                gsdf[k] = (wall_sdf(pp[None, :])[0] - (gaps[i] + r)) / h
            # rod_radius shifts the gap constantly, so grad gap = grad sdf
            grad[i] += stiffness * gaps[i] * gsdf

        return grad.reshape(-1)

    # -- minimization ---------------------------------------------------

    def minimize(self, x0, wall_sdf, rod_radius=None, stiffness=1.0e3):
        """Bounded L-BFGS-B minimization of strain + penalty contact energy.

        Returns diagnostics: success, nit (<= MAX_MINIMIZER_ITERATIONS),
        energy_initial/final, energy_history, max_residual_normal (largest
        surface penetration depth, mm; > 0 means contact engaged), points.
        """
        pts0 = np.asarray(x0, dtype=float)
        flat0 = pts0.reshape(-1)
        history = []

        def fun(flat):
            return self.total_energy(flat, wall_sdf, rod_radius, stiffness)

        def callback(flat):
            history.append(fun(flat))

        span = 200.0  # loose box: allows full reconfiguration, bounds blowup
        bounds = [(v - span, v + span) for v in flat0]
        res = minimize(
            fun,
            flat0,
            method="L-BFGS-B",
            jac=lambda f: self.total_energy_gradient(
                f.reshape(-1, 3), wall_sdf, rod_radius, stiffness
            ),
            bounds=bounds,
            callback=callback,
            options={
                "maxiter": MAX_MINIMIZER_ITERATIONS,
                "maxfun": 50 * MAX_MINIMIZER_ITERATIONS,
                "maxcor": min(30, flat0.size),
                "ftol": 1e-14,
                "gtol": 1e-10,
            },
        )
        final = res.x.reshape(-1, 3)
        gaps = self.contact_gaps(final, wall_sdf, rod_radius)
        max_residual_normal = float(max(0.0, -gaps.min()))
        energy_initial = float(fun(flat0))
        energy_final = float(res.fun)
        return RodMinimizeResult(
            points=final,
            success=bool(res.success),
            nit=int(res.nit),
            energy_initial=energy_initial,
            energy_final=energy_final,
            energy_history=[energy_initial] + [float(h) for h in history],
            max_residual_normal=max_residual_normal,
            message=str(res.message),
        )


@dataclass
class RodMinimizeResult:
    points: np.ndarray
    success: bool
    nit: int
    energy_initial: float
    energy_final: float
    energy_history: list
    max_residual_normal: float
    message: str
