"""Finite native-grid optimization for the uncalibrated nodal-contact rod.

The image support is an optimization-domain limit, NOT a vessel-wall force
or an end condition. Positions are optimized in voxel coordinates, energies
and forces evaluated in RAS mm. This supports reflected, anisotropic and
oblique orthogonal affines without replacing the true domain with an AABB.
"""

from __future__ import annotations

from typing import cast

import numpy as np
from scipy.optimize import minimize

from planner.lumen_distance import LumenWallField
from planner.rod_contact import MAX_MINIMIZER_ITERATIONS, RodMinimizeResult

_FD_MM = 1e-7


def minimize_in_lumen_field(rod, initial_points, wall: LumenWallField, *, stiffness=1000.0):
    """Bounded soft-contact solve; convergence does not imply hard feasibility.

    An inset of 10 forward-difference steps (plus 1e-8 voxel) ensures every
    finite-difference wall query also remains inside the sampled grid. An
    initial point outside that inset is rejected, never silently clipped.
    No external loading, anchoring, friction, torsion or self-contact.
    """
    points = np.asarray(initial_points, dtype=float)
    if points.shape != rod.rest_points.shape or not np.isfinite(points).all():
        raise ValueError("Initial points must match the finite rod rest configuration")
    if not np.isscalar(stiffness) or not np.isfinite(stiffness) or cast(float, stiffness) <= 0:
        raise ValueError("Contact stiffness must be finite and positive")
    metadata = wall.metadata
    affine = metadata["affine_voxel_to_ras_mm"]
    matrix, offset = affine[:3, :3], affine[:3, 3]
    inverse = np.linalg.inv(matrix)
    # q = (p-t) @ inverse.T means dq[k]/dp[j] = inverse[k,j].
    # Row sums bound RAS probes on each native axis; columns do not.
    margin = 10 * _FD_MM * np.abs(inverse).sum(axis=1) + 1e-8
    lower = margin
    upper = np.asarray(metadata["shape"], dtype=float) - 1.0 - margin
    index0 = (points - offset) @ inverse.T
    if np.any(lower >= upper) or np.any(index0 < lower) or np.any(index0 > upper):
        raise ValueError("Initial points outside finite-grid optimization domain")

    def world(flat):
        return flat.reshape(-1, 3) @ matrix.T + offset

    def nondegenerate(flat):
        lengths = np.linalg.norm(np.diff(world(flat), axis=0), axis=1)
        return bool(np.all(np.isfinite(lengths)) and np.all(lengths > 1e-10))

    def energy(flat):
        # A collapsed edge has no tangent or defined hinge energy. Infinite
        # objective rejects that line-search trial, rather than propagating NaN.
        if not nondegenerate(flat):
            return np.inf
        return rod.total_energy(world(flat).reshape(-1), wall, stiffness=stiffness)

    def gradient(flat):
        if not nondegenerate(flat):
            # Placeholder only for rejected infinite-objective trials. This is
            # not a claimed derivative at a degenerate configuration.
            return np.zeros_like(flat)
        physical = rod.total_energy_gradient(
            world(flat).reshape(-1), wall, stiffness=stiffness, h=_FD_MM
        )
        # Chain rule for x = M q + t: row-form grad_q = grad_x M.
        return (physical.reshape(-1, 3) @ matrix).reshape(-1)

    history = []
    q0 = index0.reshape(-1)
    initial_energy = float(energy(q0))
    result = minimize(
        energy,
        q0,
        method="SLSQP",
        jac=gradient,
        bounds=list(zip(np.tile(lower, len(points)), np.tile(upper, len(points)))),
        callback=lambda q: history.append(float(energy(q))),
        options={"maxiter": MAX_MINIMIZER_ITERATIONS, "ftol": 1e-12},
    )
    final = world(result.x)
    gaps = rod.contact_gaps(final, wall)
    return RodMinimizeResult(
        points=final,
        success=bool(result.success),
        nit=int(result.nit),
        energy_initial=initial_energy,
        energy_final=float(result.fun),
        energy_history=[initial_energy] + history,
        max_residual_normal=float(max(0.0, -gaps.min())),
        message=str(result.message),
    )
