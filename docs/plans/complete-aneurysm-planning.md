# Complete aneurysm-planning implementation plan

> **For Hermes:** Follow the Hermes-native engineering harness and TDD. Keep a single controlled writer; use independent bounded evidence and verification children. Do not import legacy application code, configuration or assets.

**Goal:** Build an exercised CTA-first workflow spanning owned vessel inference, aneurysm localization/segmentation, editable lesion geometry, source-backed device sizing and SAM correction.

**Architecture:** Retain the new browser workspace and case API. Add a separate local ML runtime and case-scoped, bounded inference jobs whose inputs/outputs are bound to image hashes, model/preprocessing identity and segmentation revision. Keep curated annotations, trained predictions and accepted manual edits as distinct artifacts. Derive geometry and sizing from accepted artifact revisions, invalidating dependent results on edits. Do not send imaging to hosted Muse. Unknown calibration blocks numerical millimeter sizing for that case, not all engineering or model work.

**Tech stack:** Existing React/TypeScript/NiiVue and FastAPI/SQLite; independently installed upstream ML/imaging packages in an isolated runtime; fresh Python adapters. Use the owned checkpoint from its pinned original registry, not a copied legacy checkpoint. No cloud deployment or spend is implied.

## Acceptance boundaries

- Real model execution must precede any claim of model integration. Synthetic forward tests are smoke tests, not real-image performance evidence.
- A binary vessel model is not an aneurysm detector. Lesion localization and sac segmentation need explicit producer identities and evaluation.
- Analytically correct geometry is not clinical validation. Report analytic fixture errors, public-reference errors and any clinician/reference study separately.
- Preserve original image values/geometry/calibration provenance. Never silently infer millimeters from one unit-unspecified source.
- Device outputs are source-backed nominal dimensions and explicit geometric checks, not treatment recommendations or deployment simulations. Record IFU revision, source pages, missing inputs and rule rationale.
- SAM edits require actual supported prompts/model execution; preserve pre-edit output, accepted/rejected status, operator provenance and downstream invalidation.
- Keep all source data, model weights, runtime environments, predictions and credentials out of git.

## 1. Owned vessel integration

Files: new `planner/model_assets.py`, `planner/inference.py`, isolated worker module, matching tests; later extend `planner/server.py` and browser case controls.

1. Acquire pinned `txmedai/seldinger-pooled-vessel-v1` revision `4f8253e0537770a7751916d274d3b83133bca8ff` checkpoint and verify actual byte size/SHA before loading.
2. Resolve original architecture, trainer, spacing and Nyul-plus-zscore contract from original metadata. Record unresolved fields explicitly; do not pretend a guessed transform is training-equivalent.
3. Write failing tests for artifact verification, label semantics, case/image binding and geometry-preserving mask return.
4. Implement the fixed artifact manifest/loader and separate, bounded local worker. No arbitrary model code or caller-selected filesystem tools.
5. Execute synthetic geometry/model forward smoke, then the authorized public CTA; inspect real masks, geometry, non-degeneracy, runtime and resource use.
6. Wire source-linked output into the viewer and case state, clearly distinct from curated references. Verify real UI behavior, cancellation/stale-result rejection and failure recovery.

## 2. Automatic aneurysm localization and segmentation

Files: new model-specific adapter/configuration and tests, lesion candidate/state contracts and UI.

1. Verify actual available upstream checkpoint, license, CTA modality, input normalization and detection/segmentation semantics.
2. Add RED/GREEN model-adapter and native-grid restoration tests.
3. Run real inference, not oracle prompts from reference labels. Keep reference/oracle-assisted tests separate.
4. Persist proposals with producer/score/limitations, allow acceptance/rejection and display candidate sac segmentation.
5. Measure localization, false positives and segmentation/neck-boundary accuracy against independently identified references. A smoke run does not establish a validated detector.

## 3. Measurement geometry and validation

Files: new `planner/morphometry.py`, analytic fixture tests, public-reference evaluation scripts, evidence UI.

1. Define explicit sac/neck-plane and parent cross-section contracts; record whether neck/centerline was automatic or operator-defined.
2. RED/GREEN plane/mesh intersections, sac height/width, neck contour dimensions and centerline-normal parent sections on analytic geometries, including anisotropy/obliquity.
3. Handle open surfaces, multiple loops, disconnected masks, clipped branches and uncertain necks as explicit failure/uncertainty states.
4. Preserve affine and calibration provenance. Enable mm only with corroborated units; source-unit geometry may remain inspectable without device sizing.
5. Evaluate against public curated/reference geometry and then independently defined reference measurements. Record error, repeatability and failure cases before stronger validation claims.

## 4. Device catalog and sizing

Files: new typed catalog/rules modules, source records and tests; sizing workspace component.

1. Retrieve original manufacturer/FDA labeling for a minimal intrasaccular and flow-diverter catalog. Verify exact model IDs, nominal dimensions and sizing instructions.
2. RED/GREEN provenance/schema validation, explicit unit requirements, missing-data behavior and boundary/range checks.
3. Implement traceable geometric checks with exact rule/source references. Do not extrapolate beyond IFU or interpret a range pass as clinical suitability.
4. Bind each result to accepted geometry, calibration, clinical-input and catalog revisions. Invalidate on changes.
5. Exercise actual source-backed entries using analytic cases, edge cases and a corroborated real-image case. Keep source-unit-unknown cases blocked from mm sizing without blocking the other workflows.

## 5. SAM correction

Files: new prompt/model adapter, edit ledger/API and frontend correction controls with tests.

1. Verify checkpoint/runtime and supported 2D/3D prompt interfaces from original upstream documentation.
2. RED/GREEN prompt coordinate transforms, positive/negative points/boxes, output-grid return and cancellation/stale-result handling.
3. Run actual prompted inference on synthetic then authorized public image crops. Do not present a copied reference mask as a SAM result.
4. Support preview, accept/reject and immutable edit provenance. Invalidate measurements/sizing/briefs on accepted edits.
5. Compare baseline versus corrected masks on frozen cases with boundary/neck error and interaction/time records, not Dice alone.

## Final verification

For each vertical slice: narrow RED/GREEN, broad backend/frontend/type/lint/build checks, actual worker/API/UI exercise, independent review, staged credential/artifact scan, commit/push and exact-head CI. Keep the PR draft until the separate merge gate is met. Final demonstration must show the real pipeline and distinguish functional, candidate and validated evidence levels.
