"""Section B: operator-origin contour selection and clipped sac metrics.

Fresh implementation layered on the geometry core in
:mod:`planner.morphometry` (existing helpers reused; that module's behavior is
unchanged). All measurements are in the source's own world coordinates, which
are NOT assumed to be millimeters and are NOT clinically validated. Units stay
"unknown" unless the caller declares them. No anatomical neck validation and
no automatic sizing happens here.

Stdlib only.
"""

from __future__ import annotations

import math

from planner.morphometry import (
    MAX_CONTOUR_POINTS,
    MAX_TRIANGLES,
    MorphometryError,
    _convex_hull,
    _dot,
    _feret,
    _plane_basis,
    _polygon_moments,
    _quant_key,
    _require_finite_point,
    _validate_triangles,
)

_PLANE_EPS = 1e-9


def _plane_segments(tris, o, n):
    """Intersection segments of the mesh with the plane, per old rules."""
    segments = []
    coplanar_seen = False
    for a, b, c in tris:
        d = tuple(
            (p[0] - o[0]) * n[0] + (p[1] - o[1]) * n[1] + (p[2] - o[2]) * n[2] for p in (a, b, c)
        )
        if all(abs(v) <= _PLANE_EPS for v in d):
            coplanar_seen = True
            continue
        pts = []
        vs = (a, b, c)
        for i in range(3):
            j = (i + 1) % 3
            di, dj = d[i], d[j]
            if di * dj < 0.0:
                t = di / (di - dj)
                pi, pj = vs[i], vs[j]
                pts.append(tuple(pi[k] + t * (pj[k] - pi[k]) for k in range(3)))
            elif abs(di) <= _PLANE_EPS and abs(dj) > _PLANE_EPS:
                pts.append(vs[i])
        if len(pts) == 2:
            segments.append((pts[0], pts[1]))
    if coplanar_seen:
        raise MorphometryError(
            "coplanar surface patch on the section plane; a plausible contour would be ambiguous"
        )
    return segments


def _all_loops(segments):
    """Partition segments into all closed loops (each vertex degree exactly 2)."""
    if not segments:
        raise MorphometryError("plane does not intersect the mesh")
    ids: dict[tuple, int] = {}
    verts: list[tuple] = []

    def vid(p):
        key = _quant_key(p)
        if key not in ids:
            ids[key] = len(verts)
            verts.append(p)
        return ids[key]

    adj: dict[int, list[int]] = {}
    for p, q in segments:
        i, j = vid(p), vid(q)
        adj.setdefault(i, []).append(j)
        adj.setdefault(j, []).append(i)
    if len(verts) > MAX_CONTOUR_POINTS:
        raise MorphometryError(
            f"unique contour points {len(verts)} exceed the {MAX_CONTOUR_POINTS} pre-quadratic limit"
        )
    if any(len(nbrs) != 2 for nbrs in adj.values()):
        raise MorphometryError("section contour is not a closed manifold loop (open or branched)")
    loops = []
    unvisited = set(range(len(verts)))
    while unvisited:
        start = next(iter(unvisited))
        loop = [start]
        unvisited.discard(start)
        prev, cur = None, start
        while True:
            candidates = [w for w in adj[cur] if w != prev]
            nxt = candidates[:1] if cur == start and len(candidates) == 2 else candidates
            if len(nxt) != 1:
                raise MorphometryError("section contour is not a single closed loop")
            prev, cur = cur, nxt[0]
            if cur == start:
                break
            if cur not in unvisited:
                raise MorphometryError("section contour is not a single closed loop")
            unvisited.discard(cur)
            loop.append(cur)
        loops.append([verts[i] for i in loop])
    return loops


def _project(loop, o, e1, e2):
    return [
        (
            _dot((p[0] - o[0], p[1] - o[1], p[2] - o[2]), e1),
            _dot((p[0] - o[0], p[1] - o[1], p[2] - o[2]), e2),
        )
        for p in loop
    ]


def _strictly_inside(poly, pt):
    """Even-odd containment; None denotes an ambiguous boundary point."""
    x, y = pt
    inside = False
    m = len(poly)
    for i in range(m):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % m]
        # boundary (with tolerance): reject as on-boundary
        cross = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)
        if (
            abs(cross) <= 1e-12 * max(1.0, math.hypot(x2 - x1, y2 - y1))
            and min(x1, x2) - 1e-12 <= x <= max(x1, x2) + 1e-12
            and min(y1, y2) - 1e-12 <= y <= max(y1, y2) + 1e-12
        ):
            return None
        if (y1 > y) != (y2 > y):
            xin = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if xin > x:
                inside = not inside
    return inside


def selected_section_metrics(triangles, origin, normal, *, spatial_units="unknown") -> dict:
    """Plane section selecting the closed contour containing the operator origin.

    The plane passes through `origin` (the operator-supplied lumen point) with
    direction `normal`. The intersection is partitioned into ALL closed loops;
    exactly one loop must strictly contain the projected origin. Zero or
    multiple containing loops, or an origin on a contour boundary, are errors.
    Other closed disjoint loops are never measured. All metrics come from the
    selected polygon only. This is not clinically validated morphometry and
    units are the source's declared world coordinates.
    """
    tris = _validate_triangles(triangles)
    o = _require_finite_point(origin, "plane origin")
    n, e1, e2 = _plane_basis(normal)
    loops = _all_loops(_plane_segments(tris, o, n))
    containing = []
    for loop in loops:
        poly = _project(loop, o, e1, e2)
        inside = _strictly_inside(poly, (0.0, 0.0))
        if inside is None:
            raise MorphometryError("operator origin lies on a section contour boundary")
        if inside:
            containing.append(loop)
    if not containing:
        raise MorphometryError("no closed section contour strictly contains the operator origin")
    if len(containing) > 1:
        raise MorphometryError(
            "multiple closed section contours contain the operator origin; ambiguous"
        )
    contour = containing[0]
    projected = _project(contour, o, e1, e2)
    hull = _convex_hull(projected)
    area, centroid = _polygon_moments(projected)
    if area <= 0.0:
        raise MorphometryError("closed contour has non-positive planar area")
    max_d, min_d = _feret(hull)
    center_world = tuple(o[k] + centroid[0] * e1[k] + centroid[1] * e2[k] for k in range(3))
    eq = math.sqrt(4.0 * area / math.pi)
    return {
        "contour_world": [tuple(p) for p in contour],
        "centroid_world": center_world,
        "area": area,
        "max_diameter": max_d,
        "min_diameter": min_d,
        "equivalent_diameter": eq,
        "spatial_units": spatial_units,
        "method": "plane_mesh_intersection_unique_selection",
        "selection": "unique_contour_containing_operator_origin",
        "plane_origin": tuple(o),
        "plane_normal": tuple(n),
        "validated_morphometry": False,
    }


def clipped_sac_metrics(triangles, neck_origin, neck_normal, *, spatial_units="unknown") -> dict:
    """Operator neck-plane sac geometry with true closed-half-space clipping.

    The dome side is the positive-normal side of the operator-supplied neck
    plane. `height` is the maximum perpendicular distance from the plane to any
    dome-side mesh vertex. `width` is the maximum planar Feret diameter of the
    clipped surface: all strictly positive vertices, vertices exactly on the
    plane, and true edge-plane intersection points (the closed positive
    half-space), so a cut through a face contributes its exact intersection
    geometry, not just whichever original vertices happen to survive. Exact
    geometric points are deduplicated at 1e-9 world-unit precision before the 4096-point cap. This is a
    discretization-limited definition, NOT an automatically validated
    anatomical neck and NOT clinically validated morphometry; units are the
    source's declared world coordinates.
    """
    tris = _validate_triangles(triangles)
    o = _require_finite_point(neck_origin, "neck-plane origin")
    n, e1, e2 = _plane_basis(neck_normal)
    points = []
    height = 0.0
    seen_dome = False
    for a, b, c in tris:
        d = tuple(
            (p[0] - o[0]) * n[0] + (p[1] - o[1]) * n[1] + (p[2] - o[2]) * n[2] for p in (a, b, c)
        )
        vs = (a, b, c)
        for i in range(3):
            if d[i] > _PLANE_EPS:
                seen_dome = True
                height = max(height, d[i])
                points.append(vs[i])
            elif abs(d[i]) <= _PLANE_EPS:
                points.append(vs[i])
        # true edge-plane intersections on strictly crossing edges
        for i in range(3):
            j = (i + 1) % 3
            di, dj = d[i], d[j]
            if di * dj < 0.0:
                t = di / (di - dj)
                pi, pj = vs[i], vs[j]
                points.append(tuple(pi[k] + t * (pj[k] - pi[k]) for k in range(3)))
    if not seen_dome:
        raise MorphometryError("no positive-side (dome) sac geometry for the neck plane")
    unique = {_quant_key(p): p for p in points}
    pts = list(unique.values())
    if len(pts) > MAX_CONTOUR_POINTS:
        raise MorphometryError(
            f"clipped dome-side points {len(pts)} exceed the {MAX_CONTOUR_POINTS} pre-quadratic limit"
        )
    proj = [(_dot(p, e1), _dot(p, e2)) for p in pts]
    hull = _convex_hull(proj)
    width = 0.0
    for i in range(len(hull)):
        for j in range(i + 1, len(hull)):
            width = max(width, math.hypot(hull[i][0] - hull[j][0], hull[i][1] - hull[j][1]))
    return {
        "height": height,
        "width": width,
        "spatial_units": spatial_units,
        "method": "operator_plane_clipped_surface",
        "validated_morphometry": False,
        "discretization_limited": True,
    }


_ = MAX_TRIANGLES  # enforced inside _validate_triangles
