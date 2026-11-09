"""Original segmentation head role decoding, synthetic logits, no checkpoint load."""

import os

import pytest

if os.environ.get("SELDINGER_RUN_ANEURYSM_TESTS") != "1":
    pytest.skip("Requires isolated aneurysm runtime", allow_module_level=True)


def test_vessel_role_preserves_classes_one_through_thirteen_and_excludes_sac():
    import numpy as np
    import torch

    from planner.aneurysm_inference import prepare_aneurysm_input, restore_aneurysm_mask

    image = np.arange(60, dtype=np.float32).reshape(3, 4, 5)
    affine = np.array([[0, 0, -2, 42], [3, 0, 0, 19], [0, 4, 0, -5], [0, 0, 0, 1]], float)
    _, grid = prepare_aneurysm_input(image, affine)
    logits = torch.full((1, 15, *grid.lps_shape[::-1]), -8.0)
    logits[:, 0] = 8
    logits[0, 1, 2, 1, 3] = 16
    logits[0, 13, 1, 0, 2] = 16
    logits[0, 14, 0, 2, 1] = 16
    vessel = restore_aneurysm_mask(logits, grid, role="vessel")
    sac = restore_aneurysm_mask(logits, grid)
    assert vessel.shape == image.shape and vessel.dtype == np.uint8
    assert vessel.sum() == 2 and sac.sum() == 1
    assert vessel[1, 2, 3] == 1
    assert vessel[2, 1, 2] == 1
    assert sac[0, 0, 1] == 1
    assert not np.logical_and(vessel, sac).any()


def test_unknown_role_is_rejected_before_inference_or_mask_decoding():
    from planner.aneurysm_inference import predict_aneurysm, restore_aneurysm_mask

    with pytest.raises(ValueError, match="role"):
        restore_aneurysm_mask(None, None, role="any-label")
    with pytest.raises(ValueError, match="role"):
        predict_aneurysm(None, None, checkpoint_path=None, role="any-label")
