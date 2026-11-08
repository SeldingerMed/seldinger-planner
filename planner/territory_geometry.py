"""Bounded physical-coordinate geometry shared by territory workflows."""

import math
from itertools import pairwise

MAX_CONTOUR_POINTS = 512
PLANE_TOLERANCE_MM = 1e-4


def point3(value):
    if (
        not isinstance(value, (list, tuple))
        or len(value) != 3
        or any(type(x) not in (int, float) or not math.isfinite(x) for x in value)
    ):
        raise ValueError("Expected three finite physical coordinates")
    return tuple(float(x) for x in value)


def subtract(a, b):
    return tuple(x - y for x, y in zip(a, b, strict=True))


def dot(a, b):
    return sum(x * y for x, y in zip(a, b, strict=True))


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def unit(vector):
    value = point3(vector)
    length = math.hypot(*value)
    if not math.isfinite(length) or length <= 1e-12:
        raise ValueError("Direction must be nonzero")
    return tuple(x / length for x in value)


def plane_basis(normal):
    n = unit(normal)
    reference = (0.0, 1.0, 0.0) if abs(n[0]) > 0.9 else (1.0, 0.0, 0.0)
    u = unit(cross(reference, n))
    return n, u, cross(n, u)


def _segments_intersect(a, b, c, d):
    def orientation(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    def on_segment(p, q, r):
        return all(min(p[i], q[i]) <= r[i] <= max(p[i], q[i]) for i in (0, 1))

    ab_c, ab_d = orientation(a, b, c), orientation(a, b, d)
    cd_a, cd_b = orientation(c, d, a), orientation(c, d, b)
    if ((ab_c < 0 < ab_d) or (ab_d < 0 < ab_c)) and ((cd_a < 0 < cd_b) or (cd_b < 0 < cd_a)):
        return True
    return any(
        value == 0 and on_segment(p, q, point)
        for value, p, q, point in (
            (ab_c, a, b, c),
            (ab_d, a, b, d),
            (cd_a, c, d, a),
            (cd_b, c, d, b),
        )
    )


def _hull(points):
    points = sorted(set(points))

    def turn(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    lower = []
    for point in points:
        while len(lower) >= 2 and turn(lower[-2], lower[-1], point) <= 0:
            lower.pop()
        lower.append(point)
    upper = []
    for point in reversed(points):
        while len(upper) >= 2 and turn(upper[-2], upper[-1], point) <= 0:
            upper.pop()
        upper.append(point)
    return lower[:-1] + upper[:-1]


def path_distances(path):
    if not isinstance(path, (list, tuple)) or not 2 <= len(path) <= 128:
        raise ValueError("Path requires two to 128 points")
    points = [point3(p) for p in path]
    distances = [0.0]
    for a, b in pairwise(points):
        length = math.dist(a, b)
        if not math.isfinite(length) or length <= 1e-8:
            raise ValueError("Consecutive path points must be distinct")
        distances.append(distances[-1] + length)
    if not math.isfinite(distances[-1]):
        raise ValueError("Path length must be finite")
    return distances


def angle_degrees(a, b):
    return math.degrees(math.acos(max(-1.0, min(1.0, dot(unit(a), unit(b))))))


def section_metrics(origin, normal, contour):
    origin = point3(origin)
    n, u, v = plane_basis(normal)
    if not isinstance(contour, (list, tuple)) or not 3 <= len(contour) <= MAX_CONTOUR_POINTS:
        raise ValueError("Section contour must contain three to 512 points")
    points = [point3(p) for p in contour]
    if points[0] == points[-1]:
        points.pop()
    if len(points) < 3 or len(set(points)) != len(points):
        raise ValueError("Section contour requires distinct vertices")
    projected = []
    for point in points:
        delta = subtract(point, origin)
        if abs(dot(delta, n)) > PLANE_TOLERANCE_MM:
            raise ValueError("Section contour is not on its declared plane")
        projected.append((dot(delta, u), dot(delta, v)))
    edges = list(pairwise(projected + projected[:1]))
    for i, (a, b) in enumerate(edges):
        for j in range(i + 1, len(edges)):
            if j == i + 1 or (i == 0 and j == len(edges) - 1):
                continue
            if _segments_intersect(a, b, *edges[j]):
                raise ValueError("Section contour must not self-intersect")
    area = abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in edges)) / 2
    perimeter = sum(math.dist(a, b) for a, b in edges)
    if not math.isfinite(area) or not math.isfinite(perimeter) or area <= 1e-10:
        raise ValueError("Section contour must enclose finite positive area")
    hull = _hull(projected)
    maximum = max(math.dist(a, b) for i, a in enumerate(hull) for b in hull[i + 1 :])
    minimum = min(
        max(
            abs((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0])) / math.dist(a, b)
            for q in hull
        )
        for a, b in pairwise(hull + hull[:1])
    )
    return {
        "min_diameter_mm": minimum,
        "max_diameter_mm": maximum,
        "area_mm2": area,
        "perimeter_mm": perimeter,
        "area_derived_diameter_mm": math.sqrt(4 * area / math.pi),
        "perimeter_derived_diameter_mm": perimeter / math.pi,
    }


def _project_ring(section, origin, normal):
    n, u, v = plane_basis(normal)
    points = []
    for point in section["contour"]:
        delta = subtract(point3(point), origin)
        if abs(dot(delta, n)) > PLANE_TOLERANCE_MM:
            raise ValueError("Regions must share the profile plane")
        points.append((dot(delta, u), dot(delta, v)))
    if points[0] == points[-1]:
        points.pop()
    return points


def _inside(point, polygon, *, boundary=True):
    inside = False
    for a, b in pairwise(polygon + polygon[:1]):
        cross_value = (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0])
        if abs(cross_value) <= 1e-10 and all(
            min(a[i], b[i]) - 1e-10 <= point[i] <= max(a[i], b[i]) + 1e-10 for i in (0, 1)
        ):
            return boundary
        if (a[1] > point[1]) != (b[1] > point[1]):
            x = a[0] + (point[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1])
            if point[0] < x:
                inside = not inside
    return inside


def _proper_cross(a, b, c, d):
    def side(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    return side(a, b, c) * side(a, b, d) < 0 and side(c, d, a) * side(c, d, b) < 0


def _overlap(a, b):
    # Collinear edge crossings can overlap in area without any vertex being
    # strictly inside the other polygon. Include interior edge midpoints.
    mid_a = [((p[0] + q[0]) / 2, (p[1] + q[1]) / 2) for p, q in pairwise(a + a[:1])]
    mid_b = [((p[0] + q[0]) / 2, (p[1] + q[1]) / 2) for p, q in pairwise(b + b[:1])]
    return (
        any(_inside(p, b, boundary=False) for p in a + mid_a)
        or any(_inside(p, a, boundary=False) for p in b + mid_b)
        or any(_proper_cross(*e, *f) for e in pairwise(a + a[:1]) for f in pairwise(b + b[:1]))
        or all(_inside(p, b) for p in a)
    )


def _region_areas(profile):
    section = profile["section"]
    origin = point3(section["origin"])
    normal = section["normal"]
    lumen = _project_ring(section, origin, normal)
    if not _inside((0.0, 0.0), lumen):
        raise ValueError("Profile path station must lie inside its lumen contour")
    outer = profile.get("outer_wall")
    areas: dict[str, float | None] = {
        "outer_area_mm2": None,
        "thrombus_area_mm2": None,
        "calcification_area_mm2": None,
    }
    if outer is None:
        if any(profile.get(key) for key in ("thrombus", "calcification")):
            raise ValueError("Tissue annotations require an outer-wall contour")
        for key in ("thrombus", "calcification"):
            if profile.get(key) == []:
                areas[key + "_area_mm2"] = 0.0
        return areas
    areas["outer_area_mm2"] = section_metrics(**outer)["area_mm2"]
    shell = _project_ring(outer, origin, normal)

    def contained(ring):
        return all(_inside(p, shell) for p in ring) and not any(
            _proper_cross(*e, *f)
            for e in pairwise(ring + ring[:1])
            for f in pairwise(shell + shell[:1])
        )

    if not contained(lumen):
        raise ValueError("Lumen must lie within the outer wall")
    occupied = [lumen]
    for key in ("thrombus", "calcification"):
        regions = profile.get(key)
        if regions is None:
            continue
        if len(regions) > 8:
            raise ValueError("At most eight regions per tissue class")
        total = 0.0
        for region in regions:
            area = section_metrics(**region)["area_mm2"]
            ring = _project_ring(region, origin, normal)
            if not contained(ring) or any(_overlap(ring, existing) for existing in occupied):
                raise ValueError("Tissue regions must be inside the wall and nonoverlapping")
            occupied.append(ring)
            total += area
        areas[key + "_area_mm2"] = total
    return areas


def profile_metrics(path, profiles):
    distances = path_distances(path)
    if not isinstance(profiles, list) or not 1 <= len(profiles) <= 32:
        raise ValueError("Supply one to 32 profiles")
    seen = set()
    result = []
    for profile in profiles:
        index = profile["station"]
        if type(index) is not int or not 0 <= index < len(path) or index in seen:
            raise ValueError("Profile stations must be unique path indices")
        seen.add(index)
        section = profile["section"]
        origin = point3(section["origin"])
        if math.dist(origin, point3(path[index])) > PLANE_TOLERANCE_MM:
            raise ValueError("Profile plane origin must match its path station")
        tangent = subtract(path[min(index + 1, len(path) - 1)], path[max(0, index - 1)])
        if abs(dot(unit(tangent), unit(section["normal"]))) < 1 - 1e-4:
            raise ValueError("Profile plane must be perpendicular to the local path")
        metrics = section_metrics(**section)
        areas = _region_areas(profile)
        result.append(
            {
                "station": index,
                "distance_mm": distances[index],
                **metrics,
                **areas,
            }
        )
    return sorted(result, key=lambda row: row["station"])
