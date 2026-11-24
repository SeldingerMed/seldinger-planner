# Step D parts 3 and 4 and Step E: measured on the design data, 2026-11-24

Design-data measurements of three operator workflows built on branch `feat/step-d-aorta-model`. None is a held-out test: each figure below is from data used while building, or from a set with no truth to measure against, and is labelled as such. Each evaluation is read-only, writes nothing, and prints its figures to standard output. The commands are in each file's header.

| Workflow                                                              | Method id                                                                         | Code                                                                                                                                  |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| D3: aorta and iliac model over a recorded frame, after a bone line-up | `bone_edge_compass_guarded_v2` (over the unchanged `bone_edge_compass_v1` engine) | `web/src/abdominalLineup.ts`, `web/src/AbdominalOverlayPanel.tsx`, `planner/abdominal_registration.py`, `planner/abdominal_server.py` |
| D4: wire straightening and breathing over the saved line-up           | `wire_breathing_correction_v1`                                                    | `web/src/vesselCorrection.ts`, in the same panel                                                                                      |
| E: coronary tree following the heart in the replay                    | `coronary_tree_tracking_v1`                                                       | `web/src/coronaryMotion.ts`, `web/src/heartReplay.ts`, `web/src/RecordingReplay.tsx`                                                  |

## Data and licences

Each licence was read from the dataset's own record on 2026-11-24 (Zenodo API, Hugging Face API) and matches the `SOURCE.json` written at fetch.

- C-ArmLSpine, design cases 1 to 49 only (CC BY 4.0). The held-back cases 50 to 149 were not read: their protocol is spent.
- Thorax X-ray and CT interventional set, Zenodo 1400558, subjects T15 to T17 (CC BY 4.0). Read from its archives to memory through `bsdtar`.
- CardioSYNTAX coronary angiography, Hugging Face `MesserMMP/coronary-angiography-syntax`, holdouts `philips_97` and `siemens_20` (CC BY 4.0). Native DICOM cine, decoded to memory by `scripts/research/decode_cine.py`. There is no CT of these patients, and none is paired with them.
- The synthetic cine and phantoms are in `web/src/__fixtures__/`.

## D3: the guarded line-up

`web/src/research/abdominalLineupGuard.eval.ts`, lumbar design cases 1 to 49. In every case the front frame is lined up alone. A second frame is then offered in three forms:

- the case's own side frame;
- another patient's side frame, placed in this case's geometry;
- the case's side frame with its bone smoothed away.

The guard keeps the two-frame answer only when each frame holds its bone at that answer (frame score at least `held_floor` 0.25) and the front frame keeps at least `first_kept` 0.8 of its score alone. Otherwise it sets the second frame aside, the single-frame answer stands, and depth along the beam is reported as not determined.

| Second frame       | Kept | Set aside: bone not held | Set aside: moved the first frame | Unguarded answer over 5 mm in 3D from the case's own two-frame answer | Kept two-frame answer over 5 mm from it | Front frame moved over 2 mm across its beam by the kept answer |
| ------------------ | ---: | -----------------------: | -------------------------------: | --------------------------------------------------------------------: | --------------------------------------: | -------------------------------------------------------------: |
| Own side frame     |   48 |                        1 |                                0 |                                                                     0 |                                       0 |                                                              0 |
| Another patient's  |    4 |                       44 |                                1 |                                                                    32 |                                       3 |                                                    1 (3.98 mm) |
| Bone smoothed away |    6 |                       43 |                                0 |                                                                    30 |                                       5 |                                                    1 (3.12 mm) |

- The own side frame set aside is case 34, the one case the earlier runs left short. At its two-frame answer the front frame's score fell from 0.31 alone to 0.16, and the unguarded answer moved the front frame 9.3 mm across its beam. The single-frame answer is the better one to keep.
- The guard never let a kept answer move the front frame more than 5 mm across its beam.
- `held_floor` was set on these same cases. With its own side frame, the lowest side-frame score at a two-frame answer was 0.250 (case 43), just at the floor. The floor does not separate every wrong frame: 10 of 98 wrong second frames were kept, 8 of them with a 3D answer more than 5 mm off.
- No held-out measurement of `held_floor` exists yet. One needs a new protocol and cases not yet read.

The backend admits a model only when it was made from this scan (`source_sha256` equals the scan's SHA-256) and every point lies inside the scan. The saved line-up names the model's digest and each frame's SHA-256. A lone frame must face front within 60 degrees, and a second frame must be the other plane of the same biplane acquisition. On reopening, the saved overlay is redrawn only when its frames and model are unchanged. Tests: `tests/test_abdominal_registration.py` (7), `web/src/abdominalLineup.test.ts` (7), `web/src/AbdominalOverlayPanel.test.tsx` (4).

## D4: wire and breathing correction

Known truth, synthetic (`web/src/vesselCorrection.test.ts`):

- The anatomy is a 200 mm aorta with two tortuous iliac arteries.
- The truth is a right iliac straightened by a share of 0.7 and a breathing shift of 15 mm, with five noisy wire marks and landmark marks.
- The fit recovers a share between 0.6 and 0.8 and a shift between 13 and 17 mm. The left iliac, which has no marks, is left untouched.
- At unmarked centerline points, the 3D error falls from over 8 mm (rigid) to under 1.5 mm.
- With marks that fit the rigid line-up, the line-up stands (`no_gain`). Fewer than two marks of a kind fit nothing of that kind (`too_few_marks`).

Real landmarks (`web/src/research/thoraxBreathing.eval.ts`):

- Zenodo 1400558, T15 to T17, eight bronchial landmarks each, marked in both the CT and the X-ray.
- Each landmark is left out in turn. Two fits use the other seven: a rigid pose under a pinhole camera, and the same pose plus the long-axis breathing shift.
- The X-rays carry no source distance, so the camera is an assumption: 0.14 mm pixels, source to detector 1800 mm, also run at 1500 and 2000 mm.
- Errors are in millimetres at the detector.

| Source to detector | Rigid median (max) | With breathing median (max) | Landmarks better with breathing | Correction proposed (all eight marks) |
| ------------------ | ------------------ | --------------------------- | ------------------------------: | ------------------------------------- |
| 1800 mm            | 1.33 (3.04)        | 1.46 (3.97)                 |                        14 of 24 | 0 of 3 subjects                       |
| 1500 mm            | 1.34 (3.16)        | 1.43 (4.03)                 |                        14 of 24 | 0 of 3                                |
| 2000 mm            | 1.33 (2.98)        | 1.48 (3.94)                 |                        15 of 24 | 0 of 3                                |

By subject at 1800 mm:

| Subject | Rigid median | With breathing median | Fitted shift |
| ------- | -----------: | --------------------: | -----------: |
| T15     |      2.12 mm |               2.02 mm |       3.6 mm |
| T16     |      1.10 mm |               0.56 mm |       3.4 mm |
| T17     |      1.47 mm |               1.40 mm |      -1.6 mm |

On these three chests, a single long-axis breathing shift does not beat rigid on held-out landmarks overall. The guard declines it on every subject, because fitted to all eight marks it does not cut their distance by its required 20 percent. This is a negative result for the breathing term on this set. The workflow behaves as designed: the rigid line-up stands, and the panel states the reason. The set has no wire, so straightening is measured on synthetic truth only.

In the overlay panel, the correction is offered over the saved line-up only. The operator marks wire points in a named iliac artery, or a scan point at the cursor and where it lies on the frame. One correction is proposed, and it is drawn only after the operator confirms it. The confirmed correction applies to the current view and is not saved with the case.

## E: the coronary tree following the heart

Known truth, synthetic (`web/src/research/coronarySynthetic.eval.ts`):

- The cine has 48 frames at 15 per second and an 800 ms beat that squeezes and turns the tree. It also carries breathing drift, and the contrast leaves in frames 42 to 47.
- The tree is drawn on frame 0.

| Measure                                      | Tree left still | Tree followed |
| -------------------------------------------- | --------------: | ------------: |
| Mean distance from the true tree (41 frames) |         5.33 px |       0.58 px |
| Worst frame                                  |         9.39 px |       1.22 px |
| Vessel evidence under the tree (median)      |             1.1 |          45.6 |

- Refused frames: 42 to 47, exactly the frames the contrast had left.
- A frame from another recording placed at frame 20 was refused, and the frames after it were followed again.
- The period read from the frame times was 800.9 ms, against a true 800 ms.
- The frames named at the reference frame's phase were 11, 24 and 36, against a truth of 12, 24 and 36.
- The run took 0.47 s.

Real cine, no truth (`web/src/research/coronaryCine.eval.ts`):

- The first cine of at least 30 frames was taken from each of the first 15 studies of each holdout.
- There is no operator, so the drawn tree is a fixed stand-in: the strongest dark-line points on the darkest frame.

| Measure                                                               | Value                                                                         |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Cines read                                                            | 23 (15 Philips, 8 Siemens) of 30                                              |
| Not read                                                              | 7 Siemens cines in JPEG Lossless, which the decoding runtime cannot open      |
| Frames after the reference                                            | 1277: 644 followed, 633 refused                                               |
| Followed on more than half their frames                               | 12 of 23 cines (Philips 258 of 662 frames, Siemens 386 of 638)                |
| Vessel evidence, still tree vs followed tree (median of cine medians) | 4.5 vs 10.2; higher when followed in 23 of 23 cines, on 582 of 644 frames     |
| Heart period read                                                     | 4 of 23 cines, median 878 ms                                                  |
| Another patient's frame placed next to the reference                  | refused in 22 of 22 cines checked, each of which followed its own frame there |

- On real cine the tracker refuses often (median 45 percent of frames), and it reads a period on few cines. Refusing is the designed behaviour: a refused frame shows no tree rather than a wrong one.
- The evidence figure shows that the followed tree lies on dark vessel where the still tree does not. It does not show that the tree lies on the right vessel, and no distance to truth is claimed.

In the replay, after the operator asks, the stretch of the recording where the C-arm stands as at the saved frame is read frame by frame, and the saved axis is followed over it. The proposal is stated as:

- the frames followed and refused;
- the period;
- the frames at the saved frame's phase.

Once the operator confirms, the replay draws the followed axis and labels each frame "axis follows the heart", "vessels not found: no axis", or "at the saved frame's phase". The proposal is dropped when the recording changes. Test: `web/src/RecordingReplayHeart.test.tsx` (2), on the synthetic cine through the replay.

## Limitations

- D3 is measured on design cases only, and its floor was set on them. A held-out measurement is owed under a new protocol.
- The D3 model comes from the raw CTA inference export (Step D2). Its accuracy is D2's to measure. Here it is admitted only by its source hash and its bounds.
- D4 breathing is one long-axis shift. On the thorax set it did not beat rigid. Straightening has synthetic truth only, and the confirmed correction is not saved with the case.
- E on real cine has no truth and no CT pairing. It refuses about half the frames, and reads a period on 4 of 23 cines. The 7 JPEG Lossless cines were not read.
- None of this is a clinical claim.
