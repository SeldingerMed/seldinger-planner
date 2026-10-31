# Local model and planning-core verification

This is an internal engineering receipt for the slice following `c65273619544e7b9eb8da199cd6d3710b0ddc6a8` on `feat/fresh-planning-workspace`, not a completed application, clinical study, or publication-ready demonstration. Publication and exact-head CI are separate checks.

## Owned vessel model

The pinned original-registry checkpoint has been acquired and hash-verified, and its original network executed first on a synthetic tensor and then on the authorized public CTA through `planner/vessel_inference.py`. The public context ROI returned a native 175x180x140 binary mask with 12236 foreground voxels in 46.46663312520832 seconds. Saving/reopening the NIfTI preserved its affine, unknown units and every mask voxel exactly. Receipt: `artifacts/model-discovery/owned-vessel-public-candidate.json`; output SHA-256 `b76b7408273957927b5ef09f1cdffc41e663ee33ec68059c8667c7bf901747b8`.

Original training-source review established unmasked upstream TorchIO HistogramStandardization, followed by rounding/int16, then nnU-Net preprocessing. Parent checked actual upstream code and rejected the delegate's incorrect evenly spaced-percentile and clipping claims. The implementation uses the original pinned target landmarks, actual TorchIO's nonuniform percentiles and tail extrapolation. Exact original training version and fitted cohort remain unverified. This run used ROI-level normalization, numeric source spacing with unknown physical units, and no TTA. It does not establish full-head training-distribution equivalence, vessel accuracy or aneurysm detection. The mask was subsequently connected through the real local worker/API/viewer path; see `case-inference.md` for exact browser verification. No legacy implementation was copied.

## Actual SAM execution

- Upstream code: `facebookresearch/sam2` at `2b90b9f5ceec907a1c18123530e92e794ad901a4`, installed directly into the ignored ML environment with CUDA extension building disabled.
- Original model: `facebook/sam2.1-hiera-tiny` at `de431c4043854a71d8101e17995dfe596bf101a5`.
- Checkpoint: 156008466 bytes, SHA-256 `7402e0d864fa82708a20fbd15bc84245c2f26dff0eb43a4b5b93452deb34be69`.
- Fresh adapter: `planner/sam_refinement.py`. CPU-only, same verified file descriptor passed to upstream restricted loader, native row/column prompt coordinates, separate predictor per image, explicit prompt provenance, unaccepted candidate output. SAM's score is not an aneurysm probability.
- Prompt unit tests: 11 passed after an observed missing-module RED.
- Real-weight synthetic integration test: 1 passed in 1.36 seconds after an observed missing-function RED. Upstream emits a `torch.jit.script` deprecation warning.
- Authorized public CTA: actual prompted inference on CMHA AHMU1218001, native axial crop index 72, source image SHA `98cf6634833acf722a0bd084a4bbe9b5c4545954b3c9759c1003b225086ecb0c`. Execution returned a 180x175 candidate mask with 100 foreground pixels in 0.9536726251244545 seconds. The point and box were derived from the curated reference, not a detector. Source spatial units remain unknown; display window 0–600 is in source intensity, not established HU.
- Visual inspection: the small red candidate occupies the bright focal structure around the positive point inside the supplied box. It is neither empty nor full-frame and has no obvious gross translation. This is not a clinical boundary-quality assessment or independent registration validation.
- Source case remains CC BY 4.0 with attribution to Song et al., DOI `10.6084/m9.figshare.26965450.v1`.

Reproduction in the separately installed, ignored runtime:

```sh
SELDINGER_RUN_MODEL_TESTS=1 PYTHONPATH="$PWD" .runtime/ml-runtime/bin/python -m pytest tests/ml_runtime/test_sam_model.py -q
PYTHONPATH="$PWD" .runtime/ml-runtime/bin/python artifacts/model-discovery/sam_public_probe.py
```

Ignored evidence: `artifacts/model-discovery/sam2-acquisition.json`, `sam-synthetic-tests.xml`, `sam-public-slice.json`, `sam-public-slice-mask.npy`, `sam-public-slice-preview.png`, and `ml-runtime-with-sam-freeze.txt`. The public-case probe script is a local experimental receipt, not a production API.

Subsequent case-bound worker/API integration, world-to-native coordinate tests, preview/accept/reject UI and ledger were exercised as recorded in `case-inference.md`. Still absent: 3D propagation, existing-mask splice correction and actual downstream derived-geometry/sizing invalidation. Do not call the complete SAM correction workflow finished.

## Earlier core checks

Before API integration, 212 base tests and five separately enabled ML tests passed. Parent reproduced four defects in the incoming geometry patch before fixing them: raw-XY hulls on vertical planes, tangent rather than normal minimum-Feret direction, vertex-weighted rather than area centroid, and late triangle-count enforcement on streams. The resulting 17 geometry tests passed at that stage. Independent planning-core review was subsequently reconciled in `../reviews/planning-cores.md`. API/UI integration is now exercised as recorded in `case-inference.md`, but actual downstream derived-artifact invalidation remains unfinished. No geometry or device result is clinically validated by these checks.

## Aneurysm model source findings

- `huanghoujing/bravecowcow_inference_docker` omits the segmentation decoder from its deployment artifact. This does not establish that the author's separately published full checkpoint is unavailable.
- `MeteorsHub/GLIA-Net` publishes a 12900161-byte pretrained release asset, but its original README restricts the code to noncommercial academic research. It has not been selected, acquired, or integrated for this company prototype.
- Original full checkpoint: `pengchengshi/dataset660_26classes_resize224_4661/pytorch/default/2`, exact file `Dataset660_26classes_resize224_4661/onlyMirror01_lr4e3_100epochs_ps224/fold_0/checkpoint_final.pth`. Official KaggleHub exact-file download needed no login or competition-term acceptance. Sidecars were acquired separately; no corrected labels or competition images were acquired.
- Acquired checkpoint: 875399410 bytes, SHA-256 `e60b539d025a8ecccf77d3ff1a45ef6888b5e059671cc8e24fff572d520fa521`. This is a hash of actual acquired bytes, not an upstream-published SHA manifest. Receipt: `artifacts/model-discovery/aneurysm-checkpoint-acquisition.json`.
- Actual restricted `weights_only=True` inspection found both full segmentation heads, classification and modality heads. Embedded plans differ from adjacent `plans.json`; the adapter uses the embedded architecture configuration and the actual trainer override, not its generic architecture-class text.
- Original nnXNet source was installed directly from public author revision `1ead0ba4dc00bcd84591269995dde6a8446ca3ad`. The author states Apache 2.0 for code and model weights, separately CC BY-NC for corrected labels. `planner/aneurysm_inference.py` imports the upstream `ResEncoderUNet_two_seg_with_cls_modality`, not copied legacy implementation.
- A separate Python 3.11 runtime uses PyTorch 2.12.0 and dynamic-network-architectures 0.3.1 because the original nnXNet dependency excludes 0.4. The already exercised vessel/SAM runtime remains unchanged with dynamic-network-architectures 0.4.4.
- Observed missing-module RED, then strict full-state loading and actual synthetic forward GREEN: one test passed in 1.43 seconds. Output shapes on a 64-cubed zero tensor were segmentation `(1,15,64,64,64)` and `(1,14,64,64,64)`, classification `(1,1)` and `(1,13)`, modality `(1,4)`; every output was finite. Receipt: `artifacts/model-discovery/aneurysm-real-weights-synthetic.xml`.
- The initial result was an architecture/weight smoke test only. Subsequently, fresh preprocessing/restoration and a memory-aware first-head graph produced an actual public-CTA candidate; see `aneurysm-public-inference.md` for exact output, failed CPU/MPS attempts and graph-equivalence limits. The current dedicated suite passes 19 tests. Original full-head ROI selection, lesion accuracy, product integration and clinical validation remain unfinished.

Primary source URLs:

- https://github.com/facebookresearch/sam2
- https://huggingface.co/facebook/sam2.1-hiera-tiny
- https://github.com/huanghoujing/bravecowcow_inference_docker
- https://raw.githubusercontent.com/MeteorsHub/GLIA-Net/master/readme.md
- https://github.com/PengchengShi1220/RSNA2025_Intracranial-Aneurysm-Detection/tree/1ead0ba4dc00bcd84591269995dde6a8446ca3ad
