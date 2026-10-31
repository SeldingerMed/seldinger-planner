# Final aneurysm case-integration review

Internal engineering review reconciliation for the integration content committed at `c96c0a99710c28ea9b5266b0936c7faadf5e1b4d`. This is not an automated code-review-app approval, clinical clearance, whole-codebase review, or permission to merge/deploy.

Independent read-only review `deleg_edeb1c7e` inspected the worker/API/state mapping, fixed predictor wrapper, model panel and related tests. It found **no blocking bug within that scope**. Parent had already exercised the real browser, separate runtime and actual trained model; final composed tests passed 251 base tests, 36 frontend tests and 49 distinct opt-in tests across the two ML runtimes. Exact-head backend/frontend CI passed for the published draft PR.

## Scope-specific conclusions

- API kinds, ledger roles/producers and fixed runtime selection are consistent. Wrong-role producers are rejected before ledger insertion; request data cannot select checkpoint/interpreter paths.
- Existing source/case/reference checks, stale-write/readback handling, nonblocking inference gate, subprocess timeout, metadata bounds and content-addressed blob verification remain.
- The actual aneurysm branch uses the exercised original checkpoint's first segmentation head, preserves source geometry/units and returns a `full_context_roi` candidate with explicit selected-context/nonclinical provenance.
- Acceptance version is checked before frontend candidate/current-overlay mutation. Actual preview, acceptance, reload/reopen and fresh rejection were separately verified, not inferred from mocks.

## Nonblocking findings retained

1. Optional SAM-like fields supplied to the aneurysm API are currently accepted but unused by that model. The server actually preserves a supplied `point_ras` in its internal job; it does not force that value to None as the review summary suggested. The trained branch ignores it and correctly records no prompt provenance. A stricter per-kind request schema remains useful future hardening. The new UI does not send those fields for this kind.
2. "Selected context" means the **entire installed curated reference case volume**, which was already cropped from the original source during source preparation. No new user-selected sub-volume or stage-1 ROI localization occurs inside the predictor.
3. Channel 14 is tied to the fixed registered checkpoint's merged aneurysm head and its explicit loaded configuration. A named constant is useful maintainability hardening, not a new clinical validation requirement.
4. Reject restores an accepted overlay from component state. Existing epoch/version guards prevent attachment to a replaced case; stronger display-preference preservation is a separate usability improvement.

## Evidence boundaries unchanged

Clinical validation, independent full-head localization and held-out lesion/segmentation performance remain absent. Source CMHA units stay unspecified and its millimeter controls remain disabled. Acquiring a different calibrated DICOM series does not calibrate this image. Geometry, device-catalog/sizing and existing-mask SAM-correction workflows remain separate unfinished work.
