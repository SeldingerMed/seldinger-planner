# Phase 3: coronary, structural heart and aortic/peripheral workflows

> **For Hermes:** Use `hermes-engineering-harness` and `test-driven-development`. This implements Phase 3 of the local, uncommitted `plan.md`. The planner remains the canonical codebase.

**Goal:** Add coronary PCI, TAVR and aortic/peripheral modes to the actual application, with image-linked operator geometry, reproducible measurements and reloadable, revision-bound records.

**Architecture:** Reuse the current source registry, physical-coordinate viewer, native oblique sampler and case identity. Implement a small shared planar-contour/centerline geometry layer, typed workflow inputs and a dedicated SQLite workflow ledger. Do not require an aneurysm mask to use cardiac or aortic workflows. Keep operator traces distinct from accepted-mask geometry. Display saved measurements only for their matching source and workflow input revision.

**Tech stack:** FastAPI/Pydantic/SQLite, standard-library geometry, React/TypeScript, NiiVue native volumes, existing oblique reslicing, pytest/Vitest and actual-browser checks.

## Acceptance criteria

1. The real App exposes Neurovascular, Coronary PCI, TAVR and Aortic/Peripheral modes without breaking the current neurovascular workspace.
2. TAVR supports an editable double-oblique annular plane and image-linked contour; computes area, perimeter, effective area/perimeter diameters, and signed left/right ostial heights from explicit landmarks.
3. Coronary supports an ordered vessel path, lesion start/end stations, reference/lesion cross-sections, lesion arclength, reference diameter taper, sampled lumen profile and daughter-vessel bifurcation angle.
4. Aortic/peripheral supports neck start/end and adjacent-axis landmarks, neck arclength, explicitly defined suprarenal-to-neck and neck-to-sac deflection angles, section-based thrombus/calcification burden when the required annotations exist, and left/right iliac access diameter profiles with sampled minima.
5. Derived dimensions come from physical coordinates and traced sections, not invented device parameters or numerical placeholders. Missing required inputs prevent a calculation; optional missing annotations remain unavailable rather than zero.
6. Saved input/result records bind case/image/source, calculation version and their own workflow revision; conflict recovery requires an authoritative reload. Case/source changes synchronously hide old measurements and image paint. Writes never silently overwrite another tab's workflow edits.
7. Known-value oblique/rigid-transform fixtures exercise actual geometry. The actual API saves and reloads all three modes, with malformed/stale/unit/source cases tested. Actual App browser verification exercises plane tracing and at least one persisted result in each mode.
8. Deliver through a selectively staged, independently verified candidate, exact-head GitHub app review and green CI, then merge and verify main. Keep `plan.md` and the original unrelated dirty files untouched.

## Input conventions

- Coordinates are RAS millimeters, bound to the server-selected calibrated source. No request may name a filesystem path, model or remote URL.
- A traced section carries an origin, normal and ordered open contour ring. Reject degenerate, non-planar and self-intersecting rings; accept reversed winding without changing scalar dimensions.
- Path lengths use polyline arclength, not endpoint chord distance. Stations identify path nodes explicitly. Report a profile minimum as a sampled minimum.
- Ostial height is the signed projection from the annular plane along the operator-confirmed normal; do not silently take an absolute value.
- Bifurcation angle is the angle between the two explicit outward daughter rays from the carina.
- Aortic alpha/beta are defined by the displayed forward suprarenal, neck and distal sac axes, not an undocumented supplementary-angle convention.
- Burden derives only from the supplied section annotations and declared anatomical interval. Do not infer tissue class from CTA intensity thresholds or manufacture missing wall/tissue geometry.
- Bound vertices, sections, paths and total input size. Retain exact original annotations in the ledger along with deterministic input hashes.

## Implementation sequence

### 1. Shared physical geometry
Files: `planner/territory_geometry.py`, `tests/test_territory_geometry.py`.
- RED: known annular polygon area/perimeter/diameters, oblique invariance, winding, invalid rings and signed ostial heights.
- GREEN: finite, bounded standard-library planar projection and polygon geometry.
- RED/GREEN: path station arclength, taper, bifurcation/axis angles and profile/burden aggregation with explicit missing states.
- Run: `env -u PYTHONPATH -u PYTHONHOME uv run pytest -q tests/test_territory_geometry.py`.

### 2. Typed workflow composition
Files: `planner/territory_workflows.py`, `tests/test_territory_workflows.py`.
- Define bounded mode-specific input contracts and deterministic scalar/profile outputs.
- Implement TAVR as the first complete tracer, then coronary, then aortic/peripheral.
- Exercise true contours and paths, not fixed result dictionaries.

### 3. Source-bound persistence and HTTP
Files: `planner/territory_workflow_state.py`, `planner/territory_workflow_server.py`, `planner/server.py`, `tests/test_territory_workflow_server.py`.
- Add per-case/per-mode saved input revision, immutable result identity and current/stale/missing reads.
- Bind every write/read to trusted case/image/source calibration and expected workflow revision. Use transactions, post-write identity checks and sanitized failures without rollback promises.
- Run real default-app save/GET/reload for each mode; inject races and corruption to prove failure behavior.

### 4. Application modes and oblique annotation
Files: `web/src/TerritoryStudio.tsx`, supporting territory types/editor modules/tests, `web/src/ObliqueSection.tsx`, `web/src/App.tsx`, styles and API transport as required by inspected contracts.
- Add mode navigation to the actual App.
- Build a reusable source-bound plane editor with real native oblique sampling and contour picking. Preserve existing accepted-mask section rendering semantics.
- Add explicit landmark/path/profile entry controls for each mode, compute/save/readback and stale/conflict recovery.
- Test real parent feedback, changed-source transitions, signed coordinate editing, input clearing, save failure and cross-tab revision conflicts.

### 5. Verification and delivery
Files: `docs/verification/phase3-territory-workflows.md`, exact artifact manifest.
- Export main into clean scratch and overlay only intended source members. Run base tests, affected imaging checks, both appropriate typing/runtime checks, frontend tests/build/audit and source/secret scans.
- Exercise actual App/API with generated, provenance-recorded source bytes; verify full desktop and narrow layouts, visible control styles, click-to-world geometry and persisted state after reload.
- Inspect independent reviews and reproduce assertions before changing behavior. Complete exact-head CI/app gate and main readback, preserving all original unrelated-file hashes.

## Scope discipline

No DICOM ingestion, CPR/flythrough, new model training, automatic tissue classification, manufacturer SKU acquisition or external deployment is part of Phase 3. Those do not become prerequisites for the requested workflows. Preserve current source/privacy approval boundaries and existing application contracts. Report delivered behavior and concrete remaining work without repetitive boilerplate.
