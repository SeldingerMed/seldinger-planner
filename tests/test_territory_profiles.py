"""Strict-TDD tests for planner.territory_profiles coronary/aortic composition.

Uses real planar polygon rings and the actual geometry helpers; no mocked
metric dictionaries. Expected values are analytic for circular contours.
"""

import math
from itertools import pairwise

import pytest

from planner.territory_geometry import section_metrics
from planner.territory_profiles import compute_aortic, compute_coronary

NORMAL_X = [1.0, 0.0, 0.0]


def circle_contour(center_x, center_y, radius, segments=48):
    return [
        [
            center_x,
            center_y + radius * math.cos(2 * math.pi * k / segments),
            radius * math.sin(2 * math.pi * k / segments),
        ]
        for k in range(segments)
    ]


def section_at(station_x, radius):
    return {
        "origin": [station_x, 0.0, 0.0],
        "normal": list(NORMAL_X),
        "contour": circle_contour(station_x, 0.0, radius),
    }


def profile_at(
    station_x,
    radius,
    station=None,
    outer_radius=None,
    thrombus_radius=None,
    calcification_radius=None,
):
    prof = {
        "station": station,
        "section": section_at(station_x, radius),
        "outer_wall": None,
        "thrombus": None,
        "calcification": None,
    }
    if outer_radius is not None:
        prof["outer_wall"] = section_at(station_x, outer_radius)
    if thrombus_radius is not None:
        prof["thrombus"] = [section_at(station_x, thrombus_radius)]
    if calcification_radius is not None:
        prof["calcification"] = [section_at(station_x, calcification_radius)]
    return prof


def straight_path(length, step=10.0):
    count = round(length / step) + 1
    return [[float(i * step), 0.0, 0.0] for i in range(count)]


def area_diameter(radius):
    return section_metrics([0.0, 0.0, 0.0], NORMAL_X, circle_contour(0.0, 0.0, radius))[
        "area_derived_diameter_mm"
    ]


def coronary_inputs(bifurcation=None):
    profiles = [
        profile_at(20.0, 5.0, station=2),
        profile_at(30.0, 4.0, station=3),
        profile_at(80.0, 4.0, station=8),
    ]
    for index, x in zip(range(4, 8), (40.0, 50.0, 60.0, 70.0)):
        profiles.insert(len(profiles) - 1, profile_at(x, 2.0, station=index))
    return {
        "path": straight_path(100.0),
        "lesion_start": 4,
        "lesion_end": 8,
        "proximal_reference": 2,
        "distal_reference": 8,
        "profiles": profiles,
        "bifurcation": bifurcation,
    }


def aortic_inputs(left_access=None, right_access=None):
    profiles = []
    for i in range(3, 8):
        radius = 5.0 if i not in (4, 5) else 6.0
        profile = profile_at(float(i * 10), radius, station=i, outer_radius=radius + 2)
        for key, sign in (("thrombus", 1), ("calcification", -1)):
            profile[key] = [
                {
                    "origin": [float(i * 10), 0, 0],
                    "normal": list(NORMAL_X),
                    "contour": circle_contour(float(i * 10), sign * (radius + 1), 0.25),
                }
            ]
        profiles.append(profile)
    return {
        "path": straight_path(100.0),
        "suprarenal_index": 2,
        "neck_start": 3,
        "neck_end": 7,
        "sac_index": 9,
        "profiles": profiles,
        "left_access": left_access,
        "right_access": right_access,
    }


def access_payload(step=10.0, count=6, radius=3.0):
    return {
        "path": [[float(i * step), 0.0, 0.0] for i in range(count)],
        "profiles": [
            dict(profile_at(0.0, radius), station=0),
            dict(profile_at((count - 1) * step, radius), station=count - 1),
        ],
    }


def test_composition_cannot_strip_invalid_overlapping_tissue_annotations():
    inputs = aortic_inputs()
    inputs["profiles"][0]["thrombus"] = [inputs["profiles"][0]["section"]]
    with pytest.raises(ValueError, match="nonoverlapping"):
        compute_aortic(inputs)


def test_identical_nonround_profiles_have_zero_diameter_narrowing():
    inputs = coronary_inputs()
    for profile in inputs["profiles"]:
        x = profile["section"]["origin"][0]
        profile["section"]["contour"] = [[x, -2, -1], [x, 2, -1], [x, 2, 1], [x, -2, 1]]
    result = compute_coronary(inputs)
    assert result["diameter_narrowing_pct"] == pytest.approx(0)
    assert result["diameter_basis"] == "area_equivalent"


def test_aortic_angles_use_the_three_declared_axis_segments():
    from planner.territory_geometry import plane_basis

    path = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [10, 10, 10]]
    profiles = []
    for station, normal in ((1, [10, 10, 0]), (2, [0, 10, 10])):
        _, u, v = plane_basis(normal)
        origin = path[station]
        contour = [
            [origin[k] + a * u[k] + b * v[k] for k in range(3)]
            for a, b in ((-1, -1), (1, -1), (1, 1), (-1, 1))
        ]
        profiles.append(
            {
                "station": station,
                "section": {"origin": origin, "normal": normal, "contour": contour},
            }
        )
    result = compute_aortic(
        {
            "path": path,
            "profiles": profiles,
            "suprarenal_index": 0,
            "neck_start": 1,
            "neck_end": 2,
            "sac_index": 3,
        }
    )
    assert result["alpha_deg"] == pytest.approx(90)
    assert result["beta_deg"] == pytest.approx(90)


class TestCoronary:
    def test_valid_composition(self):
        result = compute_coronary(coronary_inputs())
        assert result["lesion_length_mm"] == pytest.approx(40.0)
        prox = area_diameter(5.0)
        distal = area_diameter(4.0)
        assert result["proximal_reference_diameter_mm"] == pytest.approx(prox)
        assert result["distal_reference_diameter_mm"] == pytest.approx(distal)
        assert result["reference_taper_mm_per_mm"] == pytest.approx((distal - prox) / 60.0)
        assert result["sampled_minimum_diameter_mm"] == pytest.approx(area_diameter(2.0), rel=1e-2)
        assert result["minimum_station"] == 4
        fraction = 20.0 / 60.0
        interp = prox + (distal - prox) * fraction
        assert result["diameter_narrowing_pct"] == pytest.approx(
            100.0 * (interp - result["sampled_minimum_diameter_mm"]) / interp,
            rel=1e-2,
        )
        assert result["bifurcation_angle_deg"] is None
        stations = [row["station"] for row in result["profiles"]]
        assert stations == sorted(stations) and len(set(stations)) == len(stations)
        assert all("area_mm2" in row and "min_diameter_mm" in row for row in result["profiles"])

    def test_bifurcation_angle_between_outward_vectors(self):
        bifurcation = {
            "carina": [0.0, 0.0, 0.0],
            "daughter_a": [0.0, 1.0, 0.0],
            "daughter_b": [0.0, 0.0, 1.0],
        }
        result = compute_coronary(coronary_inputs(bifurcation))
        assert result["bifurcation_angle_deg"] == pytest.approx(90.0)

    def test_index_ordering_enforced(self):
        inputs = coronary_inputs()
        inputs["lesion_end"] = inputs["lesion_start"]  # violates start < end
        with pytest.raises(ValueError):
            compute_coronary(inputs)

    def test_reference_before_lesion_enforced(self):
        inputs = coronary_inputs()
        inputs["proximal_reference"] = 5  # lesion_start=4 < 5 violates <=
        with pytest.raises(ValueError):
            compute_coronary(inputs)

    def test_distinct_reference_stations_enforced(self):
        inputs = coronary_inputs()
        inputs["distal_reference"] = inputs["proximal_reference"]
        with pytest.raises(ValueError):
            compute_coronary(inputs)

    def test_missing_reference_profile_rejected(self):
        inputs = coronary_inputs()
        inputs["profiles"] = [p for p in inputs["profiles"] if p["station"] != 2]
        with pytest.raises(ValueError):
            compute_coronary(inputs)

    def test_missing_lesion_profile_rejected(self):
        inputs = coronary_inputs()
        inputs["lesion_start"] = 4
        inputs["lesion_end"] = 8
        inputs["profiles"] = [p for p in inputs["profiles"] if not 4 <= p["station"] <= 8]
        with pytest.raises(ValueError):
            compute_coronary(inputs)

    def test_profile_station_out_of_range_rejected(self):
        inputs = coronary_inputs()
        inputs["profiles"][0]["station"] = 99
        with pytest.raises(ValueError):
            compute_coronary(inputs)

    def test_profile_origin_mismatch_rejected(self):
        inputs = coronary_inputs()
        inputs["profiles"][0]["section"]["origin"][0] = 21.0
        with pytest.raises(ValueError):
            compute_coronary(inputs)

    def test_non_increasing_stations_rejected(self):
        inputs = coronary_inputs()
        inputs["profiles"][2]["station"] = inputs["profiles"][1]["station"]
        with pytest.raises(ValueError):
            compute_coronary(inputs)


class TestAortic:
    def test_valid_composition(self):
        result = compute_aortic(aortic_inputs())
        assert result["neck_length_mm"] == pytest.approx(40.0)
        assert result["alpha_deg"] == pytest.approx(0.0)
        assert result["beta_deg"] == pytest.approx(0.0)
        # Trapezoid over neck distance 0..40mm of class/outer area ratios.
        outer_radii = [7, 8, 8, 7, 7]
        denominator = sum(0.5 * (a * a + b * b) * 10 for a, b in pairwise(outer_radii))
        expected_thrombus = 100 * (0.25**2) * 40 / denominator
        assert result["thrombus_burden_pct"] == pytest.approx(expected_thrombus, rel=1e-3)
        assert result["sampled_minimum_diameter_mm"] == pytest.approx(area_diameter(5.0), rel=1e-2)
        assert result["minimum_station"] == 3
        assert result["sampled_maximum_diameter_mm"] == pytest.approx(area_diameter(6.0), rel=1e-2)
        assert result["maximum_station"] == 4
        assert result["left_access"] is None and result["right_access"] is None

    def test_index_chain_enforced(self):
        inputs = aortic_inputs()
        inputs["suprarenal_index"] = inputs["neck_start"]
        with pytest.raises(ValueError):
            compute_aortic(inputs)

        inputs = aortic_inputs()
        inputs["neck_end"] = inputs["sac_index"]
        with pytest.raises(ValueError):
            compute_aortic(inputs)

        inputs = aortic_inputs()
        inputs["neck_start"] = -1
        with pytest.raises(ValueError):
            compute_aortic(inputs)

    def test_neck_endpoints_required(self):
        inputs = aortic_inputs()
        inputs["profiles"] = [p for p in inputs["profiles"] if p["station"] != 3]
        with pytest.raises(ValueError):
            compute_aortic(inputs)

    def test_missing_class_at_any_station_gives_none_burden(self):
        inputs = aortic_inputs()
        for prof in inputs["profiles"]:
            if prof["station"] == 5:
                prof["thrombus"] = None  # unknown class, not observed zero
        result = compute_aortic(inputs)
        assert result["thrombus_burden_pct"] is None

    def test_missing_outer_wall_gives_none_burden(self):
        inputs = aortic_inputs()
        inputs["profiles"][0]["outer_wall"] = None
        inputs["profiles"][0]["thrombus"] = None
        inputs["profiles"][0]["calcification"] = None
        result = compute_aortic(inputs)
        assert result["calcification_burden_pct"] is None
        assert result["thrombus_burden_pct"] is None

    def test_explicit_empty_class_is_observed_zero(self):
        inputs = aortic_inputs()
        for prof in inputs["profiles"]:
            prof["calcification"] = []
        result = compute_aortic(inputs)
        assert result["calcification_burden_pct"] == pytest.approx(0.0)

    def test_access_minimum_requires_both_path_ends(self):
        covered = access_payload()
        result = compute_aortic(aortic_inputs(left_access=covered))
        assert result["left_access"]["sampled_minimum_diameter_mm"] == pytest.approx(
            area_diameter(3.0), rel=1e-2
        )
        assert result["left_access"]["minimum_station"] == 0
        assert result["left_access"]["length_mm"] == pytest.approx(50.0)

        uncovered = access_payload()
        uncovered["profiles"] = uncovered["profiles"][:1]  # missing far end
        result = compute_aortic(aortic_inputs(left_access=uncovered, right_access=access_payload()))
        assert result["left_access"]["sampled_minimum_diameter_mm"] is None
        assert result["left_access"]["minimum_station"] is None
        assert result["left_access"]["length_mm"] == pytest.approx(50.0)
        assert result["right_access"]["sampled_minimum_diameter_mm"] is not None
