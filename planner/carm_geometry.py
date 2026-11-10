"""Pinhole C-arm geometry in patient RAS millimeters. Stdlib only.

Angle convention (declared, not verified against any vendor system): the DICOM
XA patient-referenced positioner angles are read as longitude and latitude of
the detector about the isocenter. Primary is positive toward the patient's
left (LAO), secondary is positive toward the head (cranial), and at 0/0 the
detector is anterior to the patient. The image frame is right-handed: image
right (u) is the patient's left at 0/0, image up (v) is cranial, and u x v
points from the isocenter to the detector (d).

Foreshortening uses the central-ray direction for every segment. It is a
parallel-projection approximation that ignores perspective variation across
the field of view.
"""

import math
from itertools import pairwise

from planner.territory_geometry import dot, path_distances, point3, subtract

CONVENTION = "dicom_xa_patient_longitude_latitude_ras_v1"
FORESHORTENING_METHOD = "central_ray_parallel_approximation"
PRIMARY_LIMIT_DEG = 180.0
SECONDARY_LIMIT_DEG = 90.0
MIN_SOURCE_DETECTOR_MM = 300.0
MAX_SOURCE_DETECTOR_MM = 2000.0
MIN_SOURCE_ISOCENTER_MM = 100.0
MIN_DETECTOR_MM = 50.0
MAX_DETECTOR_MM = 600.0
MIN_DEPTH_MM = 1.0
VIEW_NUMBERS = (
    "primary_deg",
    "secondary_deg",
    "source_detector_mm",
    "source_isocenter_mm",
    "detector_width_mm",
    "detector_height_mm",
)


def _number(value, low, high, label):
    if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError("Invalid " + label)
    return float(value)


def view_frame(primary_deg, secondary_deg):
    """Return the image-right, image-up and isocenter-to-detector unit vectors."""
    a = math.radians(_number(primary_deg, -PRIMARY_LIMIT_DEG, PRIMARY_LIMIT_DEG, "primary angle"))
    b = math.radians(
        _number(secondary_deg, -SECONDARY_LIMIT_DEG, SECONDARY_LIMIT_DEG, "secondary angle")
    )
    sa, ca, sb, cb = math.sin(a), math.cos(a), math.sin(b), math.cos(b)
    return (-ca, -sa, 0.0), (sa * sb, -ca * sb, cb), (-sa * cb, ca * cb, sb)


def validate_view(view):
    """Bounded scalar C-arm geometry. Names are validated by the caller."""
    if not isinstance(view, dict) or any(key not in view for key in VIEW_NUMBERS):
        raise ValueError("Invalid C-arm view")
    result = {
        "primary_deg": _number(
            view["primary_deg"], -PRIMARY_LIMIT_DEG, PRIMARY_LIMIT_DEG, "primary angle"
        ),
        "secondary_deg": _number(
            view["secondary_deg"], -SECONDARY_LIMIT_DEG, SECONDARY_LIMIT_DEG, "secondary angle"
        ),
        "source_detector_mm": _number(
            view["source_detector_mm"],
            MIN_SOURCE_DETECTOR_MM,
            MAX_SOURCE_DETECTOR_MM,
            "source-to-detector distance",
        ),
        "source_isocenter_mm": _number(
            view["source_isocenter_mm"],
            MIN_SOURCE_ISOCENTER_MM,
            MAX_SOURCE_DETECTOR_MM,
            "source-to-isocenter distance",
        ),
        "detector_width_mm": _number(
            view["detector_width_mm"], MIN_DETECTOR_MM, MAX_DETECTOR_MM, "detector width"
        ),
        "detector_height_mm": _number(
            view["detector_height_mm"], MIN_DETECTOR_MM, MAX_DETECTOR_MM, "detector height"
        ),
    }
    if result["source_detector_mm"] - result["source_isocenter_mm"] < MIN_DEPTH_MM:
        raise ValueError("The isocenter must lie between the source and the detector")
    return result


def camera(view, isocenter):
    view = validate_view(view)
    iso = point3(isocenter)
    u, v, d = view_frame(view["primary_deg"], view["secondary_deg"])
    sod = view["source_isocenter_mm"]
    return {
        "u": u,
        "v": v,
        "d": d,
        "source": tuple(iso[i] - d[i] * sod for i in range(3)),
        "source_detector_mm": view["source_detector_mm"],
        "half_width_mm": view["detector_width_mm"] / 2,
        "half_height_mm": view["detector_height_mm"] / 2,
    }


def project(cam, point):
    """Detector-plane millimeters (right, up) from the central ray, plus depth."""
    relative = subtract(point3(point), cam["source"])
    depth = dot(relative, cam["d"])
    if not math.isfinite(depth) or depth < MIN_DEPTH_MM:
        raise ValueError("Point is not in front of the X-ray source")
    scale = cam["source_detector_mm"] / depth
    x, y = dot(relative, cam["u"]) * scale, dot(relative, cam["v"]) * scale
    if not math.isfinite(x) or not math.isfinite(y):
        raise ValueError("Projection is not finite")
    return x, y, depth


def foreshortening_fraction(path, direction):
    """One minus the projected-to-true length ratio along a unit view direction."""
    total = path_distances(path)[-1]
    points = [point3(p) for p in path]
    visible = []
    for a, b in pairwise(points):
        segment = subtract(b, a)
        along = dot(segment, direction)
        visible.append(math.sqrt(max(0.0, dot(segment, segment) - along * along)))
    return min(1.0, max(0.0, 1.0 - math.fsum(visible) / total))


def angle_label(primary_deg, secondary_deg):
    """Operator-facing angle naming, for example ``LAO 30.0 / CRA 20.0``."""

    def part(value, positive, negative):
        if abs(value) < 0.05:
            return f"{positive}/{negative} 0.0"
        return f"{positive if value > 0 else negative} {abs(value):.1f}"

    return f"{part(primary_deg, 'LAO', 'RAO')} / {part(secondary_deg, 'CRA', 'CAU')}"


def summarize_view(view, isocenter, path):
    """Scalar summary of one view of a target path. Raises on unprojectable input."""
    numbers = validate_view(view)
    cam = camera(numbers, isocenter)
    projected = [project(cam, p) for p in path]
    return {
        **numbers,
        "foreshortening_percent": 100.0 * foreshortening_fraction(path, cam["d"]),
        "magnification_at_isocenter": numbers["source_detector_mm"]
        / numbers["source_isocenter_mm"],
        "target_in_field": all(
            abs(x) <= cam["half_width_mm"] and abs(y) <= cam["half_height_mm"]
            for x, y, _ in projected
        ),
    }
