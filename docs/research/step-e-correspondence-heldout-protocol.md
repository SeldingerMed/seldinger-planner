# Step E correspondence: held-out protocol on cines from real CT anatomy (one run)

Written and committed before any held-out case is read. One run only. Nothing here may be changed after the run, and no constant may be set from its results.

## What this measures, and what it does not

The cines are rendered from each case's own CT coronary centerlines: the tree is moved by the synthetic beat and breathing of `web/src/__fixtures__/coronaryCtCine.ts`, carried by an unknown table offset, and projected through a known C-arm. Truth is known for every branch point in every frame. This checks the engine on real vessel shapes. It is not an angiogram and it is not a measurement of CT-to-angiogram registration on any patient. That needs the same patient's CT and invasive cine, which this repository does not hold.

## Frozen method

- Code: the commit that adds this file on `feat/fusion-e-cta-correspondence`. Method `ct_tree_cine_correspondence_v1` in `web/src/coronaryCorrespondence.ts`, with `min_fit` 0.5 and `min_mirror_margin` 0.25 (the tree must fit the frame at least 0.25 better than the best of its two mirror images, reflected across the detector axes through its centre and searched over the same poses).
- Evaluation: `web/src/research/coronaryCorrespondence.eval.ts`. Trees read by `scripts/research/imagecasx_tree.py` (left tree; LM, LAD, LCX, D1, D2, OM1, OM2 where named; resampled at 1 mm; centred).
- `min_mirror_margin` was set on the design cases: case 190 and ImageCAS-X `filelist/test.txt` lines 1 to 4 (878, 844, 80, 686). On those, at this commit: own tree proposed on 5 of 5, every branch matched but one (878's LM, not found); foreign trees refused on 15 of 15.

## Data

ImageCAS-X version 2 (Zenodo 10.5281/zenodo.23562647, CC BY 4.0), the release zip on the Training HD, read in place. Nothing is written.

- Held-out cases: ImageCAS-X `filelist/test.txt` lines 5 to 14, in file order: 87, 789, 448, 625, 954, 580, 85, 368, 806, 88 (`ICX_SPLIT=heldout`). None was read by any earlier Step E work.
- Foreign trees for each case's cine: the next held-out case's tree (the last case takes the first's), the synthetic tracer tree, and the synthetic second patient (`otherPatientTree`).

## Measures, fixed in advance

Reported in full, failures included:

1. Own tree: proposed or refused (with reason), out of 10. Branch statuses (matched, not found, ambiguous, in conflict).
2. Followed error: per branch per frame, the mean distance of the proposal's points from the branch's true course, pixels (0.8 mm per pixel at the detector). Median and 95th percentile, pooled. Beside it, the same branches held still at the phase frame on every frame.
3. Foreign trees: refused out of 30, by reason. Any proposal of a foreign tree is a failure and is reported with its fit and mirror scores.

## Command

```
ICX_ZIP="/Volumes/Training HD/Seldinger Data/raw/zenodo-23562647-imagecas-x-v2/ImageCAS-X_dataset_v2.zip" \
CINE_PYTHON=$PWD/../.runtime/ingest-runtime/bin/python ICX_SPLIT=heldout \
npx vitest run --config vitest.research.config.ts src/research/coronaryCorrespondence.eval.ts
```

Run from `web/`. Output goes to standard output only; the summary is copied into `docs/research/step-e-cta-correspondence-results.md`.
