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
):
    """Run actual SAM 2.1 tiny on one RGB uint8 native-image plane.

    Installation selects the model path, never an untrusted product request.
    Output is an unaccepted candidate mask in input row/column order. Model
    quality score is not an aneurysm probability or a calibrated confidence.
    No anatomical location, physical units, 3D propagation or clinical validity
    is inferred. A new predictor prevents cross-case image-embedding reuse.
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
    predictor = SAM2ImagePredictor(_cpu_model(str(checkpoint_path)))
    with torch.inference_mode():
        predictor.set_image(np.ascontiguousarray(image))
        masks, scores, _ = predictor.predict(
            point_coords=np.asarray(prompt["points"], dtype=np.float32) if points else None,
            point_labels=np.asarray(prompt["labels"], dtype=np.int32) if points else None,
            box=np.asarray(prompt["box"], dtype=np.float32) if box is not None else None,
            multimask_output=True,
        )
    if len(masks) != len(scores) or not len(scores) or not np.isfinite(scores).all():
        raise RuntimeError("SAM returned invalid candidate scores")
    best = int(np.argmax(scores))
    mask = np.asarray(masks[best], dtype=np.uint8)
    if mask.shape != image.shape[:2] or not np.isin(mask, [0, 1]).all():
        raise RuntimeError("SAM returned an invalid candidate mask")
    return {
        "mask": mask,
        "score": float(scores[best]),
        "method": "sam2_prompted_slice_refinement",
        "model_revision": SAM2_TINY_REVISION,
        "model_sha256": SAM2_TINY_CHECKPOINT.sha256,
        "prompt_provenance": prompt_provenance,
        "automatic_aneurysm_detection": False,
        "accepted": False,
    }
