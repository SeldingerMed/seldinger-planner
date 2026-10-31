# Full aneurysm model: fresh adapter contract

Internal implementation contract, not clinical-validation evidence. The full original checkpoint strict-loads and executes both segmentation heads on a synthetic tensor. Subsequent standalone public-ROI inference is exercised in `../verification/aneurysm-public-inference.md`; independent full-head localization, product integration and performance validation remain open.

## Pinned primary sources

Author repository: `PengchengShi1220/RSNA2025_Intracranial-Aneurysm-Detection` at `1ead0ba4dc00bcd84591269995dde6a8446ca3ad`. Source is independently installed from the original author under ignored `.runtime/upstream-rsna`; no legacy Seldinger application is imported.

- Actual architecture: `nnXNet/nnxnet/training/nnXNetTrainer/variants/network_architecture/ResEncoderUNet_two_seg_with_cls_modality.py`.
- Trainer construction: `nnXNet/nnxnet/training/nnXNetTrainer/nnXNetTrainer_ResEncoderUNet_two_seg_with_cls_modality.py`, `build_network_architecture`.
- Deployment preprocessing: `bravecowcow-2nd-place-inference-demo.ipynb`, code cell 2, especially `reorient_nii` (source lines 387–397), `predict_aneurysm` (739–778), and NIfTI input handling (833–840). These line numbers refer to the code cell's joined source, not notebook JSON lines.
- Reader: `nnXNet/nnxnet/imageio/simpleitk_reader_writer.py`, `read_images`.
- Generic training preprocessor: `nnXNet/nnxnet/preprocessing/preprocessors/default_preprocessor.py`, `run_case_npy`. This is not interchangeable with the deployment notebook's explicit stage-2 handoff.

## Reconciled audit

Read-only audit `deleg_898a2086` correctly identified the trainer override and two full segmentation heads. It used 18 calls against a requested maximum of eight, and reported temporary files outside the approved scratch directory. Do not treat that execution as limit-conformant. Parent independently checked the installed pinned source and actual strict-loading/synthetic-forward evidence.

Corrections to the returned audit:

1. `sitk.GetArrayFromImage` returns ZYX, not XYZ. The source reader calls it directly, adds the channel axis and reverses XYZ spacing. Its nearby informal comment reverses these descriptions and is not the producer contract. The author's notebook independently confirms `img_orient.get_fdata().transpose(2,1,0)[None]`.
2. The deployment notebook does not use generic cubic spacing-based resampling for the stage-2 handoff. It normalizes the supplied vessel ROI, then uses PyTorch trilinear interpolation to exactly 224 cubed with `align_corners=True`.
3. The deployment normalization uses Torch `std()` with its default sample correction, not NumPy population standard deviation. The original notebook first casts the ROI to fp16. A CPU float32 implementation must disclose that precision deviation and test it, not claim bitwise deployment equivalence.
4. Head-2 classes follow the explicit embedded `seg_index_2` groups. The returned audit's first-class example and universal `27-k` pairing formula are wrong. Do not infer names or pairings arithmetically; bind the actual embedded groups to the independently acquired `dataset.json`.
5. Generic inference reads intensity properties through the plans manager. An unacquired dataset fingerprint is not, by itself, a demonstrated blocker for the notebook's explicit per-volume normalization. No fingerprint acquisition is justified merely by that assertion.

## Input and preprocessing boundary

- Trusted installer chooses the pinned checkpoint and upstream package. Product requests never choose filesystem paths, expected hashes, arbitrary models or importable class names.
- Bind a finite, bounded native XYZ image to the server-selected case/image/reference revision and its exact affine. Preserve original units. Model resize coordinates are not millimeters.
- Reorient through NiBabel's orientation transform to LPS; preserve the reversible native-to-oriented index mapping. Then transpose XYZ to ZYX and add the channel axis. Identity `transpose_forward` does not undo this reader convention.
- The author pipeline obtains a vascular ROI using its separate stage-1 model and slices `[z_min:z_max,y_min:y_max,x_min:x_max]`. Stage-1 margin and bounds semantics must be inspected before claiming full-pipeline equivalence. Do not silently substitute a curated aneurysm box.
- For a supplied ROI, the explicit published stage-2 handoff is: contiguous ZYX array, Torch normalization `(x-x.mean()) / x.std().clip(1e-8)`, then trilinear interpolation to 224 cubed with `align_corners=True`. Initial CPU execution may use float32 with explicit provenance. It must not call this a reproduced fp16 multi-fold/TTA submission.
- A prediction on the existing curated-reference-selected context crop is only automatic segmentation within that selected crop. It is not independent full-head lesion localization. Keep this selection provenance in candidate metadata.

## Output boundary

- Use actual `ResEncoderUNet_two_seg_with_cls_modality`, not the generic class text in metadata. Embedded plans differ from adjacent sidecars. Strictly load all state; keep `deep_supervision=False`.
- Full forward returns `(head_1, head_2, classification_list, modality)`.
- Head 1 has 15 channels: background 0, vessel groups 1–13, merged aneurysm channel 14. Head 2 has 14 channels with explicit anatomical vessel/aneurysm groupings. Classification has one global and 13 location logits; modality has four logits with class-order semantics not established here.
- Use segmentation logits, not classification scores, to produce a lesion mask. No score is calibrated clinical confidence. Do not label classification-only execution as segmentation.
- Restore logits to the oriented native ROI before categorical decision, then reverse transpose/orientation and splice into the native case grid when a smaller ROI was used. Test asymmetric coordinate-coded inputs and noncubic shapes, not just centered cubes. Verify saved NIfTI shape, binary content, affine, units and exact source identity.
- Keep predictions unaccepted until explicit revision-bound acceptance; preserve separate vessel history. Future geometry/sizing invalidation is a real dependency operation, not a provenance Boolean.

## Required verification before case-inference claims

1. Test-first orientation and inverse mapping, sample-standard-deviation normalization, explicit interpolation settings and native mask restoration.
2. Invalid dimensions/affines/nonfinite values and stale case/reference identities fail before inference or acceptance.
3. Bounded actual public CTA execution through the original full network, saved native-mask readback and visual inspection. Empty or implausible output is a candidate/negative result, not fabricated success.
4. Separate localization and segmentation assessment. Curated mesh coordinate alignment is still a candidate and cannot silently become validated ground truth. Source units remain unknown, so this model cannot unlock millimeter measurements or device sizing by itself.
5. Actual worker/API/viewer preview, accept/reject, reopen and replacement cleanup. The existing vessel/SAM path is not proof that this new model is connected.
