# Phase 2 Physics and Centerline Implementation Plan

> **For Hermes:** Execute with `hermes-engineering-harness` and strict TDD. Keep `plan.md` local and uncommitted as the controlling architecture; this document makes its Phase 2 contract executable.

**Goal:** Add accepted-mask-bound numerical rod/flow computations and centerline proposals to the canonical planner, with explicit operator control and reproducible numerical evidence.

**Architecture:** Typed, bounded requests select algorithms, never files. A separate result ledger captures case, source, accepted-mask and current geometry dependencies transactionally. The fixed imaging interpreter verifies and decodes the exact immutable source/mask bytes before executing numerical code. Source and dependencies are checked again before results persist. UI results bind to both the case scope and hypothetical input parameters; proposals require explicit confirmation into the geometry draft and the existing save flow.

**Tech stack:** Existing FastAPI/SQLite/React stack, isolated NumPy/SciPy/NiBabel/scikit-image/scikit-fem runtime. No new hosted-model calls, clinical-data acquisition, source transfers or paid services.

## Evidence and support contract

- Existing `stokes_solver.py` is a manufactured Taylor-Hood benchmark only. It must not be relabeled as an aneurysm solver. A separate accepted-mask Stokes/Brinkman implementation needs actual mesh, boundary conditions, units and residual diagnostics.
- Rod constants, flow inlet/viscosity and Brinkman resistance are explicitly operator-supplied hypothetical research parameters, not inferred manufacturer specifications. Optimizer success, energy reduction and residual penetration are separate diagnostics. The rod model has no anchoring/friction/torsion/self-contact.
- Flow is a bounded steady Newtonian Stokes discretization with a hypothetical inlet, no-slip walls and natural outlet, not validated physiological CFD. Unsupported grids, topology, calibration or resource demands fail rather than silently resampling or substituting an analytical response. Signed sac-speed change can be unfavorable; never clamp it into a benefit.
- Centerlines are numerical skeleton/path proposals between explicit operator-selected vessel anchors, not autonomous anatomical landmark choices. They do not save inputs, accept masks or mutate case state. Confirmation populates a draft; the normal version-bound save remains required.
- All execution tests use synthetic images/masks or typed metadata fixtures. No sensitive clinical data will be inspected or transformed by this implementation work.

## Tasks and verification

### 1. Numerical primitives and actual producer contracts

- Inspect pre-existing `rod_contact.py`, `lumen_distance.py`, `lumen_contact.py`, `stokes_solver.py` and synthetic tests without changing unrelated work.
- Implement `planner/centerline.py` and `tests/ml_runtime/test_centerline.py`: one real skeleton/known-path RED/GREEN tracer first, then units/affine, connectivity, determinism and bounds.
- Implement `planner/aneurysm_stokes.py` and `tests/ml_runtime/test_aneurysm_stokes.py`: one real accepted-grid mesh solve first, zero-resistance comparison, boundary/mass/algebraic diagnostics and resource caps.
- Imaging commands: `env -u PYTHONPATH SELDINGER_RUN_MODEL_TESTS=1 .runtime/physics-runtime/bin/python -m pytest -q <owned-test-files>`.

### 2. Verified artifact loader and fixed-runtime supervisor

- Create `planner/native_inputs.py` with synthetic imaging tests. Read bounded bytes once, SHA-256 those bytes and decode them, not a later pathname. Validate source manifest revision, native shape, affine, units and binary uint8 masks; reject symlinks/ancestors, gzip bombs, scaling and mismatches.
- Create `planner/physics_worker.py` with a default fixed-runtime supervisor. Use a server-owned `PYTHONPATH`, bounded JSON input/output, fixed module, thread limits and wall-clock deadline. No client path, executable, model, file URL or arbitrary mesh input.
- Exercise the actual supervisor with a genuinely installed synthetic source and accepted-mask blobs, not only an injected runner.

### 3. Dependency-bound ledger and HTTP tracer

- Create `planner/physics_state.py` and `planner/physics_server.py`, wire `server.py`.
- POST/GET `/api/cases/{case_id}/physics/rod-deployment` and `/physics/stokes-flow` require case/source revision and exact current geometry result ID. Requests carry only bounded numerical parameters. Geometry dependencies include operator-input and accepted-mask identities.
- POST/GET `/api/cases/{case_id}/centerline-proposals` require case/source revision and current accepted vessel mask plus explicit start/end RAS anchors. The result remains a proposal.
- Store finite bounded JSON only, with separate result ID, algorithm version, exact parameters and dependencies. Latest-result reads suppress stale outputs, never resurrect an old matching row. Source/case/accepted-mask changes during compute reject persistence.
- Share the existing inference gate with geometry/segmentation. Invalid requests:422; stale/ineligible:409; busy:429; sanitized runtime/integrity failure:503.
- Write/run `tests/test_physics_server.py` one end-to-end RED/GREEN route tracer, then invalidation, interleavings, no-path injection, bad output, timeout and reopening cases.

### 4. UI integration

- Extend `PhysicsBench.tsx` and `DeviceStudio.tsx` with a case-bound solved-physics panel alongside existing analytical experiments, exposing hypothetical parameters and actual convergence/residual/energy/sac-speed diagnostics. Bench-only mode stays usable and does not fabricate anatomy.
- Add a proposal UI to `MorphometryInputs.tsx`: use the first and last selected parent anchors, show the proposed path/stations, require explicit confirmation, preserve the draft on failure, and save only via the existing button.
- Component tests must include real deferred responses, parameter/case/source changes, invalid output, stale eligibility, disabled/busy feedback and explicit confirmation. Never let retained numbers survive a contradictory envelope.

### 5. Exact source verification and delivery

- Preserve unrelated files by hash and stage only declared Phase 2 modules/tests/docs, including any deliberately adopted pre-existing numerical dependencies after review. Leave unrelated source-audit, requirements or coil work out unless actually needed and tested.
- Run lightweight backend, gated numerical/imaging suites, frontend tests, production build, lint/type checks, bounded secret scan and actual HTTP/browser smoke.
- Export a clean base archive with only intended files, install locked CI dependencies, compare source bytes with the final staged candidate and rerun workflow checks. Record pass/skip totals honestly.
- Independent review and parent reconciliation precede publication. Push a Phase 2 PR, verify the new `hermesreview` app's actual exact-head result, and poll boundedly rather than treating installation/request as success. Resolve actionable app/CI findings and rerun review for any new head. Merge only after exact-head CI and review satisfy the standing gate. Read back merged main and preserve the local plan/unrelated work.
