"""Original full aneurysm checkpoint foundation, not a case-inference adapter.

Run only in the separate nnXNet runtime. The pinned upstream architecture
builds two complete segmentation decoders and classification/modality heads.
A synthetic forward does not establish image preprocessing or lesion accuracy.
No application code is imported from a legacy Seldinger repository.
"""

from pathlib import Path

from planner.model_assets import RSNA_ANEURYSM_CHECKPOINT, verified_checkpoint


def load_aneurysm_network(checkpoint_path: Path):
    """Strictly load the installed original fold using its actual trainer override.

    Installation code, never a product request, selects this path. The model's
    embedded plans take precedence over a potentially different adjacent file.
    Constructor choice and imported torch operators are fixed by this adapter,
    not dynamically resolved from pickled class names or user-controlled text.
    """
    import numpy as np
    import torch
    from nnxnet.training.nnXNetTrainer.variants.network_architecture.ResEncoderUNet_two_seg_with_cls_modality import (
        ResEncoderUNet_two_seg_with_cls_modality,
    )

    allowed = [
        np.dtype,
        np._core.multiarray.scalar,
        np.dtypes.Float64DType,
        np.dtypes.Float32DType,
        np.dtypes.Int64DType,
    ]
    with (
        verified_checkpoint(checkpoint_path, expected=RSNA_ANEURYSM_CHECKPOINT) as stream,
        torch.serialization.safe_globals(allowed),
    ):
        checkpoint = torch.load(stream, map_location="cpu", weights_only=True)
    arguments = checkpoint["init_args"]
    configuration = arguments["plans"]["configurations"][arguments["configuration"]]
    kwargs = dict(configuration["architecture"]["arch_kwargs"])
    # Exact symbols used by the original trainer's builder. Do not use pydoc
    # to turn arbitrary checkpoint strings into executable class resolution.
    kwargs.update(
        conv_op=torch.nn.Conv3d,
        norm_op=torch.nn.InstanceNorm3d,
        dropout_op=None,
        nonlin=torch.nn.LeakyReLU,
    )
    network = ResEncoderUNet_two_seg_with_cls_modality(
        in_channels=1,
        out_channels_1=15,
        out_channels_2=14,
        deep_supervision=False,
        **kwargs,
    )
    network.load_state_dict(checkpoint["network_weights"], strict=True)
    return network.eval()
