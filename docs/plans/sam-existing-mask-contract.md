# Existing-mask SAM correction tracer

Internal implementation contract. No clinical validation, 3D model propagation or external deployment claim. Use original pinned SAM2.1 tiny and existing fresh-repo code only.

## First layer: slice predictor

Owning files: `planner/sam_refinement.py`, `tests/ml_runtime/test_sam_model.py`. Extend `refine_slice` with optional `initial_mask=None`, a native row/column binary array with the same dimensions as the RGB image. Preserve all existing callers and validation. Validate supplied mask before loading a model: actual ndarray, 2D matching shape, finite and exactly binary before any integer coercion. Do not infer source physical units.

Inspect the installed original SAM2 predictor/preprocessing for the correct prior-mask coordinate convention. Convert this binary mask to the predictor's actual low-resolution logit input, without new weights or an image/volume mock being reported as real inference. Pass derived `mask_input` for supplied priors and None otherwise. Name the binary-to-logit construction as a heuristic, not learned decoder logits or a proven equivalent. Preserve raw model-quality score semantics, but for initialized correction select the highest score among binary candidates satisfying the supplied nearest-native point labels, or fail if none qualifies. This repair follows an observed real negative prompt contradicted by simple argmax; it does not establish boundary quality. Return explicit `initial_mask_used` and selection provenance; a quality score remains not lesion probability.

Use strict test-first RED/GREEN vertical slices. Tests can inject the predictor for argument/validation assertions, but retain an opt-in actual SAM forward with a supplied synthetic prior and label it synthetic. Run the current optional runtime (`SELDINGER_RUN_MODEL_TESTS=1 PYTHONPATH="$PWD" .runtime/ml-runtime/bin/python -m pytest tests/ml_runtime/test_sam_model.py -q`). Do not install packages, read .env, download models, change worker/API/UI, commit/push, or inspect other repositories. Parent owns the composed product path and final exact-target verification.

## Subsequent composed product acceptance

Server-selected accepted base must belong to the same case/reference/image, match the requested role and still be the current accepted revision. Caller supplies only an opaque candidate identifier, never a file path. Worker independently verifies the server-selected base mask blob/hash/shape/affine and passes only the selected native slice as `initial_mask`.

The resulting preview is a copy of the complete accepted 3D mask with exactly that native slice replaced, not a zero-filled volume that erases the other slices. Preserve every untouched voxel. Metadata records base candidate/hash, edited native slice and original model provenance, prompted operator correction, no 3D propagation and no clinical validation. Accept/reject remains explicit and revisioned; stale/cross-case/superseded bases and malformed outputs fail closed. Acceptance invalidates downstream geometry/sizing through the existing version/change contract. UI must distinguish first-time prompted previews from correction of the accepted mask.
