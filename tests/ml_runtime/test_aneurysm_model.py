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
