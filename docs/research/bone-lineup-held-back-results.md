# Bone line-up on held-back specimens and cases: results

Protocol [`bone-lineup-held-back-v1`](bone-lineup-held-back-protocol.md), run once on 2026-11-22 at commit `5e7de86`. The pelvis set (DeepFluoro, the xvr-data copy) is for internal research evaluation only under its non-commercial licence. The lumbar set (C-ArmLSpine) is CC BY 4.0.

## Primary results

- Pelvis, specimens 4 to 6: **79 of 108** disturbed starts end under 1 mm across the beam from the reference. Design specimens 1 to 3: 105 of 108.
- Lumbar, cases 50 to 149 less case 134: **593 of 594** disturbed starts come back within 1 mm of the case's own answer with both frames. Design cases 1 to 49: 289 of 294.

## Pelvis: one frame at a time, against the reference pose

Twelve frames a specimen, three disturbed starts a frame (a median 12.5 mm across the beam from the reference on the held-back specimens). Error is the mean distance at the set's 14 landmarks, across the beam unless marked 3D.

| Specimens          | Starts | Under 0.5 mm | Under 1 mm | Under 2 mm | Under 5 mm | Median  | Worst    | Median, 3D | Refused | Median time |
| ------------------ | ------ | ------------ | ---------- | ---------- | ---------- | ------- | -------- | ---------- | ------- | ----------- |
| 4 to 6 (held back) | 108    | 26           | 79         | 98         | 106        | 0.68 mm | 10.82 mm | 3.56 mm    | 0       | 3.8 s       |
| 1 to 3 (design)    | 108    | 58           | 105        | 108        | 108        | 0.49 mm | 1.14 mm  | 1.66 mm    | 0       | 3.4 s       |

From the reference pose itself:

| Specimens          | Frames | Under 0.5 mm | Under 1 mm | Under 2 mm | Median  | Worst    |
| ------------------ | ------ | ------------ | ---------- | ---------- | ------- | -------- |
| 4 to 6 (held back) | 36     | 8            | 27         | 33         | 0.73 mm | 10.81 mm |
| 1 to 3 (design)    | 36     | 22           | 35         | 36         | 0.48 mm | 1.19 mm  |

By held-back specimen, disturbed starts:

| Specimen | Frames | Under 1 mm | Under 2 mm | Median  | Worst    |
| -------- | ------ | ---------- | ---------- | ------- | -------- |
| 4        | 12     | 17 of 36   | 27 of 36   | 1.02 mm | 10.82 mm |
| 5        | 12     | 33 of 36   | 36 of 36   | 0.58 mm | 1.45 mm  |
| 6        | 12     | 29 of 36   | 35 of 36   | 0.48 mm | 2.06 mm  |

- The worst run is specimen 4, frame 008: 10.8 mm across the beam. Frames with a run at 2 mm or more: specimen 4 frame 004, specimen 4 frame 008, specimen 4 frame 036, specimen 4 frame 044, specimen 6 frame 000.
- One frame does not place depth along its beam, which is the 3D column.

Against the stored pose as the set's files give it, disturbed starts:

| Specimens          | Under 1 mm | Median  |
| ------------------ | ---------- | ------- |
| 4 to 6 (held back) | 51 of 108  | 1.03 mm |
| 1 to 3 (design)    | 83 of 108  | 0.84 mm |

## Check of the pelvis reference on the held-back frames

Done after the pelvis run, without the line-up: a ray-cast picture of the bone at the stored pose against the real frame, by gradient correlation over small shifts. A shift of -0.40 and +0.70 pixels planted in the picture was read back as -0.36 and +0.75.

| Scan grid                          | Frames | Median shift at the bone | Worst   | Correlation at the stored pose |
| ---------------------------------- | ------ | ------------------------ | ------- | ------------------------------ |
| As the header gives it             | 36     | 0.71 mm                  | 1.99 mm | 0.62                           |
| Half a voxel along each index axis | 36     | 0.09 mm                  | 2.00 mm | 0.70                           |

The half-voxel grid holds on the held-back specimens, so the result against the reference is the pelvis result, as the protocol sets out. The worst frame on the half-voxel grid is specimen 4, frame 004, where the stored pose itself sits 2.0 mm from the picture.

## Lumbar: return to the case's own answer

Six disturbed starts a case (up to 15 mm across, 30 mm along the beam, 8 degrees about each axis). The set has no reference pose: the measure is how consistently the line-up returns to one answer, and how far that answer lies from the C-arm's stated geometry.

| Cases                 | Frames            | Cases run | Back within 1 mm | Back within 2 mm | Cases with every start back | Median from stated geometry | Within 3 mm of stated | Cases refused | Median time |
| --------------------- | ----------------- | --------- | ---------------- | ---------------- | --------------------------- | --------------------------- | --------------------- | ------------- | ----------- |
| 50 to 149 (held back) | Both              | 99        | 593 of 594       | 593 of 594       | 98 of 99                    | 1.77 mm                     | 99 of 99              | 0             | 4.5 s       |
| 50 to 149 (held back) | Front frame alone | 99        | 591 of 594       | 591 of 594       | 97 of 99                    | 2.51 mm                     | 80 of 99              | 0             | 3.0 s       |
| 1 to 49 (design)      | Both              | 49        | 289 of 294       | 289 of 294       | 48 of 49                    | 1.80 mm                     | 48 of 49              | 0             | 4.6 s       |
| 1 to 49 (design)      | Front frame alone | 49        | 288 of 294       | 288 of 294       | 48 of 49                    | 2.55 mm                     | 45 of 49              | 0             | 3.3 s       |

- With both frames every held-back case's answer lies within 3 mm of the stated geometry (the farthest at 2.7 mm). One start of case 93 ends 25 mm from the case's answer.
- The front frame alone is each case's first frame. The three starts short are one of case 93 and two of case 118. Case 118's first frame is a 58-degree oblique and its second the front frame: two of its disturbed starts turned it past the engine's 60-degree limit for a lone frame and were refused, and count as not back.
- Case 134 has no usable frame pair and was left out by the format step, as the protocol states.
- The side frame alone was not run: on the design cases it brought 116 of 294 starts back, and the engine refuses it.

## Conduct

- One run of each evaluation with the set `held_back`, from a clean tree at `5e7de86`, the commit that holds the protocol. Results: `fusion-d/pelvis-held-back-5e7de86`, `fusion-d/lumbar-held-back-5e7de86` and `fusion-d/pelvis-held-back-5e7de86-reference-check` on the research drive.
- Nothing was tuned on the held-back specimens and cases, before or after.
- The design rows come from `fusion-d/pelvis-design-d9d9259` and `fusion-d/lumbar-design-af2123a`. The engine change between those commits and `5e7de86` (frame order, the lone side frame refused) leaves three lumbar design cases and the 12 frames of pelvis specimen 3 with the same answers to the last digit.
