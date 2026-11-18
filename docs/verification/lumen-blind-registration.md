# Blind registration of five procedural exposures

Planner emitted ten proposals for review. None passed the independent 5 mm **and** 5 px accuracy test. The research gate declined all ten, including both full-tree controls. There were no wrong acceptances, no correct proposals and no native refusals. **This run demonstrates rejection, not useful coverage or the ability to distinguish correct from incorrect proposals.** No operator confirmed any pose.

The nominal overlap-A proposal illustrates why support alone is insufficient: eight of nine branches followed dark pixels by the specified test, but the two starts gave estimates 20.11 mm apart. Revealing the reference placed the nominal estimate 90.31 mm off. Transferring that actual estimate into camera B made the reprojection discrepancy obvious; refining against B reduced it but did not recover the pose. These are sequential single-plane proposals, not a joint fit. Full-tree failure matters too: the generic start was about 100 mm off. This experiment cannot attribute all failures to selective injection rather than poor initialization. The ten trials share models, frames and starts; they are not ten independent subjects.

| Exposure | Start label | Initial target mm | Final target mm | Initial reproj px | Final reproj px | Branch support | Start disagreement mm |
|---|---|---:|---:|---:|---:|---:|---:|
| full-tree-v1 | base | 99.90 | 93.97 | 60.89 | 40.82 | 50.0% | 26.25 |
| full-tree-v1 | depth+20 | 119.86 | 118.33 | 65.05 | 51.02 | 43.8% | 26.25 |
| selective-a-v1 | base | 88.94 | 88.54 | 40.64 | 46.06 | 25.0% | 19.10 |
| selective-a-v1 | depth+20 | 108.88 | 107.37 | 44.68 | 51.55 | 25.0% | 19.10 |
| selective-b-v1 | base | 88.94 | 86.19 | 40.64 | 41.94 | 25.0% | 21.46 |
| selective-b-v1 | depth+20 | 108.88 | 107.56 | 44.68 | 49.58 | 31.2% | 21.46 |
| overlap-a-v1 | base | 93.08 | 90.31 | 23.72 | 16.08 | 88.9% | 20.11 |
| overlap-a-v1 | depth+20 | 113.07 | 110.21 | 25.23 | 22.58 | 66.7% | 20.11 |
| overlap-b-v1 | base | 90.31 | 72.55 | 241.77 | 38.19 | 55.6% | 20.29 |
| overlap-b-v1 | depth+20 | 110.21 | 90.07 | 282.32 | 71.73 | 33.3% | 20.29 |

All distances above are whole-model RMS over corresponding released centerline samples, including repeated branch endpoints. The research gate requires 75% branch support and at most 5 mm disagreement. The native `mean_evidence`, `in_field_fraction` and `uncovered_fraction` remain in each `result.json`; none is calibrated confidence. The released Lumen scorer independently agreed on all 20 initial/final pose submissions within 1e-9 in each unit. The example wrong poses were not used. Synthetic-only regression; no clinical workflow was changed.

## Reproduce from the Planner checkout

Use Node 24 and `uv`. Choose new external directories for the run and Lumen clone. No patient data, model weights, solver or installed Lumen package is needed. The commands read Git blobs by commit, not files from the working tree.

```sh
# Set LUMEN to a clone of https://github.com/SeldingerMed/seldinger-lumen
# containing 79fd14d10acb96c123b37e1077214e6dbef960e4.
# Set RUN to a NEW absolute directory outside both repositories.
(cd web && npm ci)
uv run --no-project --python 3.12 --with pillow==13.0.0 python -m scripts.research.lumen_challenge blind "$LUMEN" "$RUN"
python3.12 -m scripts.research.lumen_challenge reveal "$LUMEN" "$RUN"
```

Open `$RUN/replay.html` locally. Each trial pairs the original frame with the start and candidate overlay; expand **revealed truth & correctness** for the reference overlay and separate mm/px measurements. `report.json` contains all scores and dispositions. `seal.json` records input and proposal digests before reveal; it detects ordinary modification, not adversarial re-signing. The protocol is [here](../research/lumen-registration-protocol.md). Run `python -m pytest tests/test_lumen*.py` in the dev environment and `(cd web && npm test -- src/research/lumen)` for the offline unit and production-method tracers.
