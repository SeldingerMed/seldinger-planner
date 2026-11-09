# Phase 5 case013 correction-consistency evaluation

Internal engineering evaluation of the approved public case013 workflow. The
comparison measures consistency of an accepted mask edit, not segmentation accuracy
against an external reference. The case was selected for development.

## What was run

One reproducible evaluation script compares the exact approved public original
accepted aneurysm mask against the browser SAM accepted edit on the same declared
native grid, using the existing pure helper `planner/model_evaluation.py`
(`evaluate_binary_masks`, unchanged). No model reruns, downloads, or helper/source
changes.

Command (repo root, `seldinger-planner`):

```
env -u PYTHONHOME -u PYTHONPATH PYTHONPATH="$PWD" \
  .runtime/ml-runtime/bin/python artifacts/phase5/evaluate_case013_correction.py
```

The parent-verified script decodes the same immutable bytes it hashes, under a
bounded gzip read. It verifies the native header's mm declaration, grid shape
(192³), uint8 binary values and exact context affine, then calls the helper.
Independent count, overlap, volume and physical-centroid formulas agree with the
helper. Parent execution took approximately 0.05 s, excluding imports. Repeating
the command verifies matching metrics without overwriting the retained receipt.
The command requires the approved local source installation and ignored verification
artifacts; images, masks and generated receipts are not distributed in Git.

## Inputs (byte-hash verified before decode)

| Role | SHA-256 |
|---|---|
| Original accepted mask (base candidate `mjyvYViXUAEXhilVqZK7Rg`) | `016a32ecf02dddc38166098d91a19d21438c32cbb82c00934b7693bc160f2de7` |
| Browser SAM accepted edit (candidate `-dQiZeTq2YKYxsYK5tccQw`) | `cbad6086e3552feb2b23f9d8c711fce552d888b564e07ee7be898daff97b9153` |

- Source image SHA-256: `ea86cbd72aecb251f758ecd9195111cd64c1a69823debf08feb7c48d509a427c`; 192×192×192, native anisotropic 0.578125 × 0.578125 × 0.625 mm, explicit mm, affine from `artifacts/phase5/case013-context-original-models/receipt.json`.
- Provenance receipts: `artifacts/phase5/browser-sam-accept/receipt.json` and `independent-preview-verification.json` (114 changed voxels, only native slice 97, prompt at ijk [41, 18, 97]).

## Observed metrics (helper output, verbatim)

Label semantics: this is **original-mask-versus-accepted-edit agreement**, with
the original accepted mask serving only as the comparison reference. It is **NOT**
ground-truth or reference accuracy.

| Metric | Value |
|---|---|
| true_positive_voxels | 1582 |
| false_positive_voxels | 114 |
| false_negative_voxels | 0 |
| true_negative_voxels | 7076192 |
| prediction (accepted edit) foreground voxels | 1696 |
| reference (original) foreground voxels | 1582 |
| dice | 0.9652226967663209 |
| intersection_over_union | 0.9327830188679245 |
| prediction_volume_mm3 | 354.2822265625 |
| reference_volume_mm3 | 330.46844482421875 |
| centroid_distance_mm | 3.630299630990994 |

Independent script-side check (not from the helper): changed voxels = 114, changed
native slices = [97]: consistent with the browser receipt's independent
preview verification (1582 → 1696 foreground, slice-97-only change). The helper's
volume arithmetic is internally consistent (114 voxels × voxel volume ≈ 23.8 mm³
= 354.28 − 330.47 mm³; dice/IOU match the count arithmetic).

These voxel volumes and centroids cover **all foreground components** in each
mask. They are not the source-bound, seed-selected and neck-clipped sac mesh
measurement shown by the application. After explicit recomputation, that separate
geometry result (`XFD8TryKgryYoHj8wPNuyg`, case version `6`) reports
109.41182120024254 mm³. The two quantities use different component/plane selections
and must not be substituted for each other.

## What this does and does not establish

- Established: byte-exact lineage of both masks to the approved public blobs; both
  masks share the declared mm grid/affine; exact overlap arithmetic of the SAM
  edit against the prior accepted mask. The edit is purely additive on one slice,
  so agreement is high by construction.
- Not established: any agreement with the case013 STL reference annotation: the
  original STL frame and units remain unresolved (`stl_registration: unverified`;
  both RAS and LPS hypotheses remain open) and checkpoint training overlap is
  unknown. No external reference agreement is claimed and this is not called a
  held-out evaluation.
- Not available: independent accuracy evidence of any kind for the accepted edit;
  metrics above describe correction consistency only.

## Artifacts

- Script: `artifacts/phase5/evaluate_case013_correction.py` (owned)
- Parent-verified metric receipt: `artifacts/phase5/correction-evaluation/correction-consistency-parent-verified.json`
  (SHA-256 `c308bcf4d07cad08f5fed19b6cb7bed064f1a9db910f649b04691262da3c808e`)
- Earlier child receipt retained separately: `artifacts/phase5/correction-evaluation/correction-consistency.json`
  (SHA-256 `b125e2cf94ff0eb602c99ef1ebf09ffb0ce6fc153de1cdfc019a668538db6625`)
- Inputs: `artifacts/phase5/browser-sam-accept/inference-results/blobs/<sha>.nii.gz`
