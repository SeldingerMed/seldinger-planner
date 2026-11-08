"""Accepted-mask aneurysm Stokes/Brinkman prototype solver (scikit-fem).

PROTOTYPE DISCRETIZATION ONLY. This module solves steady incompressible
Stokes with an optional scalar Brinkman drag slab on a conforming
tetrahedral mesh built from a synthetic accepted binary lumen mask, under
HYPOTHETICAL boundary conditions (fixed inlet speed on one native
grid-axis min face, no-slip walls, natural traction outlet on the axis
max face) and a HYPOTHETICAL scalar resistance parameter. The outputs are
numerical diagnostics of this discretization only: they are NOT
patient-specific validated CFD and NOT a manufacturer-device-calibrated
flow model, and carry no clinical claims.

Method
------
- A bounded voxel-bbox tetrahedral mesh (six Kuhn tets per fluid voxel)
  is built in index space and mapped to world coordinates through the
  supplied rigid-affine RAS matrix (rotation + axis-aligned positive
  scaling + translation; shear and mirroring are rejected).
- Taylor-Hood P2(vector)/P1 elements: momentum block A (vector Laplacian
  scaled by the explicit viscosity), divergence block B, natural (zero
  traction) outlet, Dirichlet velocity elsewhere, inlet plane set to
  ``inlet_velocity_mm_s`` along the flow axis.
- Treated runs add ``alpha * <u, v>`` integrated only over fluid inside
  the neck-plane slab defined by ``neck_origin``/``neck_normal``/
  ``neck_thickness_mm`` (alpha in Pa*s/mm^2).
- No pressure gauge is added or subtracted: the open natural outlet
  fixes the pressure constant for this mixed boundary-value problem.
- Diagnostics separate the free algebraic and momentum residuals, weak
  continuity residual, unprojected gradient-trace divergence L2 norm,
  full-vector boundary fluxes and quadrature-volume-weighted sac speed.

Rejected with explicit grid, mesh and finite-element allocation caps: nonbinary/nonfinite masks, shape
mismatches, non-finite or unit-inconsistent inputs, shearing or
mirroring affines, degenerate scalars, disconnected lumen, empty/non
subset sac, missing inlet or outlet face, slab with no fluid overlap,
voxel/element/DOF budget violations, and inadequate (too small) domains.
"""

from __future__ import annotations

from typing import Any, cast

import numpy as np

__all__ = ["AneurysmStokesError", "solve_aneurysm_stokes"]

MAX_GRID_VOXELS = 8_000_000
MAX_BBOX_VOXELS = 32768
MAX_FLUID_VOXELS = 1000
MAX_TOTAL_DOF = 120000
MIN_FLUID_VOXELS = 4
MIN_SIDE_VOXELS = 2
SHEAR_TOLERANCE = 1e-6

_FLAGS = {
    "prototype_discretization": True,
    "hypothetical_boundary_conditions": True,
    "hypothetical_resistance_model": True,
    "not_patient_specific_validated_cfd": True,
    "not_manufacturer_device_calibrated": True,
}

_UNITS = {
    "velocity": "mm/s",
    "pressure": "Pa",
    "viscosity": "Pa*s",
    "length": "mm",
    "resistance": "Pa*s/mm^2",
}


class AneurysmStokesError(ValueError):
    """Raised for any rejected input, domain, or budget condition."""


def _require(condition, message):
    if not condition:
        raise AneurysmStokesError(message)


def _as_float_scalar(value, name, *, positive=False, nonnegative=False):
    arr = np.asarray(value)
    _require(arr.ndim == 0 and arr.dtype.kind in "iuf", f"{name} must be a numeric scalar")
    try:
        val = float(arr)
    except (TypeError, ValueError):
        raise AneurysmStokesError(f"{name} must be a finite number") from None
    _require(np.isfinite(val), f"{name} must be finite")
    if positive:
        _require(val > 0.0, f"{name} must be > 0")
    if nonnegative:
        _require(val >= 0.0, f"{name} must be >= 0")
    return val


def _validate_mask(mask, name):
    arr = np.asarray(mask)
    _require(arr.ndim == 3, f"{name} must be a 3-D array")
    _require(arr.size <= MAX_GRID_VOXELS, f"{name} grid exceeds its voxel budget")
    _require(
        arr.shape[0] >= MIN_SIDE_VOXELS
        and arr.shape[1] >= MIN_SIDE_VOXELS
        and arr.shape[2] >= MIN_SIDE_VOXELS,
        f"{name} must have at least {MIN_SIDE_VOXELS} voxels per side",
    )
    if arr.dtype == bool:
        return arr.astype(np.uint8)
    try:
        vals = np.asarray(arr, dtype=np.float64)
    except (TypeError, ValueError):
        raise AneurysmStokesError(f"{name} must be numeric") from None
    _require(bool(np.all(np.isfinite(vals))), f"{name} must contain only finite values")
    _require(bool(np.all((vals == 0.0) | (vals == 1.0))), f"{name} must be binary (exactly 0/1)")
    return (vals == 1.0).astype(np.uint8)


def _validate_affine(affine_ras):
    arr = np.asarray(affine_ras, dtype=np.float64)
    _require(arr.shape == (4, 4), "affine_ras must be a 4x4 matrix")
    _require(bool(np.all(np.isfinite(arr))), "affine_ras must be finite")
    _require(
        bool(np.allclose(arr[3], np.array([0.0, 0.0, 0.0, 1.0]))),
        "affine_ras last row must be [0, 0, 0, 1]",
    )
    linear = arr[:3, :3]
    det = float(np.linalg.det(linear))
    _require(det > 0.0, "affine_ras must have positive determinant (mirroring is not supported)")
    gram = linear.T @ linear
    diag = np.sqrt(np.diag(gram))
    _require(bool(np.all(diag > 0.0)), "affine_ras has a degenerate voxel axis")
    off = np.abs(gram - np.diag(np.diag(gram)))
    worst = float((off / np.outer(diag, diag)).max())
    _require(
        worst <= SHEAR_TOLERANCE,
        "affine_ras shear is not supported; only rigid rotations with "
        "axis-aligned scaling are accepted",
    )
    return arr, linear


def _normalize_normal(neck_normal):
    arr = np.asarray(neck_normal, dtype=np.float64).reshape(-1)
    _require(arr.size == 3, "neck_normal must have 3 components")
    _require(bool(np.all(np.isfinite(arr))), "neck_normal must be finite")
    norm = float(np.linalg.norm(arr))
    _require(norm > 0.0, "neck_normal must be nonzero")
    return arr / norm


def _validate_origin(neck_origin):
    arr = np.asarray(neck_origin, dtype=np.float64).reshape(-1)
    _require(arr.size == 3, "neck_origin must have 3 components")
    _require(bool(np.all(np.isfinite(arr))), "neck_origin must be finite")
    return arr


def _connected_voxels(fluid):
    """Return True if the fluid voxel set is a single 6-connected component."""
    idx = np.argwhere(fluid > 0)
    seen = set()
    start = tuple(idx[0])
    stack = [start]
    seen.add(start)
    offsets = ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))
    while stack:
        i, j, k = stack.pop()
        for di, dj, dk in offsets:
            nxt = (i + di, j + dj, k + dk)
            if nxt in seen:
                continue
            if (
                0 <= nxt[0] < fluid.shape[0]
                and 0 <= nxt[1] < fluid.shape[1]
                and 0 <= nxt[2] < fluid.shape[2]
                and fluid[nxt] > 0
            ):
                seen.add(nxt)
                stack.append(nxt)
    return len(seen) == idx.shape[0]


def _validate_topology(lumen, sac, flow_axis):
    fluid_idx = np.argwhere(lumen > 0)
    _require(
        fluid_idx.shape[0] >= MIN_FLUID_VOXELS,
        f"lumen domain is inadequate: fewer than {MIN_FLUID_VOXELS} fluid voxels",
    )
    sac_idx = np.argwhere(sac > 0)
    _require(sac_idx.shape[0] > 0, "sac_mask is empty")
    _require(bool(np.all(sac[lumen == 0] == 0)), "sac_mask must be a subset of lumen_mask")
    _require(_connected_voxels(lumen), "lumen_mask must be a single 6-connected component")
    amin = int(fluid_idx[:, flow_axis].min())
    amax = int(fluid_idx[:, flow_axis].max())
    _require(amin < amax, "lumen has zero extent along the flow axis")
    # Nonempty extrema follow from argwhere. _facet_sets validates the
    # actual inlet/outlet boundary facets after tetrahedralization; the fluid
    # is intentionally allowed to occupy only an interior portion of the grid.
    return fluid_idx, sac_idx, amin, amax


# Six-tet Kuhn decomposition of the unit cube (conforming across voxels;
# every tet shares the space diagonal 0-7).
_CUBE_VERTS = np.array(
    [[di, dj, dk] for dk in (0, 1) for dj in (0, 1) for di in (0, 1)], dtype=np.int64
)
_CUBE_TETS = np.array(
    [
        [0, 1, 3, 7],
        [0, 3, 2, 7],
        [0, 2, 6, 7],
        [0, 6, 4, 7],
        [0, 4, 5, 7],
        [0, 5, 1, 7],
    ],
    dtype=np.int64,
)


def _build_tets(fluid_idx, linear, affine):
    """Build the conforming Kuhn tet mesh of the fluid voxel set.

    Returns (p_world, tets, local_vertex_indices, edge_count, lower_native_voxel_index).
    DOF budget is checked before any skfem allocation.
    """
    lo = fluid_idx.min(axis=0)
    hi = fluid_idx.max(axis=0) + 1  # upper node grid bound
    bbox_voxels = int(np.prod(hi - lo))
    _require(
        bbox_voxels <= MAX_BBOX_VOXELS,
        f"voxel bounding box {bbox_voxels} exceeds {MAX_BBOX_VOXELS} budget",
    )
    _require(
        fluid_idx.shape[0] <= MAX_FLUID_VOXELS,
        f"fluid voxel count {fluid_idx.shape[0]} exceeds {MAX_FLUID_VOXELS} budget",
    )

    grid_shape = tuple(int(hi[ax] - lo[ax]) + 1 for ax in range(3))
    vert_ids = -np.ones(grid_shape, dtype=np.int64)
    verts = []
    for i in range(grid_shape[0]):
        for j in range(grid_shape[1]):
            for k in range(grid_shape[2]):
                vert_ids[i, j, k] = len(verts)
                verts.append((i, j, k))
    verts = np.array(verts, dtype=np.int64)

    tet_list = []
    for i, j, k in fluid_idx:
        base = np.array([i, j, k], dtype=np.int64) - lo
        for tet in _CUBE_TETS:
            corners = base + _CUBE_VERTS[tet]  # (4, 3)
            tet_list.append(vert_ids[corners[:, 0], corners[:, 1], corners[:, 2]])
    tets = np.array(tet_list, dtype=np.int64).T  # (4, nt)
    # Bounding-box nodes outside a nonrectangular fluid domain have no
    # elements and would create unconstrained pressure/velocity unknowns.
    used, inverse = np.unique(tets, return_inverse=True)
    verts = verts[used]
    tets = inverse.reshape(tets.shape)

    # Positive orientation in index space (positive world determinant is
    # guaranteed by det(linear) > 0).
    p_idx_t = verts.astype(np.float64)
    v0 = p_idx_t[tets[0]]
    v1 = p_idx_t[tets[1]] - v0
    v2 = p_idx_t[tets[2]] - v0
    v3 = p_idx_t[tets[3]] - v0
    signed6 = np.einsum("ij,ij->i", np.cross(v1, v2), v3)
    flip = signed6 < 0
    if np.any(flip):
        tets[2, flip], tets[3, flip] = tets[3, flip], tets[2, flip].copy()

    p_world = linear @ (verts.T + lo[:, None] - 0.5) + affine[:3, 3:4]

    # DOF budget before allocation: P2 tet velocity = 3*(nv + ne), P1 pressure = nv.
    edges = np.sort(
        np.concatenate(
            [tets[[0, 1]], tets[[0, 2]], tets[[0, 3]], tets[[1, 2]], tets[[1, 3]], tets[[2, 3]]],
            axis=1,
        ),
        axis=0,
    )
    unique_edges = np.unique(edges, axis=1)
    total_dof = 3 * (verts.shape[0] + unique_edges.shape[1]) + verts.shape[0]
    _require(total_dof <= MAX_TOTAL_DOF, f"DOF budget exceeded: {total_dof} > {MAX_TOTAL_DOF}")
    return p_world, tets, verts, unique_edges.shape[1], lo


def _facet_sets(tets, verts, lo, flow_axis):
    """Return boundary facet array and inlet/outlet facet masks (index space)."""
    faces = np.concatenate(
        [tets[[1, 2, 3]], tets[[0, 2, 3]], tets[[0, 1, 3]], tets[[0, 1, 2]]], axis=1
    )  # (3, 4*nf)
    order = np.sort(faces, axis=0)
    # Lexicographic dedup: facets appearing once are boundary facets.
    view = np.ascontiguousarray(order.T)
    _, first_idx, counts = np.unique(view, axis=0, return_index=True, return_counts=True)
    boundary_cols = first_idx[counts == 1]  # column ids into `faces`

    node_ax = verts[:, flow_axis] + lo[flow_axis]
    amin = float(node_ax.min())
    amax = float(node_ax.max())
    fv = verts[faces[:, boundary_cols].T]  # (nbf, 3, 3) verts per facet
    facet_min_ax = fv[:, :, flow_axis].min(axis=1) + lo[flow_axis]
    facet_max_ax = fv[:, :, flow_axis].max(axis=1) + lo[flow_axis]
    inlet_mask = (facet_min_ax == amin) & (facet_max_ax == amin)
    outlet_mask = (facet_min_ax == amax) & (facet_max_ax == amax)
    _require(bool(np.any(inlet_mask)), "no inlet boundary facets found")
    _require(bool(np.any(outlet_mask)), "no outlet boundary facets found")
    return (faces[:, boundary_cols], inlet_mask, outlet_mask)


def _solve_case(basis_u, A, B, C, alpha, inlet_dofs, inlet_value, wall_dofs, direction, nu):
    """Solve one (alpha) case; returns (u, p, res_rel, momentum_rel)."""
    import scipy.sparse as sp
    import scipy.sparse.linalg as spla

    K = cast(
        sp.csc_matrix,
        sp.bmat(
            [
                [A + alpha * C, B.T],
                [B, None],
            ],
            format="csc",
        ),
    )
    matrix_shape = cast("tuple[int, int]", K.shape)
    b = np.zeros(matrix_shape[0])
    x = np.zeros(matrix_shape[0])
    # Zero on every wall, including shared inlet/wall edges.  The hypothetical
    # inlet nodal speed applies only to the open interior of the inlet patch.
    active_inlet = np.setdiff1d(inlet_dofs, wall_dofs)
    _require(active_inlet.size > 0, "inlet has no unconstrained interior velocity nodes")
    for component, indices in enumerate(basis_u.split_indices()):
        x[np.intersect1d(indices, active_inlet)] = inlet_value * direction[component]
    fixed = np.union1d(inlet_dofs, wall_dofs)
    free = np.setdiff1d(np.arange(matrix_shape[0]), fixed)
    rhs = b - K[:, fixed] @ x[fixed]
    sol = cast("np.ndarray", spla.spsolve(K[free][:, free], rhs[free]))
    _require(bool(np.all(np.isfinite(sol))), "linear solve produced non-finite values")
    x[free] = sol
    u = x[:nu]
    p = x[nu:]
    # Residual on free rows (constrained rows are satisfied by construction):
    res_rel = float(np.linalg.norm((K @ x - b)[free]) / max(np.linalg.norm(rhs[free]), 1e-300))
    momentum_rows = free[free < nu]
    momentum_rel = float(
        np.linalg.norm((K @ x - b)[momentum_rows]) / max(np.linalg.norm(rhs[momentum_rows]), 1e-300)
    )
    return u, p, res_rel, momentum_rel


def _divergence_l2(basis, dofs):
    gradient = basis.interpolate(dofs).grad
    div_values = np.trace(gradient, axis1=0, axis2=1)
    return float(np.sqrt(np.sum(div_values**2 * basis.dx)))


def solve_aneurysm_stokes(
    lumen_mask,
    sac_mask,
    affine_ras,
    *,
    flow_axis,
    inlet_velocity_mm_s,
    viscosity_pa_s,
    neck_origin,
    neck_normal,
    neck_thickness_mm,
    resistance_pa_s_per_mm2,
    spatial_units="mm",
):
    """Solve the prototype Stokes/Brinkman comparison on an accepted mask.

    Returns a finite JSON-serializable dict of scalar diagnostics. See the
    module docstring for the method and its limitations.
    """
    _require(
        spatial_units == "mm", f"unsupported spatial_units {spatial_units!r}; only 'mm' is accepted"
    )
    _require(
        not isinstance(flow_axis, (bool, np.bool_))
        and isinstance(flow_axis, (int, np.integer))
        and int(flow_axis) in (0, 1, 2),
        "flow_axis must be one of 0, 1, 2",
    )
    flow_axis = int(flow_axis)
    inlet_velocity = _as_float_scalar(inlet_velocity_mm_s, "inlet_velocity_mm_s", positive=True)
    viscosity = _as_float_scalar(viscosity_pa_s, "viscosity_pa_s", positive=True)
    thickness = _as_float_scalar(neck_thickness_mm, "neck_thickness_mm", positive=True)
    resistance = _as_float_scalar(
        resistance_pa_s_per_mm2, "resistance_pa_s_per_mm2", nonnegative=True
    )
    normal = _normalize_normal(neck_normal)
    origin = _validate_origin(neck_origin)
    affine, linear = _validate_affine(affine_ras)

    lumen = _validate_mask(lumen_mask, "lumen_mask")
    sac = _validate_mask(sac_mask, "sac_mask")
    _require(lumen.shape == sac.shape, "lumen_mask and sac_mask must share a shape")
    fluid_idx, _sac_idx, _amin, _amax = _validate_topology(lumen, sac, flow_axis)
    _require(
        int(fluid_idx.shape[0]) <= MAX_FLUID_VOXELS,
        f"fluid voxel count {fluid_idx.shape[0]} exceeds {MAX_FLUID_VOXELS} budget",
    )

    from skfem import (
        Basis,
        BilinearForm,
        ElementTetP1,
        ElementTetP2,
        ElementVector,
        FacetBasis,
        LinearForm,
        MeshTet,
        asm,
    )
    from skfem.helpers import div, grad, inner

    p_world, tets, verts, _n_edges, lo = _build_tets(fluid_idx, linear, affine)
    boundary_faces, inlet_mask, outlet_mask = _facet_sets(tets, verts, lo, flow_axis)

    mesh = MeshTet(p_world.astype(np.float64), tets.astype(np.int64))

    # Map boundary vertex triples to skfem facet indices.
    facet_key = {}
    facets_sorted = np.sort(cast("np.ndarray", mesh.facets), axis=0)
    for f in range(facets_sorted.shape[1]):
        facet_key[tuple(facets_sorted[:, f])] = f
    boundary = np.array(
        [facet_key[tuple(np.sort(boundary_faces[:, k]))] for k in range(boundary_faces.shape[1])],
        dtype=np.int64,
    )
    _require(
        set(boundary.tolist()) == set(mesh.boundary_facets().tolist()),
        "boundary facet bookkeeping mismatch",
    )
    intorder = 4
    basis_u = Basis(mesh, ElementVector(ElementTetP2()), intorder=intorder)
    basis_p = Basis(mesh, ElementTetP1(), intorder=intorder)

    @BilinearForm
    def vector_laplace(u: Any, v: Any, w: Any) -> np.ndarray:
        return cast(np.ndarray, inner(cast(Any, grad(u)), cast(Any, grad(v))))

    @BilinearForm
    def divergence(u: Any, q: Any, w: Any) -> np.ndarray:
        return cast(np.ndarray, div(u) * q)

    # Include ties at a slab boundary consistently after rigid transforms.
    # This is floating-arithmetic tolerance, not an anatomical error bound.
    slab_tolerance = (
        64
        * np.finfo(float).eps
        * max(1.0, float(np.max(np.abs(origin))), float(np.max(np.abs(p_world))), thickness)
    )

    @BilinearForm
    def brinkman(u, v, w):
        x = w.x
        d = np.abs(np.einsum("i,ieq->eq", normal, x - origin[:, None, None]))
        return (d <= 0.5 * thickness + slab_tolerance).astype(np.float64) * inner(u, v)

    A = asm(vector_laplace, basis_u) * viscosity
    B = -asm(divergence, basis_u, basis_p)

    inlet_facets = boundary[inlet_mask]
    outlet_facets = boundary[outlet_mask]
    inlet_dofs = np.unique(basis_u.get_dofs(facets=inlet_facets).all())
    wall_facets = boundary[~(inlet_mask | outlet_mask)]
    wall_dofs = np.unique(basis_u.get_dofs(facets=wall_facets).all())
    direction = linear[:, flow_axis] / np.linalg.norm(linear[:, flow_axis])

    # Slab must overlap the fluid domain.
    tet_centroids = mesh.p[:, mesh.t].mean(axis=1)
    d_cent = np.abs(normal @ (tet_centroids - origin[:, None]))
    _require(
        bool(np.any(d_cent <= 0.5 * thickness + slab_tolerance)),
        "neck slab does not overlap the fluid domain (missing slab)",
    )

    C = asm(brinkman, basis_u)

    @LinearForm
    def flux_form(v, w):
        return inner(w.n, v)

    fb_in = FacetBasis(mesh, basis_u.elem, facets=inlet_facets, intorder=intorder)
    fb_out = FacetBasis(mesh, basis_u.elem, facets=outlet_facets, intorder=intorder)
    Fin = asm(flux_form, fb_in)
    Fout = asm(flux_form, fb_out)

    inlet_facet_dofs_p = np.unique(basis_p.get_dofs(facets=inlet_facets).all())
    outlet_facet_dofs_p = np.unique(basis_p.get_dofs(facets=outlet_facets).all())

    def run(alpha):
        u, p, res_rel, momentum_rel = _solve_case(
            basis_u,
            A,
            B,
            C,
            alpha,
            inlet_dofs,
            inlet_velocity,
            wall_dofs,
            direction,
            basis_u.N,
        )
        fin = -float(Fin @ u)
        fout = float(Fout @ u)
        imbalance = abs(fin - fout) / max(abs(fin), 1e-300) * 100.0
        pdrop = float(p[inlet_facet_dofs_p].mean() - p[outlet_facet_dofs_p].mean())
        div_res = float(np.max(np.abs(B @ u)))
        return (
            u,
            p,
            {
                "flux_in": fin,
                "flux_out": fout,
                "imbalance": imbalance,
                "pdrop": pdrop,
                "res_rel": res_rel,
                "div_res": div_res,
                "momentum_rel": momentum_rel,
            },
        )

    u_b, _p_b, d_b = run(0.0)
    u_t, _p_t, d_t = run(resistance)

    # Each group of six mesh elements belongs to the original native voxel.
    # Integrate speed with the actual FEM volume quadrature, not a pressure
    # projection or a component-layout guess at arbitrary probe points.
    in_sac = np.repeat(sac[tuple(fluid_idx.T)].astype(bool), 6)
    weights = basis_u.dx[in_sac]
    speed_b = np.linalg.norm(basis_u.interpolate(u_b), axis=0)[in_sac]
    speed_t = np.linalg.norm(basis_u.interpolate(u_t), axis=0)[in_sac]
    base_speed = float(np.sum(weights * speed_b) / np.sum(weights))
    treated_speed = float(np.sum(weights * speed_t) / np.sum(weights))
    _require(
        base_speed > 1e-12 * inlet_velocity,
        "baseline sac mean speed is too small to normalize a "
        "relative change; reject rather than fabricate a percentage",
    )
    rel_change = 100.0 * (treated_speed - base_speed) / abs(base_speed)

    out = {
        "sac_mean_speed_baseline_mm_s": base_speed,
        "sac_mean_speed_treated_mm_s": treated_speed,
        "sac_mean_speed_relative_change_pct": float(rel_change),
        "inlet_flux_baseline_mm3_s": d_b["flux_in"],
        "outlet_flux_baseline_mm3_s": d_b["flux_out"],
        "flux_imbalance_baseline_pct": d_b["imbalance"],
        "inlet_flux_treated_mm3_s": d_t["flux_in"],
        "outlet_flux_treated_mm3_s": d_t["flux_out"],
        "flux_imbalance_treated_pct": d_t["imbalance"],
        "pressure_drop_inlet_to_outlet_baseline_pa": d_b["pdrop"],
        "pressure_drop_inlet_to_outlet_treated_pa": d_t["pdrop"],
        "momentum_residual_relative_baseline": d_b["momentum_rel"],
        "momentum_residual_relative_treated": d_t["momentum_rel"],
        "stokes_residual_rel_baseline": d_b["res_rel"],
        "stokes_residual_rel_treated": d_t["res_rel"],
        "divergence_l2_baseline": _divergence_l2(basis_u, u_b),
        "divergence_l2_treated": _divergence_l2(basis_u, u_t),
        "divergence_residual_baseline": d_b["div_res"],
        "divergence_residual_treated": d_t["div_res"],
        "n_fluid_voxels": int(fluid_idx.shape[0]),
        "n_tets": int(cast("np.ndarray", tets).shape[1]),
        "n_boundary_facets": int(boundary.size),
        "n_velocity_dofs": int(basis_u.N),
        "n_pressure_dofs": int(basis_p.N),
        "flow_axis": flow_axis,
        "inlet_velocity_mm_s": inlet_velocity,
        "viscosity_pa_s": viscosity,
        "neck_thickness_mm": thickness,
        "resistance_pa_s_per_mm2": resistance,
        "units": dict(_UNITS),
        "flags": dict(_FLAGS),
        "limitations": (
            "Prototype voxel-tet Taylor-Hood Stokes/Brinkman discretization "
            "under hypothetical boundary conditions and a hypothetical scalar "
            "neck-slab resistance; not patient-specific validated CFD and not "
            "a manufacturer-device-calibrated model."
        ),
    }
    for key, val in out.items():
        if isinstance(val, float):
            _require(bool(np.isfinite(val)), f"non-finite diagnostic {key}")
    return out
