# Manifest-installed image sources

Phase 1 supports additional server-installed, calibrated NIfTI-1 volumes without accepting request-provided filesystem paths or download URLs. This is an operator configuration interface, not an upload service or clinical-data authorization mechanism.

## Authorization boundary

Use synthetic, public or explicitly authorized data in an approved environment. Establish institutional approvals, deidentification, permitted purpose, retention, security and transfer rights separately before installing clinical or partner data. Format acceptance does not establish those permissions. Retain origin, license or authorization basis and permitted purpose in `source_provenance`; this provenance record is an operator responsibility, not an automated rights determination.

## Layout and manifest

Install a regular directory under `.runtime/installed-sources/<source-id>/`, containing `manifest.json` and a single-file NIfTI image. Source IDs match `[a-z0-9][a-z0-9_-]{1,63}`. The image filename is a leaf name, with no directory separators. Neither the directory, its ancestors nor the source files may be symlinks.

The manifest is a JSON object with `clinical_validation: false` and an `image` object containing:

- `filename`: the local image leaf filename, conventionally `context-cta.nii.gz` or `context-cta.nii`.
- `sha256`: lowercase SHA-256 of the exact stored image bytes, including gzip compression when present.
- `bytes`: stored byte count. Include it for reproducibility; the loader verifies it when supplied.
- `dtype`: `int16`, `int32`, `uint8`, `uint16` or `float32`.
- `shape_xyz`: three positive integer dimensions.
- `spatial_units`: `mm`.
- `affine_ras`: a finite, nonsingular, homogeneous 4 by 4 voxel-to-RAS matrix matching the image sform.

Optional `crop` contains a nonnegative three-integer `start_voxels` and `size_voxels` equal to `shape_xyz`. Without it, the installed grid is used with a zero crop origin. The manifest's exact bytes determine its revision hash. Duplicate installed directories claiming the same image hash are rejected as ambiguous, rather than arbitrarily choosing one.

## Supported bounds

The manifest is at most 16 KiB and the stored image at most 16 MiB. Each dimension is at most 2048 and the grid at most 8,000,000 voxels. Decompression is bounded. The loader checks the hashed bytes against NIfTI-1 shape, datatype, exact payload length, millimeter units and explicit sform calibration.

Qform-only images, NIfTI-2, malformed headers, mismatched calibration and tampered payloads fail closed. These constraints are not a general full-head ingestion pipeline. Preparing larger data, cropping or resampling requires a separately authorized, provenance-preserving process. A valid installed source does not establish trained-model applicability, anatomical accuracy or clinical suitability.

## Interfaces and verification

The registry resolves installed sources by opaque source ID or image fingerprint. Browser asset routes remain source-bound. The planning context sent to the hosted agent contains bounded scalar/identifier evidence, not image bytes, filesystem paths, mesh arrays or arbitrary manifest provenance.

Source admission and HTTP contracts are exercised by `tests/test_installed_sources.py`. `tests/ml_runtime/test_installed_source_geometry.py` runs a newly installed synthetic source through the native geometry function in the isolated imaging runtime. See [Phase 1 verification](verification/phase1-consolidation.md) for observed results and remaining limits.
