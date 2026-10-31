# Case-bound inference: real API and browser verification

Internal engineering receipt for the slice following `c65273619544e7b9eb8da199cd6d3710b0ddc6a8`. This is a functional local prototype slice, not clinical validation, a complete aneurysm-planning application, or a deployed product. Independent worker/API review has been reconciled; publication and exact-head CI are separate checks.

## Exercised path

The real browser at `http://127.0.0.1:5173` loaded the independently acquired CMHA AHMU1218001 public context crop, used the new case-bound API, invoked actual installed models through the separate Python worker, hash-verified returned NIfTI bytes, and rendered masks as overlays. The public source is CC BY 4.0, Song et al. (2024), DOI `10.6084/m9.figshare.26965450.v1`.

- Actual SAM button produced a red candidate preview. The operator-confirmed crosshair was in a curated-reference case and may be reference-informed. The output explicitly says `single_native_axial_slice`, not a full 3D sac. Acceptance persisted candidate `dCbmy-XJBk554hrJhwm5wA`, segmentation revision 1, case artifact revision 3. Mask GET returned HTTP 200, 19498 bytes. Source units remain unknown.
- Actual vessel-model button produced a green trained-vessel preview through the full worker/API/UI path in 41.66315337456763 seconds observed by the browser loop. Acceptance persisted candidate `jelZ1_3DpLUP16686ad2ng`, segmentation revision 2, case artifact revision 4. The full-volume mask has 12236 foreground voxels; GET returned HTTP 200, 27318 bytes. Its hash is `b76b7408273957927b5ef09f1cdffc41e663ee33ec68059c8667c7bf901747b8`, exactly matching the earlier independently exercised direct adapter result.
- Acceptance of the vessel candidate preserved the separate accepted SAM record. Both roles reappeared after reload and reopening the original public CTA. The vessel overlay rendered again without rerunning the model.
- A fresh real SAM preview was rejected through the UI. Readback preserved case revision 4 and both previously accepted candidate IDs.
- Captured views show native-image-linked green vessel overlays and a localized red SAM candidate, not an empty/full-frame result or obvious gross shift. No clinical boundary or registration accuracy is inferred from that inspection.

Case ID: `WzFtr9iVULfwb0B6HB2KGg`. Original image hash: `98cf6634833acf722a0bd084a4bbe9b5c4545954b3c9759c1003b225086ecb0c`.

Ignored receipts and image: `artifacts/model-integration/{sam-api-browser.json,vessel-api-browser-preview.json,vessel-api-browser-accepted.json,rejection-browser.json,model-accepted-browser.png}`. The initial relative browser-receipt writes landed in the browser interpreter's cwd rather than its reported workspace. Parent located, identity-checked and moved only those four generated files into the intended ignored artifact directory, leaving no such files behind in the Hermes checkout.

## Parent reconciliation of incoming patches

The API child stopped at its iteration cap with a broken test decorator/fixture refactor. Parent repaired collection, tuple identities, fixture directory ownership and invalid-output tests. Parent then reproduced and fixed real contract defects before exercising the browser:

- Worker confused manifest revision with image SHA. Its original real-model test repeated that wrong input and therefore did not prove API compatibility. The corrected test computes the actual manifest-byte SHA and the worker now compares it separately from image identity.
- API accepted numeric strings and Boolean display-window values. Strict numeric schemas now reject them.
- Stale previews remained downloadable after a case edit. That route now refuses them with 409.
- Case dimensions were not compared against the installed reference crop. They are now bound to the source manifest.
- SAM requests are restricted to the sac-role single-slice preview in this slice, so they cannot overwrite a full-volume accepted vessel record.

At initial browser verification, 247 base and 18 separately enabled ML tests passed. After review hardening, 248 base tests and 20 separately enabled vessel/SAM-runtime tests passed, including actual SAM child-process execution using the corrected reference identity. Frontend: 34 tests passed; TypeScript/production build passed and production dependency audit reported zero vulnerabilities. The separate aneurysm runtime additionally passed one real-weight synthetic architecture test. Base CI intentionally skips opt-in model tests. Upstream PyTorch emits a `torch.jit.script` deprecation warning; Vite reports large imaging chunks. Neither is hidden as a failed experiment or converted into a clinical claim.

## Independent review and parent follow-up

Read-only review `deleg_ba0018da` found no blocking issue within the inspected worker/API scope. Parent subsequently added a fault-injected concurrent save exactly between final case readback and `ledger.preview`; the unmodified API raised an uncaught `SegmentationConflict`. The observed RED was fixed to return HTTP 409, and all 36 API tests passed. A conflict may leave an unreferenced content-addressed blob, but never an accepted candidate; do not describe every failure as zero filesystem side effects.

Parent reproduced both oversized and symlinked worker metadata acceptance before fixing it. Metadata is now checked before opening and read with a 32769-byte cap for a maximum 32768-byte payload. The focused tests and all 20 vessel/SAM-runtime tests passed. Subprocess shell execution is explicitly disabled and the intentional isolated `PYTHONPATH` is documented. Half-voxel banker's-rounding behavior remains a nonblocking documented ambiguity, not a clinically validated plane-selection rule.

## Remaining boundaries

- Inference currently supports only the installed original public reference crop. Arbitrary uploaded/browser-local cases are not sent to the worker.
- The vessel preprocessing uses original pinned Nyul targets, upstream TorchIO and actual nnU-Net. The original training TorchIO version/cohort equivalence is not established, context-ROI normalization differs from a full head, no TTA is used, and physical source units remain unknown.
- SAM does not automatically localize aneurysms, propagate 3D contours, or establish volumetric morphometry eligibility. Existing 3D-mask splice corrections and clinical improvement studies remain unimplemented.
- Case acceptance is revisioned and resets stale UI discussion state. Actual geometry/sizing derived-artifact stores and dependency invalidation remain unfinished, not proved by metadata validity flags.
- Geometry and historical device-rule cores exist but are not yet a complete source-linked measurement/sizing product. Millimeter measurements remain disabled for this source.
- Automatic aneurysm case inference remains open. Original second-place RSNA training code publishes full segmentation architecture and states Apache 2.0 for code/weights. Its linked Docker deployment omits a segmentation decoder, but the original full Kaggle checkpoint has now been acquired independently and executed on a synthetic tensor through both segmentation heads. See `model-foundations.md`. CTA preprocessing, actual public-case inference, measured performance and product integration remain separate acceptance steps.
