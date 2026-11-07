"""Geometry core: plane-mesh section morphometry from triangle soups.

Synthetic prototype. All measurements are computed in the source's own world
coordinates, which are NOT assumed to be millimeters and are NOT clinically
validated; `spatial_units` stays "unknown" unless the caller declares it.
No automatic aneurysm detection or clinical-validity claims are made here.

Stdlib only.
"""

from __future__ import annotations

import math

MAX_TRIANGLES = 50000
MAX_CONTOUR_POINTS = 4096
_PLANE_EPS = 1e-9


class MorphometryError(ValueError):
    """Invalid, ambiguous, or out-of-bounds morphometry input."""


def _require_finite_point(p, what):
    try:
        x, y, z = (float(c) for c in p)
    except (TypeError, ValueError) as exc:
        raise MorphometryError(f"{what} is not a 3-component numeric point: {p!r}") from exc
    if not all(math.isfinite(c) for c in (x, y, z)):
        raise MorphometryError(f"{what} is not finite: {p!r}")
    return x, y, z


def _validate_triangles(triangles):
    tris = []
    for t in triangles:
        if len(tris) >= MAX_TRIANGLES:
            raise MorphometryError(f"triangle count exceeds the {MAX_TRIANGLES} limit")
        try:
            a, b, c = t
        except (TypeError, ValueError) as exc:
            raise MorphometryError(f"triangle is not three points: {t!r}") from exc
        tris.append(
            (
                _require_finite_point(a, "triangle vertex"),
                _require_finite_point(b, "triangle vertex"),
                _require_finite_point(c, "triangle vertex"),
            )
        )
    if not tris:
        raise MorphometryError("triangle sequence is empty")
    if len(tris) > MAX_TRIANGLES:
        raise MorphometryError(
            f"triangle count {len(tris)} exceeds the {MAX_TRIANGLES} pre-quadratic limit"
        )
    for a, b, c in tris:
        if _point_plane_class(a, b, c) == 0:
            raise MorphometryError("degenerate (zero-area) triangle in input")
    return tris


def _plane_basis(normal):
    n = _require_finite_point(normal, "plane normal")
    length = math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2])
    if length == 0.0 or not math.isfinite(length):
        raise MorphometryError("plane normal must be nonzero and finite")
    nx, ny, nz = (c / length for c in n)
    ref = (1.0, 0.0, 0.0) if abs(nx) < 0.9 else (0.0, 1.0, 0.0)
    e1 = _cross(ref, (nx, ny, nz))
    l1 = math.sqrt(sum(c * c for c in e1))
    e1 = tuple(c / l1 for c in e1)
    e2 = _cross((nx, ny, nz), e1)
    return (nx, ny, nz), e1, e2


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _point_plane_class(a, b, c):
    """0 for a degenerate (zero-area) triangle, else 1."""
    ux, uy, uz = (b[k] - a[k] for k in range(3))
    vx, vy, vz = (c[k] - a[k] for k in range(3))
    cr = _cross((ux, uy, uz), (vx, vy, vz))
    return 1 if math.sqrt(sum(v * v for v in cr)) > _PLANE_EPS else 0


# ------------------------------------------------------------------ sections
def section_metrics(triangles, origin, normal, *, spatial_units="unknown") -> dict:
    """Intersect a triangle mesh with a plane and measure the single contour.

    The plane passes through `origin` with direction `normal` (any magnitude,
    nonzero). Triangles lying entirely in the plane (coplanar surface patches)
    are rejected rather than silently merged into the contour. The intersection
    segments are joined into exactly one closed contour; zero, open, or multiple
    contours are errors. Max/min diameters are planar Feret diameters of the
    contour's convex hull. Distances and areas are in the source's declared
    world coordinates, which are not assumed to be millimeters. This is not
    clinically validated morphometry.
    """
    tris = _validate_triangles(triangles)
    o = _require_finite_point(origin, "plane origin")
    n, e1, e2 = _plane_basis(normal)
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
    contour = _join_segments(segments)
    projected = [
        (
            _dot(tuple(p[k] - o[k] for k in range(3)), e1),
            _dot(tuple(p[k] - o[k] for k in range(3)), e2),
        )
        for p in contour
    ]
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
        "method": "plane_mesh_intersection",
        "validated_morphometry": False,
    }


def _quant_key(p):
    return (round(p[0], 9), round(p[1], 9), round(p[2], 9))


def _join_segments(segments):
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
    start = next(iter(adj))
    loop = [start]
    prev, cur = None, start
    while True:
        candidates = [w for w in adj[cur] if w != prev]
        if cur == start:
            nxt = [candidates[0]] if candidates else []
        else:
            nxt = candidates
        if len(nxt) != 1:
            raise MorphometryError("section contour is not a single closed loop")
        prev, cur = cur, nxt[0]
        if cur == start:
            break
        loop.append(cur)
    if len(loop) != len(verts):
        raise MorphometryError("multiple disjoint contours on the section plane; ambiguous")
    return [verts[i] for i in loop]


def _convex_hull(points):
    pts = sorted(set(points))
    if len(pts) < 3:
        raise MorphometryError("contour is degenerate (fewer than 3 distinct points)")

    def half(pts_in):
        out = []
        for p in pts_in:
            while len(out) >= 2 and _orient(out[-2], out[-1], p) <= 0:
                out.pop()
            out.append(p)
        return out

    lower = half(pts)
    upper = half(reversed(pts))
    return lower[:-1] + upper[:-1]


def _orient(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _polygon_moments(proj):
    area2 = 0.0
    moment_x = moment_y = 0.0
    for i in range(len(proj)):
        x1, y1 = proj[i]
        x2, y2 = proj[(i + 1) % len(proj)]
        cross = x1 * y2 - x2 * y1
        area2 += cross
        moment_x += (x1 + x2) * cross
        moment_y += (y1 + y2) * cross
    if not math.isfinite(area2) or area2 == 0:
        raise MorphometryError("closed contour has invalid planar area")
    return abs(area2) / 2.0, (moment_x / (3 * area2), moment_y / (3 * area2))


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _feret(hull):
    proj = hull
    m = len(proj)
    max_d = 0.0
    for i in range(m):
        for j in range(i + 1, m):
            max_d = max(max_d, math.hypot(proj[i][0] - proj[j][0], proj[i][1] - proj[j][1]))
    min_d = None
    for i in range(m):
        a, b = proj[i], proj[(i + 1) % m]
        dx, dy = b[0] - a[0], b[1] - a[1]
        length = math.hypot(dx, dy)
        if length == 0.0:
            continue
        ux, uy = -dy / length, dx / length
        vals = [p[0] * ux + p[1] * uy for p in proj]
        width = max(vals) - min(vals)
        if min_d is None or width < min_d:
            min_d = width
    if min_d is None:
        raise MorphometryError("degenerate convex hull for Feret diameters")
    return max_d, min_d


# --------------------------------------------------------------- sac metrics
def sac_metrics(triangles, neck_origin, neck_normal, *, spatial_units="unknown") -> dict:
    """Operator-defined neck-plane sac geometry (definition, not validation).

    The sac dome side is the positive-normal side of the operator-supplied neck
    plane (through `neck_origin`, direction `neck_normal`). `height` is the
    maximum perpendicular distance from the neck plane to any dome-side mesh
    vertex. `width` is the maximum planar Feret diameter of the dome-side mesh
    vertices projected onto the neck plane. These are the exact definitions
    used; this is NOT an automatically validated anatomical neck definition and
    NOT clinically validated morphometry. Units are the source's declared world
    coordinates, not assumed to be millimeters. Input with no positive-side sac
    geometry is rejected.
    """
    tris = _validate_triangles(triangles)
    o = _require_finite_point(neck_origin, "neck-plane origin")
    n, e1, e2 = _plane_basis(neck_normal)
    dome = []
    for a, b, c in tris:
        for p in (a, b, c):
            d = _dot((p[0] - o[0], p[1] - o[1], p[2] - o[2]), n)
            if d > _PLANE_EPS:
                dome.append((p, d))
    if not dome:
        raise MorphometryError("no positive-side (dome) sac geometry for the neck plane")
    if len(dome) > MAX_CONTOUR_POINTS:
        raise MorphometryError(
            f"dome-side points {len(dome)} exceed the {MAX_CONTOUR_POINTS} pre-quadratic limit"
        )
    height = max(d for _, d in dome)
    proj = [(_dot(p, e1), _dot(p, e2)) for p, _ in dome]
    hull = _convex_hull([(x, y) for x, y in proj])
    width = 0.0
    for i in range(len(hull)):
        for j in range(i + 1, len(hull)):
            width = max(width, math.hypot(hull[i][0] - hull[j][0], hull[i][1] - hull[j][1]))
    return {
        "height": height,
        "width": width,
        "spatial_units": spatial_units,
        "method": "operator_plane_sac_geometry",
        "validated_morphometry": False,
    }


# ------------------------------------------------------------ parent section
def parent_section(triangles, centerline, index, *, spatial_units="unknown") -> dict:
    """Measure the parent-vessel section at a supplied centerline point.

    The plane normal is the normalized tangent of the supplied `centerline`
    (finite xyz points, same world frame as the mesh) computed from the
    neighboring points `index-1` and `index+1`; `index` must be interior.
    Delegates measurement to :func:`section_metrics` at the centerline point.
    The centerline's extraction method and clinical adequacy are separate
    acceptance criteria and are not established here. Units are the source's
    declared world coordinates, not assumed to be millimeters.
    """
    if not isinstance(centerline, (list, tuple)) or len(centerline) < 3:
        raise MorphometryError("centerline must have at least three points")
    if type(index) is not int:
        raise MorphometryError("centerline index must be an integer")
    if index < 1 or index > len(centerline) - 2:
        raise MorphometryError(f"centerline index {index} is not interior")
    pts = [_require_finite_point(p, "centerline point") for p in centerline]
    tangent = tuple(pts[index + 1][k] - pts[index - 1][k] for k in range(3))
    length = math.sqrt(sum(c * c for c in tangent))
    if length == 0.0 or not math.isfinite(length):
        raise MorphometryError("centerline tangent is zero or non-finite at the index")
    n = tuple(c / length for c in tangent)
    metrics = section_metrics(triangles, pts[index], n, spatial_units=spatial_units)
    metrics["method"] = "supplied_centerline_normal_section"
    return metrics
