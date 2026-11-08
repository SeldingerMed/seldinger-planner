# Phase 2: native physics and centerline verification

## Scope and repository

Local pre-publication checkpoint for `feat/phase2-physics-centerlines`, based on `a37e9c05e7a7bc0f410a5a953bdd7c69195a115c`. Git/PR history records subsequent exact-head CI, app review and delivery. This report does not itself assert those later gates passed.

The implementation is a bounded research slice: native-mask elastic-rod/contact optimization, accepted-mask Stokes/Brinkman comparison, dependency-bound persisted numerical results, and operator-confirmed skeleton-path proposals. The analytical bench remains separate. Tests and tracers used generated synthetic source/mask bytes only. No patient data, new trained-model inference, hosted-model calls, clinical validation, manufacturer mechanics calibration or deployment is claimed.

`plan.md` remains uncommitted. Unrelated source-audit, research-verification, simulation requirements, manufactured Stokes benchmark and coil-rest-shape work were excluded and preserved by exact hashes. Existing rod/contact/distance infrastructure was adopted explicitly with its tests, not described as newly authored in this phase.

## Clean publication candidate

Exported the base Git tree into isolated scratch, then overlaid the explicit Phase 2 members only. The candidate excludes the local plan and unrelated files. Locked API dependencies were installed with Python 3.12. The numerical and imaging lanes borrowed only their installed interpreter environments, not clinical sources or model artifacts. Source modules and synthetic installed assets came from the export.

| Check | Observed result |
|---|---|
| `env -u PYTHONPATH -u PYTHONHOME uv run pytest -q` | **685 passed, 108 skipped** |
| Standalone numerical lane, the eight files listed in `docs/native-physics.md` | **114 passed** |
| Existing `test_geometry_worker.py`, `test_mask_geometry.py`, `test_installed_source_geometry.py` imaging lane | **21 passed** |
| `cd web && npm test` | **36 files, 245 passed** |
| `npm run build` | TypeScript and Vite passed; existing large-chunk advisory remains |
| `npm audit --omit=dev --audit-level=high` | Zero reported vulnerabilities |
| Whole-candidate Ruff lint and format | Passed |
| Pyright 1.1.414, four API/contract modules against `.venv/bin/python` | Zero errors/warnings |
| Pyright 1.1.414, seven numerical modules against `.runtime/physics-runtime/bin/python` | Zero errors/warnings |

Skipped tests are not passes. Optional model/public-source tests remain separate. Earlier mixed-checkout frontend totals included unrelated coil-rest-shape tests; the final totals above describe the actual publication slice. An inherited host Python 3.14 search path initially contaminated commands; clearing `PYTHONPATH` corrected interpreter isolation without changing dependencies. Bare Pyright also used the wrong analysis environment; the successful checks explicitly selected each runtime and declared file set.

`requirements/physics.txt` is independently hash-locked and has no dependency on the excluded local simulation requirements. `.github/workflows/native-physics.yml` repeats the numerical lane on Python 3.11 without PyTorch, weights or clinical datasets.

## Actual default-runner HTTP and browser execution

A real loopback API used a fresh scratch SQLite database, one exact owned synthetic installed-source directory, generated uint8 masks and the default geometry/numerical subprocess runners. No injected numerical result or manufactured-box solver substituted for the native accepted-mask solve. Physics POST succeeded and GET returned the exact persisted current row.

The browser harness imported production `MorphometryInputs` and `DeviceStudio`, with the real API/default workers. This is component integration, not a full App source-import workflow. Observed:

1. A centerline POST produced 16 native-center points along a 15 mm path. **Use proposed parent path** changed only the draft, left revision 4 and issued no PUT.
2. Explicitly reviewed parent stations 2/14 outside the accepted synthetic sac, then saved. PUT succeeded and revision advanced to 5.
3. Default native geometry recomputed successfully on exact-grid stations. The earlier shared-mesh-ring intersection failure was repaired without offsetting the requested operator plane.
4. Loaded the accepted anatomy in the studio. Typed hypothetical rod/flow inputs and executed each real worker through the UI.
5. Rod: optimizer success, one iteration, initial/final energy 0 N·mm, maximum nodal penetration 0 mm and minimum nodal clearance 1.8 mm. A straight unloaded path is not evidence of device deployment fidelity.
6. Flow: baseline sac speed 0.4483611978467964mm/s; treated 0.45022506189930694mm/s; signed change **+0.4157059222478527%**. The increase is retained, not presented as benefit.
7. Baseline/treated momentum residuals were approximately 3.84e-12/3.29e-12; weak continuity approximately 3.14e-14/2.50e-14mm³/s. Unprojected divergence L2 remained approximately 2.01/2.35mm^(3/2)/s and was displayed explicitly. Small weak residuals do not establish pointwise incompressibility or physiological validity.
8. Desktop 1440 px and portrait 430 px screenshots/readback verified readable Compute/Close controls. At 430 px, document scroll width was 430 px. An out-of-range neck-thickness draft suppressed retained results, disabled Compute and issued no extra POST.

The default illustrative 20 mm device exceeded the 15 mm synthetic path; its geometry warning remained visible. This was not a successful fitted-device demonstration. Synthetic anatomy is not a credible clinical demo substitute.

Absolute local-only receipts under the Seldinger scratch directory: `phase2-final-proposal-confirmation.json`, `phase2-final-geometry-confirmation.json`, `phase2-final-rod-browser.json`, `phase2-final-flow-browser.json`, `phase2-final-portrait-controls.json` and desktop/portrait PNGs. These are not distributed datasets. The exact task-owned browser target, listener and installed source were removed; target disappearance and listener/source absence were verified.

## Regression and independent review

The real browser producer exposed a segmentation-revision envelope mismatch missed by earlier mocked tests. The checked-in synthetic producer fixture now exercises the actual shape, including nested source binding. Other regressions cover exact numeric parameter echoes, nested case identity, prepaint suppression, busy-owner release, stale/replaced geometry, strict output shape/hash and persistence readback.

The independent native-loader audit added six synthetic guards for tampering, calibration/units, symlinks, bounded decompression and immutable-byte decoding. Parent strengthened the final guard by replacing the owned file immediately after its read, before verification/decode completed. In separate throwaway copies, restoring the old sectioner failed the exact-ring regression; reopening a mask pathname after verification failed the replacement regression. Both mutations failed for the intended behavior, and the shared review candidate remained unchanged.

Final local reviews on the pre-typing-cleanup export:

- `deleg_0c090009`: backend/worker **ACCEPT**; parent reproduced 15 API and 33 targeted native tests and checked the inspected hashes. A post-persistence409 can follow a committed row, so failure does not imply rollback.
- `deleg_090b0547`: UI/technical-doc **ACCEPT**; parent reproduced 54 targeted tests. The child misstated the candidate file count as 37; parent parsed 35 actual pre-report members, all matching. Preserved hashes bind the original dirty checkout, not baseline copies/absent files in the export; all nine original preserved files matched.
- `deleg_325c8c70`: scoped numerical typing cleanup. Parent inspected every delta: annotations, identity casts and an alias of matrix shape only. Corrected FEM-form annotations to arrays rather than scalar floats. No numerical algorithm, boundary condition, cap or parameter change. Both typing lanes and the full checks above were rerun after refreezing.

These are scoped implementation reviews, not scientific or clinical clearance. The configured GitHub review app must separately complete on the exact pushed head, CI must pass, and actionable findings must be resolved before merge. `phase2-artifacts.json` binds the final source/report bytes, excluding itself to avoid a recursive hash.
