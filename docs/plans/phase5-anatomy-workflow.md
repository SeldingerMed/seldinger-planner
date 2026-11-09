# Phase 5 anatomy-assisted workflow implementation plan

> **For Hermes:** Implement through the Hermes-native engineering harness, independent scoped subagents and RED-GREEN verification. Never use OMP. This plan is being refined against the existing producer contracts before shared interfaces are frozen.

**Goal:** Complete one imported-CTA aneurysm workflow from editable anatomy proposals through confirmed measurements, source-bound device alternatives and local export, with reproducible real-image evaluation.

**Architecture:** Preserve the current source registry, accepted-mask/geometry/physics/scene ledgers and their revision identities. Add orchestration and adapters around those actual providers, not a replacement inference/geometry stack. Proposal generation never silently confirms operator inputs. Each saved alternative and exported result binds to exact source and upstream materialized evidence.

**Tech stack:** Existing Python/FastAPI/SQLite lightweight API, isolated locked imaging/model/numerical runtimes, React/TypeScript/NiiVue native-volume UI.

## Boundaries

- Base: `7af0136b1c194cb0ce2df61bd7dcf6831f329f47`; branch `feat/phase5-anatomy-workflow`.
- Keep eight unrelated dirty files intact. Extend the controlling local `plan.md` deliberately, but do not commit it.
- Original public or declared synthetic inputs only for autonomous verification. No patient/partner material, new data transfers, deployments or paid compute are authorized.
- Retain exact original model-artifact provenance and applicable use rights. No model/code/data copying from legacy checkouts.
- Never replace an unavailable real model result with a synthetic response. Record empty/error results, inference context, stage runtimes and unsupported measurements honestly.
- Retain unknown manufacturer dimensions and distinguish measurement definitions. Device comparisons use available declared data and existing numerical outputs, not invented commercial specifications.

## Delivery slices

### 1. Source and model integration

Inspect `planner/segmentation_server.py`, `planner/segmentation_worker.py`, `planner/source_registry.py` and the existing model adapters/tests. Capture actual supported producer payloads, exact original-artifact rights and runnable local runtimes. Add failing source-rebinding/calibration/stale-byte cases before changing the fixed worker path. Generalize only proven pinning restrictions; preserve accepted candidate and SAM correction behavior.

### 2. Anatomy-to-measurement proposals

Use `planner/centerline.py`, `planner/geometry_worker.py`, `planner/geometry_server.py` and the actual operator-input schema. Produce editable, source-bound path/plane proposals from accepted masks. Explicit confirmation, not generation, commits them to geometry/reformat providers. Add known-geometry and changed-mask/result/source tests before implementation.

### 3. Device alternatives

Compose the actual device/physics producers into bounded saved alternatives with independent revisions and explicit upstream dependencies. Preserve operator-entered versus computed values. Compare saved current alternatives and mark stale evidence unavailable; never resurrect older matching history. Implement pure contracts and ledger tests before HTTP and UI wiring.

### 4. Guided application

Wire Import, Anatomy, Measurements, Device scenarios and Export into the real App. Reuse the editors and renderer rather than implementing a second viewer. Show readiness and required confirmation; preserve dirty/busy/ambiguous-write ownership and case-switch recovery. Exercise the real parent feedback loop, not only mocked callback tests.

### 5. Reproducible evaluation

Create `planner/model_evaluation.py` and isolated tests `tests/ml_runtime/test_model_evaluation.py` first. Exact binary-grid counts, Dice/IoU, foreground volumes and physical centroid agreement use declared units and validated affine. Empty reference/prediction cases remain explicit, with undefined metrics represented as unavailable rather than artificial perfect scores. Image/model/label provenance and stage runtime are recorded by the integration harness, not invented by the pure metric helper. Run actual permitted public cases after the complete producer path works; distinguish development-selected inputs from independent evaluation.

### 6. Verification and publication

Run a clean explicit candidate using locked CI-compatible environments, including repo-relative worker interpreters. Require actual default-App public/synthetic producer tests, real browser render/edit/reload/compare/download checks, negative dependency/race tests, bounded original-model execution, quantitative real-case readback, secret/privacy audits, independent final review and exact-head Hermes Review/CI. Commit/push/open PR/merge through the authorized gate; verify merged tree, postmerge checks and preserved local hashes.

## Initial evaluation tracer

1. Add a synthetic known-value binary-grid test before creating the helper.
2. Run `env -u PYTHONPATH -u PYTHONHOME SELDINGER_RUN_MODEL_TESTS=1 .runtime/ml-runtime/bin/python -m pytest -q tests/ml_runtime/test_model_evaluation.py` and observe RED.
3. Implement exact counts, finite affine/units guards, empty states and bounded centroid arithmetic with lazy imaging imports.
4. Run the narrow tests, then expand adversarial shapes/values/affines and base-import isolation. The remaining task-level files and producer interfaces are frozen after the scoped reconnaissance returns.

## Frozen integration decisions

- Existing `ImageSourceRegistry.load_for_case` and the fixed model worker already resolve arbitrary admitted installed sources. Preserve and exercise that implementation rather than falsely claim a new general source path.
- The pinned upstream RSNA README explicitly licenses both code and weights under Apache-2.0. Its separately restricted corrected training labels are not acquired. Add `rsna-vessel` as a fixed-runtime vessel candidate from the original first segmentation head, with distinct `rsna_vessel_model` provenance. Retain the historical owned-vessel adapter without making the demonstrated path depend on its unresolved pooled-corpus rights.
- Keep source decoding tied to the exact hashed immutable bytes. Recheck source bytes after inference; validate binary outputs before uint8 conversion, and enforce actual mm declarations for every calibrated installed source. The existing pinned unknown-unit float64 CMHA input retains a separately bounded eight-byte decode path, not a relaxation of the installed-source dtype contract.
- New anatomy input proposals reuse the existing operator geometry input shape and are never persisted as confirmed geometry by generation alone. One selected connected sac component, an editable neck/seed/parent path, and explicit confirmation are required.
- Saved device alternatives use an immutable independent-revision ledger, at most12 entries with strict procedural placement fields, bound to current materialized geometry and server-selected catalog identity. Do not attach copied client-supplied numerical diagnostics or infer missing commercial specifications.
- The existing original Zenodo15697196 case013 is a calibrated CC-BY-4.0 saccular development/reference candidate with public DICOM, STL and measurements. Its full volume exceeds application transport limits. Any bounded selected context must preserve exact source/calibration/crop provenance, disclose reference-informed selection, and remain separate from independent detection or training-overlap claims.
- All new source/model tests remain distinct from synthetic-logit, synthetic-mask, metric-arithmetic and injected HTTP fixtures. Real model output and real default-App integration require separate receipts.
