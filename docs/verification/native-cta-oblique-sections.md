# Native CTA oblique sections: actual application verification

Internal prototype evidence. This verifies display coordinates/intensities and source binding, not anatomical landmark accuracy, measurement validity or device suitability.

## Working behavior

The planning panel now samples the actual native CTA in each current operator-defined neck, proximal-parent and distal-parent plane. The accepted-mask contour is overlaid in the same plane basis and physical bounds. Existing origin navigation remains available; it is no longer the only image connection. CTA/soft-tissue window presets update the section images without changing geometry.

The image is sourced from the exact File/NVImage already decoded by NiiVue. App passes it only when File identity and case image SHA match. Source failures/replacements/unmount clear the image callback. The WebGL viewer is keyed by image digest to isolate different-image loading instances. Existing case/source/version/currentness/dirty/busy/conflict guards still suppress geometry and images together.

## Incoming-helper defects and parent repair

The incoming sampler was incomplete and independently failed7of15tests; it had never passed typecheck. It interpreted matRAS as a nested4x4 matrix even though the installed producer exposes a flat matrix, mixed RAS-space coordinates with the native raw buffer, supported only float buffers, and included erroneous expected basis signs, out-of-volume expectations and fractional expected values for uint8 output.

Parent replaced that approach with explicit inversion of `NVImage.getAffine()` (the original/native header affine) and native `hdr.dims` strides. No RAS permutation is applied to the raw buffer. New producer-conformance tests load actual in-memory NIfTI bytes via installed NVImage and cover flipped/permuted/anisotropic/sheared native affines, signed-short scaling, eight-corner fractional interpolation, shared contour/raster direction, edges/transparency, sampling caps and invalid inputs. Reproduced RED, then12tests and typecheck passed.

The sampler is display-only and bounded: native3D scalar/mm sources,8Msource voxels, max256square output, max200mm extent, finite nonsingular native affine, finite scaling/window and sampled intensities. Outside points are transparent. It does not change masks, planes, dimensions or sizing values.

## Actual browser and independent numerical readback

Fresh browser load at http://127.0.0.1:5173 opened the installed public calibrated case:

- Case `IkEMF5YWYSm7LeodOXBSbQ`, version9.
- Image SHA `26b8a3e766cf1306796286c8d10dfef41192930919df9029f9be0779b8080473`.
- Current geometry result `AO_E1txbmLBk0InJ7ZMiwQ`.
- All3sections produced real128×128PNG planes with explicit screen-axis RAS vectors and accepted-mask contours.
- Source NIfTI: `.runtime/original-public-source/zenodo-15697196/prepared-case-006/context-planning-v1/context-cta.nii.gz`.

Independently recomputed18sampled browser pixels using nibabel's saved native affine, NumPy's matrix inverse/cross products and SciPy `map_coordinates(order=1)`. Converted native HU to the0–600window and uint8 output. **All18matched exactly, maximum grayscale error0**. This tests sampled coordinate/intensity consistency, not every pixel or anatomical correctness.

Actual CTA→soft-tissue preset changed all3section PNGs; restoring CTA returned all3exact original image URLs. No alerts or horizontal overflow were observed. No case/geometry/input/mask mutation was made for this verification.

Ignored receipts under `artifacts/native-oblique-sections/`:
- `current-native-cta.png`, `proximal-native-cta.png`, `distal-native-cta.png`.
- `section-0.png`, `section-1.png`, `section-2.png`.
- `browser-section-pixels.json`.
- `independent-source-pixel-readback.json`.
- `window-preset-lifecycle.json`.

## Tests and boundary

- Full frontend: **159passed**, including real-App wrong-File rejection/current-File binding and native-image lifecycle tests.
- TypeScript and production build passed. Retained bundle-size advisory is not a new functional failure. Candidate frontend files passed Prettier. A whole-src Prettier pass still reports11unchanged baseline files (calibratedSource, SegmentationPanel and existing JSON fixtures); none were reformatted in this slice. There is no `npm run lint` script in package.json, so that attempted command failed before the separately rerun build/audit; it is not a passed lint check.
- Reference-ingestion code had separate independent review and actual-data reproduction with no blockers:553backend passed/96skipped.
- Separate sampler-math and integrated-identity reviews were reconciled with no reproducible blockers; see `../reviews/native-cta-sampler.md` and `../reviews/native-cta-application.md`. Source-only publication/exact-head CI are separately verified at the publishing checkpoint.

Current example006 remains publisher-classified fusiform-saccular, not a canonical saccular-neck reference. The new images do not validate its operator-selected neck/parent planes or authorize copying section extrema into device inputs. The six existing operator-reported sizing fields were not filled. Newly acquired case013/reference data and current-WEB labeling are separate workstreams.
