# Native CTA sampler mathematical review

Internal engineering review of `web/src/obliqueSlice.ts` and its synthetic producer-conformance tests. No anatomical accuracy, clinical validity or treatment suitability is established.

Read-only reviewer `deleg_649f24fa` reported no reproducible bugs and independently ran12tests and TypeScript successfully. Parent had separately reproduced the incoming implementation's failures, repaired the native-affine/storage path, run the same12tests/typecheck, and compared18actual approved-public-case browser pixels with an independent nibabel/NumPy/SciPy calculation (maximum grayscale error0).

Reviewed mathematical contract:
- Native header affine inverse: subtract translation, invert the3×3 linear part, then sample native x-fastest storage with `hdr.dims`.
- Correct eight-corner trilinear weights and max-edge handling; transparent out-of-source points.
- Shared normalized plane basis and physical pixel-center bounds for raster and contour.
- Scalar/mm/3D/source/output/extent/finite guards and raw-to-HU scaling. Sampled nonfinite values reject the whole slice intentionally.

Nonblocking observations retained: `getAffine()` is called twice, and a single nonfinite sample refuses the whole slice rather than masking one pixel. No cosmetic production edit was made after review. The existing tests do not prove every possible malformed-header branch; actual reviewed scope is the exercised fixture set and mathematical contract, not a complete imaging study.

The independent application-identity review is in `native-cta-application.md`. Source-only publication and exact-head CI remain separate verification steps.
