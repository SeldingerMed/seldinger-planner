# Calibrated public context preparation contract

Internal offline data-preparation layer only. No product endpoint, generic upload handler, source-header relabeling, model execution or clinical claim. Preserve old public-reference data and application behavior. Source is explicitly authorized deidentified public Zenodo case 006, CC BY 4.0.

## Owning files and command

Implement fresh `planner/calibrated_context.py` and `tests/ml_runtime/test_calibrated_context.py` only, using strict one-behavior-at-a-time RED/GREEN. Optional NumPy/NiBabel imports must remain function-local, preserving base-environment module import. Runtime is `.runtime/ml-runtime/bin/python`; use the existing `SELDINGER_RUN_MODEL_TESTS=1` gate for numerical tests. No installs, .env, model weights, old repositories, commit or push. Parent owns source registry/API/frontend integration.

## Function contract

Expose `prepare_calibrated_context(source_path, output_dir, *, expected_sha256, start_xyz, size_xyz, provenance)` returning `{"image_path": Path, "manifest_path": Path, "manifest": dict}`. The version-1 manifest uses `image: {filename, sha256, bytes, shape_xyz, dtype, spatial_units, affine_ras}`, `source_image_sha256`, `crop: {start_voxels, size_voxels}`, `source_provenance`, and fixed false clinical-validation/application-installation flags. Keep caller provenance separate from the measured output fields, bounded and JSON-finite. Provide an operator-only preparation function taking source path, trusted expected compressed-file SHA-256, integer native `start_xyz` and `size_xyz`, and a fresh output directory. Reject malformed hashes, symlinks, source hash mismatch, non-3D/invalid geometry, non-mm declared units, invalid bounds, boolean/noninteger coordinates, empty/oversized context (>8000000 voxels), nonfinite scalar values and any pre-existing output artifact. Validate source header/dimensions before large voxel materialization; source-size ceiling 100000000 voxels. Never mutate raw input or manufacture physical units. Use original dtype and scalar values, preserve header unit declarations, and compose crop origin via source affine × voxel-index translation, including reflections and oblique orthogonal geometry.

Write `context-cta.nii.gz` plus a small `manifest.json` with original source hash, output compressed hash/bytes, crop bounds, actual shape/dtype/units/affine, declared source/calibration provenance supplied by the trusted caller and explicit selection/evidence limits. Read the saved artifact and independently compare nonpadding source→saved voxel probes and serialization-appropriate world-coordinate round trips. Do not assert exact float64 equality after NIfTI float32 affine serialization. Return paths/receipt only after actual readback. Do not classify a selected context as independent lesion localization or the annotation as validated anatomy.

## Tests and actual authorized data exercise

Start with an asymmetric coordinate-coded, reflected/translated/anisotropic synthetic source with mm declaration; a crop must contain the correct exact absolute source scalars and physical positions, not a coordinate-plausible reordered array. Add bounds/hash/unit/dtype/output-preservation and base-import guards as vertical slices. A second oblique orthogonal affine test should distinguish corner/index errors. Then exercise the function on this exact already verified public input:

- `.runtime/original-public-source/zenodo-15697196/prepared-case-006/cta-mm.nii.gz`
- SHA-256 `98ecbcedc625ff1eecdf3a90366a05ec0bc38fd6c4172facbc8bb5bb7d86e9b4`
- native start `[242,210,166]`, size `[56,77,50]` (215600 voxels).
- Fresh output `.runtime/original-public-source/zenodo-15697196/prepared-case-006/context-v1/` only. May also write a concise acquisition/execution receipt in `artifacts/calibrated-source-discovery/context-preparation/`.

Selection is **reference-informed candidate context** based on unvalidated XY-flip STL placement. The DICOM-derived image's mm/HU calibration is independently established by the parent receipts; STL coordinate frame/units and registration remain unvalidated. Manifest must preserve that distinction. Relevant evidence: `docs/reviews/calibrated-mesh-frame-audit.md`, and parent `parent-calibrated-volume.json`/`parent-calibrated-nonpadding-readback.json` under `artifacts/calibrated-source-discovery/complete-case-006/`.

This layer does not install the new context into the application, run a model, validate clinical measurements or alter the older CMHA image with unspecified units.
