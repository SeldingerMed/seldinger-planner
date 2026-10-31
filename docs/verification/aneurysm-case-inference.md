# Aneurysm model in the real application

Internal local-prototype verification, not clinical validation, independent full-head detection, a completed performance study or external deployment. This extends the existing vessel/SAM flow after `49d852826af66ddbb8d2466290150bfadb80a35a`; source publication and exact-head CI are separate checks.

## Exercised application path

Parent used the actual browser at `http://127.0.0.1:5173`, loaded the installed original CMHA AHMU1218001 public context crop, and clicked **Run aneurysm model**. The UI issued the real case-bound API request without a SAM point prompt. The backend selected the fixed separate aneurysm runtime, verified original assets, ran the actual trained head-1 graph on MPS and returned a revision-bound preview. No test runner or synthetic model response was substituted.

Observed request-to-preview duration in the browser polling loop: 5280 milliseconds. HTTP POST returned 200. The candidate has 317 foreground voxels and SHA-256 `68666d83675e9d2be4f2e13f1efe6fc4140269b48dee2f5940a85ccadf474dc0`, exactly matching the earlier direct real-model run and the separately exercised real worker.

- Case: `WzFtr9iVULfwb0B6HB2KGg`.
- Image SHA-256: `98cf6634833acf722a0bd084a4bbe9b5c4545954b3c9759c1003b225086ecb0c`.
- Reference revision: `8b6b5a3a45243084cd6a39b5d2b19e758d6dfb63112eb30feaafc470b47e5f3a`.
- New trained candidate: `xgiMbCbHle1DyMt2y60GEw`, producer `aneurysm_model`, role `aneurysm`, produced on case artifact 4.
- Explicit UI acceptance returned segmentation revision 3 and case artifact **5**.
- A fresh reload/reopen and exact API readback showed that same accepted trained candidate and preserved accepted vessel `jelZ1_3DpLUP16686ad2ng`.
- Earlier SAM candidate `dCbmy-XJBk554hrJhwm5wA` remains in history as `superseded`, not erased or relabeled as trained output.
- A second actual trained candidate, `XWx6kVa1h4S3EdfPAmZRCg`, was rejected through the UI. Independent ledger readback confirms `rejected`; its exact mask route returns 404. Case artifact remains 5 and both accepted IDs remain unchanged.

The browser displayed the red trained overlay with curated reference surfaces disabled, and allowed selection of the accepted aneurysm overlay after reopening. No runtime errors were recorded during preview/accept or the fresh reject check. Source units remain unspecified and millimeter controls stayed disabled. The technical screenshot is not boundary/registration/clinical validation.

Source attribution remains Song et al., CMHA, CC BY 4.0, DOI `10.6084/m9.figshare.26965450.v1`. The input is the existing **curated-reference-selected context ROI**. This run is prompt-free trained segmentation within that crop, not independent full-head lesion localization.

## Integration contracts and parent reconciliation

- Fixed API `kind="aneurysm"` maps to ledger producer `aneurysm_model` and role aneurysm. No product runtime/checkpoint/path/device selection was added.
- The worker chooses `.runtime/aneurysm-runtime/bin/python` only for this kind; vessel/SAM keep their previously exercised runtime. Heavy imports remain child-local and original source identity checks remain.
- The ledger now refuses SAM/aneurysm producers pretending to be vessel, closing a pre-existing role guard gap.
- Parent inspected the actual patches, ran the composed suites, and separately tested the real subprocess worker against the direct mask hash. The child note that the helper was missing was stale: parent had already authored and exercised it.
- Parent added explicit `input_context="server_installed_curated_reference_selected_roi"` metadata after an observed failing regression; `full_context_roi` alone did not communicate input selection adequately.
- Metadata explicitly says no clinical validation, no independent automatic full-head detection and no volumetric-morphometry eligibility. Classification confidence is not fabricated because unused heads were omitted.
- Frontend labels the candidate **Trained aneurysm candidate (3D context)**, not SAM output. Missing acceptance revision is checked before overlay/current-state mutation.

Observed composed checks before final publication: 251 base tests passed; opt-in tests are intentionally skipped there. Frontend 36 tests, TypeScript/production build and production dependency audit passed. The old runtime passed 27 opt-in tests; the new runtime's adapter passed 21 tests, with its actual worker additionally passing one test. Final XML receipts are canonical for subsequent totals. Vite retains its large-chunk warning and upstream PyTorch retains a deprecation warning.

Ignored receipts/screenshots under `artifacts/model-integration/`: `aneurysm-ui-preview.json`, `aneurysm-ui-accepted.json`, `aneurysm-ui-reopened.json`, `aneurysm-ui-rejected-readback.json`, `aneurysm-ledger-readback.json`, `aneurysm-real-worker.xml`, and `aneurysm-model-accepted-browser.png`.

Only the uniquely identified newly created verification tab was closed. A different pre-existing planner tab was left untouched. The original default `Target.getTargetInfo` did not identify the controlled browser tab, so parent resolved the explicit target using the exact current URL/title before closing and verified its disappearance.

## Still open

- Independent lesion-level sensitivity/false-positive and segmentation-boundary evaluation.
- Stage-1/full-head ROI localization and complete published ensemble/TTA equivalence.
- Importing and validating the newly acquired calibrated DICOM case; it does not calibrate this old NIfTI.
- Product sac/neck and orthogonal parent-vessel geometry, current source-versioned device catalogs/rules and real dependency invalidation.
- Existing-mask SAM correction/splice and volumetric refinement. Single-slice prompted previews are not that finished workflow.

The real browser/worker/API exercise establishes a functional local inference slice, not the completion of all five requested capabilities.
