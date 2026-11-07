"""Opt-in real-weight tests. Run in the isolated ML runtime, not base CI.

All tests in this module run in the opt-in isolated ML runtime. Injected
predictors are synthetic fixtures; the named actual-forward tests use weights.
"""

import os
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1",
    reason="Requires separately installed ML runtime and hash-pinned model weights",
)


def test_actual_sam2_tiny_refines_a_synthetic_prompted_object():
    import numpy as np
    import torch

    from planner.sam_refinement import refine_slice

    torch.set_num_threads(4)
    yy, xx = np.mgrid[:128, :128]
    image = np.zeros((128, 128, 3), dtype=np.uint8)
    image[(xx - 64) ** 2 + (yy - 64) ** 2 < 20**2] = [200, 100, 70]
    root = Path(__file__).resolve().parents[2]
    result = refine_slice(
        image,
        points=[(64, 64), (15, 15)],
        labels=[1, 0],
        box=[40, 40, 88, 88],
        checkpoint_path=root / ".runtime/models/sam2.1-tiny/sam2.1_hiera_tiny.pt",
        prompt_provenance="synthetic_fixture",
    )
    assert result["mask"].shape == image.shape[:2]
    assert result["mask"].dtype == np.uint8
    assert result["mask"][64, 64] == 1
    assert result["mask"][15, 15] == 0
    assert result["mask"].sum() > 0
    assert np.isfinite(result["score"])
    assert result["method"] == "sam2_prompted_slice_refinement"
    assert result["prompt_provenance"] == "synthetic_fixture"
    assert result["automatic_aneurysm_detection"] is False
    assert result["initial_mask_used"] is False


class _FakePredictor:
    """Synthetic predictor fixture with explicitly point-compliant outputs."""

    def __init__(self):
        self.calls = []

    def set_image(self, image):
        self.image = image

    def predict(
        self,
        point_coords=None,
        point_labels=None,
        box=None,
        mask_input=None,
        multimask_output=True,
        return_logits=False,
    ):
        self.calls.append({"mask_input": mask_input, "multimask_output": multimask_output})
        import numpy as np

        h, w = self.image.shape[:2]
        masks = np.ones((3, h, w), dtype=bool)
        if point_coords is not None and point_labels is not None:
            for (x, y), label in zip(point_coords, point_labels):
                masks[:, round(float(y)), round(float(x))] = bool(label)
        scores = np.array([0.5, 0.9, 0.7])
        low = np.zeros((3, 256, 256), dtype=np.float32)
        return masks, scores, low


def _refine_with_fake(image, predictor_factory, **kwargs):
    from planner.sam_refinement import refine_slice

    kwargs.setdefault("points", [(4, 4)])
    kwargs.setdefault("labels", [1])
    kwargs.setdefault("checkpoint_path", "unused-checkpoint-path")
    kwargs.setdefault("prompt_provenance", "operator_entered")
    return refine_slice(image, predictor_factory=predictor_factory, **kwargs)


class TestInitialMaskValidation:
    """Validation precedes any model load; no coercion of malformed values."""

    def test_accepts_matching_binary_uint8_mask(self):
        import numpy as np

        image = np.zeros((32, 32, 3), dtype=np.uint8)
        prior = np.zeros((32, 32), dtype=np.uint8)
        prior[8:16, 8:16] = 1
        seen = {}

        def factory(checkpoint_path):
            seen["checkpoint"] = checkpoint_path
            return _FakePredictor()

        result = _refine_with_fake(image, factory, initial_mask=prior)
        assert result["initial_mask_used"] is True

    def test_rejects_non_array_mask_before_model_load(self):
        import numpy as np

        image = np.zeros((32, 32, 3), dtype=np.uint8)
        called = []

        def factory(checkpoint_path):
            called.append(checkpoint_path)
            return _FakePredictor()

        with pytest.raises(Exception, match="initial_mask"):
            _refine_with_fake(image, factory, initial_mask=[[0, 1], [1, 0]])
        assert called == []

    def test_rejects_shape_mismatch_before_model_load(self):
        import numpy as np

        image = np.zeros((32, 32, 3), dtype=np.uint8)
        prior = np.zeros((16, 16), dtype=np.uint8)
        called = []

        def factory(checkpoint_path):
            called.append(checkpoint_path)
            return _FakePredictor()

        with pytest.raises(Exception, match="initial_mask"):
            _refine_with_fake(image, factory, initial_mask=prior)
        assert called == []

    def test_rejects_non_binary_values_before_model_load(self):
        import numpy as np

        image = np.zeros((32, 32, 3), dtype=np.uint8)
        prior = np.zeros((32, 32), dtype=np.uint8)
        prior[0, 0] = 2
        called = []

        def factory(checkpoint_path):
            called.append(checkpoint_path)
            return _FakePredictor()

        with pytest.raises(Exception, match="initial_mask"):
            _refine_with_fake(image, factory, initial_mask=prior)
        assert called == []

    def test_rejects_fractional_float_values_without_coercion(self):
        import numpy as np

        image = np.zeros((32, 32, 3), dtype=np.uint8)
        prior = np.zeros((32, 32), dtype=np.float32)
        prior[5, 5] = 0.5
        called = []

        def factory(checkpoint_path):
            called.append(checkpoint_path)
            return _FakePredictor()

        with pytest.raises(Exception, match="initial_mask"):
            _refine_with_fake(image, factory, initial_mask=prior)
        assert called == []

    def test_rejects_nonfinite_float_values(self):
        import numpy as np

        image = np.zeros((32, 32, 3), dtype=np.uint8)
        prior = np.zeros((32, 32), dtype=np.float32)
        prior[5, 5] = np.nan
        called = []

        def factory(checkpoint_path):
            called.append(checkpoint_path)
            return _FakePredictor()

        with pytest.raises(Exception, match="initial_mask"):
            _refine_with_fake(image, factory, initial_mask=prior)
        assert called == []

    def test_rejects_non_numeric_dtype(self):
        import numpy as np

        image = np.zeros((32, 32, 3), dtype=np.uint8)
        prior = np.zeros((32, 32), dtype=object)
        called = []

        def factory(checkpoint_path):
            called.append(checkpoint_path)
            return _FakePredictor()

        with pytest.raises(Exception, match="initial_mask"):
            _refine_with_fake(image, factory, initial_mask=prior)
        assert called == []


def test_initialized_correction_selects_highest_score_that_honors_point_labels():
    import numpy as np

    image = np.zeros((16, 16, 3), dtype=np.uint8)
    prior = np.zeros((16, 16), dtype=np.uint8)
    prior[4, 4] = 1

    class Predictor(_FakePredictor):
        def predict(self, **kwargs):
            masks = np.zeros((3, 16, 16), dtype=bool)
            masks[0] = True  # Highest-scoring candidate contradicts the negative point.
            masks[1, 4, 4] = True  # Satisfies both requested points.
            return masks, np.array([0.95, 0.7, 0.6]), np.zeros((3, 256, 256), np.float32)

    result = _refine_with_fake(
        image, lambda p: Predictor(), initial_mask=prior, points=[(4, 4), (2, 2)], labels=[1, 0]
    )
    assert result["mask"][4, 4] == 1 and result["mask"][2, 2] == 0
    assert result["score"] == pytest.approx(0.7)
    assert result["point_constraints_satisfied"] is True


def test_initialized_correction_fails_if_every_candidate_contradicts_a_point():
    import numpy as np

    image = np.zeros((16, 16, 3), np.uint8)
    prior = np.zeros((16, 16), np.uint8)

    class Contradicting:
        def set_image(self, image):
            self.image = image

        def predict(self, **kwargs):
            return (
                np.ones((3, 16, 16), bool),
                np.array([0.9, 0.8, 0.7]),
                np.zeros((3, 256, 256), np.float32),
            )

    with pytest.raises(RuntimeError, match="No SAM correction satisfies"):
        _refine_with_fake(
            image,
            lambda p: Contradicting(),
            initial_mask=prior,
            points=[(2, 2)],
            labels=[0],
            box=[0, 0, 15, 15],
        )


def test_fractional_predicted_mask_cannot_be_truncated_into_a_binary_candidate():
    import numpy as np

    class Fractional:
        def set_image(self, image):
            self.image = image

        def predict(self, **kwargs):
            return (
                np.full((3, 16, 16), 0.5),
                np.array([0.9, 0.8, 0.7]),
                np.zeros((3, 256, 256), np.float32),
            )

    with pytest.raises(RuntimeError, match="invalid candidate masks"):
        _refine_with_fake(np.zeros((16, 16, 3), np.uint8), lambda p: Fractional())


def test_prior_logit_resize_uses_upstream_half_pixel_not_corner_alignment():
    import numpy as np
    import torch
    from torch.nn.functional import interpolate

    from planner.sam_refinement import _mask_to_logit_input

    prior = np.zeros((5, 9), dtype=np.uint8)
    prior[1:4, 2:5] = 1
    expected = interpolate(
        torch.from_numpy(prior.astype(np.float32))[None, None],
        size=(256, 256),
        mode="bilinear",
        align_corners=False,
    )[0].numpy()
    expected = (expected * 2.0 - 1.0) * 4.0
    np.testing.assert_allclose(_mask_to_logit_input(prior), expected, rtol=0, atol=1e-6)


class TestInitialMaskPredictorHandoff:
    def test_supplied_prior_passed_as_low_res_logit_input(self):
        import numpy as np

        from planner.sam_refinement import _mask_to_logit_input

        yy, xx = np.mgrid[:128, :128]
        prior = ((xx - 64) ** 2 + (yy - 64) ** 2 < 20**2).astype(np.uint8)
        logits = _mask_to_logit_input(prior)
        assert logits.shape == (1, 256, 256)
        assert logits.dtype == np.float32
        assert np.isfinite(logits).all()
        # Explicit derived heuristic: interior positive, exterior negative.
        assert logits[0, 128, 128] > 0
        assert logits[0, 4, 4] < 0

    def test_prior_forward_passes_mask_input_keeps_prompts_and_multimask(self):
        import numpy as np

        image = np.zeros((64, 64, 3), dtype=np.uint8)
        prior = np.zeros((64, 64), dtype=np.uint8)
        prior[10:20, 10:20] = 1
        fake = _FakePredictor()

        result = _refine_with_fake(
            image,
            lambda cp: fake,
            points=[(30, 30), (2, 2)],
            labels=[1, 0],
            box=[5, 5, 55, 55],
            initial_mask=prior,
        )
        assert len(fake.calls) == 1
        call = fake.calls[0]
        assert call["multimask_output"] is True
        assert call["mask_input"] is not None
        assert call["mask_input"].shape == (1, 256, 256)
        assert result["initial_mask_used"] is True
        assert result["mask"].shape == (64, 64)

    def test_no_prior_passes_no_mask_input(self):
        import numpy as np

        image = np.zeros((64, 64, 3), dtype=np.uint8)
        fake = _FakePredictor()
        result = _refine_with_fake(image, lambda cp: fake)
        assert fake.calls[0]["mask_input"] is None
        assert result["initial_mask_used"] is False


@pytest.mark.skipif(
    os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1",
    reason="Requires separately installed ML runtime and hash-pinned model weights",
)
def test_actual_sam2_tiny_forward_with_supplied_synthetic_prior():
    """Actual SAM2 forward with a synthetic prior. Prior is synthetic, not learned-logit equivalent."""
    import numpy as np
    import torch

    from planner.sam_refinement import refine_slice

    torch.set_num_threads(4)
    yy, xx = np.mgrid[:128, :128]
    image = np.zeros((128, 128, 3), dtype=np.uint8)
    image[(xx - 64) ** 2 + (yy - 64) ** 2 < 20**2] = [200, 100, 70]
    # Synthetic slightly-shrunk prior disk (deliberately not the true outline).
    prior = ((xx - 64) ** 2 + (yy - 64) ** 2 < 14**2).astype(np.uint8)
    root = Path(__file__).resolve().parents[2]
    result = refine_slice(
        image,
        points=[(64, 64)],
        labels=[1],
        box=[40, 40, 88, 88],
        checkpoint_path=root / ".runtime/models/sam2.1-tiny/sam2.1_hiera_tiny.pt",
        prompt_provenance="synthetic_fixture",
        initial_mask=prior,
    )
    assert result["initial_mask_used"] is True
    assert result["mask"].shape == image.shape[:2]
    assert result["mask"].dtype == np.uint8
    assert result["mask"][64, 64] == 1
    assert result["mask"][15, 15] == 0
    assert np.isfinite(result["score"])
    assert result["automatic_aneurysm_detection"] is False
    assert result["accepted"] is False
