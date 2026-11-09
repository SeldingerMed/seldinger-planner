# Phase 5 source and model evidence

Internal implementation checkpoint. The end-to-end workflow and quantitative reference evaluation are not yet complete.

## Original RSNA model and label mapping

The exact [upstream README at1ead0ba4dc00bcd84591269995dde6a8446ca3ad](https://raw.githubusercontent.com/PengchengShi1220/RSNA2025_Intracranial-Aneurysm-Detection/1ead0ba4dc00bcd84591269995dde6a8446ca3ad/README.md) explicitly licenses **code and model weights under Apache-2.0**. Its separately released corrected segmentation masks are CC-BY-NC-4.0 and are not acquired for this workflow.

The original installed checkpoint was reverified and safely loaded to inspect its embedded metadata, not to acquire training images or label assets:

- Checkpoint SHA-256: `e60b539d025a8ecccf77d3ff1a45ef6888b5e059671cc8e24fff572d520fa521`.
- Configuration: `3d_fullres`.
- Original first-head `seg_index_1`: singleton groups1 through13, followed by one group containing14 through26.
- Original dataset label metadata names1 through13 as vessel locations and14 through26 as aneurysm locations.
- The original trainer's `_init_mapping` assigns `new_label+1` to each group, with background0. Thus first-head classes1 through13 are vessels, and first-head class14 merges the aneurysm classes. The source checkout's actual Git revision matches the pinned README revision above.

This closes the class-index gap left by the README's abbreviated14-class output description. The `rsna-vessel` adapter unions first-head classes1 through13; the existing aneurysm output selects class14. Both use the same original, fully verified checkpoint and original first-decoder graph. Neither requires the separately owned pooled-vessel checkpoint.

Ignored executed receipts/scripts: `artifacts/phase5/inspect_original_head_metadata.py`, `artifacts/phase5/rsna-head-label-metadata.json`.

## Actual vessel-output tracer

A real fixed-runtime `rsna-vessel` worker execution on the existing CC-BY CMHA context completed in4.999seconds and produced32985 foreground voxels on its native175×180×140 grid. The parent independently reopened the output and checked its hash, binary uint8 values, count, exact affine and retained unknown spatial units.

- Image SHA-256: `98cf6634833acf722a0bd084a4bbe9b5c4545954b3c9759c1003b225086ecb0c`.
- Manifest revision: `8b6b5a3a45243084cd6a39b5d2b19e758d6dfb63112eb30feaafc470b47e5f3a`.
- Mask SHA-256: `2d8961fb31655637b9e0e4c193bfbf07bcc7597c060f80ab0352490b84f45b34`.
- Stored mask:40746bytes.

This is actual model execution, not a reference-agreement result or permission to infer millimeter calibration. Receipt: `artifacts/phase5/cmha-rsna-vessel/receipt.json`.

## Calibrated public workflow candidate

Use the already-acquired **Zenodo15697196 case013**, CC-BY-4.0, for the calibrated workflow. [Acquisition and calibration evidence](labeled-cta-reference-acquisition.md) records289 public DICOM members, original `Annotations/an_013.stl`, DICOM-tag-derived spacing and independent saved-world-position/scalar checks.

- Prepared source:512×512×289, explicit mm, spacing `[0.578125,0.578125,0.625]`mm.
- Source SHA-256: `56f0e39bb93d31559a62636faa46ab47fd56ae3c1a09515ecf4194073904a5db`.
- Original STL:204141bytes, SHA-256 `9525d267be258d78ba032bcdbd9d74e467ccfc54e7093a6585eaae17f0873416`.
- Calibration receipt explicitly retains `stl_registration: unverified`.
- Checkpoint-training overlap remains unknown. This is a development/reference candidate, not a sealed evaluation subject.

The full prepared image exceeds app source-transport bounds. The offline native-grid context contract requires preserving source hash, calibration, exact index window, scalar values, serialized output affine and declared context-selection basis, without raising the app's8M-voxel/16MiB admission limits. Parent header inspection of the exact case013 file found identity-scaled **int32**,303038464 uncompressed grid bytes and85459853 stored bytes; the offline decoder therefore needs the separately declared384MiB raw-byte budget rather than its initial256MiB draft. The parent now admitted an 8-cubed calibration probe and a 192-cubed int32 context through the real installed-source reader; the probe retained the independently recorded 58HU sample and RAS position. The crop helper passes36 optional-runtime tests across allowed dtypes, endian/container variants, source tampering, effective scaling, scalar/affine preservation and failed-output cleanup. Actual model-output and source receipts are under `artifacts/phase5/case013-context-original-models/`; annotation and measurement definitions are reconciled in [the full-text reference contract](phase5-reference-annotation-contract.md). Reference-informed context selection must remain disclosed. STL frame/unit interpretation must be checked against actual source geometry before voxel-grid scoring; a metadata coordinate-alignment statement is not the completed check.

## Reconciliation of an audit false inference

The old `ahmu1218001-acquisition.json` records a failed acquisition attempt: `solid_run_7z_ok:false`, zero-byte mesh entries and even a7-byte NIfTI entry. Those entries do **not** establish that the publisher's case has no paired meshes. The current hash-pinned `ReferenceStore` independently admits nonempty curated surfaces:

- Aneurysm:19184bytes,382triangles, SHA-256 `7f29ceb929c58ed2ce0a6fc6bc1289bed95a27030dd1f5fb2b34bd4ba0006a9a`.
- Artery:265684bytes,5312triangles, SHA-256 `a7a0822f057970f54b2e56b2961dcdec36029b161afdd590f514bf7b216cd4e7`.

Their retained source units are0/unknown and transform status is `candidate_image_consistent`. This is why case013 is preferred for the calibrated workflow, not a claim that CMHA reference assets do not exist. Existing original acquisition, failed-attempt and research records remain unchanged.
