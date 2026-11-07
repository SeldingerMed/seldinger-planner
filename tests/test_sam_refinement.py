import pytest

from planner.sam_refinement import PromptError, normalize_prompts


def test_points_and_box_are_validated_in_native_image_pixels():
    result = normalize_prompts(100, 80, [(20, 30), (0, 0)], [1, 0], [10, 15, 40, 50])
    assert result == {
        "points": [[20.0, 30.0], [0.0, 0.0]],
        "labels": [1, 0],
        "box": [10.0, 15.0, 40.0, 50.0],
    }


def test_box_only_is_an_explicit_supported_prompt():
    assert normalize_prompts(100, 80, [], [], [10, 15, 40, 50])["points"] == []


@pytest.mark.parametrize(
    "points,labels,box",
    [
        ([(100, 10)], [1], None),
        ([(float("nan"), 10)], [1], None),
        ([(10, 10)], [], None),
        ([(10, 10)], [True], None),
        ([(10, 10)], [2], None),
        ([(10, 10)], [0], None),
        ([], [], None),
        ([], [], [40, 15, 10, 50]),
        ([], [], [10, 15, 100, 50]),
    ],
)
def test_invalid_or_unseeded_prompts_are_rejected(points, labels, box):
    with pytest.raises(PromptError):
        normalize_prompts(100, 80, points, labels, box)
