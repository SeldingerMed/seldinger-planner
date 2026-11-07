# Calibrated case 006 mesh-audit reconciliation

Internal numerical/provenance note. Neither registration nor raw STL units are declared validated. This is not a clinical interpretation or measured aneurysm size.

Parent read the exact child receipt `artifacts/calibrated-source-discovery/stl-registration-audit/case-006-stl-frame-audit.json` and independently re-read the original approved-public STL and derived calibrated volume. Parent verified STL SHA-256 `1972d61beb66d9f75f19f454948d365d5d185d91f0ab5a8e6ed94ca4b2ee078c`.

Observed raw geometry: 6712 triangles, 3358 unique vertices, 10068 undirected edges. Every undirected edge has exactly two incident face uses, one in each direction. No repeated-vertex triangle or duplicate face was found; Euler characteristic is 2. This is edge-incidence evidence, not a complete vertex-manifold/embedded-surface or clinical audit. Raw coordinate bounds are `[9.715858,-25.00915,-13.56863]` to `[20.46761,-4.00349,0.1936321]`; do not label their units as verified millimeters.

Parent reproduced the exact inset-box comparisons: identity-RAS candidate uses 2200 voxels, mean 38.88272727272727 HU and fraction above 200 of 0; XY-flip candidate uses 1900 voxels, mean 324.2457894736842 HU and fraction above 200 of 0.95. These are bounding-box samples, **not actual mesh-interior or boundary agreement** and not an anatomical diagnosis. Both transforms remain in-volume. The child receipt's narrative `numerical_evidence.observation` contains different broader-box statistics without that qualification; its separate structured inset values, now parent-reproduced, are the supported comparison.

The child used `bounds_min_mm`, `extent_mm` and similar raw-STL keys despite saying STL units remain unverified. Those key names are not unit provenance and must not flow into a measurement/sizing API. Its `world_min`/`world_max` values are opposite voxel-box corners under a reflected affine, not component-wise world minima/maxima.

The candidate voxel box `[242,210,166]` through `[297,286,215]` inclusive contains 215600 voxels, verified arithmetically. It is a possible bounded **reference-informed preview context** under the explicitly unvalidated XY-flip mapping, not stage-1 independent localization or a clinical neck definition. No crop was generated or installed by this audit.

Canonical parent numeric receipt: `artifacts/calibrated-source-discovery/stl-registration-audit/parent-topology-intensity.json`. Original-source frame documentation, exact mesh/image registration, source CSV, model segmentation on the new source and application installation remain separate work. The underlying DICOM-derived image calibration is established independently and is not revoked or conferred by this mesh audit.
