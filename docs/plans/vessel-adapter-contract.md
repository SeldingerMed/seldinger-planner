# Fresh owned-vessel inference adapter contract

Scope ONLY `planner/vessel_inference.py` and `tests/ml_runtime/test_vessel_preprocessing.py`. No legacy repository access or copied implementation. Install/use upstream libraries already present in `.runtime/ml-runtime`; parent handles data execution, API/UI and fixes elsewhere. Use strict RED/GREEN. Root environment lacks ML deps intentionally; tests are opt-in via `SELDINGER_RUN_MODEL_TESTS=1` as in test_sam_model.py.

## APIs

- `standardize_cta(image_xyz, landmarks_path)` returns same-shape numpy int16 array.
- `predict_vessel(image_xyz, spacing_xyz, *, checkpoint_path, landmarks_path)` returns dict including native XYZ binary uint8 `mask`, method `owned_pooled_vessel_inference`, `automatic_aneurysm_detection=False`, model revision/hash, `tta=False`, and preprocessing provenance with unresolved original training TorchIO version and unreproduced cohort equivalence. No clinical accuracy claims. CPU threads set by caller, no global device hacks.

Inputs are trusted installer/case-worker arguments, NOT arbitrary paths exposed to the product agent. Validate 3D finite nonempty input and <=8 million voxels, positive finite nonbool 3-element spacing. Values are source numeric spacings; caller must preserve unknown spatial units. This adapter never establishes mm or rewrites image geometry.

## Original-artifact contract

Model `.runtime/models/pooled-vessel-v1/checkpoint_best.pth` already exists. Use `planner.model_assets.verified_checkpoint`, same verified open descriptor, restricted torch.load(weights_only=True) with only exact NumPy scalar/dtype allowlist observed in artifacts/model-discovery/smoke_owned_forward.py (read that NEW-REPO smoke, not legacy source). Embedded checkpoint plans/dataset_json are authoritative. Build upstream network dynamically from embedded architecture via get_network_from_plans, strict state load, stripping `_orig_mod.` only if every key starts that. Binary labels must exactly background0/vessel1. No arbitrary checkpoint architecture accepted beyond exact known network class from original plans. Set deep_supervision=False, allow_init=False.

Original `landmarks.npz` is 364 bytes, SHA256 `09b6b9f43458493631cff1470c02d8c1480a258b62dee2ef4ba3f2d9c3e0eaab`, contains CTA shape(13,) float64. Verify with same artifact helper `CheckpointSpec(364,sha)` and np.load(stream,allow_pickle=False) from descriptor. Check finite ordered 13 entries, not caller-provided expected hash.

## Verified original training algorithm facts

Parent read original TRAINING source read-only, no code copied. It calls public `torchio.HistogramStandardization({"img": original_landmarks})` on `ScalarImage`, no masking option, then Torch `.round().short()`. Non-CT channel later uses nnU-Net DefaultPreprocessor with unmasked ZScoreNormalization.

Use UPSTREAM TorchIO 1.2.1 currently installed, don't rewrite Nyul. Parent compared its source to upstream 0.20.1: effective percentiles `[1,10,20,25,30,40,50,60,70,75,80,90,99]`, mapping uses selected indices `[0,1,2,4,5,6,7,8,10,11,12]`; all voxels included, piecewise-linear tail EXTRAPOLATION (NOT clipping), epsilon duplicate-percentile handling. Original training's exact TorchIO version and fitted cohort cannot be independently re-established. State this in provenance. Do not assert [0,100] clipped range or linspace percentiles. The pinned original target file is used, not a newly fitted cohort or synthetic substituted landmarks.

Use `tio.ScalarImage(tensor=torch.as_tensor(image_xyz[None],dtype=torch.float32))` and a Subject or documented tensor API; no orientation change needed for histogram statistics. Validate finite output and reject round results outside int16 representability rather than silently corrupting. Return `.round().short()` numpy values.

## nnU-Net prediction

Construct nnUNetPredictor(tile_step_size=0.5,use_gaussian=True,use_mirroring=False,perform_everything_on_device=False,device=torch.device('cpu'),verbose=False,allow_tqdm=False).

`manual_initialization(network,plans_manager,configuration_manager,parameters=[strictly_loaded_original_state],dataset_json=...,trainer_name=...,inference_allowed_mirroring_axes=None)` is required by installed nnunetv2 2.8.1: its prediction loop iterates the parameter list. `parameters=None` is not supported by that prediction path. Parent inspected the actual upstream implementation and exercised the corrected full path on the public CTA. `PlansManager(embedded_plans)` and `get_configuration('3d_fullres')` are used. With `save_or_return_probabilities=False`, `predict_single_npy_array` returns a ZYX ndarray, not a tuple; do not index `[0]` before restoring XYZ. A parent RED/GREEN native-grid regression covers this actual producer contract.

SimpleITK reader order is channel,Z,Y,X, while input/output adapter contract is X,Y,Z. Feed standardized XYZ transposed to `(1,Z,Y,X)` as float32, image_properties `{"spacing": tuple(reversed(spacing_xyz))}` to `predict_single_npy_array`, return segmentation transposed back XYZ. No output disk exports. Validate returned exact original shape, finite binary values BEFORE cast. No TTA in this bounded CPU candidate path; record explicitly.

## Required opt-in tests

1. First RED→GREEN against standardize_cta using actual original target file, seeded monotonic synthetic source array: same shape/int16, matches direct upstream TorchIO public transform + rounding; no clipped-range assumption. File hash verification is real, not monkeypatched.
2. Rejection of invalid dimensions/nonfinite input and bad spacing through cheap validation path before loading 0.8GB checkpoint.
3. Parent will separately exercise predict_vessel on actual public CTA and inspect resulting mask; don't launch that image inference yourself or add a fake model result to tests.

Run tests via `SELDINGER_RUN_MODEL_TESTS=1 PYTHONPATH="$PWD" .runtime/ml-runtime/bin/python -m pytest tests/ml_runtime/test_vessel_preprocessing.py -q --basetemp artifacts/pytest-vessel-preprocessing`, root Ruff on your files. Limit <=13 calls <=5min; return real test evidence, no commits, no other file writes.
