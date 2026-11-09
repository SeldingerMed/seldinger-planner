"""Known-value evaluation arithmetic, separate from actual-model evidence."""

import os

import pytest

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Requires isolated imaging runtime", allow_module_level=True)


def test_exact_overlap_and_physical_agreement():
    import numpy as np

    from planner.model_evaluation import evaluate_binary_masks

    prediction = np.zeros((3, 3, 3), dtype=np.uint8)
    reference = prediction.copy()
    reference[0, 0, 0] = reference[1, 0, 0] = 1
    prediction[1, 0, 0] = prediction[2, 0, 0] = 1
    affine = np.diag([2.0, 3.0, 4.0, 1.0])
    result = evaluate_binary_masks(prediction, reference, affine, spatial_units="mm")
    assert result["true_positive_voxels"] == 1
    assert result["false_positive_voxels"] == 1
    assert result["false_negative_voxels"] == 1
    assert result["true_negative_voxels"] == 24
    assert result["dice"] == 0.5
    assert result["intersection_over_union"] == pytest.approx(1 / 3)
    assert result["prediction_volume_mm3"] == pytest.approx(48)
    assert result["reference_volume_mm3"] == pytest.approx(48)
    assert result["centroid_distance_mm"] == 2


@pytest.mark.parametrize("predicted,referenced", [(0, 0), (1, 0), (0, 1)])
def test_empty_foreground_is_not_an_artificial_perfect_score(predicted, referenced):
    import numpy as np

    from planner.model_evaluation import evaluate_binary_masks

    prediction = np.zeros((2, 2, 2), dtype=np.uint8)
    reference = prediction.copy()
    prediction[0, 0, 0] = predicted
    reference[0, 0, 0] = referenced
    result = evaluate_binary_masks(prediction, reference, np.eye(4), spatial_units="mm")
    assert result["dice"] == (None if predicted + referenced == 0 else 0)
    assert result["intersection_over_union"] == (None if predicted + referenced == 0 else 0)
    assert result["centroid_distance_mm"] is None
    assert result["prediction_foreground_voxels"] == predicted
    assert result["reference_foreground_voxels"] == referenced


@pytest.mark.parametrize("bad", [2, 0.5, float("nan"), float("inf"), "1"])
def test_nonbinary_inputs_are_rejected_without_coercion(bad):
    import numpy as np

    from planner.model_evaluation import evaluate_binary_masks

    mask = np.full((2, 2, 2), bad)
    with pytest.raises(ValueError, match="binary"):
        evaluate_binary_masks(mask, np.ones((2, 2, 2)), np.eye(4), spatial_units="mm")


@pytest.mark.parametrize("shape", [(2, 2), (2, 2, 3), (0, 2, 2), (1, 1, 2049)])
def test_grid_envelope_is_checked_before_metrics(shape):
    import numpy as np

    from planner.model_evaluation import evaluate_binary_masks

    with pytest.raises(ValueError, match="grid"):
        evaluate_binary_masks(np.zeros(shape), np.zeros((2, 2, 2)), np.eye(4), spatial_units="mm")


@pytest.mark.parametrize("kind", ["singular", "nonfinite", "projective", "wrongshape", "overflow"])
def test_affine_failures_are_explicit(kind):
    import numpy as np

    from planner.model_evaluation import evaluate_binary_masks

    affine = np.eye(4)
    if kind == "singular":
        affine[0, 0] = 0
    if kind == "nonfinite":
        affine[0, 0] = np.nan
    if kind == "projective":
        affine[3, 0] = 0.1
    if kind == "wrongshape":
        affine = affine[:3]
    if kind == "overflow":
        affine[:3, :3] *= 1e120
    with pytest.raises(ValueError, match="affine"):
        evaluate_binary_masks(np.ones((2, 2, 2)), np.ones((2, 2, 2)), affine, spatial_units="mm")


def test_units_and_voxel_budget_are_required(monkeypatch):
    import numpy as np

    import planner.model_evaluation as module

    mask = np.ones((2, 2, 2))
    with pytest.raises(ValueError, match="units"):
        module.evaluate_binary_masks(mask, mask, np.eye(4), spatial_units="unknown")
    monkeypatch.setattr(module, "MAX_VOXELS", 7, raising=False)
    with pytest.raises(ValueError, match="bound"):
        module.evaluate_binary_masks(mask, mask, np.eye(4), spatial_units="mm")
