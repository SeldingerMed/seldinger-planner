# Original-case reference preview implementation plan

**Goal:** Display the original public CMHA CTA and paired curated surfaces in the fresh planner, with explicit candidate alignment and unchanged unknown units. This is not trained inference, validated registration, morphometry or device sizing.

**Architecture:** An offline, hash-checked, narrowly scoped source preparer emits a deterministic context crop and transformed binary STL references into ignored runtime storage. Fixed loopback endpoints validate the installed manifest, bind annotation access to case image fingerprint and reference revision, and expose no arbitrary path/URL capability. The browser verifies asset hashes before adding surfaces and clears them on image replacement.

**Stack:** Python stdlib, FastAPI/Pydantic, React/TypeScript, installed upstream NiiVue 0.68.2. No legacy repository imports. No new runtime dependencies.

## Task 1: Offline source preparer, independent writer

Files: `planner/reference_assets.py`, `tests/test_reference_assets.py` only.

API:
```python
prepare_reference(cta_path: Path, aneurysm_path: Path, artery_path: Path, output_dir: Path, *,
                  expected_sha256: dict[str,str], ijk_start: tuple[int,int,int],
                  ijk_stop: tuple[int,int,int]) -> dict
```
Hashes use keys `cta`, `aneurysm`, `artery`; stop is exclusive. Fixed standard candidate STL transform is diag(-1,-1,1), explicitly labeled, never inferred silently. Scope is little-endian 3D float64 NIfTI-1, qform=0, active non-singular diagonal sform, no extensions; reject unsupported inputs. Preserve source unit byte, pixel sizes, scale/intercept and exact raw voxel bytes. Update dimensions and sform translation with the cropped index origin. Source payload offset must include vox_offset. Stream with EOF, shape/size and elapsed-time bounds; do not allocate the full source volume. Cap compressed source at 100 MiB, declared uncompressed at 1100 MiB, mesh input at 2 MiB each, processing at 30 seconds. Reject source/output aliasing and symlinked inputs; require absent or empty output directory. Only write a completed manifest after outputs succeed.

Read binary or strict ASCII STL, reject non-finite/truncated geometry and excessive triangle counts. Write transformed binary STL with fresh recomputed normals; topology unchanged. Use aneurysm transformed bounding-box center for `focus_ras` (source units).

Exact manifest contract (`manifest.json`):
- `schema_version: 1`, `case_label: "CMHA AHMU1218001"`
- `source_url: "https://doi.org/10.6084/m9.figshare.26965450.v1"`
- `license_url: "https://creativecommons.org/licenses/by/4.0/"`
- `citation: "Song et al., CMHA (2024). Original case AHMU1218001. Context crop and coordinate-transformed curated references."`
- `image: {filename:"reference-cta.nii.gz", sha256:<actual>}`
- `annotations`: two objects with `id` = `aneurysm` / `artery`, fixed filenames `reference-aneurysm.stl` / `reference-artery.stl`, `sha256`, `triangle_count`; no absolute paths.
- `focus_ras`: finite 3-vector, source units
- `source_sha256`: the verified three-key input hash dictionary
- `transform: {matrix:[[-1,0,0],[0,-1,0],[0,0,1]], status:"candidate_image_consistent"}`
- `source_header`: preserve `xyzt_units`, `scl_slope`, `scl_inter`, numeric source spacing
- `crop`: `origin_ijk`, `size_voxels`, `source_affine` and `cropped_affine` (3×4).

Use TDD: coordinate-coded synthetic gzip fixture proves exact crop bytes, negative-axis affine translation, unknown-unit/scaling preservation and deterministic outputs; STL tests prove transform and both formats; fail on mismatched hash, short source, invalid bounds and unsupported geometry. Commands: `uv run pytest tests/test_reference_assets.py -q`; `uv run ruff check planner/reference_assets.py tests/test_reference_assets.py`. Do not read actual data or run downloads, touch other files, change dependencies or commit.

## Task 2: Fixed reference API, parent writer

Files: new `planner/reference_server.py`, `tests/test_reference_server.py`; extend `planner/server.py`.

Write failing tests for installed/absent/corrupt references, foreign case binding, reference revision mismatch, symlink/filename rejection and source receipt whitelist. Implement fixed manifest/volume metadata endpoints and case/fingerprint/revision-bound STL routes. Do not expose local file paths. Include only verified reference provenance in the read-only model snapshot and discard a response if that reference revision changes during the call.

## Task 3: Browser reference display, parent writer

Files: `web/src/reference.ts`, `Viewer.tsx`, `App.tsx` and focused tests. Add Open reference CTA and reference visibility/3D-surface controls. Hash-check image and surface bytes. Keep image ownership, stale-load generation guards, failure isolation and physical-affine coordinates. Candidate alignment and curated-not-inferred provenance remain explicit. Numerical measurement controls stay disabled for the actual unknown-unit source.

## Task 4: Exercise and review

Prepare the exact original acquired case locally from pinned hashes. Use a broad context crop containing the candidate reference, not the tight ROI alone. Verify native voxel samples and crop affine, then actual browser MPR/3D overlay, refocus, toggles and volume replacement. Independently review final source/evidence boundaries. Run broad tests/lint/types/build/audit and targeted secrets scan. Commit/push to the existing draft PR only after real exercise; require exact-head CI. No merge, deployment, data publication or clinical claim.
