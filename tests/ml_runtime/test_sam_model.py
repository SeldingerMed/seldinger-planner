"""Opt-in real-weight tests. Run in the isolated ML runtime, not base CI."""

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
