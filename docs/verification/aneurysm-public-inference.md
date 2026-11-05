# Actual public-CTA aneurysm inference: local candidate

Internal prototype verification, not clinical validation, a completed detection study, or application integration. Source changes after `49d852826af66ddbb8d2466290150bfadb80a35a` remain a separate review/CI target.

## Actual result

The original full Apache-licensed second-place RSNA checkpoint produced a native 175×180×140 binary aneurysm candidate on the authorized public CMHA AHMU1218001 context crop. The full 224-cubed model-input grid was retained. Successful execution used local MPS float32, no CPU fallback, no TTA and one fold, in **4.551119707990438 seconds** including preparation, verified loading, forward execution, restoration and saved-mask readback.

- Input image SHA-256: `98cf6634833acf722a0bd084a4bbe9b5c4545954b3c9759c1003b225086ecb0c`.
- Output: **317 foreground voxels**, native inclusive bounds `(82,87,68)`–`(91,96,74)`.
- Output SHA-256: `68666d83675e9d2be4f2e13f1efe6fc4140269b48dee2f5940a85ccadf474dc0`.
- Saving/reopening independently preserved every mask voxel, the exact affine and the unknown spatial/time units. Parent rechecked output hash, binary values and foreground count.
- The selected input is the existing **curated-reference-selected context ROI**, not an independently localized full head. No lesion point or box prompt was supplied to this trained model, but input selection remains reference-informed.
- The mask is not accepted in the case ledger and is not yet connected through the product worker/API/viewer.

Source: Song et al., CMHA, CC BY 4.0, DOI `10.6084/m9.figshare.26965450.v1`. Unknown source units remain unknown; this result does not unlock millimeter measurement or device sizing.

## Failed attempts retained

1. Full original float32 CPU public-case run was killed by its 120-second SIGALRM. It produced no mask or result receipt. That initial probe lacked phase instrumentation, so the failing phase is not established.
2. Full original float32 MPS public-case run hit the retained 0.5 recommended-memory fraction at second-decoder `torch.cat`: 10.52 GiB allocated, 1.34 GiB other allocations, 14.04 GiB allowed, next requested allocation 2.68 GiB. No mask was produced. The memory guard was not disabled.
3. Float16 MPS compatibility testing stopped on a synthetic tensor: `ConvTranspose 3D with BF16 or FP16 types is not supported on MPS`. No float16 public-case run was launched.

These failures are not converted into successful inference evidence by the later result. Their engineering conditions differ and remain recorded in `artifacts/model-discovery/aneurysm-local-trials.json`.

## Memory-aware architecture reassessment

The original full forward computes a merged aneurysm/vessel segmentation head, a separate anatomical segmentation head, classification heads and a modality head. The public candidate needs only the first segmentation head. Its branch is independent after the shared decoder stage in the actual published forward.

`aneurysm_head1_graph` traces the original evaluation network, selects its first output and removes unused FX nodes/modules. It does not copy a legacy implementation, retrain, approximate the first head, reduce the 224-cubed input resolution or create a new truncated checkpoint. The whole original checkpoint is still hash-verified and strictly loaded before extraction. Classification, anatomy and modality outputs are deliberately absent; no classification probability is fabricated.

Observed missing-helper RED, then actual original-weight equivalence tests on seeded 64-cubed synthetic tensors passed with **zero absolute and relative tolerance on both CPU and MPS**. Unused second-decoder modules are absent. This verifies those tested executions, not an independently measured full-resolution equivalence study. Full-resolution original MPS execution cannot be directly compared under the same memory cap because it ran out of memory.

The resulting float32 first-head graph completed the real public-case run with the **same 120-second alarm and 0.5 MPS memory fraction**. Parent used its 15-channel logits, restored them to the native oriented grid before argmax, selected merged aneurysm class 14 and inverted LPS/ZYX mapping. No classification score was returned.

## Visual and automated checks

The saved three-plane preview shows a small, nonempty yellow candidate over focal bright image content in sagittal, coronal and axial slices, without an obvious full-frame fill or gross translation. This is a technical visual sanity check, not diagnosis, boundary agreement, lesion accuracy, or registration validation.

Current dedicated-runtime suite: **19 passed**, including actual original-weight full-network smoke, asymmetric orientation/restoration, finite/size guards, overflow rejection and CPU/MPS graph equivalence. Ruff passed. The original vessel/SAM runtime remains separate and unchanged; delayed installation notifications are not new model executions.

Ignored artifacts:

- `artifacts/model-discovery/aneurysm-public-candidate.{json,nii.gz}`
- `artifacts/model-discovery/aneurysm-public-parent-readback.json`
- `artifacts/model-discovery/aneurysm-public-preview.png`
- `artifacts/model-discovery/aneurysm-head-equivalence.xml`
- `artifacts/model-discovery/aneurysm-preprocessing-tests.xml`
- `artifacts/model-discovery/aneurysm-cpu-timeout.json`
- `artifacts/model-discovery/aneurysm-local-trials.json`

Remaining: independent review of the graph extraction, product worker/API/UI integration, realistic full-head ROI selection, independent lesion-level and segmentation evaluation, calibrated-source import, and actual downstream measurement/sizing invalidation. No clinical or treatment-recommendation claim follows from this candidate.
