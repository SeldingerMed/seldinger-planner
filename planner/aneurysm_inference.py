"""Original full aneurysm checkpoint foundation, not a case-inference adapter.

Run only in the separate nnXNet runtime. The pinned upstream architecture
builds two complete segmentation decoders and classification/modality heads.
A synthetic forward does not establish image preprocessing or lesion accuracy.
No application code is imported from a legacy Seldinger repository.
"""

from dataclasses import dataclass
from pathlib import Path

from planner.model_assets import RSNA_ANEURYSM_CHECKPOINT, verified_checkpoint


@dataclass(frozen=True)
class AneurysmGrid:
    native_shape: tuple[int, int, int]
    lps_shape: tuple[int, int, int]
    native_to_lps: tuple[tuple[int, int], ...]
    lps_to_native: tuple[tuple[int, int], ...]


def prepare_aneurysm_input(image_xyz, affine):
    """Published ROI handoff in CPU float32, not fp16/TTA equivalence.

    Input is an already selected ROI. This does not reproduce the author's
    independent stage-1 vascular localization or establish millimeter units.
    """
    import nibabel as nib
    import numpy as np
    import torch

    image_xyz = np.asarray(image_xyz)
    affine = np.asarray(affine)
    if (
        image_xyz.ndim != 3
        or image_xyz.dtype.kind not in "iuf"
        or image_xyz.size > 8_000_000
        or min(image_xyz.shape) < 2
    ):
        raise ValueError("Expected bounded real 3D ROI with at least two voxels per axis")
    if not np.isfinite(image_xyz).all() or np.max(np.abs(image_xyz)) > np.finfo(np.float32).max:
        raise ValueError("ROI must be finite and representable in float32")
    if (
        affine.shape != (4, 4)
        or affine.dtype.kind not in "iuf"
        or not np.isfinite(affine).all()
        or not np.array_equal(affine[3], [0, 0, 0, 1])
    ):
        raise ValueError("Invalid homogeneous native affine")
    basis = np.abs(affine[:3, :3].astype(float))
    scales = basis.max(axis=0)
    if np.any(scales < 1e-8) or np.any(scales > 1e8):
        raise ValueError("Unsupported affine scale or singular affine")
    dominant = basis / scales
    if (
        not np.all((dominant < 1e-6) | (dominant == 1))
        or not np.all(np.sum(dominant >= 1e-6, axis=0) == 1)
        or len(set(np.argmax(dominant, axis=0))) != 3
    ):
        raise ValueError("Initial adapter supports axis-aligned/permuted affines only")
    source_orientation = nib.io_orientation(affine)
    target_orientation = nib.orientations.axcodes2ornt(("L", "P", "S"))
    forward = nib.orientations.ornt_transform(source_orientation, target_orientation)
    inverse = nib.orientations.ornt_transform(target_orientation, source_orientation)
    lps_xyz = nib.orientations.apply_orientation(image_xyz, forward)
    tensor = torch.from_numpy(np.ascontiguousarray(lps_xyz.transpose(2, 1, 0), dtype=np.float32))[
        None
    ]
    tensor = (tensor - tensor.mean()) / tensor.std().clamp_min(1e-8)
    if not torch.isfinite(tensor).all():
        raise ValueError("ROI normalization produced nonfinite values")
    resized = torch.nn.functional.interpolate(
        tensor[None], size=(224, 224, 224), mode="trilinear", align_corners=True
    )
    grid = AneurysmGrid(
        tuple(image_xyz.shape),
        tuple(lps_xyz.shape),
        tuple(tuple(int(v) for v in row) for row in forward),
        tuple(tuple(int(v) for v in row) for row in inverse),
    )
    return resized, grid


def restore_aneurysm_mask(head_1_logits, grid: AneurysmGrid, *, role="aneurysm"):
    """Restore logits before categorical decision, then invert LPS/ZYX mapping.

    This fresh segmentation adapter interpolates logits, not softmax
    probabilities; those operations are not generally equivalent. It is not
    proof of the author's classification-only deployment's segmentation accuracy.
    Vessel output unions original first-head classes 1..13, excluding class 14
    (merged aneurysm) and background. No new checkpoint or inferred labels.
    """
    if role not in ("vessel", "aneurysm"):
        raise ValueError("Unsupported segmentation role")
    import nibabel as nib
    import numpy as np
    import torch

    if (
        not isinstance(head_1_logits, torch.Tensor)
        or head_1_logits.ndim != 5
        or head_1_logits.shape[:2] != (1, 15)
        or any(n < 1 or n > 224 for n in head_1_logits.shape[2:])
        or not head_1_logits.is_floating_point()
        or not torch.isfinite(head_1_logits).all()
    ):
        raise ValueError("Expected bounded finite 15-channel segmentation logits")
    resized = torch.nn.functional.interpolate(
        head_1_logits, size=grid.lps_shape[::-1], mode="trilinear", align_corners=True
    )
    labels = resized.argmax(dim=1)[0]
    binary = (labels == 14) if role == "aneurysm" else ((labels >= 1) & (labels <= 13))
    mask_zyx = binary.to(torch.uint8).cpu().numpy()
    lps_xyz = mask_zyx.transpose(2, 1, 0)
    native = nib.orientations.apply_orientation(lps_xyz, np.asarray(grid.lps_to_native))
    if native.shape != grid.native_shape:
        raise ValueError("Restored aneurysm mask does not match native ROI")
    return np.ascontiguousarray(native, dtype=np.uint8)


def aneurysm_head1_graph(network):
    """Eliminate unused heads from the original eval graph, without new weights.

    The original full state must already be strictly loaded. Keep the actual
    upstream first-decoder operations; do not rewrite or approximate its math.
    This retains only merged aneurysm/vessel segmentation, not anatomy naming
    or classification. Equivalence is separately tested against full forward.
    The returned graph shares parameter/module objects with the input network;
    it is not a snapshot. Keep both immutable and in evaluation mode.
    """
    import torch

    if network.training:
        raise ValueError("Graph extraction requires original evaluation mode")

    class DecoderTracer(torch.fx.Tracer):
        def is_leaf_module(self, module, qualified_name):
            # Attention heads have input-shape control flow and are unused by
            # the selected output. Treat them as leaves before dead-code removal.
            return module.__class__.__name__ == "ClassificationHead" or super().is_leaf_module(
                module, qualified_name
            )

    graph = DecoderTracer().trace(network, concrete_args={"only_forward_cls": False})
    output = next(node for node in graph.nodes if node.op == "output")
    output.args = (output.args[0][0],)
    pruned = torch.fx.GraphModule(network, graph)
    pruned.graph.eliminate_dead_code()
    pruned.graph.lint()
    pruned.delete_all_unused_submodules()
    pruned.recompile()
    return pruned.eval()


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


def predict_aneurysm(image_xyz, affine, *, checkpoint_path: Path, role="aneurysm"):
    """Produce an unaccepted 3D candidate within a trusted selected native ROI.

    Fixed local MPS float32 path, verified whole original checkpoint, retained
    memory cap and original first-head graph. No classification or independent
    full-head localization claim. Installer, never product requests, picks paths.
    An explicit vessel role selects the original vessel classes from this same
    licensed task head, not the separately owned pooled-vessel checkpoint.
    """
    if role not in ("vessel", "aneurysm"):
        raise ValueError("Unsupported segmentation role")
    import torch

    from planner.model_assets import RSNA_ANEURYSM_REVISION, RSNA_ANEURYSM_SOURCE_REVISION

    if not torch.backends.mps.is_available():
        raise RuntimeError("Installed aneurysm inference requires local MPS acceleration")
    torch.set_num_threads(4)
    torch.mps.set_per_process_memory_fraction(0.5)
    prepared, grid = prepare_aneurysm_input(image_xyz, affine)
    network = aneurysm_head1_graph(load_aneurysm_network(checkpoint_path)).to("mps")
    with torch.inference_mode():
        logits = network(prepared.to("mps"))
        mask = restore_aneurysm_mask(logits, grid, role=role)
    return {
        "mask": mask,
        "model_version": RSNA_ANEURYSM_REVISION,
        "upstream_source_revision": RSNA_ANEURYSM_SOURCE_REVISION,
        "checkpoint_sha256": RSNA_ANEURYSM_CHECKPOINT.sha256,
        "selected_head": "merged_aneurysm_vessel_head_1",
        "output_role": role,
        "foreground_classes": [14] if role == "aneurysm" else list(range(1, 14)),
        "artifact_license": "Apache-2.0",
        "graph": "original_eval_head1_fx_dead_code_elimination",
        "preprocessing": "LPS_ZYX_sample_zscore_trilinear_224_align_corners",
        "precision": "float32",
        "device": "mps",
        "mps_memory_fraction": 0.5,
        "tta": False,
        "ensemble": False,
        "accepted": False,
        "automatic_full_head_localization": False,
        "source_spatial_calibration_inferred": False,
        "validated_morphometry": False,
        "clinical_validation": "none",
    }
