# Step E heart period: held-out protocol (one run)

Written and committed before any held-out cine is read. One run only. Nothing here may be changed after the run, and no constant may be set from its results.

## Frozen method

- Code: commit `d9ea216` on `feat/fusion-e-cta-correspondence`. Method `cine_heart_period_v2` in `web/src/cardiacPeriod.ts`, constants as printed in the run's summary line (`period_ms` 333 to 1500, `grid_px` 64, `shading_px` 3, `modes` 6, `min_mode_share` 0.02, `min_repeat` 0.45, `min_rise` 0.35, `max_step_spread` 0.25, `min_periods` 2.5, `max_frames` 600).
- Comparator: the Step E tracker of PR #27 (`coronary_tree_tracking_v1`) over the stand-in drawn tree (`web/src/research/drawnTree.ts`), unchanged.
- Decoder: `planner.cine_bundle.read_cine` (one window over the whole cine; JPEG Lossless through GDCM 3.2.6).

## Data

CardioSYNTAX (Hugging Face `MesserMMP/coronary-angiography-syntax`, CC BY 4.0), `test_data`, read-only from the Training HD copy, decoded to memory, nothing written.

- Held-out studies: in name order, `philips_97` studies 16 to 97 and `siemens_20` studies 16 to 20 (`CINE_SPLIT=heldout`, indices 15 onward). PR #27 and the design work read only studies 1 to 15 of each holdout.
- Per study: the first file of at least 30 frames with recorded times.

## Measures, fixed in advance

There is no ECG in these files, so no period has a truth. These measures are reported in full, failures included:

1. Coverage: cines where `cine_heart_period_v2` reads a period, out of cines decoded; the same for the tracker. Refusal reasons are counted.
2. Agreement with the tracker where both read.
3. Self-consistency: on cines where both halves (by frame count) read a period, how often the halves agree within 10 percent. Also how often the whole-cine period lies within 10 percent of both halves.
4. Phase matching against a still overlay: the stand-in tree is drawn on the quiet frame with the strongest lines. It is then scored on the other quiet frames and on every frame at least 2 frames from a quiet one. The score is the mean dark-line strength along the tree, best over shifts up to 6 pixels, over the frame's own 99.5th percentile. Report how many cines score higher at the same phase, and the median ratio.
5. Decode failures by transfer syntax.

## Design-data figures (studies 1 to 15 of each holdout; not a test)

From the run at `d9ea216`: 30 cines decoded (7 JPEG Lossless, all now read). Period read on 21 of 30 (no rhythm 8, too short 1). The tracker read 4 of 30. Halves both read on 10, and agreed within 10 percent on 4. Phase matching was higher at the same phase on 11 of 21 (Siemens 8 of 10, Philips 3 of 11), median ratio 1.04. Philips cines are 2 to 4 seconds long, and their short readings (under 600 ms) may be half-beats. Nothing is truth.

## Command

```
CINE_SET="/Volumes/Training HD/Seldinger Data/raw/hf-MesserMMP-coronary-angiography-syntax" \
CINE_PYTHON=$PWD/../.runtime/ingest-runtime/bin/python CINE_SPLIT=heldout \
npx vitest run --config vitest.research.config.ts src/research/cardiacPeriod.eval.ts
```

Run from `web/`. Output goes to standard output only; the summary is copied into `docs/research/step-e-cta-correspondence-results.md`.
