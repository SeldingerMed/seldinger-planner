"""Known-value checks for the stdlib C-arm geometry against independent vectors."""

import json
import math
from pathlib import Path

import pytest

from planner.carm_geometry import (
    CONVENTION,
    angle_label,
    camera,
    foreshortening_fraction,
    project,
    summarize_view,
    validate_view,
    view_frame,
)

VECTORS = json.loads(
    (
        Path(__file__).resolve().parents[1]
        / "web"
        / "src"
        / "__fixtures__"
        / "carm-geometry-vectors.json"
    ).read_text()
)
VIEW = {
    "primary_deg": 0.0,
    "secondary_deg": 0.0,
    "source_detector_mm": 1200.0,
    "source_isocenter_mm": 750.0,
    "detector_width_mm": 200.0,
    "detector_height_mm": 200.0,
}


def close(actual, expected, tolerance=1e-9):
    return all(
        math.isclose(a, e, rel_tol=tolerance, abs_tol=tolerance)
        for a, e in zip(actual, expected, strict=True)
    )


def test_fixture_convention_is_the_implemented_convention():
    assert VECTORS["convention"] == CONVENTION and len(VECTORS["cases"]) >= 8


@pytest.mark.parametrize("case", VECTORS["cases"], ids=lambda case: case["name"])
def test_matches_independent_vectors(case):
    u, v, d = view_frame(case["view"]["primary_deg"], case["view"]["secondary_deg"])
    assert close(u, case["frame"]["u"]) and close(v, case["frame"]["v"])
    assert close(d, case["frame"]["d"])
    cam = camera(case["view"], case["isocenter"])
    assert close(cam["source"], case["source"])
    for point, expected in zip(case["path"], case["projected"], strict=True):
        assert close(project(cam, point), expected, 1e-8)
    summary = summarize_view(case["view"], case["isocenter"], case["path"])
    assert math.isclose(
        summary["foreshortening_percent"], case["foreshortening_percent"], abs_tol=1e-8
    )
    assert summary["magnification_at_isocenter"] == case["magnification_at_isocenter"]
    assert summary["target_in_field"] is case["target_in_field"]


def test_hand_computed_anchor_values():
    # AP: a point 10 mm to the patient's left of the isocenter lands on image
    # right, magnified by SID/SOD = 1.6. A point 10 mm anterior stays central
    # and is magnified by 1200/760.
    cam = camera(VIEW, [0, 0, 0])
    assert close(project(cam, [-10, 0, 0]), (16.0, 0.0, 750.0))
    assert close(project(cam, [0, 0, 5]), (0.0, 8.0, 750.0))
    assert close(project(cam, [-10, 10, 0]), (10 * 1200 / 760, 0.0, 760.0))
    # A 3-4-5 segment viewed along its 4 mm component keeps 3/5 of its length.
    assert math.isclose(foreshortening_fraction([[0, 0, 0], [3, 4, 0]], (0, 1, 0)), 0.4)
    assert foreshortening_fraction([[0, 0, 0], [0, 7, 0]], (0, 1, 0)) == 1.0
    assert foreshortening_fraction([[0, 0, 0], [7, 0, 0], [7, 0, 2]], (0, 1, 0)) == 0.0


def test_angle_labels_name_the_declared_directions():
    assert angle_label(30, 20) == "LAO 30.0 / CRA 20.0"
    assert angle_label(-45.25, -10) == "RAO 45.2 / CAU 10.0"
    assert angle_label(0, 0) == "LAO/RAO 0.0 / CRA/CAU 0.0"


@pytest.mark.parametrize(
    "change",
    [
        {"primary_deg": 180.5},
        {"secondary_deg": -90.5},
        {"primary_deg": True},
        {"primary_deg": "30"},
        {"secondary_deg": math.nan},
        {"source_detector_mm": 299},
        {"source_detector_mm": math.inf},
        {"source_isocenter_mm": 1200},
        {"source_isocenter_mm": 1199.5},
        {"source_isocenter_mm": 50},
        {"detector_width_mm": 0},
        {"detector_height_mm": 601},
    ],
)
def test_rejects_unbounded_or_contradictory_views(change):
    with pytest.raises(ValueError):
        validate_view({**VIEW, **change})


def test_rejects_missing_fields_and_points_behind_the_source():
    with pytest.raises(ValueError):
        validate_view({k: v for k, v in VIEW.items() if k != "detector_width_mm"})
    cam = camera(VIEW, [0, 0, 0])
    with pytest.raises(ValueError):
        project(cam, [0, -750, 0])
    with pytest.raises(ValueError):
        project(cam, [0, -900, 0])
    with pytest.raises(ValueError):
        summarize_view(VIEW, [0, 0, 0], [[0, -800, 0], [0, 0, 0]])
