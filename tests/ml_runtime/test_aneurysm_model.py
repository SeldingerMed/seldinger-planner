"""Opt-in full-checkpoint architecture smoke, not image inference or validation.

Run separately in .runtime/aneurysm-runtime with SELDINGER_RUN_ANEURYSM_TESTS=1.
The original nnXNet architecture requires dynamic-network-architectures<0.4;
never replace the vessel/SAM runtime's independently exercised dependencies.
"""

import os
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("SELDINGER_RUN_ANEURYSM_TESTS") != "1",
    reason="Requires original full aneurysm checkpoint and isolated nnXNet runtime",
)
ROOT = Path(__file__).resolve().parents[2]
CHECKPOINT = (
    ROOT
    / ".runtime/models/rsna-aneurysm-stage2-v2/Dataset660_26classes_resize224_4661/onlyMirror01_lr4e3_100epochs_ps224/fold_0/checkpoint_final.pth"
)


def test_lps_zyx_handoff_matches_explicit_native_permutation_and_torch_normalization():
    import numpy as np
    import torch

    from planner.aneurysm_inference import prepare_aneurysm_input

    x, y, z = np.indices((3, 4, 5))
    image = (x + 10 * y + 100 * z).astype(np.float32)
    affine = np.array([[0, 0, -2, 42], [3, 0, 0, 19], [0, 4, 0, -5], [0, 0, 0, 1]], dtype=float)
    prepared, grid = prepare_aneurysm_input(image, affine)
    # Native axes are A,S,L. LPS XYZ is native axis order 2,0,1 with
    # native axis 0 reversed; then handoff transposes to ZYX.
    expected_zyx = torch.from_numpy(image[::-1, :, :].transpose(1, 0, 2).copy())[None]
    expected = (expected_zyx - expected_zyx.mean()) / expected_zyx.std().clamp_min(1e-8)
    expected = torch.nn.functional.interpolate(
        expected[None], size=(224, 224, 224), mode="trilinear", align_corners=True
    )
    torch.testing.assert_close(prepared, expected, rtol=0, atol=0)
    assert grid.native_shape == (3, 4, 5)
    assert grid.lps_shape == (5, 3, 4)
    assert prepared.dtype == torch.float32


@pytest.mark.parametrize(
    "invalid",
    [
        "bool",
        "complex",
        "nan",
        "huge",
        "voxel_cap",
        "singular",
        "bad_affine_shape",
        "nan_affine",
        "nonhomogeneous",
        "sheared",
    ],
)
def test_preprocessing_rejects_invalid_inputs_before_model_execution(invalid):
    import numpy as np

    from planner.aneurysm_inference import prepare_aneurysm_input

    image = np.ones((3, 4, 5), dtype=np.float32)
    affine = np.eye(4)
    if invalid == "bool":
        image = image.astype(bool)
    elif invalid == "complex":
        image = image.astype(complex)
    elif invalid == "nan":
        image[0, 0, 0] = np.nan
    elif invalid == "huge":
        image = np.full((3, 4, 5), np.finfo(np.float64).max)
    elif invalid == "voxel_cap":
        image = np.zeros((201, 200, 200), dtype=np.uint8)
    elif invalid == "singular":
        affine[0, 0] = 0
    elif invalid == "bad_affine_shape":
        affine = np.eye(3)
    elif invalid == "nan_affine":
        affine[0, 0] = np.nan
    elif invalid == "nonhomogeneous":
        affine[3, 0] = 1
    elif invalid == "sheared":
        affine[0, 1] = 0.2
    with pytest.raises(ValueError):
        prepare_aneurysm_input(image, affine)


def test_merged_aneurysm_head_restores_asymmetric_native_voxel_after_orientation():
    import numpy as np
    import torch

    from planner.aneurysm_inference import prepare_aneurysm_input, restore_aneurysm_mask

    image = np.arange(60, dtype=np.float32).reshape(3, 4, 5)
    affine = np.array([[0, 0, -2, 42], [3, 0, 0, 19], [0, 4, 0, -5], [0, 0, 0, 1]], dtype=float)
    _, grid = prepare_aneurysm_input(image, affine)
    logits = torch.full((1, 15, *grid.lps_shape[::-1]), -8.0)
    logits[:, 0] = 8
    logits[0, 14, 2, 1, 3] = 16
    mask = restore_aneurysm_mask(logits, grid)
    assert mask.shape == (3, 4, 5) and mask.dtype == np.uint8
    assert mask[1, 2, 3] == 1 and mask.sum() == 1


@pytest.mark.parametrize("mode", ["channels", "nan", "integer"])
def test_restore_rejects_malformed_or_nonfinite_segmentation_head(mode):
    import numpy as np
    import torch

    from planner.aneurysm_inference import prepare_aneurysm_input, restore_aneurysm_mask

    _, grid = prepare_aneurysm_input(np.ones((3, 4, 5), dtype=np.float32), np.eye(4))
    logits = torch.zeros((1, 15, 5, 4, 3))
    if mode == "channels":
        logits = logits[:, :14]
    elif mode == "nan":
        logits[0, 0, 0, 0, 0] = float("nan")
    else:
        logits = logits.long()
    with pytest.raises(ValueError):
        restore_aneurysm_mask(logits, grid)


def test_finite_but_overflowing_normalization_fails_before_inference():
    import numpy as np

    from planner.aneurysm_inference import prepare_aneurysm_input

    image = np.full((3, 4, 5), np.finfo(np.float32).max / 2, dtype=np.float32)
    with pytest.raises(ValueError):
        prepare_aneurysm_input(image, np.eye(4))


def test_head1_only_graph_preserves_original_logits_exactly():
    import torch

    from planner.aneurysm_inference import aneurysm_head1_graph, load_aneurysm_network

    torch.set_num_threads(4)
    original = load_aneurysm_network(CHECKPOINT)
    pruned = aneurysm_head1_graph(original)
    image = torch.randn((1, 1, 64, 64, 64), generator=torch.Generator().manual_seed(17))
    with torch.inference_mode():
        expected = original(image)[0]
        actual = pruned(image)
    torch.testing.assert_close(actual, expected, rtol=0, atol=0)
    assert not any(
        "_2" in name
        for name in dict(pruned.named_modules())
        if "last_two" in name or "seg_layers" in name
    )
    assert not pruned.training


def test_head1_graph_preserves_original_mps_logits():
    import torch

    from planner.aneurysm_inference import aneurysm_head1_graph, load_aneurysm_network

    if not torch.backends.mps.is_available():
        pytest.skip("Local MPS verification only")
    torch.mps.set_per_process_memory_fraction(0.5)
    original = load_aneurysm_network(CHECKPOINT).to("mps")
    pruned = aneurysm_head1_graph(original)
    image = torch.randn((1, 1, 64, 64, 64), generator=torch.Generator().manual_seed(19)).to("mps")
    with torch.inference_mode():
        expected = original(image)[0]
        actual = pruned(image)
    torch.testing.assert_close(actual, expected, rtol=0, atol=0)


def test_restore_resizes_224_logits_before_native_orientation():
    import math

    import numpy as np
    import torch

    from planner.aneurysm_inference import prepare_aneurysm_input, restore_aneurysm_mask

    image = np.arange(60, dtype=np.float32).reshape(3, 4, 5)
    affine = np.array([[0, 0, -2, 42], [3, 0, 0, 19], [0, 4, 0, -5], [0, 0, 0, 1]], dtype=float)
    _, grid = prepare_aneurysm_input(image, affine)
    logits = torch.full((1, 15, 224, 224, 224), -8.0)
    logits[:, 0] = 8
    # Independent known landmark: native (1,2,3) -> LPS ZYX (2,1,3).
    # Match the align-corners sampling centers, not voxel-count scale factors.
    centers = [index * 223 / (length - 1) for index, length in zip((2, 1, 3), grid.lps_shape[::-1])]
    slices = tuple(slice(math.floor(c) - 2, math.ceil(c) + 3) for c in centers)
    logits[(0, 14, *slices)] = 16
    restored = restore_aneurysm_mask(logits, grid)
    expected = np.zeros((3, 4, 5), dtype=np.uint8)
    expected[1, 2, 3] = 1
    np.testing.assert_array_equal(restored, expected)


def test_fixed_predictor_returns_native_candidate_and_scoped_provenance():
    import numpy as np
    import torch

    from planner.aneurysm_inference import predict_aneurysm

    if not torch.backends.mps.is_available():
        pytest.skip("Local MPS verification only")
    image = np.arange(17 * 18 * 19, dtype=np.float32).reshape(17, 18, 19)
    affine = np.diag([-0.4, -0.6, 0.8, 1.0])
    result = predict_aneurysm(image, affine, checkpoint_path=CHECKPOINT)
    assert result["mask"].shape == image.shape
    assert result["mask"].dtype == np.uint8
    assert set(np.unique(result["mask"])) <= {0, 1}
    assert result["device"] == "mps" and result["precision"] == "float32"
    assert result["accepted"] is False
    assert result["clinical_validation"] == "none"
    assert result["automatic_full_head_localization"] is False
    assert result["validated_morphometry"] is False
    assert result["selected_head"] == "merged_aneurysm_vessel_head_1"
    assert "classification_probability" not in result


def test_full_original_network_loads_strictly_and_executes_both_segmentation_heads():
    import torch

    from planner.aneurysm_inference import load_aneurysm_network

    torch.set_num_threads(4)
    network = load_aneurysm_network(CHECKPOINT)
    with torch.inference_mode():
        outputs = network(torch.zeros((1, 1, 64, 64, 64), dtype=torch.float32))
    assert len(outputs) == 4
    sac_and_vessels, anatomical_regions, classification, modality = outputs
    assert tuple(sac_and_vessels.shape) == (1, 15, 64, 64, 64)
    assert tuple(anatomical_regions.shape) == (1, 14, 64, 64, 64)
    assert [tuple(x.shape) for x in classification] == [(1, 1), (1, 13)]
    assert tuple(modality.shape) == (1, 4)
    assert all(
        torch.isfinite(x).all()
        for x in [sac_and_vessels, anatomical_regions, *classification, modality]
    )
    assert not network.training
