"""Synthetic-fixture tests for planner.morphometry geometry core.

All meshes are generated analytically in tests; no image data, downloads, or
clinical claims. Source units are deliberately unspecified ("unknown") except
where a label is exercised explicitly.
"""

import math

import pytest

from planner.morphometry import MorphometryError, parent_section, sac_metrics, section_metrics

EPS = 1e-9


# ---------------------------------------------------------------- mesh helpers
def regular_polygon(n, radius, center=(0.0, 0.0, 0.0), axis=(0.0, 0.0, 1.0)):
    """Vertices of a regular n-gon in the plane through `center` ⊥ `axis`."""
    ax = _unit(axis)
    ref = (1.0, 0.0, 0.0) if abs(ax[0]) < 0.9 else (0.0, 1.0, 0.0)
    u = _unit(_cross(ref, ax))
    v = _unit(_cross(ax, u))
    pts = []
    for i in range(n):
        ang = 2.0 * math.pi * i / n
        w, h = radius * math.cos(ang), radius * math.sin(ang)
        pts.append(tuple(center[k] + w * u[k] + h * v[k] for k in range(3)))
    return pts


def _unit(x):
    n = math.sqrt(sum(c * c for c in x))
    return tuple(c / n for c in x)


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def polygonal_prism(n, radius, z0, z1, center=(0.0, 0.0, 0.0), axis=(0.0, 0.0, 1.0)):
    """Closed triangulated prism mesh (tube with end caps) along `axis`."""
    ax = _unit(axis)
    base = tuple(center[k] + z0 * ax[k] for k in range(3))
    ring0 = regular_polygon(n, radius, base, axis)
    shift = tuple(center[k] + z1 * ax[k] for k in range(3))
    ring1 = regular_polygon(n, radius, shift, axis)
    ax = _unit(axis)
    tris = []
    for i in range(n):
        j = (i + 1) % n
        if ax[2] >= 0:  # consistent outward winding
            tris.append((ring0[i], ring0[j], ring1[j]))
            tris.append((ring0[i], ring1[j], ring1[i]))
        else:
            tris.append((ring0[i], ring1[j], ring0[j]))
            tris.append((ring0[i], ring1[i], ring1[j]))
    c = tuple((a + b) / 2.0 for a, b in zip(center, shift))
    for ring, flip in ((ring0, True), (ring1, False)):
        for i in range(1, n - 1):
            fan = (ring[0], ring[i], ring[i + 1])
            tris.append(tuple(reversed(fan)) if flip else fan)
    _ = c
    return tris


def _plane_transform(point, normal):
    """Orthonormal basis (e1, e2, n) of the plane through `point` ⊥ `normal`."""
    n = _unit(normal)
    ref = (1.0, 0.0, 0.0) if abs(n[0]) < 0.9 else (0.0, 1.0, 0.0)
    e1 = _unit(_cross(ref, n))
    e2 = _cross(n, e1)
    return e1, e2, n, point


def transform_mesh(tris, point, normal, flip=False):
    """Map the canonical z-axis setup into an arbitrary plane frame (and back)."""
    e1, e2, n, o = _plane_transform(point, normal)
    sgn = -1.0 if flip else 1.0

    def map(p):
        x, y, z = p
        w = (x * e1[k] + y * e2[k] + z * n[k] * sgn for k in range(3))
        return tuple(o[k] + next(w) for k in range(3))

    return [(map(a), map(b), map(c)) for a, b, c in tris]


def sphere_mesh(radius, center=(0.0, 0.0, 0.0), nu=24, nv=12):
    """UV-sphere triangulation (analytic geometry, synthetic mesh)."""
    tris = []
    rows = []
    for iv in range(nv + 1):
        phi = math.pi * iv / nv
        r = radius * math.sin(phi)
        z = radius * math.cos(phi)
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


# ------------------------------------------------------------ section_metrics
def test_section_metrics_regular_polygon_analytic():
    n, r = 8, 2.0
    mesh = polygonal_prism(n, r, -1.0, 1.0)
    m = section_metrics(mesh, (0.0, 0.0, 0.0), (0.0, 0.0, 1.0), spatial_units="unknown")
    area = 0.5 * n * r * r * math.sin(2 * math.pi / n)
    assert m["area"] == pytest.approx(area, rel=1e-9)
    assert m["max_diameter"] == pytest.approx(2 * r, rel=1e-9)  # opposite vertices
    assert m["min_diameter"] == pytest.approx(2 * r * math.cos(math.pi / n), rel=1e-9)
    assert m["equivalent_diameter"] == pytest.approx(math.sqrt(4 * area / math.pi), rel=1e-9)
    # Triangulation diagonals may add collinear points along the polygon edges,
    # so the contour has >= n vertices; all must lie in the section plane.
    assert len(m["contour_world"]) >= n
    assert all(abs(p[2]) < 1e-9 for p in m["contour_world"])
    assert m["centroid_world"] == pytest.approx((0.0, 0.0, 0.0), abs=1e-9)
    assert m["spatial_units"] == "unknown"
    assert m["method"] == "plane_mesh_intersection"
    assert m["validated_morphometry"] is False


def test_section_metrics_oblique_translated_and_reflected_equivalence():
    n, r = 12, 3.0
    base = polygonal_prism(n, r, -1.0, 1.0)
    ref = section_metrics(base, (0.0, 0.0, 0.0), (0.0, 0.0, 1.0))
    point, normal = (1.5, -2.0, 4.0), (0.3, -0.4, 0.5)
    for flip in (False, True):
        mesh = transform_mesh(base, point, normal, flip=flip)
        m = section_metrics(mesh, point, normal)
        assert m["area"] == pytest.approx(ref["area"], rel=1e-7)
        assert m["max_diameter"] == pytest.approx(ref["max_diameter"], rel=1e-7)
        assert m["min_diameter"] == pytest.approx(ref["min_diameter"], rel=1e-7)
        assert len(m["contour_world"]) >= n
        assert all(
            abs(_dot3(p, _unit(normal)) - _dot3(point, _unit(normal))) < 1e-7
            for p in m["contour_world"]
        )


def _dot3(a, b):
    return sum(x * y for x, y in zip(a, b))


def test_section_metrics_declared_units_propagate():
    mesh = polygonal_prism(6, 1.0, -1.0, 1.0)
    m = section_metrics(mesh, (0, 0, 0), (0, 0, 1), spatial_units="voxels")
    assert m["spatial_units"] == "voxels"


def test_section_metrics_rejects_invalid_inputs():
    good = polygonal_prism(8, 1.0, -1.0, 1.0)
    with pytest.raises(MorphometryError):
        section_metrics(good, (0, 0, 0), (0, 0, 0))  # zero normal
    with pytest.raises(MorphometryError):
        section_metrics(good, (0, 0, 0), (float("nan"), 0, 1))
    with pytest.raises(MorphometryError):
        section_metrics(good, (float("inf"), 0, 0), (0, 0, 1))
    with pytest.raises(MorphometryError):
        section_metrics([(float("nan"), 0, 0), (0, 1, 0), (0, 0, 1)], (0, 0, 0), (0, 0, 1))
    with pytest.raises(MorphometryError):
        section_metrics([((0, 0, 0), (1, 0, 0), (0, 1, 0))] * 2, (0, 0, 0), (0, 0, 1))  # degenerate
    with pytest.raises(MorphometryError):
        section_metrics(good, (0, 0, 5), (0, 0, 1))  # plane misses mesh -> no contour


def test_section_metrics_rejects_too_many_triangles():
    n = 50001 // 2
    mesh = polygonal_prism(n, 1.0, -1.0, 1.0) if n > 1 else []
    assert len(mesh) >= 50000 or True
    big = list(mesh)
    while len(big) <= 50000:
        big.extend(mesh)
    with pytest.raises(MorphometryError):
        section_metrics(big[:50001], (0, 0, 0), (0, 0, 1))


def test_section_metrics_rejects_open_and_multiple_contours():
    # Open contour: single-sided tube (no seam closure) cut by a plane.
    n, r = 16, 1.0
    ring0 = regular_polygon(n, r, (0, 0, -1))
    ring1 = regular_polygon(n, r, (0, 0, 1))
    open_tris = []
    for i in range(n - 1):  # omit last quad -> open strip
        j = i + 1
        open_tris.append((ring0[i], ring0[j], ring1[j]))
        open_tris.append((ring0[i], ring1[j], ring1[i]))
    with pytest.raises(MorphometryError):
        section_metrics(open_tris, (0, 0, 0), (0, 0, 1))
    # Two disjoint tubes -> ambiguous multiple contours.
    two = polygonal_prism(n, r, -1, 1) + polygonal_prism(n, r, -1, 1, center=(5.0, 0, 0))
    with pytest.raises(MorphometryError):
        section_metrics(two, (0, 0, 0), (0, 0, 1))


def test_section_metrics_rejects_coplanar_patch_and_point_overflow():
    n = 8
    mesh = polygonal_prism(n, 1.0, -1.0, 1.0)
    coplanar = [((0.5, 0.5, 0.0), (0.8, 0.5, 0.0), (0.8, 0.8, 0.0))]
    with pytest.raises(MorphometryError):
        section_metrics(mesh + coplanar, (0, 0, 0), (0, 0, 1))
    # Contour point cap: fine polygon far beyond 4096 unique points.
    big = polygonal_prism(8200, 1.0, -1.0, 1.0)
    with pytest.raises(MorphometryError):
        section_metrics(big, (0, 0, 0), (0, 0, 1))


# --------------------------------------------------------------- sac_metrics
def test_sac_metrics_box_analytic():
    # Box with planar extent 4 x 2 and dome side z in [0, 3] above neck plane.
    w, d, h = 4.0, 2.0, 3.0
    p = [
        (0, 0, 0),
        (w, 0, 0),
        (w, d, 0),
        (0, d, 0),
        (0, 0, h),
        (w, 0, h),
        (w, d, h),
        (0, d, h),
    ]
    quads = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    tris = []
    for quad in quads:
        a, b, c, d_ = (p[i] for i in quad)
        tris.append((a, b, c))
        tris.append((a, c, d_))
    m = sac_metrics(tris, (0, 0, 0), (0, 0, 1))
    assert m["height"] == pytest.approx(h, rel=1e-9)
    assert m["width"] == pytest.approx(math.hypot(w, d), rel=1e-9)  # planar diagonal
    assert m["method"] == "operator_plane_sac_geometry"
    assert m["validated_morphometry"] is False
    assert m["spatial_units"] == "unknown"


def test_sac_metrics_oblique_plane_matches_axis_aligned():
    w, d, h = 4.0, 2.0, 3.0
    p = [
        (0, 0, 0),
        (w, 0, 0),
        (w, d, 0),
        (0, d, 0),
        (0, 0, h),
        (w, 0, h),
        (w, d, h),
        (0, d, h),
    ]
    quads = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    tris = []
    for quad in quads:
        a, b, c, d_ = (p[i] for i in quad)
        tris.append((a, b, c))
        tris.append((a, c, d_))
    ref = sac_metrics(tris, (0, 0, 0), (0, 0, 1))
    point, normal = (2.0, -1.0, 0.5), (0.2, 0.2, 1.0)
    oblique = transform_mesh(tris, point, normal)
    m = sac_metrics(oblique, point, normal)
    assert m["height"] == pytest.approx(ref["height"], rel=1e-7)
    assert m["width"] == pytest.approx(ref["width"], rel=1e-7)


def test_sac_metrics_sphere_dome_height_and_width():
    r = 2.5
    mesh = sphere_mesh(r)
    m = sac_metrics(mesh, (0, 0, 0), (0, 0, 1))
    assert m["height"] == pytest.approx(r, rel=1e-6)
    # Width is over dome-side MESH VERTICES; the nearest latitude ring sits at
    # polar angle pi/2 + pi/nv, so width = 2r*cos(pi/nv) at this resolution.
    assert m["width"] == pytest.approx(2 * r * math.cos(math.pi / 12), rel=1e-6)


def test_sac_metrics_rejects_no_positive_side_and_bad_inputs():
    mesh = polygonal_prism(8, 1.0, -1.0, 1.0)
    with pytest.raises(MorphometryError):
        sac_metrics(mesh, (0, 0, 2), (0, 0, 1))  # dome side empty
    with pytest.raises(MorphometryError):
        sac_metrics(mesh, (0, 0, 0), (0, 0, 0))
    with pytest.raises(MorphometryError):
        sac_metrics(mesh, (float("nan"), 0, 0), (0, 0, 1))
    with pytest.raises(MorphometryError):
        sac_metrics([((0, 0, 0), (1, 0, 0), (0, 1, 0))] * 2, (0, 0, 0), (0, 0, 1))


# ------------------------------------------------------------ parent_section
def test_parent_section_matches_section_metrics_on_cylinder_axis():
    n, r = 16, 2.0
    mesh = polygonal_prism(n, r, -2.0, 2.0)
    centerline = [(0.0, 0.0, z) for z in (-2.0, -1.0, 0.0, 1.0, 2.0)]
    m = parent_section(mesh, centerline, 2)
    ref = section_metrics(mesh, (0.0, 0.0, 0.0), (0.0, 0.0, 1.0))
    assert m["method"] == "supplied_centerline_normal_section"
    for key in ("area", "max_diameter", "min_diameter", "equivalent_diameter"):
        assert m[key] == pytest.approx(ref[key], rel=1e-9)
    assert m["spatial_units"] == "unknown"
    assert m["validated_morphometry"] is False


def test_parent_section_rejects_endpoint_zero_tangent_and_nonfinite():
    mesh = polygonal_prism(8, 1.0, -2.0, 2.0)
    line = [(0.0, 0.0, z) for z in (-2.0, -1.0, 0.0, 1.0, 2.0)]
    with pytest.raises(MorphometryError):
        parent_section(mesh, line, 0)  # endpoint index
    with pytest.raises(MorphometryError):
        parent_section(mesh, line, 4)
    with pytest.raises(MorphometryError):
        parent_section(mesh, [(0.0, 0.0, z) for z in (0.0, 1.0, 1.0, 1.0, 2.0)], 2)  # zero tangent
    with pytest.raises(MorphometryError):
        parent_section(mesh, [(0.0, 0.0, z) for z in (-2.0, -1.0, float("nan"), 1.0, 2.0)], 2)
    with pytest.raises(MorphometryError):
        parent_section(mesh, [(0.0, 0.0, 0.0)], 0)  # too short
