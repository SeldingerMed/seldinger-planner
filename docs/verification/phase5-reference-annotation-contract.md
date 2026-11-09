# Phase 5 reference annotation contract

Internal engineering and source-audit checkpoint, not a completed reference-agreement study.

## Primary evidence

The Zenodo record identifies the dataset as CC-BY-4.0 and requests citation of its data paper.[1] The publisher HTML endpoint refused extraction; the parent retrieved and read the official full-text PDF instead of treating the child's search excerpts as a full-text audit.

The paper states that the STL objects are aligned with the original image coordinate system.[2] It describes segmentation in **Gamma Multivox D2**, not Slicer: experts manually isolated the region and chose intensity thresholds; the exported surface represents contrast-opacified aneurysm lumen, excluding uninvolved arteries, thrombus and calcification.[2]

The full text resolves one uncertainty left by the snippet-only audit: **all linear measurements were performed manually by an experienced radiologist at a workstation using multiplanar reconstruction of the original axial slices**.[2]

For nonfusiform lesions, maximum length is neck-base-center to the most remote dome point; width is the largest transverse dome diameter.[2]

The bifurcation-involvement rules can make neck absent.[2]

Volume was computed on the segmented object, but the numerical volume algorithm is not specified in that passage.[2]

The retrieved PDF does not explicitly identify LPS versus RAS or a separate STL unit declaration. Image-coordinate alignment is not, by itself, a completed per-file frame check. Do not promote a customary workstation convention to observed registration evidence.

## Consequences for this workflow

- Preserve the annotation as a lumen-surface reference, not vessel wall or a native voxel label map.
- Do not treat the application's normal-projected dome height as interchangeable with the paper's neck-center-to-dome maximum length. Neck-plane calipers likewise do not establish agreement with a manually selected published neck measurement.
- Establish and record the surface-to-native-image transform before voxel-grid scoring. Do not select the transform by whichever one maximizes model agreement.
- Keep rasterization conventions, frame/unit assumptions, annotation SHA, native affine and label-grid hash in the evaluation receipt.
- The development context is reference-informed; training overlap remains unknown. Neither is changed by a successful coordinate check.

## Executed case013 observations

The parent hash-verified the original ASCII STL and observed no `SPACE=LPS` or `SPACE=RAS` marker. Both candidate sign conventions put its bounds inside the calibrated CTA. This remains an unresolved frame question, not evidence that both placements are anatomically correct.

The admitted 192-cubed context deliberately covers both frame hypotheses. Real original-checkpoint executions produced vessel and aneurysm candidates, and the parent independently checked mask hashes, binary values, grid, affine and millimeter units. These are executed model outputs, not yet annotation-agreement metrics. Receipts: `artifacts/phase5/case013-context-original-models/receipt.json` and `artifacts/phase5/case013-native-probe.json`.

## Sources

[1] https://zenodo.org/records/15697196
    > "The dataset is publicly accessible under CC-BY 4.0."
[2] https://mdpi-res.com/d_attachment/data/data-11-00074/article_deploy/data-11-00074.pdf
    > "All linear measurements were performed manually by an experienced radiologist at a workstation using multiplanar reconstruction of the original axial slices."
    > "The coordinates of all segmented objects are aligned with the coordinate system of the original images."
