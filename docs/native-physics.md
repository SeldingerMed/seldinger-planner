# Native numerical research workers

Phase 2 adds bounded native-mask rod deployment, a steady Stokes/Brinkman comparison, and centerline proposals. These are exercised research implementations, not clinically validated measurements, physiological CFD or manufacturer-calibrated device predictions. The existing analytical physics bench remains separate.

## Install and verify

From the repository root:

```sh
uv venv --python 3.11 .runtime/physics-runtime
uv pip sync --python .runtime/physics-runtime/bin/python --require-hashes requirements/physics.txt
env -u PYTHONPATH SELDINGER_RUN_MODEL_TESTS=1 .runtime/physics-runtime/bin/python -m pytest -q \
  tests/ml_runtime/test_physics_worker.py tests/ml_runtime/test_centerline.py \
  tests/ml_runtime/test_aneurysm_stokes.py tests/ml_runtime/test_aneurysm_stokes_invariants.py \
  tests/ml_runtime/test_native_input_guards.py tests/ml_runtime/test_rod_contact.py \
  tests/ml_runtime/test_lumen_contact.py tests/ml_runtime/test_lumen_distance.py
```

This model-free runtime does not install PyTorch or download model weights. The existing geometry worker has its own imaging-runtime requirements. Missing runtimes cause a computation failure, never a substitute result.

## Prerequisites and dependencies

Follow [installed-source admission](installed-sources.md). Installation does not grant permission to use clinical data. These checks used generated synthetic images and masks only.

Requests select an algorithm and typed parameters, never paths, executables, URLs or arbitrary meshes. Source image and accepted binary uint8 masks must share the verified native NIfTI-1 millimeter calibration. There is no silent resampling. Stored files, decompression and grids are bounded; source/mask symlinks are rejected. The same immutable bytes are hashed and decoded.

Rod and flow require current accepted vessel/sac masks, saved operator geometry and its exact current materialized result ID. A centerline proposal needs the accepted vessel mask and explicit first/last anchors, not saved operator geometry. Every result binds case/image/version, source-manifest revision, accepted-mask identities, algorithm version and exact parameters. Replacing geometry can invalidate a result without changing the case version. Reads consider the latest result rather than resurrecting older matching history.

Semantic numerical changes after release must advance the numerical algorithm version so old results cannot be represented as recomputations under new code.

## Endpoints

- GET/POST `/api/cases/{case_id}/physics/rod-deployment`
- GET/POST `/api/cases/{case_id}/physics/stokes-flow`
- GET/POST `/api/cases/{case_id}/centerline-proposals`

Computations use the existing local inference gate, a fixed interpreter/module, one-thread numerical libraries, a 120-second worker deadline, 16 KiB input and 64 KiB output limits. Request paths and result fields are whitelisted. Invalid request: 422; stale/ineligible: 409; busy: 429; sanitized runtime/integrity failure: 503. A post-compute 409 can follow persistence and requires reloading saved state, not an assumption of rollback.

### Rod

The saved parent path has 4 to 32 nodes. Parameters are hypothetical radius (mm), EA (N), EI (N·mm²), and contact stiffness (N/mm). Radius is positive and at most 5; EA and contact stiffness are positive and at most 100000; EI is between 0 and 100000. Optional rest points must have the same node count. Without them, the saved parent path is the rest shape.

The discrete elastic rod uses the native lumen distance field. Optimizer success, iteration count, initial/final energy (N·mm), nodal clearance and penetration (mm) are separate diagnostics. No friction, anchoring, torsion, self-contact or device-specific material calibration is inferred. Distance-field interpolation is not a certified anatomical wall-error bound.

### Flow

The fluid domain is the union of the accepted vessel and sac masks. The sac remains a separate averaging region. The conforming voxel-cell mesh uses six tetrahedra per fluid voxel and Taylor-Hood P2/P1 elements.

Supported inputs are deliberately small: at most 8,000,000 input-grid voxels, 32,768 bounding-box voxels, 1,000 fluid voxels and 120,000 total finite-element DOFs. Disconnected domains, unsupported shear/reflection, missing sac/slab and inadequate boundaries fail. Many full-resolution clinical masks exceed this prototype's budget. There is no automatic coarsening or manufactured-box fallback.

The operator supplies a native axis 0/1/2, positive inlet speed up to 1000 mm/s, viscosity between 1e-6 and 1 Pa·s, resistance between 0 and 100 Pa·s/mm², and positive neck-slab thickness up to 20 mm. The neck plane comes from saved operator inputs. Inlet speed is applied to interior velocity nodes along the calibrated native-axis direction; wall/shared-edge nodes remain no-slip. This is not an inferred mean physiological inlet velocity. The outlet has the vector-Laplacian natural zero-traction condition; no artificial mean-zero pressure shift is applied.

Baseline and treatment use the same inlet. Treatment adds the hypothetical scalar Brinkman slab resistance once, with explicit physical units. Sac mean speed uses FEM volume quadrature. Signed change is `100*(treated-baseline)/baseline`, not a forced benefit. The synthetic HTTP tracer produced an increase, which was retained.

Momentum residual, weak continuity residual and the unprojected divergence L2 norm are distinct. Tiny algebraic/weak residuals do not imply small pointwise divergence, mesh convergence or physiological validity. Units are mm/s, Pa, mm³/s and mm^(3/2)/s for the divergence L2 norm. Pressure-drop and flux diagnostics are retained in the API.

### Centerline proposal and operator confirmation

The skeleton path stays on native vessel foreground between voxel-center representatives of the explicit anchors. The grid is bounded to 8,000,000 voxels; the requested output budget is 4 to 32 path points. Corner-only voxel connections are rejected. This is not autonomous anatomical landmark detection.

The UI presents the proposal and requires **Use proposed parent path**. That action changes only the draft path and station indices. **Save geometry inputs** is a separate version-bound mutation. Station suggestions are geometric fractions along the path, not anatomical parent-vessel selections. Choose stations outside the accepted sac mask before computing geometry; overlap is rejected. Sections through native mesh rings use the exact operator plane, without a hidden positional offset. Coplanar patches and tangent/open/non-manifold plane edges remain unsupported.

## UI and evidence scope

The numerical panel is alongside the analytical bench in the device studio and is enabled only for loaded, current, millimeter-bound accepted anatomy. Hypothetical inputs are typed explicitly, without commercial device defaults. Parameter/scope changes suppress retained numbers, including before passive-effect cleanup. Results are POST acknowledgements, not automatically restored old parameter sets.

The Phase 2 browser tracer uses production components against an isolated real API and generated NIfTI/mask bytes. It is a component-integration harness, not proof of the full App source-import workflow or anatomy/device/clinical validation. Generic installed-source admission remains an API/operator workflow; the existing App calibrated-source launcher names its two curated sources.
