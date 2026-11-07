# Phase 1 consolidation: local execution verification

Observed 2026-11-07, America/Chicago. This report covers local software behavior, not clinical validation, a completed imaging study, a deployment, or current device-IFU verification.

## Repository and plan

- Canonical repository: `/Users/colin/Desktop/Projects/Seldinger/seldinger-planner`.
- Branch: `feat/fresh-planning-workspace`.
- Base HEAD: `33ea6ff3b3b0bf18fd286f85b53610682066b83d`.
- The original execution checkpoint preceded Git delivery. The local `plan.md` remains untracked and is excluded from the source commit; commit and PR history record subsequent delivery.
- Plan SHA-256 at this checkpoint: `a8c39308b56d9a3f9c4124ab04da0c526cc89a34e29fd305e0378499e090e023`.
- Pre-existing research audit, numerical solver/distance/contact files, requirements and coil-rest-shape work were retained, not claimed as newly delivered by this refactor.

## Exercised behavior

1. Shared frontend-listing to SQLite model/SKU/source-record seeding, deterministic hashes and idempotent repeat seeding; catalog filtering via `/api/devices`. Existing historical `/api/device-catalog` remains separate and backward-compatible.
2. Six declarative territory/plugin contracts with finite-input deterministic calculators. Empty or unrelated measurements do not invent findings or severity. ELAPSS age steps and the 3-year risk lookup were corrected after source review. EVAR thresholds are explicitly heuristics, not generic IFU compliance.
3. Neck-clipped signed mesh volume with topology-derived winding, known-value box/prism/hemisphere tests, rigid-motion tests, disconnected-component handling and fail-closed non-manifold/open/nested-component checks. This is a mesh estimate with documented supported-topology limits.
4. Exact-SKU diameter/length resolution for coil primary diameter, conditional wire-volume/packing arithmetic, and suppression of missing, nonfinite, nonpositive and overflowing inputs. A real commercial family with unknown captured specifications does not inherit a measured-looking default.
5. Additional manifest-installed, bounded NIfTI-1 sources with hash, manifest revision, grid/dtype/header/mm/sform and symlink checks. A genuinely new synthetic NIfTI source ran through the real native-mask geometry function, not an invented API response.
6. Current accepted-mask identifiers, scalar geometry, derived indices and saved sizing reach `/planning-context`, the agent's `computed_context`, and the Markdown brief. Raw mesh/contour/path arrays are excluded. An injected local model probe inspected the context; auxiliary geometry recomputation without a case-version increment caused the response to be discarded with 409.
7. Geometry subprocess module resolution is isolated from the host agent's incompatible Python search path.

## Original mixed-checkout checks

| Command/check | Observed result |
|---|---|
| `uv run pytest -q --tb=short --ignore=tests/ml_runtime` | **625 passed** |
| `env -u PYTHONPATH SELDINGER_RUN_MODEL_TESTS=1 .runtime/ml-runtime/bin/python -m pytest -q --tb=short tests/ml_runtime/test_geometry_worker.py tests/ml_runtime/test_installed_source_geometry.py tests/ml_runtime/test_mask_geometry.py` | **21 passed** |
| `cd web && npm test -- --run` | **36 files, 214 tests passed** |
| `cd web && npm run build` | TypeScript check and Vite production build passed; existing >500 kB chunk warnings remain |
| Ruff on the 23 Phase 1 implementation/test paths | Passed |
| Pyright on 11 changed/new lightweight domain/API/source modules, using `.venv/bin/python` | **0 errors, 0 warnings** |
| `git diff --check` | Passed |
| Credential-pattern scan of 21 selected Phase 1 code/document/test files | No credential-pattern hits; this is a bounded heuristic scan, not a guarantee of absence |

The lightweight test environment and isolated imaging runtime remain separate. These imaging commands exercise synthetic masks and producer-shape fixtures, not new trained-model inference or clinical segmentation accuracy. No hosted model was called during this verification.

## Real HTTP and browser smoke

A fresh scratch SQLite workspace was served through real loopback HTTP, isolated from the usual workspace, samples and reference sources. Observed:

- Territory listing: six plugins.
- Intrasaccular listing filter: three listing models.
- Synthetic case creation, planning-context response and Markdown brief: successful, with absent computed evidence explicit.
- Invalid catalog category: 422.
- Untrusted browser origin: 403.
- Hosted model calls: zero. Clinical data used: none.

The production frontend build was then served with a fresh scratch backend. The smoke instance explicitly allowed its own test origin; production origin policy was not changed. Shared Chrome rendered the workspace and actual WebGL device bench. Selecting Target 360 rendered the illustrative coil, showed no coil wire-volume or packing-density metric, and emitted no captured page errors. The Close studio control had visible foreground/background colors and nonzero bounds. This was a desktop bench smoke, not an anatomy-backed planning or narrow-layout regression pass.

Local-only receipt artifacts, not publication assets:

- `/Users/colin/.hermes/profiles/seldinger/cache/scratch/phase1-ui-smoke/browser-receipt.json`
- `/Users/colin/.hermes/profiles/seldinger/cache/scratch/phase1-ui-smoke/coil-bench.png`

The owned Chrome tab was closed and its target disappearance verified. The temporary server was terminated; port 8876 had no remaining listener.

## Independent review closeout

A separate read-only reviewer inspected the new scalar context projection, server/brief integration and installed-source handling and found no blockers for this nonclinical software slice. The parent independently verified the reported behavior and resolved two small findings with RED/GREEN regression tests: duplicate custom source hash claims now fail with 503 instead of selecting the first directory; downloads preserve the actual NIfTI filename/extension.

Two availability tradeoffs are intentional: a corrupt bound image fails the case read, and corrupt or conflicting computed evidence prevents brief export instead of silently downgrading integrity failure into missing data. An ordinary absent/uncomputed source still has an explicit unavailable context and an exportable brief. These are not hidden service failures or implied clinical clearance.

After review, parent-added numeric guard tests confirmed finite-positive sac-volume rendering and rejection of supplied invalid volumes; all suites were rerun at the final source state. The earlier desktop browser receipt covers the unchanged coil-bench behavior, not every later numeric guard or responsive layout. `phase1-artifacts.json` binds the final reviewed/tested source files and report by SHA-256.

## Clean publication-slice verification and review reconciliation

The final source slice was exported from base HEAD with only the explicit Phase 1 file list overlaid. The untracked `plan.md`, unrelated source audit, numerical/contact solvers, extra requirements and coil-rest-shape files were excluded. This tests what will be committed, not an accidentally dependency-rich local working tree.

Observed on Python 3.12.13, matching the CI Python minor version:

| Clean-export check | Observed result |
|---|---|
| `env -u PYTHONPATH uv run pytest -q --tb=short` | **666 passed, 100 skipped** |
| Isolated synthetic native geometry/mask lane, same three imaging files above | **21 passed** |
| `npm test` | **35 files, 208 passed** |
| `npm run build` | Passed; existing chunk-size warnings only |
| `npm audit --omit=dev --audit-level=high` | Zero reported vulnerabilities |
| Whole-tree Ruff lint and format | Passed |
| Pyright on the 11 lightweight changed/new modules above | Zero errors, warnings or information diagnostics |
| Fresh real loopback HTTP smoke | Catalog, six plugins, synthetic case, context and brief passed; invalid category 422 and untrusted origin 403 |

The skipped lane includes optional heavyweight/model tests and two unavailable installed-public-source tests. They are not counted as passes. The six-test frontend difference from the earlier 214-test mixed checkout is the deliberately excluded unrelated coil-rest-shape test file. The clean environment initially inherited an incompatible host `PYTHONPATH`; rerunning without that variable resolved import contamination without changing application dependencies. The imaging lane reuses only the installed interpreter environment, not source images or model artifacts.

The requested independent review ran on **z-ai/glm-5.3-flash** (`deleg_cca455cb`). It reported no blockers and ran 86 targeted tests plus the synthetic installed-source imaging test. Parent reconciliation addressed its findings:

1. Model ID/dedup identity collisions now raise before overwriting a different identity. A related SKU DI collision cannot update another model's specifications. RED/GREEN tests verify unchanged stored rows after rejection.
2. Numeric alias and model-default fallbacks apply only to `None`, never replacing an explicit zero with a plausible alternate specification. This preserves source evidence; downstream metric validity checks still reject unusable diameters.
3. Catalog observation/seeding happens once during app construction. Repeated catalog GETs do not write or reseed the shared SQLite database, verified with an independent connection's `PRAGMA data_version`.
4. Fixed clinical-input examples assert score totals and both sides of every PHASES/ELAPSS risk band. The parent found and repaired a PHASES non-Finnish alias substring bug, and aligned NASCET boolean/string rejection with the other numeric helpers.
5. The WEB helper docstring now states the implemented status precedence. The bounded manifest scan remains uncached intentionally: a small installation set favors fresh integrity/ambiguity checks over a new invalidation mechanism.

The repaired slice then received a second independent **z-ai/glm-5.3-flash** review (`deleg_11a206b2`), which accepted it with no blockers and observed 70 targeted tests passing. The parent reran those 70 tests and independently matched the reviewer's SHA-256 bindings for `device_db.py`, `calculators.py`, `server.py` and the catalog regression tests before delivery.

The new guard tests were observed failing before each production repair and passing afterward. A throwaway clean-export mutation reinstating the PHASES substring bug was caught by the alias regression, then the source file was restored byte-for-byte. No hosted model calls or clinical data were used.

## Evidence boundaries and remaining work

- No unsupported coil SKU/diameter or supplemental regulatory identifiers were retained. Outside the sourced neurovascular listing, category scaffolding is visibly unverified. Current source-backed commercial catalog expansion remains an evidence-acquisition task.
- New source loading is bounded NIfTI-1 with explicit sform, not arbitrary unrestricted NIfTI-2/qform-only/full-head ingestion.
- Potentially nested/overlapping disconnected mesh components are conservatively rejected. There is no general solid-membership or self-intersection certification.
- Clinical measurement validity, device suitability, individualized risk, treatment recommendations and outcomes are not established.
- Physics worker/API integration, automatic centerlines, structural/coronary/peripheral workflow UIs, DICOM ingestion, CPR and the four additional target adapter protocols remain subsequent phases.
- Software-source delivery is separate from deployment, data publication, patient-data transfer and external outreach; none of those broader actions is authorized or established by these checks.
