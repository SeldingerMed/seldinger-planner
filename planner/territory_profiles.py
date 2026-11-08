"""Pure composition of territory measurements from validated input dictionaries.

Contract (phase3): `compute_coronary(inputs)` and `compute_aortic(inputs)` accept
already shape-validated dictionaries and enforce cross-field geometry/index
relationships themselves. No heuristic flags, no device oversizing ranges.

Kernel helpers from planner.territory_geometry (parent-owned): path_distances,
angle_degrees, profile_metrics, section_metrics, point3.
"""

from .territory_geometry import (
    angle_degrees,
    path_distances,
    profile_metrics,
)

MAX_PATH_VERTICES = 128
MAX_PROFILES = 32


def _require_index(value, name):
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError(f"{name} must be an integer index")
    return value


def _ordering_and_range(profiles, path_length):
    """Child-enforced ordering/index checks on the supplied profile list."""
    if not isinstance(profiles, (list, tuple)) or len(profiles) > MAX_PROFILES:
        raise ValueError("profiles must be a list of at most 32 entries")
    last_station = -1
    for prof in profiles:
        station = _require_index(prof.get("station"), "profile station")
        if not 0 <= station < path_length:
            raise ValueError("profile station out of path range")
        if station <= last_station:
            raise ValueError("profile stations must be strictly increasing")
        last_station = station


def _lumen_rows(path, profiles):
    """Use the shared full-profile guard chain, including tissue topology."""
    return profile_metrics(path, profiles)


def _trapezoid_volume(stations, values):
    """Trapezoid integration of values over station arclength spacing."""
    total = 0.0
    for i in range(1, len(stations)):
        total += 0.5 * (values[i - 1] + values[i]) * (stations[i] - stations[i - 1])
    return total


def compute_coronary(inputs):
    """Coronary composition per contract: lesion/reference metrics and rows."""
    path = inputs["path"]
    lesion_start = _require_index(inputs["lesion_start"], "lesion_start")
    lesion_end = _require_index(inputs["lesion_end"], "lesion_end")
    proximal_reference = _require_index(inputs["proximal_reference"], "proximal_reference")
    distal_reference = _require_index(inputs["distal_reference"], "distal_reference")
    profiles = inputs.get("profiles", [])
    bifurcation = inputs.get("bifurcation")

    if len(path) > MAX_PATH_VERTICES or len(path) < 2:
        raise ValueError("path must contain between 2 and 128 points")
    if not (0 <= proximal_reference <= lesion_start < lesion_end <= distal_reference < len(path)):
        raise ValueError(
            "require proximal_reference <= lesion_start < lesion_end <= distal_reference"
            " within path range"
        )
    if proximal_reference == distal_reference:
        raise ValueError("reference stations must be distinct")

    _ordering_and_range(profiles, len(path))
    rows = _lumen_rows(path, profiles)
    stations = {row["station"] for row in rows}
    for required in (proximal_reference, distal_reference):
        if required not in stations:
            raise ValueError(f"reference profile at station {required} is required")
    lesion_rows = [r for r in rows if lesion_start <= r["station"] <= lesion_end]
    if not lesion_rows:
        raise ValueError("at least one lesion profile is required")

    proximal_diameter = next(
        r["area_derived_diameter_mm"] for r in rows if r["station"] == proximal_reference
    )
    distal_diameter = next(
        r["area_derived_diameter_mm"] for r in rows if r["station"] == distal_reference
    )
    distances = path_distances(path)
    reference_length = distances[distal_reference] - distances[proximal_reference]
    taper = (distal_diameter - proximal_diameter) / reference_length

    minimum_row = min(lesion_rows, key=lambda r: r["area_derived_diameter_mm"])
    minimum_station = minimum_row["station"]
    fraction = (distances[minimum_station] - distances[proximal_reference]) / reference_length
    interpolated = proximal_diameter + (distal_diameter - proximal_diameter) * fraction
    narrowing_pct = 100.0 * (interpolated - minimum_row["area_derived_diameter_mm"]) / interpolated

    if bifurcation is None:
        bifurcation_angle = None
    else:
        carina = bifurcation["carina"]
        daughter_a = bifurcation["daughter_a"]
        daughter_b = bifurcation["daughter_b"]
        bifurcation_angle = angle_degrees(
            [daughter_a[k] - carina[k] for k in range(3)],
            [daughter_b[k] - carina[k] for k in range(3)],
        )

    return {
        "lesion_length_mm": distances[lesion_end] - distances[lesion_start],
        "diameter_basis": "area_equivalent",
        "proximal_reference_diameter_mm": proximal_diameter,
        "distal_reference_diameter_mm": distal_diameter,
        "reference_taper_mm_per_mm": taper,
        "sampled_minimum_diameter_mm": minimum_row["area_derived_diameter_mm"],
        "minimum_station": minimum_station,
        "diameter_narrowing_pct": narrowing_pct,
        "bifurcation_angle_deg": bifurcation_angle,
        "profiles": rows,
    }


def compute_aortic(inputs):
    """Aortic/peripheral composition per contract: neck, burdens, access routes."""
    path = inputs["path"]
    suprarenal_index = _require_index(inputs["suprarenal_index"], "suprarenal_index")
    neck_start = _require_index(inputs["neck_start"], "neck_start")
    neck_end = _require_index(inputs["neck_end"], "neck_end")
    sac_index = _require_index(inputs["sac_index"], "sac_index")
    profiles = inputs.get("profiles", [])
    left_access = inputs.get("left_access")
    right_access = inputs.get("right_access")

    if len(path) > MAX_PATH_VERTICES or len(path) < 2:
        raise ValueError("path must contain between 2 and 128 points")
    if not (0 <= suprarenal_index < neck_start < neck_end < sac_index < len(path)):
        raise ValueError(
            "require 0 <= suprarenal_index < neck_start < neck_end < sac_index < len(path)"
        )

    _ordering_and_range(profiles, len(path))
    rows = _lumen_rows(path, profiles)
    stations = {row["station"] for row in rows}
    for required in (neck_start, neck_end):
        if required not in stations:
            raise ValueError(f"neck profile at station {required} is required")

    distances = path_distances(path)

    def axis(a, b):
        return [path[b][k] - path[a][k] for k in range(3)]

    neck_axis = axis(neck_start, neck_end)
    alpha = angle_degrees(axis(suprarenal_index, neck_start), neck_axis)
    beta = angle_degrees(neck_axis, axis(neck_end, sac_index))

    neck_rows = [r for r in rows if neck_start <= r["station"] <= neck_end]
    neck_rows.sort(key=lambda r: r["station"])
    neck_distances = [distances[r["station"]] for r in neck_rows]

    def burden(class_key):
        class_areas = [r[class_key] for r in neck_rows]
        outer_areas = [r["outer_area_mm2"] for r in neck_rows]
        if any(a is None for a in class_areas) or any(a is None for a in outer_areas):
            return None
        outer_volume = _trapezoid_volume(neck_distances, outer_areas)
        if outer_volume <= 0.0:
            return None
        class_volume = _trapezoid_volume(neck_distances, class_areas)
        if class_volume < 0.0:
            raise ValueError("class areas must be non-negative")
        return 100.0 * class_volume / outer_volume

    min_row = min(neck_rows, key=lambda r: r["min_diameter_mm"])
    max_row = max(neck_rows, key=lambda r: r["max_diameter_mm"])

    def access_result(access):
        if access is None:
            return None
        access_path = access["path"]
        if len(access_path) > MAX_PATH_VERTICES or len(access_path) < 2:
            raise ValueError("access path must contain between 2 and 128 points")
        access_profiles = access.get("profiles", [])
        _ordering_and_range(access_profiles, len(access_path))
        access_rows = _lumen_rows(access_path, access_profiles)
        end_station = len(access_path) - 1
        access_stations = {r["station"] for r in access_rows}
        if 0 in access_stations and end_station in access_stations:
            minimum_row = min(access_rows, key=lambda r: r["min_diameter_mm"])
            minimum = minimum_row["min_diameter_mm"]
            minimum_station = minimum_row["station"]
        else:
            minimum = None
            minimum_station = None
        return {
            "profiles": access_rows,
            "sampled_minimum_diameter_mm": minimum,
            "minimum_station": minimum_station,
            "length_mm": path_distances(access_path)[-1],
        }

    return {
        "neck_length_mm": distances[neck_end] - distances[neck_start],
        "alpha_deg": alpha,
        "beta_deg": beta,
        "profiles": rows,
        "thrombus_burden_pct": burden("thrombus_area_mm2"),
        "calcification_burden_pct": burden("calcification_area_mm2"),
        "sampled_minimum_diameter_mm": min_row["min_diameter_mm"],
        "minimum_station": min_row["station"],
        "sampled_maximum_diameter_mm": max_row["max_diameter_mm"],
        "maximum_station": max_row["station"],
        "left_access": access_result(left_access),
        "right_access": access_result(right_access),
    }
