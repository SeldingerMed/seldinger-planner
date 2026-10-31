"""Fresh prompt contract for upstream SAM 2.1, not an aneurysm detector.

Prompts are in native 2D image pixel coordinates (x=column, y=row). Callers
must map these to the source voxel grid and preserve case/revision identity.
The optional ML runtime is imported only when actual refinement is requested.
"""

import math
from functools import lru_cache
from numbers import Real
from pathlib import Path

from planner.model_assets import CheckpointSpec, verified_checkpoint

SAM2_TINY_CHECKPOINT = CheckpointSpec(
    156008466,
    "7402e0d864fa82708a20fbd15bc84245c2f26dff0eb43a4b5b93452deb34be69",
)
SAM2_TINY_REVISION = "de431c4043854a71d8101e17995dfe596bf101a5"


class PromptError(ValueError):
    """A prompt is invalid or has no object seed."""


def _coordinate(value):
    if isinstance(value, bool) or not isinstance(value, Real) or not math.isfinite(value):
        raise PromptError("Prompt coordinates must be finite numbers")
    return float(value)


def normalize_prompts(width, height, points, labels, box=None):
    """Validate one bounded native-image frame without silently clipping prompts."""
    if any(type(v) is not int or not 1 <= v <= 2048 for v in (width, height)):
        raise PromptError("Image dimensions must be integers within 1..2048")
    if len(points) > 64 or len(points) != len(labels):
        raise PromptError("Provide matching points/labels, at most 64")
    normalized = []
    for point in points:
        if len(point) != 2:
            raise PromptError("Points require x and y")
        x, y = (_coordinate(v) for v in point)
        if not 0 <= x < width or not 0 <= y < height:
            raise PromptError("Point lies outside the image")
        normalized.append([x, y])
    if any(type(label) is not int or label not in (0, 1) for label in labels):
        raise PromptError("Point labels must be integer 0 or 1")
    normalized_box = None
    if box is not None:
        if len(box) != 4:
            raise PromptError("Box requires x0,y0,x1,y1")
        normalized_box = [_coordinate(v) for v in box]
        x0, y0, x1, y1 = normalized_box
        if not (0 <= x0 < x1 < width and 0 <= y0 < y1 < height):
            raise PromptError("Box must have positive area within the image")
    if 1 not in labels and normalized_box is None:
        raise PromptError("Provide a positive point or a box")
    return {"points": normalized, "labels": list(labels), "box": normalized_box}


def _validate_initial_mask(image, initial_mask):
    """Validate a caller-supplied binary prior before any model is loaded.

    Requires an actual ndarray, 2D, matching the image row/column shape, with
    finite values that are exactly binary before any integer coercion. No
    physical-unit or source-format inference is performed.
    """
    import numpy as np

    if not isinstance(initial_mask, np.ndarray):
        raise PromptError("initial_mask must be a numpy ndarray")
    if initial_mask.ndim != 2 or initial_mask.shape != image.shape[:2]:
        raise PromptError("initial_mask must be 2D and match the image rows and columns")
    if initial_mask.dtype.kind == "f":
        if not np.isfinite(initial_mask).all():
            raise PromptError("initial_mask values must be finite")
    elif initial_mask.dtype.kind not in ("b", "i", "u"):
        raise PromptError("initial_mask must have a numeric dtype")
    if not np.isin(initial_mask, (0, 1)).all():
        raise PromptError("initial_mask values must be exactly binary 0 or 1")
    return initial_mask


def _mask_to_logit_input(binary_mask):
    """Convert a validated binary prior to SAM2's low-resolution logit input.

    Upstream SAM2ImagePredictor.predict accepts ``mask_input`` of form 1xHxW
    float logits (typically 1x256x256, from a previous prediction iteration),
    passed to the mask decoder as a low-resolution prior. This construction is
    an explicit derived heuristic: bilinear resize with align_corners=False to
    256x256, then linearly mapped to +4/-4 logits. It is NOT asserted to be
    equivalent to a prior decoder's learned mask logits.
    """
    import numpy as np
    import torch
    from torch.nn.functional import interpolate

    mask = torch.from_numpy(np.ascontiguousarray(binary_mask)).to(torch.float32)[None, None]
    # Same half-pixel geometry as upstream SAM2Transforms.postprocess_masks.
    resized = interpolate(mask, size=(256, 256), mode="bilinear", align_corners=False)
    return ((resized[0] * 2.0 - 1.0) * 4.0).numpy()


@lru_cache(maxsize=1)
def _cpu_model(checkpoint_path):
    from sam2.build_sam import build_sam2

    # Upstream loader accepts a file object and uses weights_only=True. Keep the
    # verified descriptor open until deserialization, rather than reopening it.
    with verified_checkpoint(Path(checkpoint_path), expected=SAM2_TINY_CHECKPOINT) as stream:
        return build_sam2(
            "configs/sam2.1/sam2.1_hiera_t.yaml",
            ckpt_path=stream,
            device="cpu",
            apply_postprocessing=False,
        )


def refine_slice(
    image,
    *,
    points,
    labels,
    checkpoint_path,
    prompt_provenance,
    box=None,
    initial_mask=None,
    predictor_factory=None,
):
    """Run actual SAM 2.1 tiny on one RGB uint8 native-image plane.

    Installation selects the model path, never an untrusted product request.
    Output is an unaccepted candidate mask in input row/column order. Model
    quality score is not an aneurysm probability or a calibrated confidence.
    No anatomical location, physical units, 3D propagation or clinical validity
    is inferred. A new predictor prevents cross-case image-embedding reuse.

    ``initial_mask`` is an optional native row/column binary prior of the same
    shape as the image. When supplied, it is converted to the predictor's
    low-resolution logit convention (see ``_mask_to_logit_input``) and passed
    as ``mask_input`` alongside the point/box prompts. Initialized corrections
    select the highest model-quality score among masks satisfying the nearest
    native sampled point labels, or fail if none do. No-prior selection remains
    highest-score. This is not a boundary-quality or clinical guarantee.
    The logit construction is an explicit derived heuristic, not a prior decoder's learned logits.
    ``predictor_factory`` is a test seam only: it builds the predictor and must
    be left unset in product callers.
    """
    import numpy as np
    import torch
    from sam2.sam2_image_predictor import SAM2ImagePredictor

    if not isinstance(image, np.ndarray) or image.dtype != np.uint8:
        raise PromptError("SAM input must be an RGB uint8 array")
    if image.ndim != 3 or image.shape[2] != 3:
        raise PromptError("SAM input must have shape rows,columns,3")
    prompt = normalize_prompts(image.shape[1], image.shape[0], points, labels, box)
    if prompt_provenance not in (
        "operator_entered",
        "reference_derived",
        "detector_derived",
        "synthetic_fixture",
    ):
        raise PromptError("Explicit recognized prompt provenance is required")
    mask_input = None
    if initial_mask is not None:
        mask_input = _mask_to_logit_input(_validate_initial_mask(image, initial_mask))
    if predictor_factory is None:
        # Product path: verified-load the pinned checkpoint and wrap it in a
        # fresh predictor to prevent cross-case image-embedding reuse.
        predictor = SAM2ImagePredictor(_cpu_model(str(checkpoint_path)))
    else:
        # Test seam only: no checkpoint is opened or loaded.
        predictor = predictor_factory(checkpoint_path)
    with torch.inference_mode():
        predictor.set_image(np.ascontiguousarray(image))
        masks, scores, _ = predictor.predict(
            point_coords=np.asarray(prompt["points"], dtype=np.float32) if points else None,
            point_labels=np.asarray(prompt["labels"], dtype=np.int32) if points else None,
            box=np.asarray(prompt["box"], dtype=np.float32) if box is not None else None,
            mask_input=mask_input,
            multimask_output=True,
        )
    masks = np.asarray(masks)
    scores = np.asarray(scores)
    if scores.ndim != 1 or not len(scores) or not np.isfinite(scores).all():
        raise RuntimeError("SAM returned invalid candidate scores")
    if masks.shape != (len(scores), *image.shape[:2]) or not np.isin(masks, [0, 1]).all():
        raise RuntimeError("SAM returned invalid candidate masks")
    eligible = list(range(len(scores)))
    if initial_mask is not None:
        # The generic model's highest quality score can contradict an explicit
        # include/exclude correction. Never silently choose that contradiction.
        samples = [
            (min(image.shape[0] - 1, round(y)), min(image.shape[1] - 1, round(x)), label)
            for (x, y), label in zip(prompt["points"], prompt["labels"])
        ]
        eligible = [
            index
            for index in eligible
            if all(masks[index, row, col] == label for row, col, label in samples)
        ]
        if not eligible:
            raise RuntimeError("No SAM correction satisfies the requested point labels")
    best = max(eligible, key=lambda index: float(scores[index]))
    mask = np.asarray(masks[best], dtype=np.uint8)
    return {
        "mask": mask,
        "score": float(scores[best]),
        "method": "sam2_prompted_slice_refinement",
        "model_revision": SAM2_TINY_REVISION,
        "model_sha256": SAM2_TINY_CHECKPOINT.sha256,
        "prompt_provenance": prompt_provenance,
        "automatic_aneurysm_detection": False,
        "initial_mask_used": initial_mask is not None,
        "point_constraints_satisfied": True if initial_mask is not None else None,
        "candidate_selection": (
            "highest_score_among_nearest_native_point_satisfying_masks"
            if initial_mask is not None
            else "highest_mask_quality_score"
        ),
        "accepted": False,
    }
