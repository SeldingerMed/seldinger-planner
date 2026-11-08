# Phase 4: Local ingestion and advanced native-volume views

> **For Hermes:** Implement task-by-task with the Hermes-native engineering harness, bounded independent subagents and test-driven development. Do not use OMP.

**Goal:** Extend the canonical planner with local DICOM-to-native-source conversion, usable curved-planar reformations and endoluminal navigation, explicitly registered multimodal overlays, and source-bound local brief export.

**Architecture:** Keep DICOM parsing/conversion in an optional local imaging runtime, never in an arbitrary-path HTTP tool. Reuse the existing bounded, hash-checked installed-source admission contract. Reformations and overlays sample physical RAS coordinates from verified native image buffers; the server remains authoritative for saved anatomy/results. The actual App owns source identity and confirmation epochs, and old renderings disappear when their source/path/window/registration changes.

**Tech stack:** Existing Python/FastAPI/SQLite and React/TypeScript/NiiVue stack; upstream pydicom and NumPy/NiBabel only in the declared optional conversion runtime. No sibling application imports.

## Frozen scope and acceptance criteria

1. **Local ingestion:** An executable local operator converter reads only an explicitly selected series in an approved environment. Generated DICOM fixtures exercise conversion into a fresh NIfTI-1/mm/sform bundle admitted by `InstalledNiftiSourceStore` and the default API. Sort by physical slice position, not filenames/instance numbers. Verify orientation, in-plane spacing, uniform slice displacement, dimensions, scalar storage and rescale behavior. Reject unsupported acquisition/projection/time/contrast mixtures instead of guessing a volume. The exact supported SOP/geometry subset is documented after upstream conformance checks.
2. **Metadata privacy and provenance:** Build a new header and whitelist manifest fields rather than attempting to copy and blacklist DICOM tags. Do not retain patient text, filenames, local paths, raw UIDs, private tags, overlays, source preambles, descriptions or extensions. Keep source-byte digests, geometry, safe modality/storage identifiers and declared authorization scope. Tag removal is distinct from pixel deidentification; no burned-in-text/face-removal certification is claimed. Never inspect real clinical directories during development.
3. **Bounded publication:** Honor existing image/voxel/manifest caps. Bound file count, input bytes and decoded voxel work before allocation. No silent crop/downsample or network transfer. Refuse symlinks/unsafe ancestry and existing destinations; validate complete output before atomic installation. Failed conversion must not replace a trusted source or leave an admitted partial package.
4. **CPR:** Generate stretched/fixed-direction and straightened/transported-frame views along an explicitly confirmed physical path, with arc-length coordinates and known-value tests. Confirm a source-bound saved territory path or accepted/confirmed neurovascular centerline. No automatic acceptance of model-proposed paths. Raster dimensions/work are capped; out-of-volume samples remain transparent/unavailable, not fabricated anatomy.
5. **Endoluminal view:** Navigate an actual intensity-boundary/volume rendering along the same confirmed path with explicit station, orientation and threshold controls. Do not rename a scrolling orthogonal slice as a flythrough. Exercise real rendering on generated tubular/curved sources and independently check the sampling geometry.
6. **Fusion:** Load a secondary server-admitted native source using only opaque IDs/owned asset URLs. Require an operator-applied, confirmed rigid secondary-RAS-to-primary-RAS transform; matching dimensions or modality are not registration. Validate orthonormality, handedness, homogeneous row and finite bounds. Blend actual primary/secondary samples with independent windows/opacity; source or transform changes invalidate previous paint immediately. Do not add unmeasured automatic registration.
7. **Brief export:** Extend the existing local brief/export path with current territory scalar results and explicit source/view/registration provenance. Preserve frozen coherent provider snapshots and independent revisions. Exclude image data, raw DICOM identifiers, arbitrary provenance and stale calculations. Distinguish server-verified evidence from locally confirmed visualization settings. No external upload or hosted model is needed for export.
8. **Regression and delivery:** Preserve neurovascular/Phase 2/3 behavior and all nine unrelated file hashes, including uncommitted `plan.md`. Exercise actual default API and actual browser, not only mocked components. Verify a clean explicit candidate with locked runtime/dependencies, then commit/push a PR. Run the shared `scripts/pr_review_gate.py` against the exact head, address/disposition findings individually, merge only after clearance, and verify matching main tree plus postmerge checks.

## Task sequence

### 1. Native sampling tracer
- Create `web/src/nativeSampling.ts` and its tests.
- RED: sample an analytic 3D ramp at a fractional RAS point through an oblique/anisotropic native affine and verify slope/intercept; reject unknown units, bad buffers, nonfinite values and outside-grid queries.
- GREEN: expose a validated native sampler and reuse it without changing existing oblique reslice behavior.
- Run narrow tests, then the existing native-oblique suite before expanding.

### 2. Path/frame tracer
- Create `web/src/curvedPlanar.ts` and tests.
- RED: known straight-path length/stations, exact interpolated station, orthonormal transported frames, corner/reversal and invalid/duplicate path admission.
- GREEN: bounded arc-length resampling and explicit frame definitions; independently verify rigid-transform behavior and preserve units.
- Add one actual native-volume CPR ramp tracer, then rectangular/path caps and outside-grid negatives.

### 3. Local DICOM tracer
- Create `planner/dicom_ingest.py`, a declared conversion lock/runtime, synthetic fixture producer and focused ingest tests.
- RED: generated shuffled slices with nontrivial patient orientation and rescale must produce exact voxel values and RAS affine.
- GREEN: decode only the supported native scalar subset, construct a fresh safe NIfTI/header and manifest, validate with the actual installed-source store.
- Add mixed-series/geometry/gaps/duplicates/rescale/pixel-format/privacy/resource/publication failure tests one tracer at a time.
- Exercise the real CLI and default API admission; retain no DICOM/image assets in git.

### 4. Actual App reformation and fusion studio
- Add focused studio components and integration tests at the discovered App/centerline/territory interfaces.
- RED: confirmed path controls actual sampling; source/path/window changes suppress retained paint before passive effects; unconfirmed proposals do not render an accepted-path view.
- GREEN: linked CPR station controls and real endoluminal rendering, then the secondary-source rigid overlay.
- Verify loading/failure/epoch cleanup, readable controls, desktop/narrow layout and source-bound motion in real Chrome. Close only owned targets/listeners.

### 5. Coherent export
- Extend the actual brief/context integration at the existing route, with tests for valid current, absent and corrupt/stale providers.
- RED: current territory scalars appear with source/revision provenance; stale or contradictory numeric providers fail closed; output has no pixel/contour/path/raw-DICOM fields.
- GREEN: local deterministic Markdown/download and any required structured receipt; verify response bytes and actual browser download.

### 6. Publication candidate
- Record explicit intended paths and preserve unrelated hashes.
- Export `git archive` of baseline `5235d512f220877daf009a93ad0bf4d76e4820b6`, overlay intended files only, install locked dependencies and run lightweight, numerical, imaging/conversion and frontend suites separately.
- Run lint/format, changed-surface Pyright, TypeScript/build, dependency audit, diff/secret/privacy inspection and real-path traces.
- Hash actual bytes and raw Git blobs, not rendered terminal strings. Stage only verified files. Publish PR and run the required review gate, handling findings before every new head.

## Verification commands

Existing base commands remain `env -u PYTHONPATH -u PYTHONHOME uv run pytest -q`, Ruff check/format and `cd web && npm test && npm run build && npm audit --omit=dev --audit-level=high`. Optional imaging/conversion modules must gate before heavyweight imports in the base suite. Numerical and conversion checks use their declared interpreter explicitly. Record final exact commands/results and artifact hashes in `docs/verification/phase4-local-imaging.md` rather than predicting totals here.
