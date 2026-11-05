# Extend case-bound inference with exercised aneurysm segmentation

Fresh implementation, no legacy copying or data/weights in git. The actual public-ROI adapter has produced a 317-voxel candidate and passed native readback. This extension connects it to existing case-bound machinery, not independent full-head detection or clinical validation. Existing unknown-unit/reference gates remain unchanged.

## Single-writer scopes

- Backend child: ONLY `planner/segmentation_server.py`, `planner/segmentation_state.py`, `tests/test_segmentation_server.py`, `tests/test_segmentation_state.py`.
- Worker child: ONLY `planner/segmentation_worker.py`, `tests/ml_runtime/test_segmentation_worker.py`.
- Parent: `planner/aneurysm_inference.py` and its tests, frontend, docs, actual model/browser runs, final verification/publication.

Read existing code/tests and AGENTS. TDD: observe focused failure before implementation. No AGENTS edits, .env access, installs/downloads, clinical data, model execution, commits or edits outside assigned scope. Preserve prior worker/API guards and evidence distinctions.

## Exact new producer contract

- API `kind: "aneurysm"`, `role: "aneurysm"`, ledger producer `"aneurysm_model"` (already declared in existing ledger and TypeScript union).
- No prompt needed or used. Existing request artifact version/reference/image/dimensions gates, final readback, semaphore, byte caps, sanitized failures and permanent decisions all remain.
- API kind→role and kind→producer maps gain this fixed mode. Requests cannot select runtime, device, checkpoint, expected hash, model name or paths.
- Ledger producer→role mapping must reject BOTH prompted SAM and aneurysm model pretending to be vessel, as well as owned vessel pretending to be aneurysm. Test this actual guard before fixing.

## Worker child

`run_local_model` selects `.runtime/aneurysm-runtime/bin/python` ONLY for kind `aneurysm`; vessel and sam2 keep `.runtime/ml-runtime/bin/python`. Runtime paths are trusted constants, never job inputs. Refuse unknown kinds before subprocess. Keep no shell, isolated PYTHONPATH, timeout180, strict metadata size/read bounds and diagnostics.

Inside `_run_job`, accept the new fixed kind, independently require role aneurysm, and use lazily imported `planner.aneurysm_inference.predict_aneurysm(data, source.affine, checkpoint_path=ANEURYSM_CHECKPOINT)`. Parent is implementing that exact signature. Original checkpoint path is `.runtime/models/rsna-aneurysm-stage2-v2/Dataset660_26classes_resize224_4661/onlyMirror01_lr4e3_100epochs_ps224/fold_0/checkpoint_final.pth`.

Return from parent helper is a dict with `mask` binary native XYZ `uint8`, plus JSON-safe provenance. Do not implement or stub that parent helper. Unit tests may monkeypatch it with explicitly synthetic arrays and distinguish them from real model output. Worker must save/reopen with existing geometry/unit/dtype checks and filter mask from JSON as before.

New branch sets `slice_index=None`, `segmentation_extent="full_context_roi"`, `prompt_provenance=None`, metadata producer `aneurysm_model`, role aneurysm. `volumetric_morphometry_eligible=False` for this branch; clinical validation remains none. `automatic_aneurysm_detection=False` denotes no independent full-head localization; add explicit `automatic_aneurysm_segmentation_within_selected_context=True` for the new mode. Existing modes have that field false. Retain reference-selected context provenance. No classification confidence is fabricated because unused classification heads are pruned.

## Required tests

Backend: API accepts kind aneurysm without SAM point, passes exact selected identities to runner, creates correct producer/role preview, downloads/accepts/readbacks while preserving accepted vessel; wrong role rejected; existing stale/foreign/race/failure tests remain. Ledger wrong-role producer guards observed RED then GREEN.

Worker: subprocess chooses exact new interpreter (not job-supplied path) only for new kind; rejects unknown kind; source identity verification still applies. Inject synthetic new helper result, test saved native affine/units/dtype/binary provenance and no prompt/clinical/morphometry claim. Test role mismatch before helper invocation. Keep actual fixed-source source tests; no need to run a model for child verification.

Use base `uv run pytest` for backend. Worker analytics use `SELDINGER_RUN_MODEL_TESTS=1 PYTHONPATH="$PWD" .runtime/ml-runtime/bin/python -m pytest tests/ml_runtime/test_segmentation_worker.py` excluding real model tests. Parent owns actual new-runtime worker/API/browser execution.
