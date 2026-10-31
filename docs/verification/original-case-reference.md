# Original public-case reference preview

## Exercised scope

The fresh planner displays a context crop of CMHA `AHMU1218001` and its paired dataset-provided aneurysm and artery-plus-aneurysm surfaces. All source assets were acquired from the original public distribution, not an earlier application repository. No new model inference was run.

Source: Song et al., CMHA (2024), [dataset version 1](https://doi.org/10.6084/m9.figshare.26965450.v1), [descriptor](https://doi.org/10.1038/s41597-024-04056-8), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The preprocessing here consists of a context crop and an explicit candidate coordinate transform of curated surfaces. The earlier unidentified public crop is a separate artifact; no identity match to it is asserted.

## Actual source and output checks

- Original CTA SHA-256: `63ffa377f4189b25e9496f125d0bb6a9d86969614757d8261ed3ac1c40fa43f8`.
- Original aneurysm STL SHA-256: `5f64c2cab231288e253315cbfd1c02d4bde3613234d4cdaa3b5170282bd2c4f2`.
- Original artery-plus-aneurysm STL SHA-256: `cb023e26602c451400a6e29712ecd78e270b9c5c8ad907e3c9815b71b20bd8f6`.
- Native crop start `(215, 220, 280)`, exclusive stop `(390, 400, 420)`, output grid `175 × 180 × 140`.
- Output CTA SHA-256: `98cf6634833acf722a0bd084a4bbe9b5c4545954b3c9759c1003b225086ecb0c`.
- Output curated surfaces retain 382 and 5,312 triangles, respectively.
- Three independently sought native/cropped float64 samples matched byte-for-byte, including the first and last crop voxels. Source-to-crop world-coordinate discrepancy was at most `6.258487701416016e-07` source units at those probes, from float32 NIfTI header rounding. This is a crop-coordinate check, not a registration-accuracy estimate.
- Source `xyzt_units=0`, scalar scaling and raw crop voxel bytes were preserved. The explicit candidate STL transform is `diag(-1, -1, 1)`.

The stdlib preparer streams the source rather than allocating the full volume. It checks expected input hashes, source-size caps, declared payload length, uncropped tail and gzip integrity. It has cooperative elapsed-time checks during crop streaming, not process-level I/O preemption. Synthetic tests exercise deterministic gzip output, payload offsets, signed affine translation, scalar/unit preservation, binary/ASCII STL input and rejected inputs.

## Browser checks

The installed original-source bundle was exercised in the attached browser:

- CTA and both verified curated surfaces loaded through fixed local endpoints.
- The dedicated Reference 3D view frames the curated geometry without hiding its provenance.
- Linked, axial, coronal, sagittal and 3D volume modes were selected and observed in the active toolbar.
- Whole surfaces are suppressed on 2D slices using NiiVue `meshThicknessOn2D: 0`. They are 3D references, not validated slice-wise contours.
- Reference visibility was turned off and back on; reference focus updated the physical-affine coordinate readout.
- Replacing the real reference CTA with an explicitly synthetic geometry fixture removed the reference card/view, cleared inherited source provenance and reset the worksheet target. Reopening the original restored its saved target. This was a lifecycle test, not clinical data or inference validation.
- An operator-entered target was saved on the actual public case and restored after a fresh page load. This does not establish an automated finding or validated lesion localization.
- Millimeter measurement controls remained disabled for the unknown-unit source.
- Desktop canvas bounds fit the observed `1200 × 858` viewport, with the canvas bottom at `784`.
- A camera drag changed 49,596 pixels within the cropped canvas. The input helper timed out mid-drag; current state was inspected and the button released through CDP before proceeding. This was a harness timeout, not a recorded application exception.
- No window error events were recorded in these exercised paths. This is not an exhaustive rendering or error audit.

Two browser-discovered regressions now have tests: NiiVue chooses the STL parser using the supplied name extension, and its default whole-mesh slice projection must not be mistaken for an annotation contour. The adapter supplies `.stl` names and disables that projection.

Hot-refresh teardown temporarily invalidated a reused WebGL canvas during development. Final rendering checks used fresh page loads, not that hot-refresh state.

Ignored local evidence is under `artifacts/reference-preview/`: source sample/affine readback, canvas rotation comparison, screenshots and test reports. Assets are under `.runtime/public-reference/`. Neither directory is committed.

## Reproduce source preparation

Obtain the three original public files independently and verify their provenance first. The example paths below describe the locally acquired installation; no downloader or dataset is shipped with the application. From the repository root, run this Python with `uv run python`. The output directory must be absent or empty; do not overwrite an existing installation.

```python
from pathlib import Path
from planner.reference_assets import prepare_reference
from planner.reference_server import ReferenceStore

root = Path(".runtime/original-public-source/case-AHMU1218001")
meshes = root / "unar-extracted/patients/AHMU1218001"
output = Path(".runtime/public-reference")
manifest = prepare_reference(
    root / "cta_images_head_AHMU1218001.nii.gz",
    meshes / "3D_aneurysm_AHMU1218001.stl",
    meshes / "3D_aneurysm_artery_AHMU1218001.stl",
    output,
    expected_sha256={
        "cta": "63ffa377f4189b25e9496f125d0bb6a9d86969614757d8261ed3ac1c40fa43f8",
        "aneurysm": "5f64c2cab231288e253315cbfd1c02d4bde3613234d4cdaa3b5170282bd2c4f2",
        "artery": "cb023e26602c451400a6e29712ecd78e270b9c5c8ad907e3c9815b71b20bd8f6",
    },
    ijk_start=(215, 220, 280),
    ijk_stop=(390, 400, 420),
)
ReferenceStore(output).load()
print(manifest["image"]["sha256"])
```

Run the normal API/frontend commands in the README, then choose **Open reference CTA**. A clean clone has no installed bundle and reports that absence rather than generating substitute anatomy.

## Automated checks observed

`uv run pytest -q`: **129 passed**. Frontend Vitest: **27 passed**. Ruff checks/formatting, TypeScript, Vite production build, frontend formatting and diff checks passed. Production npm audit reported zero vulnerabilities. Existing warnings remain: NiiVue intentionally warns about zero-filled/oblique geometry fixtures, and Vite reports large library chunks. These checks do not establish clinical performance.

## Evidence boundary

The empirical image/surface consistency investigation supports only a candidate preview transform. It does not establish the publisher's STL coordinate convention, millimeter calibration, HU calibration, validated registration, segmentation performance, morphometry, device compatibility or clinical use. Dataset-curated geometry, operator-entered targets and any future trained inference must remain distinguishable. No dataset or image publication, external deployment, or clinical clearance is implied by this verification.
