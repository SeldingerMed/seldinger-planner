# Calibrated public context preparation: parent verification

Internal offline preparation only. The application still uses its existing source and has not installed this new context. This is not clinical measurement validation or independent lesion localization.

## Source and actual artifact

- Public deidentified Zenodo record `15697196`, case `006`, CC BY 4.0. Source image was independently decoded from the complete original DICOM series; source mm/HU calibration and STL registration are separate evidence questions.
- Parent source/readback receipts: `artifacts/calibrated-source-discovery/complete-case-006/parent-calibrated-volume.json` and `parent-calibrated-nonpadding-readback.json`.
- Exact compressed source SHA-256: `98ecbcedc625ff1eecdf3a90366a05ec0bc38fd6c4172facbc8bb5bb7d86e9b4`.
- Native crop start `[242,210,166]`, size `[56,77,50]`: 215600 voxels, int32, mm/sec. Selection remains reference-informed candidate context from **unvalidated** XY-flip STL placement. No claim of validated STL frame, units, registration or anatomy follows from the image calibration.
- Parent prepared a fresh `context-v2/` below `.runtime/original-public-source/zenodo-15697196/prepared-case-006/`, preserving the child's v1 output and historical manifest. Image SHA-256 `88f6e5a67dee23439c864d9e32d771fdd24abee55b904b8260fe30e3ddcd40a3`, 312177 bytes. Image bytes match v1; v2 binds manifest geometry to the actual saved affine instead of the pre-serialization matrix.
- Full receipt: `artifacts/calibrated-source-discovery/context-preparation/parent-context-v2-readback.json`. All 215600 saved voxels equal the source crop, dtype/units preserved, actual affine bound to manifest, all eight corner world and inverse-index errors below `1e-5` in their respective units, and five nonpadding source probes independently match. Source compressed hash checked before and after. Actual execution 1.776 seconds under an independent 60-second alarm.

## Incoming patch reconciliation

`deleg_6f950a9d` reached its iteration cap. Parent reran the actual final incoming patch rather than trusting its earlier GREEN report: a residual Ruff `check=` failure was fixed, then the original 12 tests passed.

Parent subsequently observed RED and GREEN for missing protections:

- ±Inf/NaN crop values: now rejected before writing artifacts.
- Singular source affine: now rejected before writing; homogeneous/nonsingular geometry required.
- Integer-overflow source-size guard: arbitrary-precision product now enforces the 100M-voxel ceiling before materialization.
- Symlinked output: no writes through an alternate target directory.
- Actual serialized affine in manifest: a genuinely oblique 37-degree reflected/anisotropic test exposed the previous pre-save/saved mismatch and also checks source-world/inverse-index consistency.
- Hard-coded source-calibration/XY-flip statements: moved out of generic measured evidence; dataset-specific provenance remains supplied by the trusted caller, not manufactured by the preparer.

A separate ungated base test blocks NumPy/NiBabel/Torch imports. The original ML-directory import test is itself gated; it did not establish an ungated base regression check.

## Observed checks

- 19 isolated preparer tests passed.
- Base suite: 262 passed, 84 opt-in tests skipped.
- ML runtime: 62 passed, 22 aneurysm-runtime tests skipped; separate aneurysm runtime: 22 passed. JUnit deduplication confirms 84 distinct passing opt-in tests.
- Frontend: 38 passed; TypeScript/Vite build passed.
- Whole-source Ruff lint/format and tracked diff whitespace checks passed. Known upstream TorchScript deprecation and Vite chunk-size warnings remain.
- Machine-readable counts: `artifacts/calibrated-source-discovery/context-preparation/parent-final-checks.json`.

No weights, image data or generated artifacts are intended for git. Source changes remain local/uncommitted at this checkpoint. The later review `deleg_e3edde10` is now reconciled in `docs/reviews/calibrated-context-preparer.md`: remaining output-file/scaling guards, manifest readback, strict hash syntax and JSON provenance behavior were repaired and tested. Fresh context-v3 was actually regenerated after these fixes with identical image/manifest bytes and a newly recorded producing-module hash; v1/v2 remain unchanged. Current focused suite is 29 passing preparer checks; base suite 262 passed/94 skipped; general ML runtime 72 passed/22 skipped. No deployment, app installation, clinical clearance or whole-product completion is implied. Source-registry/API integration, case-bound morphometry, sizing/catalog integration and actual downstream invalidation remain open.
