"""Bounded binary-mask agreement arithmetic, with optional runtime imports."""

import math

MAX_VOXELS = 8_000_000
MAX_DIMENSION = 2048


def evaluate_binary_masks(prediction, reference, affine_ras, *, spatial_units):
    """Compare same-grid masks; annotations are reference evidence, not truth.

    Spatial correspondence is the caller's separately verified responsibility.
    No resampling or alignment is inferred. Undefined overlap for two empty
    masks and undefined centroid distance are represented by None.
    """
    import numpy as np

    if spatial_units != "mm":
        raise ValueError("Evaluation requires explicit mm units")
    arrays = [np.asarray(prediction), np.asarray(reference)]
    if any(a.ndim != 3 or min(a.shape) < 1 or max(a.shape) > MAX_DIMENSION for a in arrays):
        raise ValueError("Invalid bounded 3D mask grid")
    if arrays[0].shape != arrays[1].shape:
        raise ValueError("Mask grids must have the same shape")
    if arrays[0].size > MAX_VOXELS:
        raise ValueError("Mask grid voxel bound exceeded")
    if any(a.dtype.kind not in "biuf" or not np.all((a == 0) | (a == 1)) for a in arrays):
        raise ValueError("Evaluation requires finite binary masks")
    try:
        affine = np.asarray(affine_ras, dtype=np.float64)
    except (ValueError, TypeError):
        raise ValueError("Invalid affine") from None
    if (
        affine.shape != (4, 4)
        or not np.isfinite(affine).all()
        or not np.array_equal(affine[3], [0, 0, 0, 1])
    ):
        raise ValueError("Invalid homogeneous affine")
    with np.errstate(over="ignore", invalid="ignore", divide="ignore"):
        voxel_volume = float(abs(np.linalg.det(affine[:3, :3])))
    if not math.isfinite(voxel_volume) or voxel_volume <= 0:
        raise ValueError("Invalid singular or nonfinite affine volume")
    predicted, target = [a == 1 for a in arrays]
    predicted_count = int(np.count_nonzero(predicted))
    reference_count = int(np.count_nonzero(target))
    overlap = int(np.count_nonzero(predicted & target))
    false_positive = predicted_count - overlap
    false_negative = reference_count - overlap
    union = predicted_count + reference_count - overlap

    def centroid(mask, count):
        native = []
        for axis, size in enumerate(mask.shape):
            marginal = mask.sum(axis=tuple(a for a in range(3) if a != axis))
            native.append(float(np.arange(size) @ marginal) / count)
        with np.errstate(over="ignore", invalid="ignore"):
            world = (affine @ np.array([*native, 1.0]))[:3]
        if not np.isfinite(world).all():
            raise ValueError("Affine produces nonfinite centroid coordinates")
        return world

    distance = None
    if predicted_count and reference_count:
        delta = centroid(predicted, predicted_count) - centroid(target, reference_count)
        distance = math.hypot(*delta)
    predicted_volume = predicted_count * voxel_volume
    reference_volume = reference_count * voxel_volume
    if not all(
        math.isfinite(v)
        for v in [predicted_volume, reference_volume] + ([] if distance is None else [distance])
    ):
        raise ValueError("Affine produces nonfinite agreement metrics")
    total_foreground = predicted_count + reference_count
    return {
        "true_positive_voxels": overlap,
        "false_positive_voxels": false_positive,
        "false_negative_voxels": false_negative,
        "true_negative_voxels": int(predicted.size) - union,
        "prediction_foreground_voxels": predicted_count,
        "reference_foreground_voxels": reference_count,
        "dice": 2 * overlap / total_foreground if total_foreground else None,
        "intersection_over_union": overlap / union if union else None,
        "prediction_volume_mm3": predicted_volume,
        "reference_volume_mm3": reference_volume,
        "centroid_distance_mm": distance,
    }
