import pytest
from pydantic import ValidationError

from planner.territory_workflows import compute_workflow, validate_inputs


def test_true_oblique_rigid_transform_preserves_tavr_dimensions_and_signed_heights():
    import copy

    from planner.territory_workflows import compute_workflow

    inputs = tavr_inputs()
    transformed = copy.deepcopy(inputs)
    rotation = [[2 / 3, -1 / 3, 2 / 3], [2 / 3, 2 / 3, -1 / 3], [-1 / 3, 2 / 3, 2 / 3]]

    def rotate(p, translate=True):
        return [
            sum(rotation[i][j] * p[j] for j in range(3)) + ([-10, 20, -30][i] if translate else 0)
            for i in range(3)
        ]

    section = transformed["annulus"]
    section["origin"] = rotate(section["origin"])
    section["normal"] = rotate(section["normal"], False)
    section["contour"] = [rotate(p) for p in section["contour"]]
    for key in ("left_ostium", "right_ostium"):
        transformed[key] = rotate(transformed[key])
    expected = compute_workflow("tavr", inputs)
    actual = compute_workflow("tavr", transformed)
    for key, value in expected.items():
        if isinstance(value, (int, float)):
            assert actual[key] == pytest.approx(value, abs=1e-9)
        else:
            assert actual[key] == value


def test_geometry_and_http_share_the_same_contour_bound():
    from planner.territory_geometry import MAX_CONTOUR_POINTS
    from planner.territory_workflows import Section

    assert MAX_CONTOUR_POINTS == 128
    assert Section.model_json_schema()["properties"]["contour"]["maxItems"] == MAX_CONTOUR_POINTS


def tavr_inputs():
    return {
        "annulus": {
            "origin": [5, 5, 10],
            "normal": [0, 0, 2],
            "contour": [[4, 4, 10], [7, 4, 10], [7, 6, 10], [4, 6, 10]],
        },
        "left_ostium": [5, 5, 15],
        "right_ostium": [5, 5, 8],
    }


def test_tavr_uses_traced_ring_and_keeps_signed_ostial_heights():
    data = validate_inputs("tavr", tavr_inputs())
    result = compute_workflow("tavr", data)
    assert result["area_mm2"] == pytest.approx(3 * 2)
    assert result["left_coronary_height_mm"] == pytest.approx(5)
    assert result["right_coronary_height_mm"] == pytest.approx(-2)
    assert result["annotation_source"] == "operator_traced"


def test_tavr_schema_rejects_nonfinite_boolean_and_unknown_fields():
    for bad in [True, float("nan"), float("inf"), "5"]:
        value = tavr_inputs()
        value["left_ostium"][0] = bad
        with pytest.raises(ValidationError):
            validate_inputs("tavr", value)
    value = tavr_inputs()
    value["model_path"] = "/not/accepted"
    with pytest.raises(ValidationError):
        validate_inputs("tavr", value)
