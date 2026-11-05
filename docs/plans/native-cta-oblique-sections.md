# Native CTA Oblique Sections Implementation Plan

> **For Hermes:** Execute task-by-task inside the Hermes-native engineering harness with bounded subagents, test-first changes and parent verification. Never use OMP.

**Goal:** Show the actual native CTA in the current operator-defined neck and parent-vessel planes, with the existing accepted-mask contours registered on top.

**Architecture:** Reuse NiiVue's decoded native scalar image and full physical affine. A bounded pure sampler produces display-only trilinear plane pixels. The existing geometry envelope remains the authority for current planes/contours; image sampling adds no sizing values or clinical-validity flag.

**Tech stack:** Existing React/TypeScript/NiiVue, Canvas2D, SVG, Vitest and Testing Library. No new packages, remote images or model calls.

## Task1: Sampling kernel and producer conformance

Create `web/src/obliqueSlice.ts` and `obliqueSlice.test.ts`, exclusive to the kernel helper. Export a guarded `planeBasis` with the orientation already used by MorphometryResults and `sampleObliqueSlice(volume, origin, normal, bounds, window, resolution=128)`. Use fractional native coordinates; the installed NiiVue `mm2vox` defaults to rounding. Reject unsupported units/dimensionality/buffers/geometry, nonfinite sampled values and excessive source/output/physical extents. Outside-source pixels are transparent, not invented HU.

RED→GREEN with a real in-memory NIfTI loaded by installed NVImage: test affine/raw-buffer correspondence, anisotropy/rotation, scaling, trilinear interpolation and guards. Run `npm test -- --run src/obliqueSlice.test.ts` and `npx tsc --noEmit`.

## Task2: Native image lifetime

Modify `Viewer.tsx`, test `Viewer.lifecycle.test.tsx`. Add optional callback delivering the exact immutable File identity and loaded NVImage. Clear on replacement, failure and unmount; do not expose late results. Existing physical-coordinate and mask/reference lifecycle tests must stay green. This tracer has a reproduced missing-callback RED before implementation.

## Task3: Application binding and display

Modify `App.tsx` and `MorphometryResults.tsx`, with a small `ObliqueSection.tsx` renderer and tests. Store the native image locally; pass it only when its exact File equals the active file and the active digest equals the case image SHA. Remount the WebGL viewer on image-digest changes so late loads cannot mutate a replacement instance. Preserve the existing case/revision/currentness/dirty/busy/conflict gates.

Canvas and contour SVG must use identical plane bounds/basis and explicit orientation, with source images hidden synchronously on input/scope changes. Show sampling failure as an unavailable image, not a successful image-linked section. Do not change computed dimensions, ledgers, accepted masks, input semantics or device-selection behavior.

RED→GREEN tests: source replacement/failed load clearing, actual contour/image projection, unit/eligibility/stale suppression, window changes and rejected sampled data. Then full frontend tests/typecheck/lint/build and actual calibrated-public-case browser readback. A synthetic sampler test is not a browser or anatomical validation result.

## Task4: Review and publication boundary

Independently review the exact integrated diff and actual browser receipts; resolve actionable findings. Run full applicable suites and secret/source-inventory scan. Keep all CTA, STL, CSV and generated receipts ignored/local. Commit/push source only after checks; bind CI to exact SHA. No merge without exact-revision approval or successful authorized automated review. Device-source and public-data permission audits remain separate; no contact or dataset-license acceptance is implied by this display work.
