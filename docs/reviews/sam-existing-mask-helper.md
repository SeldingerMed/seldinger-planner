# Review: optional `initial_mask` prior in `refine_slice`

**Historical incoming-helper report, not the final implementation/release review.** Parent subsequently reproduced and fixed its module-level NumPy import (base environment intentionally has no NumPy), replaced corner-aligned custom interpolation with upstream-compatible half-pixel Torch interpolation, and repaired point-contradicting argmax selection for initialized correction. Worker/API/browser composition is now independently exercised. See `docs/verification/sam-case-correction.md` for the final evidence and remaining gaps. The leaf's RED/GREEN report below is retained as reported; it does not establish a vertical one-behavior-at-a-time TDD sequence or base-suite compatibility.

Scope: first layer only of `docs/plans/sam-existing-mask-contract.md`. Volume splice, worker handoff, and composed-product acceptance are NOT implemented (parent owns them).

## Changed files

- `planner/sam_refinement.py`
- `tests/ml_runtime/test_sam_model.py`

## Source convention (read from installed upstream)

`sam2/sam2_image_predictor.py` (installed `.runtime/ml-runtime`): `predict(..., mask_input=None)` accepts a low-resolution mask-logit array of form `1xHxW` (typically `1x256x256`), "typically coming from a previous prediction iteration". `_prep_prompts` converts a 3D array to 4D and passes it to the mask decoder as a prior. Prompts (points XY, box XYXY) and `multimask_output=True` are unchanged.

## Implementation

- `initial_mask=None` keyword on `refine_slice`; `initial_mask_used` boolean in the result.
- Validation runs before any model load: actual `np.ndarray`, 2D, exact image row/column shape, finite (float dtype), numeric dtype, and values exactly in {0,1} pre-coercion. Malformed/fractional/NaN/object values raise `PromptError` and never reach `_cpu_model`.
- `_mask_to_logit_input` builds `1x256x256` float32 logits: numpy bilinear downsample of the binary prior to 256x256, mapped linearly to +4/-4. Documented as an explicit derived heuristic — NOT claimed equivalent to a prior decoder's learned logits.
- `mask_input` is passed only when a prior is supplied. Score selection (`argmax` over multimask scores) and all prior callers unchanged.
- `predictor_factory` test seam: injected tests never open a checkpoint; the product path is unchanged (`SAM2ImagePredictor(_cpu_model(...))`, fresh predictor per call).

## RED/GREEN (observed commands)

RED: `SELDINGER_RUN_MODEL_TESTS=1 PYTHONPATH="$PWD" .runtime/ml-runtime/bin/python -m pytest tests/ml_runtime/test_sam_model.py -q` → 12 failed (new validation/handoff/forward tests plus existing test on missing `initial_mask_used` key).
GREEN: same command → `12 passed` in 1.68s (both actual SAM2 tiny CPU forwards ran; the second uses a deliberately shrunk synthetic prior disk).

## Non-clinical boundaries

Internal tracer only. Prior logits are a heuristic, not learned-logit equivalent. Quality score is not lesion probability. No anatomical/physical-unit inference, no 3D propagation, no clinical validation; results are unaccepted candidates (`accepted: False`).
