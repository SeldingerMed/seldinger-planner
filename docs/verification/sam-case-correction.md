# Existing-mask SAM correction in the application

Internal local-prototype evidence after `c96c0a9`, not clinical validation, improved boundary accuracy, 3D model propagation or completion of every requested planning capability. Source-publication revision and final independent-review reconciliation are separate.

## Actual product flow

Parent reopened original public CMHA case `WzFtr9iVULfwb0B6HB2KGg`, artifact 5, with accepted trained aneurysm `xgiMbCbHle1DyMt2y60GEw` and accepted vessel `jelZ1_3DpLUP16686ad2ng`. The real browser button supplied the opaque accepted base identifier, current artifact/reference identities, native-space crosshair and point polarity. API selected and verified the base, then executed the actual pinned SAM2.1 worker. No fixture response was used.

- Include preview `u59a4hJ4IMk-Jy5Q8t_Aug` was explicitly rejected. Exact API/ledger readback preserved artifact 5 and both accepted identities; rejected mask route returned 404.
- Initial exclusion preview `0aXu9VAIlE1Ya20R6St0eQ` also was rejected after parent found it still included the nearest selected background voxel. Do not report this preview as a successful exclusion.
- Parent reproduced that defect through the actual original predictor: three raw masks had point values `[1,0,1]`, with the contradictory third mask having the largest model-quality score. This was a selection bug for explicit correction intent, not evidence that a higher score meant better anatomy.
- A failing regression reproduced score-only misselection. Initialized correction now selects the highest score among exactly binary masks satisfying all supplied nearest-native sampled point labels, or fails if none qualifies. No-prior selection remains highest-score; no clinical score threshold was invented.
- Real repaired exclusion preview `nrdMTRnhw404jgnDYNWcSQ` used the same trained base, native slice 72 and background prompt. Parent independently verified output voxel `[86,91,72]` is zero, original slice foreground 74 became 169, 183 voxels changed in that slice, and **all other slices match exactly**. Saved affine, units and payload hash were checked.
- Repaired whole-mask hash: `1448cb89a539ce4e474e53f7758ffb9ff479022aa865fd9f6a4042fadccd6bf1`; whole-mask foreground 412. The chosen model-quality score was `4.43373865399721e-10`, not a calibrated lesion probability. Point compliance does not establish boundary quality or improvement.
- Explicit browser acceptance returned case artifact **6**, segmentation revision **4**. A fresh page reload/source reopen restored that accepted SAM candidate and the unchanged accepted vessel. The former trained base is retained as `superseded`; both rejected previews are retained as `rejected`.
- Source units remain `unknown`. Millimeter measurement controls remained disabled. This different pipeline state does not borrow calibration from case 006.

This was an automated technical workflow test on an approved public case, not clinician acceptance or approval for patient care. Curated surfaces were switched off during overlay inspection. No browser runtime errors or alert banners were recorded on final reopen. The saved public-case screenshot shows the red accepted model overlay, not a curated-reference contour.

## Usability and contract repairs

The initial four-button row overflowed the real 1200-pixel viewport. Parent's bounds assertion stopped before model submission; the source-state readback confirmed no request occurred. The correction action was moved to a full-width row and the selector themed; a fresh bounds check passed at x927/y435.921875, width257/height35 before submission. A source-code/layout failure was not mislabeled a model failure.

Inference waits for the accepted-mask snapshot before enabling controls. An unresolved preview prevents a replacement run. Existing accepted aneurysms disable the unseeded single-slice mode, and the API also rejects that unsafe replacement route. A normal initial SAM preview remains available when no accepted aneurysm exists. API/worker failures remain unaccepted and revision-bound.

## Durable prompt provenance

A subsequent test-first hardening added actual RAS input, native floating I/J plus selected integer K, and native prompt-box XYXY to worker metadata, alongside the already recorded polarity/window/base identity. The earlier accepted artifact is not retroactively rewritten: its complete request is retained in the browser receipt. Parent exercised a fresh real API correction `_Ul_iHFy3-0f-1mVKOV5yg` against the current accepted SAM base, verified those metadata fields, then rejected it and read back unchanged artifact 6/current accepted identity. Canonical receipt: `sam-durable-prompt-api-readback.json`.

## Scope of invalidation

Acceptance increments the real case version. Existing ledger metadata marks derived geometry/sizing invalid. **No computed geometry/sizing result was actually invalidated**, because those product pipelines do not exist yet. Do not upgrade those flags into an end-to-end dependency-invalidation claim. That remains part of the unfinished morphometry/sizing integration.

## Verification and receipts

Observed final checks before publication: 261 base tests passed, 65 opt-in tests skipped there; 43 tests passed in the original ML runtime and 22 passed in the separate aneurysm runtime. Frontend 38 tests, TypeScript/production build, Ruff/check/format and production dependency audit passed. Upstream TorchScript deprecation and Vite large-chunk warnings remain.

Ignored receipts under `artifacts/model-integration/`: `sam-ui-first-preview.json`, `sam-ui-first-rejected.json`, `sam-ui-second-preview.json`, `sam-negative-candidate-diagnostic.json`, `sam-ui-repaired-preview.json`, `sam-api-repaired-mask-readback.json`, `sam-ui-accepted.json`, `sam-accepted-api-ledger-readback.json`, `sam-ui-reopened.json`, `sam-ui-reopened.png`, and final XML test reports. The older standalone-worker and initial pre-repair mask-readback receipts remain archival failures/smoke evidence, not final outcome records.

A factual current-slice update to protected `AGENTS.md` was denied by the instruction-file approval boundary. No retry or alternate-path write was attempted; the file remains unchanged and its final current-slice paragraph describes an earlier stage. The standing safety/data/reuse rules remain in force. This verification note records observed software behavior without changing those instructions.

Clinical validation, independent full-head localization/evaluation, calibrated product sac/neck/parent-vessel geometry, integrated source-versioned device sizing and real downstream invalidation remain unfinished.
