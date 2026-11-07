# Labeled CTA reference and planning completion

Internal engineering plan. No clinical use, publication, data upload, outreach, model-training spend or institutional representation is authorized by this plan.

## Current slice: actual public reference acquisition

- Source: https://zenodo.org/records/15697196, CC-BY-4.0. Publisher describes anonymized and defaced CTA, expert STL annotations and morphology CSV.
- Acquire only exact Metadata.csv ZIP member with bounded HTTP206 ranges and local-header/size/CRC verification. Keep original bytes ignored under .runtime, receipts under ignored artifacts. Do not claim the whole-archive checksum was verified.
- TDD a deterministic metadata normalizer that preserves source IDs/tokens, decimal-comma measurements and missing values, excludes demographic/clinical fields unnecessary for geometric evaluation, rejects inconsistent case/multilesion groups, and binds exact expert STL and DICOM-series members from the verified ZIP directory.
- Exercise on actual public bytes; reconcile counts and expected source members in code. Keep training overlap, STL frame/registration and clinical validity explicitly unestablished. Never copy published neck/length/width into differently defined sizing fields.
- Identify a source-reference development case with an actual neck measurement, rather than treating current case006 (CSV: nonsaccular, fusiform-saccular, no neck value) as a canonical saccular sizing case. Do not silently replace the live case.

## Subsequent application/evaluation slices

1. Native-CTA oblique plane tracer: retain scalar scaling and full affine, bound sampling/allocation, render neck/parent sections with explicit physical orientation, verify rotated/anisotropic synthetic tests and actual public-case readback. Existing contour SVG is not an oblique CTA image.
2. Define device-family-specific measurement semantics and user-confirmed provenance before any auto-fill. Six missing dimensions remain null until measured under those definitions. Published maximum width is not automatically an average sac diameter or dome diameter.
3. Version current official labeling/catalog sources for a narrow device-family scope, including delivery compatibility. Preserve historical implementation until a new source-backed contract and boundary tests exist; do not assume historical margins remain current.
4. Whole-head detection baseline on bounded native/canonical tiles, without annotation-derived cropping. First exercise the existing checkpoint. Keep development/public overlap-unknown data separate from a frozen independent benchmark. Detection sensitivity/false positives require positive and negative cases; STL rasterization requires verified frame registration.

## Verification boundary

Run focused tests, full lightweight Python suite, Ruff/format and git diff checks for this slice. Independent read-only review must inspect exact code plus actual producer-data audit. No raw datasets, demographic tables, artifacts, runtime files or secrets in commits. Later UI/model claims require their own actual browser/model runs, not the metadata audit.
