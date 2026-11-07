"""Synthetic tests for planner.morphometry_selection (contract section B).

All meshes are analytic; no data, models, network, or clinical claims.
"""

import math

import pytest

from planner.morphometry import MorphometryError, sac_metrics, section_metrics
from planner.morphometry_selection import clipped_sac_metrics, selected_section_metrics


# ------------------------------------------------------------- mesh helpers
def _unit(x):
    n = math.sqrt(sum(c * c for c in x))
    return tuple(c / n for c in x)


def regular_polygon(n, radius, center=(0.0, 0.0, 0.0), axis=(0.0, 0.0, 1.0)):
    ax = _unit(axis)
    ref = (1.0, 0.0, 0.0) if abs(ax[0]) < 0.9 else (0.0, 1.0, 0.0)
    u = _unit(
        (
            ax[1] * ref[2] - ax[2] * ref[1],
            ax[2] * ref[0] - ax[0] * ref[2],
            ax[0] * ref[1] - ax[1] * ref[0],
        )
    )
    v = (ax[1] * u[2] - ax[2] * u[1], ax[2] * u[0] - ax[0] * u[2], ax[0] * u[1] - ax[1] * u[0])
    return [
        tuple(
            center[k]
            + radius * math.cos(2 * math.pi * i / n) * u[k]
            + radius * math.sin(2 * math.pi * i / n) * v[k]
            for k in range(3)
        )
        for i in range(n)
    ]


def polygonal_prism(n, radius, z0, z1, center=(0.0, 0.0, 0.0), axis=(0.0, 0.0, 1.0)):
    ax = _unit(axis)
    ring0 = regular_polygon(n, radius, tuple(center[k] + z0 * ax[k] for k in range(3)), axis)
    ring1 = regular_polygon(n, radius, tuple(center[k] + z1 * ax[k] for k in range(3)), axis)
    tris = []
    for i in range(n):
        j = (i + 1) % n
        tris.append((ring0[i], ring0[j], ring1[j]))
        tris.append((ring0[i], ring1[j], ring1[i]))
    for ring, flip in ((ring0, True), (ring1, False)):
        for i in range(1, n - 1):
            fan = (ring[0], ring[i], ring[i + 1])
            tris.append(tuple(reversed(fan)) if flip else fan)
    return tris


def sphere_mesh(radius, center=(0.0, 0.0, 0.0), nu=24, nv=12):
    tris, rows = [], []
    for iv in range(nv + 1):
        phi = math.pi * iv / nv
        r, z = radius * math.sin(phi), radius * math.cos(phi)
        rows.append(
            [
                (
                    center[0] + r * math.cos(2 * math.pi * iu / nu),
                    center[1] + r * math.sin(2 * math.pi * iu / nu),
                    center[2] + z,
                )
                for iu in range(nu)
            ]
        )
    for iv in range(nv):
        for iu in range(nu):
            j = (iu + 1) % nu
            a, b = rows[iv][iu], rows[iv][j]
            c, d = rows[iv + 1][iu], rows[iv + 1][j]
            if iv != 0:
                tris.append((a, b, c))
            if iv != nv - 1:
                tris.append((b, d, c))
    return tris


def transform_mesh(tris, point, normal, flip=False):
    n = _unit(normal)
    ref = (1.0, 0.0, 0.0) if abs(n[0]) < 0.9 else (0.0, 1.0, 0.0)
    e1 = _unit(
        (
            n[1] * ref[2] - n[2] * ref[1],
            n[2] * ref[0] - n[0] * ref[2],
            n[0] * ref[1] - n[1] * ref[0],
        )
    )
    e2 = (n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0])
    sgn = -1.0 if flip else 1.0

    def map(p):
        x, y, z = p
        return tuple(point[k] + x * e1[k] + y * e2[k] + z * n[k] * sgn for k in range(3))

    return [(map(a), map(b), map(c)) for a, b, c in tris]


def box_mesh(w, d, h):
    p = [(0, 0, 0), (w, 0, 0), (w, d, 0), (0, d, 0), (0, 0, h), (w, 0, h), (w, d, h), (0, d, h)]
    quads = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    tris = []
    for q in quads:
        a, b, c, d_ = (p[i] for i in q)
        tris.append((a, b, c))
        tris.append((a, c, d_))
    return tris


# ---------------------------------------------- selected_section_metrics
def test_selected_section_rejects_boundary_of_inner_loop_even_if_outer_contains():
    nested = polygonal_prism(8, 2.0, -1, 1) + polygonal_prism(8, 1.0, -1, 1)
    with pytest.raises(MorphometryError, match="boundary"):
        selected_section_metrics(nested, (1.0, 0, 0), (0, 0, 1))


def test_selected_section_single_tube_matches_section_metrics():
    n, r = 8, 2.0
    mesh = polygonal_prism(n, r, -1.0, 1.0)
    ref = section_metrics(mesh, (0, 0, 0), (0, 0, 1))
    m = selected_section_metrics(mesh, (0, 0, 0), (0, 0, 1), spatial_units="unknown")
    for key in ("area", "max_diameter", "min_diameter", "equivalent_diameter"):
        assert m[key] == pytest.approx(ref[key], rel=1e-9)
    assert m["selection"] == "unique_contour_containing_operator_origin"
    assert m["plane_origin"] == pytest.approx((0.0, 0.0, 0.0), abs=1e-12)
    assert m["plane_normal"] == pytest.approx((0.0, 0.0, 1.0), abs=1e-12)
    assert m["validated_morphometry"] is False
    assert m["spatial_units"] == "unknown"
    assert m["method"] == "plane_mesh_intersection_unique_selection"


def test_selected_section_picks_loop_containing_origin():
    n, r = 8, 1.0
    mesh = polygonal_prism(n, r, -1, 1) + polygonal_prism(n, r, -1, 1, center=(5.0, 0, 0))
    m = selected_section_metrics(mesh, (5.0, 0, 0), (0, 0, 1))
    assert m["area"] == pytest.approx(0.5 * n * r * r * math.sin(2 * math.pi / n), rel=1e-9)
    assert all(abs(p[0] - 5.0) < r + 1e-9 for p in m["contour_world"])
    assert m["centroid_world"] == pytest.approx((5.0, 0.0, 0.0), abs=1e-9)


def test_selected_section_rejects_zero_or_multiple_or_boundary():
    n, r = 8, 1.0
    two = polygonal_prism(n, r, -1, 1) + polygonal_prism(n, r, -1, 1, center=(5.0, 0, 0))
    with pytest.raises(MorphometryError):
        selected_section_metrics(two, (2.5, 0, 0), (0, 0, 1))  # inside neither
    nested = polygonal_prism(n, 2.0, -1, 1) + polygonal_prism(n, 1.0, -1, 1)
    with pytest.raises(MorphometryError):
        selected_section_metrics(nested, (0, 0, 0), (0, 0, 1))  # inside both
    with pytest.raises(MorphometryError):
        selected_section_metrics(polygonal_prism(n, r, -1, 1), (r, 0, 0), (0, 0, 1))  # on boundary
    with pytest.raises(MorphometryError):
        selected_section_metrics(
            polygonal_prism(n, r, -1, 1), (0, 0, 5), (0, 0, 1)
        )  # no intersection


def test_selected_section_oblique_reflected_equivalence():
    n, r = 12, 3.0
    base = polygonal_prism(n, r, -1.0, 1.0)
    ref = selected_section_metrics(base, (0, 0, 0), (0, 0, 1))
    point, normal = (1.5, -2.0, 4.0), (0.3, -0.4, 0.5)
    for flip in (False, True):
        mesh = transform_mesh(base, point, normal, flip=flip)
        m = selected_section_metrics(mesh, point, normal)
        assert m["area"] == pytest.approx(ref["area"], rel=1e-7)
        assert m["max_diameter"] == pytest.approx(ref["max_diameter"], rel=1e-7)
        assert m["min_diameter"] == pytest.approx(ref["min_diameter"], rel=1e-7)


def test_selected_section_preserves_old_rejection_rules():
    n, r = 8, 1.0
    with pytest.raises(MorphometryError):
        selected_section_metrics(polygonal_prism(n, r, -1, 1), (0, 0, 0), (0, 0, 0))  # zero normal
    with pytest.raises(MorphometryError):
        selected_section_metrics(
            [((0, 0, 0), (1, 0, 0), (0, 1, 0))] * 2, (0, 0, 0), (0, 0, 1)
        )  # degenerate
    mesh = polygonal_prism(n, r, -1, 1)
    with pytest.raises(MorphometryError):
        selected_section_metrics(
            mesh + [((0.5, 0.5, 0.0), (0.8, 0.5, 0.0), (0.8, 0.8, 0.0))], (0, 0, 0), (0, 0, 1)
        )  # coplanar
    ring0 = regular_polygon(n, r, (0, 0, -1))
    ring1 = regular_polygon(n, r, (0, 0, 1))
    open_tris = []
    for i in range(n - 1):
        j = i + 1
        open_tris.append((ring0[i], ring0[j], ring1[j]))
        open_tris.append((ring0[i], ring1[j], ring1[i]))
    with pytest.raises(MorphometryError):
        selected_section_metrics(open_tris, (0, 0, 0), (0, 0, 1))  # open


# ---------------------------------------------------- clipped_sac_metrics
def test_clipped_hemisphere_equatorial_width_fixes_old_bias():
    r = 2.5
    mesh = sphere_mesh(r)
    old = sac_metrics(mesh, (0, 0, 0), (0, 0, 1))
    m = clipped_sac_metrics(mesh, (0, 0, 0), (0, 0, 1))
    # Old helper sees only strictly positive vertices: nearest latitude ring
    # width 2r*cos(pi/nv). Clipping must include equatorial vertices -> 2r.
    assert old["width"] == pytest.approx(2 * r * math.cos(math.pi / 12), rel=1e-6)
    assert m["width"] == pytest.approx(2 * r, rel=1e-9)
    assert m["height"] == pytest.approx(r, rel=1e-6)
    assert m["method"] == "operator_plane_clipped_surface"
    assert m["validated_morphometry"] is False
    assert m["discretization_limited"] is True
    assert m["spatial_units"] == "unknown"


def test_clipped_edge_plane_intersections_counted():
    # Sphere cut by a plane strictly between latitude rings: old helper's
    # strictly-positive vertices undershoot the true circle radius; the
    # edge-plane intersection points must restore it.
    r = 3.0
    mesh = sphere_mesh(r, nu=48, nv=24)
    cut = r * math.sin(math.pi / 24) * 0.5  # between equator and first ring
    m = clipped_sac_metrics(mesh, (0, 0, cut), (0, 0, 1))
    true_width = 2 * math.sqrt(r * r - cut * cut)
    old = sac_metrics(mesh, (0, 0, cut), (0, 0, 1))
    # Edge-plane intersection points are included: the clipped width strictly
    # exceeds the old strictly-positive-vertex width and never overshoots the
    # true cut-circle width. Chord discretization keeps ~1% tolerance.
    assert old["width"] < m["width"] < true_width
    assert m["width"] == pytest.approx(true_width, rel=1e-2)


def test_clipped_matches_old_on_box_and_oblique():
    tris = box_mesh(4.0, 2.0, 3.0)
    old = sac_metrics(tris, (0, 0, 0), (0, 0, 1))
    m = clipped_sac_metrics(tris, (0, 0, 0), (0, 0, 1))
    assert m["height"] == pytest.approx(old["height"], rel=1e-9)
    assert m["width"] == pytest.approx(old["width"], rel=1e-9)
    point, normal = (2.0, -1.0, 0.5), (0.2, 0.2, 1.0)
    oblique = transform_mesh(tris, point, normal)
    ref = clipped_sac_metrics(oblique, point, normal)
    assert ref["height"] == pytest.approx(m["height"], rel=1e-7)
    assert ref["width"] == pytest.approx(m["width"], rel=1e-7)


def test_clipped_rejects_bad_inputs_and_no_dome():
    mesh = polygonal_prism(8, 1.0, -1.0, 1.0)
    with pytest.raises(MorphometryError):
        clipped_sac_metrics(mesh, (0, 0, 2), (0, 0, 1))  # empty dome side
    with pytest.raises(MorphometryError):
        clipped_sac_metrics(mesh, (0, 0, 0), (0, 0, 0))
    with pytest.raises(MorphometryError):
        clipped_sac_metrics(mesh, (float("nan"), 0, 0), (0, 0, 1))
    with pytest.raises(MorphometryError):
        clipped_sac_metrics(
            [((0, 0, 0), (1, 0, 0), (0, 1, 0))] * 2, (0, 0, 0), (0, 0, 1)
        )  # degenerate


def test_clipped_rejects_point_cap_after_dedup():
    # Dense sphere: unique clipped points exceed 4096 -> rejection, not silent cap.
    mesh = sphere_mesh(2.0, nu=150, nv=80)
    with pytest.raises(MorphometryError):
        clipped_sac_metrics(mesh, (0, 0, 0), (0, 0, 1))


# --------------------------------------------- clipped volume / surface area
def test_clipped_hemisphere_volume_and_surface_area_known_values():
    r = 2.5
    mesh = sphere_mesh(r)
    m = clipped_sac_metrics(mesh, (0, 0, 0), (0, 0, 1))
    # Hemisphere bounded by the dome surface and the planar neck cap.
    assert m["volume"] == pytest.approx((2.0 / 3.0) * math.pi * r**3, rel=5e-2)
    assert m["volume"] < (2.0 / 3.0) * math.pi * r**3  # chord chords undershoot
    assert m["surface_area"] == pytest.approx(2.0 * math.pi * r**2, rel=5e-2)


def test_clipped_box_volume_and_surface_area_exact():
    # Planar-faced box cut by a plane: clipped mesh arithmetic is exact.
    mesh = box_mesh(4.0, 2.0, 3.0)  # 0..4 x 0..2 x 0..3
    m = clipped_sac_metrics(mesh, (0, 0, 1.5), (0, 0, 1))
    assert m["volume"] == pytest.approx(4.0 * 2.0 * 1.5, rel=1e-12)
    # Dome surface: top face 8 + two 2x1.5 faces + two 4x1.5 faces.
    assert m["surface_area"] == pytest.approx(8.0 + 2 * 3.0 + 2 * 6.0, rel=1e-12)


def test_clipped_prism_volume_and_surface_area_exact():
    n, r = 8, 1.0
    mesh = polygonal_prism(n, r, -1.0, 1.0)
    m = clipped_sac_metrics(mesh, (0, 0, 0), (0, 0, 1))
    cap = (n / 2.0) * r * r * math.sin(2 * math.pi / n)
    assert m["volume"] == pytest.approx(cap * 1.0, rel=1e-12)
    lateral = n * 2.0 * r * math.sin(math.pi / n) * 1.0
    assert m["surface_area"] == pytest.approx(lateral + cap, rel=1e-12)


def test_clipped_volume_invariant_to_mixed_input_winding():
    import random

    mesh = box_mesh(4.0, 2.0, 3.0)
    ref = clipped_sac_metrics(mesh, (0, 0, 1.5), (0, 0, 1))
    rng = random.Random(20261107)
    mixed = [tuple(reversed(t)) if rng.random() < 0.5 else t for t in mesh]
    m = clipped_sac_metrics(mixed, (0, 0, 1.5), (0, 0, 1))
    assert m["volume"] == pytest.approx(ref["volume"], rel=1e-9)
    assert m["surface_area"] == pytest.approx(ref["surface_area"], rel=1e-9)


def test_clipped_volume_invariant_to_oblique_plane():
    mesh = box_mesh(4.0, 2.0, 3.0)
    ref = clipped_sac_metrics(mesh, (0, 0, 1.5), (0, 0, 1))
    # transform_mesh maps local z=0 to the plane through `point`; the cut must
    # sit at the same local offset (z=1.5) on both sides for a rigid-motion
    # comparison of an actual mid-box cut.
    point, normal = (2.0, -1.0, 0.5), (0.2, 0.2, 1.0)
    nlen = math.sqrt(sum(c * c for c in normal))
    cut_point = tuple(point[k] + 1.5 * normal[k] / nlen for k in range(3))
    m = clipped_sac_metrics(transform_mesh(mesh, point, normal), cut_point, normal)
    assert m["volume"] == pytest.approx(ref["volume"], rel=1e-7)
    assert m["surface_area"] == pytest.approx(ref["surface_area"], rel=1e-7)


def test_clipped_volume_sums_disconnected_dome_components():
    # Two disjoint octagonal prisms above the plane: neither lobe's arbitrary
    # winding parity may cancel the other's contribution.
    left = polygonal_prism(8, 1.0, 0.0, 1.0, center=(3.0, 0.0, 0.0))
    right = polygonal_prism(8, 1.0, 0.0, 1.0, center=(-3.0, 0.0, 0.0))
    m = clipped_sac_metrics(left + right, (0, 0, 0), (0, 0, 1))
    cap = 4.0 * math.sin(math.pi / 4.0)
    assert m["volume"] == pytest.approx(2.0 * cap, rel=1e-12)
    flipped = [tuple(reversed(t)) for t in left] + right
    m2 = clipped_sac_metrics(flipped, (0, 0, 0), (0, 0, 1))
    assert m2["volume"] == pytest.approx(2.0 * cap, rel=1e-12)


def test_clipped_rejects_nested_components_without_solid_membership():
    # Arbitrarily wound nested shells do not specify whether the inner solid
    # is a cavity or another filled component. Do not add both absolute volumes.
    with pytest.raises(MorphometryError, match="overlap|nested|ambiguous"):
        clipped_sac_metrics(sphere_mesh(3.0) + sphere_mesh(1.0), (0, 0, 0), (0, 0, 1))


def test_clipped_rejects_nonmanifold_shared_edge():
    # Three triangles sharing one edge: non-manifold patch, reject rather
    # than reporting a volume.
    e0, e1 = (0.0, 0.0, 1.0), (1.0, 0.0, 1.0)
    mesh = [
        (e0, e1, (0.0, 1.0, 1.0)),
        (e0, e1, (0.0, 2.0, 1.0)),
        (e0, e1, (-1.0, 1.0, 1.0)),
    ]
    with pytest.raises(MorphometryError, match="non-manifold|orientation"):
        clipped_sac_metrics(mesh, (0, 0, 0), (0, 0, 1))
