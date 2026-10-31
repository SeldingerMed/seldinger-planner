"""Asymmetric/vertical-plane regressions, using analytic synthetic prisms."""

import math

import pytest

from planner.morphometry import MorphometryError, parent_section, section_metrics


def test_boolean_index_is_not_a_centerline_location():
    mesh = _prism([(-1, -1), (1, -1), (1, 1), (-1, 1)])
    with pytest.raises(MorphometryError, match="integer"):
        parent_section(mesh, [(0, 0, -1), (0, 0, 0), (0, 0, 1)], True)


def _prism(polygon, axis="z"):
    def point(x, y, z):
        return (z, x, y) if axis == "x" else (x, y, z)

    triangles = []
    for i, a in enumerate(polygon):
        b = polygon[(i + 1) % len(polygon)]
        low_a, low_b = point(*a, -1), point(*b, -1)
        high_a, high_b = point(*a, 1), point(*b, 1)
        triangles.extend([(low_a, low_b, high_b), (low_a, high_b, high_a)])
    return triangles


def test_vertical_section_uses_its_own_plane_for_the_convex_hull():
    triangles = _prism([(-2, -1), (2, -1), (2, 1), (-2, 1)], axis="x")
    result = section_metrics(triangles, (0, 0, 0), (1, 0, 0))
    assert result["area"] == pytest.approx(8)
    assert result["max_diameter"] == pytest.approx(math.sqrt(20))
    assert result["min_diameter"] == pytest.approx(2)


def test_minimum_feret_uses_edge_normal_not_edge_direction():
    result = section_metrics(_prism([(0, 0), (4, 0), (1, 1)]), (0, 0, 0), (0, 0, 1))
    assert result["area"] == pytest.approx(2)
    assert result["min_diameter"] == pytest.approx(1)
    assert result["max_diameter"] == pytest.approx(4)


def test_section_centroid_is_area_weighted_not_vertex_density_weighted():
    result = section_metrics(_prism([(0, 0), (4, 0), (1, 2), (0, 2)]), (0, 0, 0), (0, 0, 1))
    # Exact polygon moments: area=5; first moments about y/x are 7 and 4.
    assert result["centroid_world"] == pytest.approx((7 / 5, 4 / 5, 0))


def test_triangle_cap_stops_consuming_an_unbounded_iterator():
    triangle = ((0, 0, 0), (1, 0, 0), (0, 1, 0))

    def stream():
        for _ in range(50001):
            yield triangle
        raise AssertionError("Input iterator read beyond the triangle cap")

    with pytest.raises(MorphometryError, match="triangle count"):
        section_metrics(stream(), (0, 0, 0), (0, 0, 1))
