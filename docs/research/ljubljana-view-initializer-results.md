# Ljubljana evaluation of the learned view initializer: results

Protocol `ljubljana-view-initializer-v1` ([protocol](ljubljana-view-initializer-protocol.md)), run once on 2026-11-18 at commit `6d89223`. Network file SHA-256 `1c76811c...2b8b56`. Research evidence on ten subjects of a public set, for internal use under CC BY-NC-ND 4.0. Not a validation study, and not for commercial, pitch or grant material without the owners' agreement.

## In short

- On real frames the five proposals usually contain a view near the stored one, but the network does not rank it first. Held back: first proposal within 15 degrees in 4 of 10 frames, any of the five in 7 of 10.
- Started from the first proposal, the part 1 registrations do worse than from the studio's default views. Held back, two planes, under 1 mm: 1 of 5 from the first proposal, 4 of 5 from the default views, 4 of 5 from the proposal nearest the stored view.
- The set cannot show a gain: its frames were taken near standard views, so the default views already start near the reference (within 15 degrees in 9 of 10 held-back frames).
- The synthetic gate was passed with 88.4% and 63.1%. The real frames are well below that, so the synthetic numbers overstate what the network does on real frames.

## Proposed views against stored views

Frames with a view within 15 degrees of the stored one, and the median angle in degrees.

| Subjects              | Frames | First proposal | Any of five | Default view | Median, first | Median, nearest of five | Median, default |
| --------------------- | ------ | -------------- | ----------- | ------------ | ------------- | ----------------------- | --------------- |
| 01 to 05, development | 10     | 1              | 8           | 8            | 27.9          | 9.0                     | 1.3             |
| 06 to 10, held back   | 10     | 4              | 7           | 9            | 25.7          | 10.1                    | 0.7             |
| All                   | 20     | 5              | 15          | 17           | 27.9          | 9.8                     | 0.8             |

By plane, all ten subjects: frontal 2, 8 and 7 of 10; lateral 3, 7 and 10 of 10. The largest angle of a first proposal was 66 degrees. Over the 20 frames the nearest proposal was the first in 4, the second in 5, the third in 6, the fourth in 4 and the fifth in 1.

## Registrations from each start

Two planes, `vessel_evidence_compass_biplane_v1`, five runs per group. Target error over the stored 3D points.

| Subjects | Start           | Median start turn (degrees) | Median (mm) | Maximum (mm) | Under 1 mm | Under 5 mm |
| -------- | --------------- | --------------------------- | ----------- | ------------ | ---------- | ---------- |
| 01 to 05 | default views   | 14.0                        | 0.40        | 3.6          | 3 of 5     | 5 of 5     |
| 01 to 05 | first proposal  | 31.3                        | 11.30       | 26.2         | 0 of 5     | 1 of 5     |
| 01 to 05 | nearest of five | 13.7                        | 0.41        | 13.8         | 4 of 5     | 4 of 5     |
| 06 to 10 | default views   | 1.1                         | 0.27        | 28.2         | 4 of 5     | 4 of 5     |
| 06 to 10 | first proposal  | 32.1                        | 22.23       | 27.2         | 1 of 5     | 1 of 5     |
| 06 to 10 | nearest of five | 11.4                        | 0.38        | 20.5         | 4 of 5     | 4 of 5     |

One plane, all ten subjects: no lateral run from any start came under 5 mm (medians 25 to 28 mm, the depth along the ray, as in part 1). Frontal runs under 5 mm: 4 of 10 from the default view, 0 of 10 from the first proposal, 5 of 10 from the nearest of five. Every run returned a proposal.

The "nearest of five" rows use the stored view to pick the proposal. They show what an operator who picks well could get, not what the network does alone.

## How to read this

- The development numbers were seen before the protocol was written. The held-back numbers were not, and nothing was changed after them.
- The reading of the set's axes (patient axes turned half round about the vertical) was found on subjects 01 to 05 and applied to 06 to 10 unseen. There the default views lie within 15 degrees of the stored ones in 9 of 10 frames, which is what that reading predicts.
- On the development frontal frames the first proposal leaned 21 to 31 degrees caudal in four of five. The cause was not settled (see the decisions log of the plan). The held-back subjects were not opened to look for it.
- One held-back subject fails from every start, as it did in part 1. It was not opened.
- Counts on ten subjects carry no significance claim.

## What follows

The network stays as it is under this protocol. The proposals are useful only as a short list for a person to choose from, and that is the only way the plan offers them. Whether that helps on frames taken far from standard views, which is the case this part was built for, is not shown here and is what the TAIR reading is for.
