# Case-bound local inference integration

Fresh implementation only. Parent owns frontend. Backend writer owns ONLY planner/segmentation_server.py, tests/test_segmentation_server.py and small registration in planner/server.py. Worker writer owns ONLY planner/segmentation_worker.py and tests/ml_runtime/test_segmentation_worker.py. Both use TDD and actual existing producer contracts, no legacy imports. Read AGENTS and planner/segmentation_state.py. No cloud, spending, arbitrary files/URLs, images to hosted Muse, or clinical validation claims.

## API contract, backend writer

Register `register_segmentation_routes(app, ledger, references, read_case, results_dir, runner=None)`. Instantiate SegmentationLedger(db_path) inside build_app and register with private `.runtime/inference-results` default path. Add optional `inference_runner=None`, `inference_results_dir=None` kwargs for test injection. No frontend changes. runner is `run_local_model` from planner.segmentation_worker, imported LAZILY so base server never imports ML libs. That module must keep heavy imports function-local.

`POST /api/cases/{case_id}/segmentations` body strictly forbids extras:
- artifact_version: string
- reference_revision: exact SHA string
- kind: `vessel` or `sam2`
- role: `vessel` or `aneurysm` (vessel model requires vessel)
- point_ras: optional finite xyz, required for sam2
- radius_voxels: strict integer 2..40, default12
- display_window: finite increasing 2-values, default[0,600], source intensities not asserted HU

Load current case and ReferenceStore bundle. Require exact case image hash, artifact version and reference revision, actual known reference dimensions, source unknown units; no client calibration overrides. First integration is deliberately limited to the installed original public reference image. Non-reference cases fail explicitly. Serialize inference with nonblocking process-local BoundedSemaphore(1), busy429; runner exception yields sanitized503 and no ledger preview. Keep source reference/case readback after worker and before preview; stale409, no candidate acceptance.

Call runner(job, output_dir) synchronously in a private new staging dir below results_dir. Job contains ONLY validated fields above plus server-selected case_id,image_sha256,reference_revision. Its output is dict `{"mask_path": Path, "metadata": dict}`. File must be exactly stagingdir/mask.nii.gz, regular notsymlink, 0<size<=16MiB. Compute SHA on actual bytes, atomically install content-addressed results_dir/blobs/{sha}.nii.gz. Metadata must fit ledger cap. `ledger.preview(case_id, artifact_version, reference_revision=..., producer="owned_vessel" or "sam2_prompted_slice", role=..., mask_sha256=...,provenance=metadata)` produces candidate. Always clean attempt-owned staging directory; never delete unrelated files. Nonclinical unit-test runner may explicitly produce synthetic fixture bytes for route tests, not fake model claims.

`GET /api/cases/{case_id}/segmentations`: return `{current:{vessel:entry|null,aneurysm:entry|null}}`; each entry includes exact fixed mask_url below. No arbitrary path parameters.

`POST /api/cases/{case_id}/segmentations/{candidate_id}/decision`: strict body artifact_version, reference_revision, decision `accept|reject`; verify reference still matches and candidate reference_revision matches, then ledger.decide. Return entry plus new artifact_version. Map SegmentationConflict to409; candidate foreign case404/409 without disclosure. Accept bumps case revision via actual ledger; reject doesn't. Do not claim derived artifacts are implemented merely because validity flags are false.

`GET /api/cases/{case_id}/segmentations/{candidate_id}/mask`: verify entry owned by case, current image/reference identity, status preview or accepted; stale preview409, rejected/superseded404. Verify blob size/symlink/hash, then FileResponse. No image bytes in metadata responses.

All returned entries get `mask_url="/api/cases/{case_id}/segmentations/{candidate_id}/mask"` and carry existing ledger fields: candidate_id,case_id,image_sha256,produced_artifact_version,reference_revision,producer,role,mask_sha256,status,segmentation_revision,provenance. API rejects caller model paths/hashes/URLs. Tests: successful synthetic route/accept/reject/mask; stale case/reference before and after fake runner; other-case ownership; failure no candidate/revision change; no unexpected paths. Use actual ReferenceStore synthetic fixtures from tests/test_reference_server.py if useful. No real model weights required for base tests. Parent separately exercises real worker/API/browser.

## Worker contract, worker writer

Expose `run_local_model(job:dict,output_dir:Path)->dict` without heavy imports at module scope. It runs fixed project `.runtime/ml-runtime/bin/python -m planner.segmentation_worker` with JSON on stdin, private output_dir argument set by trusted backend caller, subprocess timeout180 seconds, no shell, captured output/log cap. Child CLI reads same job, fixed project `.runtime/public-reference` (never job-supplied filesystem or URL), verifies manifest revision and actual image SHA, loads NIfTI via nibabel. Guard <=8M voxels, finite 3D source, source units unchanged. Source header/affine is authoritative, not client metadata.

CLI uses existing real `predict_vessel` and `refine_slice`, CPU threads4. For vessel call known checkpoint/landmarks fixed .runtime model paths. For sam2 convert point_ras with inverse source affine to nativeIJK, require within image and finite; k=round(nativeK); only native axial plane is supported. Prompt x=i,y=j, displayed image is volume[:,:,k].T. Native radius determines a clipped box strictly inside frame; normalization uses caller display_window in source intensity units. Candidate mask rowsJ,colsI is transposed back into XYZ[:,:,k]. Other slices zero for a fresh SAM candidate; explicitly mark `segmentation_extent="single_native_axial_slice"`, `volumetric_morphometry_eligible=False`, `prompt_provenance="operator_entered"`. This is not automatic lesion detection or full-volume propagation. No curated coordinates/masks as automatic prompts.

Save mask.nii.gz with source shape/affine/header units preserved, dtypeuint8; re-read and assert shape/affine/units/binary data. Save metadata.json alongside it. Metadata includes producer returned provenance, image_sha256,reference_revision,native_shape,source_units,source_dtype/window, sourceaffine, single-slice index ifSAM, foregroundcount and no clinical validation. No arrays/tensors in metadata JSON. Hashes chosen by backend, not arbitrary client arguments.

Parent runner returns mask path and parsed metadata only; stdout logs aren't assumed pure JSON because nnUNet emits diagnostics. On subprocess failure/timeout, raise a sanitized RuntimeError with bounded diagnostics only in private logs, never leak paths/trace to API. Do not initiate network downloads from worker; fixed installed artifacts only.

TDD opt-in tests for `native_prompt` coordinate helper (define signature you choose, report it), reflected/translated/anisotropic source affine, bounds and XYZ plane insertion. Skip base env intentionally as in existing ML tests, and separately run enabled in ML runtime. Do not launch expensive vessel inference or copy/read legacy repo. Parent owns actual full API execution. Both writers run focused tests + `uv run ruff format` and `uv run ruff check` on their own files, no commits.
