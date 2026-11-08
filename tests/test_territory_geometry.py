"""Known-value physical geometry for the territory workspace."""

import math

import pytest

from planner.territory_geometry import section_metrics


def test_self_crossing_annular_trace_with_nonzero_shoelace_area_is_rejected():
    # A pentagram has nonzero shoelace area but is not a simple annular ring.
    outer = [[math.cos(2 * math.pi * i / 5), math.sin(2 * math.pi * i / 5), 0] for i in range(5)]
    star = [outer[i] for i in [0, 2, 4, 1, 3]]
    with pytest.raises(ValueError, match="self-intersect"):
        section_metrics([0, 0, 0], [0, 0, 1], star)


def test_feret_and_path_geometry_have_known_values():
    from planner.territory_geometry import angle_degrees, path_distances

    result = section_metrics([0, 0, 0], [0, 0, 1], [[-2, -1, 0], [2, -1, 0], [2, 1, 0], [-2, 1, 0]])
    assert result["min_diameter_mm"] == pytest.approx(2)
    assert result["max_diameter_mm"] == pytest.approx(math.hypot(4, 2))
    assert path_distances([[0, 0, 0], [3, 0, 0], [3, 4, 0]]) == pytest.approx([0, 3, 7])
    assert angle_degrees([1, 0, 0], [0, 1, 0]) == pytest.approx(90)
    with pytest.raises(ValueError):
        path_distances([[0, 0, 0], [0, 0, 0]])


def test_profile_sections_are_bound_to_path_tangent_and_explicit_missing_regions():
    from planner.territory_geometry import profile_metrics

    section = {
        "origin": [0, 0, 0],
        "normal": [0, 0, 1],
        "contour": [[-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0]],
    }
    profile = {
        "station": 0,
        "section": section,
        "outer_wall": None,
        "thrombus": None,
        "calcification": None,
    }
    row = profile_metrics([[0, 0, 0], [0, 0, 5]], [profile])[0]
    assert row["area_mm2"] == pytest.approx(4)
    assert row["thrombus_area_mm2"] is None and row["outer_area_mm2"] is None
    profile["section"] = {**section, "origin": [0, 0, 1]}
    with pytest.raises(ValueError):
        profile_metrics([[0, 0, 0], [0, 0, 5]], [profile])


def test_profile_regions_validate_containment_and_preserve_explicit_zero():
    from copy import deepcopy

    from planner.territory_geometry import profile_metrics

    def ring(x0, x1, y0, y1):
        return {
            "origin": [0, 0, 0],
            "normal": [0, 0, 1],
            "contour": [[x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0]],
        }

    profile = {
        "station": 0,
        "section": ring(-1, 1, -1, 1),
        "outer_wall": ring(-3, 3, -3, 3),
        "thrombus": [ring(2, 3, -0.5, 0.5)],
        "calcification": [],
    }
    row = profile_metrics([[0, 0, 0], [0, 0, 5]], [profile])[0]
    assert row["outer_area_mm2"] == pytest.approx(6 * 6)
    assert row["thrombus_area_mm2"] == pytest.approx(1)
    assert row["calcification_area_mm2"] == 0
    for bad in [ring(-0.5, 0.5, -0.5, 0.5), ring(3, 4, -0.5, 0.5)]:
        changed = deepcopy(profile)
        changed["thrombus"] = [bad]
        with pytest.raises(ValueError):
            profile_metrics([[0, 0, 0], [0, 0, 5]], [changed])


def test_collinear_edge_tissue_overlap_is_not_misclassified_as_boundary_touch():
    from planner.territory_geometry import profile_metrics

    def ring(x0, x1):
        return {
            "origin": [0, 0, 0],
            "normal": [0, 0, 1],
            "contour": [[x0, -1, 0], [x1, -1, 0], [x1, 1, 0], [x0, 1, 0]],
        }

    profile = {
        "station": 0,
        "section": ring(-1, 1),
        "outer_wall": {
            "origin": [0, 0, 0],
            "normal": [0, 0, 1],
            "contour": [[-3, -3, 0], [3, -3, 0], [3, 3, 0], [-3, 3, 0]],
        },
        "thrombus": [ring(0, 2)],
        "calcification": None,
    }
    with pytest.raises(ValueError, match="nonoverlapping"):
        profile_metrics([[0, 0, 0], [0, 0, 5]], [profile])


def test_annular_contour_reports_physical_area_perimeter_and_effective_diameters():
    width, height, z = 4.0, 2.0, 2.0
    result = section_metrics(
        [0, 0, z],
        [0, 0, 1],
        [[0, 0, z], [width, 0, z], [width, height, z], [0, height, z]],
    )
    area = width * height
    perimeter = 2 * (width + height)
    assert result["area_mm2"] == pytest.approx(area)
    assert result["perimeter_mm"] == pytest.approx(perimeter)
    assert result["area_derived_diameter_mm"] == pytest.approx(math.sqrt(4 * area / math.pi))
    assert result["perimeter_derived_diameter_mm"] == pytest.approx(perimeter / math.pi)
