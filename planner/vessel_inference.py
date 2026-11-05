"""Fresh owned-vessel inference adapter over hash-pinned original artifacts.

No legacy repository code is imported. Preprocessing uses the installed
upstream TorchIO 1.2.1 public API and the original pinned target landmarks;
network inference uses the installed upstream nnunetv2 predictor primitives
around the verified original checkpoint. Inputs are trusted installer or
case-worker arguments, never arbitrary product-agent paths.
"""

import json
from pathlib import Path

import numpy as np
import torch

from planner.model_assets import (
    OWNED_VESSEL_CHECKPOINT,
    OWNED_VESSEL_REVISION,
    CheckpointSpec,
    ModelArtifactError,
    verified_checkpoint,
)

_MAX_VOXELS = 8_000_000

# Exact original targetlandmarks artifact identity (364 bytes, CTA float64(13)).
OWNED_VESSEL_LANDMARKS = CheckpointSpec(
    364,
    "09b6b9f43458493631cff1470c02d8c1480a258b62dee2ef4ba3f2d9c3e0eaab",
)

# Exact NumPy scalar/dtype globals observed in the verified original checkpoint
# by artifacts/model-discovery/smoke_owned_forward.py (no arbitrary imports).
_CHECKPOINT_GLOBALS = [
    np.dtype,
    np._core.multiarray.scalar,
    np.dtypes.Float64DType,
    np.dtypes.Float32DType,
    np.dtypes.Int64DType,
]

_INT16_MIN, _INT16_MAX = np.iinfo(np.int16).min, np.iinfo(np.int16).max


def _validate_image_xyz(image_xyz: np.ndarray) -> np.ndarray:
    array = np.asarray(image_xyz)
    if array.ndim != 3 or array.size == 0:
        raise ValueError("image must be a nonempty 3D array")
    if not np.issubdtype(array.dtype, np.number) or not np.isfinite(array).all():
        raise ValueError("image must be finite numeric data")
    if array.size > _MAX_VOXELS:
        raise ValueError("image exceeds 8,000,000 voxels")
    return array


def _validate_spacing_xyz(spacing_xyz) -> tuple:
    spacing_array = np.asarray(spacing_xyz, dtype=object)
    if spacing_array.shape != (3,) or any(
        isinstance(item, (bool, np.bool_)) for item in spacing_array
    ):
        raise ValueError("spacing must be three elements")
    spacing = tuple(float(value) for value in spacing_array)
    if not all(np.isfinite(value) and value > 0 for value in spacing):
        raise ValueError("spacing must be positive and finite")
    return spacing


def _load_landmarks(path: Path) -> np.ndarray:
    """Verify and load the original pinned landmarks; reject caller hashes."""
    with verified_checkpoint(path, expected=OWNED_VESSEL_LANDMARKS) as stream:
        archive = np.load(stream, allow_pickle=False)
        entries = archive[archive.files[0]]
    if entries.shape != (13,) or entries.dtype != np.float64:
        raise ValueError("landmarks artifact shape or dtype mismatch")
    if not np.isfinite(entries).all() or not (np.diff(entries) > 0).all():
        raise ValueError("landmarks must be finite and strictly ordered")
    return entries.astype(np.float64)


def standardize_cta(image_xyz, landmarks_path) -> np.ndarray:
    """Histogram-standardize a 3D CTA against the original pinned landmarks.

    Uses upstream torchio.HistogramStandardization on the image volume (no
    masking, all voxels included, piecewise-linear tail extrapolation), then
    rounds to int16 like the original training preprocessing. Source numeric
    spacing and spatial units are preserved; geometry is never rewritten.
    """
    import torchio as tio

    array = _validate_image_xyz(image_xyz)
    landmarks = _load_landmarks(Path(landmarks_path))
    subject = tio.Subject(
        img=tio.ScalarImage(tensor=torch.as_tensor(array[None], dtype=torch.float32))
    )
    transformed = tio.HistogramStandardization({"img": landmarks})(subject)
    rounded = transformed["img"].data
    if not torch.isfinite(rounded).all():
        raise ValueError("standardization produced non-finite values")
    if rounded.min().item() < _INT16_MIN or rounded.max().item() > _INT16_MAX:
        raise ValueError("rounded output outside int16 representability")
    return rounded.round().short().numpy()[0]


def _load_network_and_plans(stream):
    from nnunetv2.utilities.get_network_from_plans import get_network_from_plans

    with torch.serialization.safe_globals(_CHECKPOINT_GLOBALS):
        checkpoint = torch.load(stream, map_location="cpu", weights_only=True)
    args = checkpoint["init_args"]
    if args["configuration"] != "3d_fullres":
        raise ModelArtifactError("Checkpoint configuration mismatch")
    dataset_json = args["dataset_json"]
    if dataset_json["labels"] != {"background": 0, "vessel": 1}:
        raise ModelArtifactError("Unexpected checkpoint label scheme")
    plans = args["plans"]
    architecture = plans["configurations"]["3d_fullres"]["architecture"]
    network = get_network_from_plans(
        architecture["network_class_name"],
        architecture["arch_kwargs"],
        architecture["_kw_requires_import"],
        1,
        2,
        allow_init=False,
        deep_supervision=False,
    )
    state = checkpoint["network_weights"]
    if state and all(key.startswith("_orig_mod.") for key in state):
        state = {key[len("_orig_mod.") :]: value for key, value in state.items()}
    network.load_state_dict(state, strict=True)
    network.eval()
    return network, [state], plans, dataset_json, checkpoint.get("trainer_name") or "nnUNetTrainer"


def _restore_native_mask(segmentation, expected_shape):
    """Restore the upstream predictor's actual ZYX ndarray, not a guessed tuple."""
    if not isinstance(segmentation, np.ndarray) or segmentation.ndim != 3:
        raise ValueError("predicted mask must be a three-dimensional ndarray")
    mask_xyz = np.transpose(segmentation, (2, 1, 0))
    if mask_xyz.shape != tuple(expected_shape):
        raise ValueError("predicted mask shape mismatch")
    if not np.isfinite(mask_xyz).all() or not np.isin(mask_xyz, [0, 1]).all():
        raise ValueError("predicted mask is not finite binary background/vessel")
    return mask_xyz.astype(np.uint8)


def predict_vessel(image_xyz, spacing_xyz, *, checkpoint_path, landmarks_path) -> dict:
    """Predict the vessel mask in native XYZ with the verified pooled model.

    Returns a dict with the native-XYZ binary uint8 ``mask`` and explicit
    provenance. CPU only; the caller controls thread counts. No TTA in this
    bounded candidate path. Preprocessing equivalence to the original training
    cohort is not reproduced: the exact original training TorchIO version and
    fitted cohort cannot be re-established; the pinned original target
    landmarks file is used with installed upstream TorchIO 1.2.1. No clinical
    or accuracy claims are made.
    """
    import torchio
    from nnunetv2.inference.predict_from_raw_data import nnUNetPredictor
    from nnunetv2.utilities.plans_handling.plans_handler import PlansManager

    array = _validate_image_xyz(image_xyz)
    spacing = _validate_spacing_xyz(spacing_xyz)

    standardized = standardize_cta(array, Path(landmarks_path))

    checkpoint_path = Path(checkpoint_path)
    with verified_checkpoint(checkpoint_path, expected=OWNED_VESSEL_CHECKPOINT) as stream:
        network, parameters, plans, dataset_json, trainer_name = _load_network_and_plans(stream)

    plans_manager = PlansManager(plans)
    configuration_manager = plans_manager.get_configuration("3d_fullres")
    predictor = nnUNetPredictor(
        tile_step_size=0.5,
        use_gaussian=True,
        use_mirroring=False,
        perform_everything_on_device=False,
        device=torch.device("cpu"),
        verbose=False,
        allow_tqdm=False,
    )
    predictor.manual_initialization(
        network,
        plans_manager,
        configuration_manager,
        parameters=parameters,
        dataset_json=dataset_json,
        trainer_name=trainer_name,
        inference_allowed_mirroring_axes=None,
    )

    # SimpleITK reader order is (channel, Z, Y, X); adapter contract is X,Y,Z.
    input_npy = np.transpose(standardized, (2, 1, 0))[None].astype(np.float32)
    segmentation = predictor.predict_single_npy_array(
        input_npy,
        {"spacing": tuple(reversed(spacing))},
    )
    mask_xyz = _restore_native_mask(segmentation, array.shape)
    return {
        "mask": mask_xyz.astype(np.uint8),
        "method": "owned_pooled_vessel_inference",
        "automatic_aneurysm_detection": False,
        "checkpoint_revision": OWNED_VESSEL_REVISION,
        "checkpoint_sha256": OWNED_VESSEL_CHECKPOINT.sha256,
        "tta": False,
        "preprocessing_provenance": {
            "landmarks_sha256": OWNED_VESSEL_LANDMARKS.sha256,
            "upstream_torchio_version": torchio.__version__,
            "original_training_torchio_version_resolved": False,
            "original_training_cohort_equivalence_reproduced": False,
            "accuracy_claims": "none",
        },
        "plans_configuration": "3d_fullres",
        "trainer_name": trainer_name,
        "network_architecture": plans["configurations"]["3d_fullres"]["architecture"][
            "network_class_name"
        ],
        "dataset_json_labels": dict(dataset_json["labels"]),
        "checkpoint_bytes_verified": OWNED_VESSEL_CHECKPOINT.size_bytes,
        "checkpoint_metadata_json": json.dumps({"revision": OWNED_VESSEL_REVISION}),
    }
