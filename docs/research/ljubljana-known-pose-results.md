# Ljubljana known-pose evaluation: results

Protocol `ljubljana-known-pose-v1`, as written in [ljubljana-known-pose-protocol.md](ljubljana-known-pose-protocol.md). Run once on 2026-11-14 at commit `352ebca`, the commit that added the protocol, with a clean working tree. 330 registrations in 123 seconds on one desktop machine.

Status: a completed run of a small, fixed protocol. It is not a validation study. Ten subjects, one center, one start distribution, and a reference pose with its own error.

Only aggregate numbers are recorded here. Per-run detail is kept outside the repository. The data license is non-commercial: these numbers are for internal research use and are not to be used in commercial, pitch or grant material without the owners' agreement.

## Summary

- The two-plane proposal was better than either single-plane proposal in median and mean error and in the share of runs under each threshold. Its worst runs were worse: its 90th percentile and largest target errors were higher than either single plane's. It was more than 1 mm from the reference in about three runs out of four.
- Started at the reference pose itself, the two-plane engine moved away from it by more than 1 mm in 8 of 10 subjects. That points to what the score prefers, not how far the search can reach, as the limit.
- Fitting the detector size did not work on this data in any arm.

## Calibrated arms, perturbed starts

Target error is the mean 3D distance at the stored evaluation points. Every arm ran the same 50 starts, 5 per subject. The starts were 11.5 mm from the reference at the median (mean 11.2, 90th percentile 14.5, largest 16.7).

| Arm | Median (mm) | Mean | 90th pct | Largest | Runs under 1 / 2 / 5 mm | Subjects with all five runs under 1 / 2 / 5 mm |
| --- | --- | --- | --- | --- | --- | --- |
| `biplane` | 3.28 | 11.91 | 43.87 | 65.41 | 24% / 32% / 64% | 2 / 2 / 6 of 10 |
| `frontal` | 9.31 | 13.28 | 39.91 | 46.49 | 0% / 0% / 14% | 0 / 0 / 0 |
| `lateral` | 13.20 | 19.48 | 43.53 | 52.09 | 0% / 2% / 14% | 0 / 0 / 0 |

Every run returned a proposal.

One plane cannot determine depth, so the single-plane arms are judged more fairly by in-plane error: the mean distance on that plane's detector, in millimeters at the isocenter. The two-plane arm contributes two planes per run.

| Arm | Median (mm) | Mean | 90th pct | Largest | Under 1 / 2 / 5 mm |
| --- | --- | --- | --- | --- | --- |
| `biplane` | 2.21 | 8.83 | 39.46 | 60.61 | 28% / 44% / 76% |
| `frontal` | 4.51 | 9.74 | 38.87 | 46.02 | 6% / 14% / 56% |
| `lateral` | 7.72 | 15.45 | 41.34 | 49.43 | 10% / 18% / 38% |

## Started at the reference pose

Ten runs per arm, one per subject. The start error is zero, so the target error is how far the engine moved away from the reference.

| Arm | Median (mm) | Mean | 90th pct | Largest | Under 1 / 2 / 5 mm |
| --- | --- | --- | --- | --- | --- |
| `biplane_from_reference` | 2.52 | 13.14 | 47.94 | 67.13 | 20% / 40% / 70% |
| `frontal_from_reference` | 7.42 | 11.54 | 23.95 | 43.83 | 0% / 0% / 20% |
| `lateral_from_reference` | 8.96 | 16.76 | 35.69 | 52.27 | 0% / 0% / 20% |

## Uncalibrated arms

The frontal detector size was entered 0.85 times and the lateral 1.2 times the stored size, and the engine fitted a scale for each. The scale error is the absolute relative error of the fitted detector size.

| Arm | Proposals | Median target error (mm) | 90th pct | Largest | Under 1 / 2 / 5 mm | Scale error, median / 90th pct / largest |
| --- | --- | --- | --- | --- | --- | --- |
| `biplane_uncalibrated` | 45 of 50 | 13.81 | 35.71 | 39.94 | 0% / 0% / 0% | 0.21 / 0.49 / 0.74 |
| `frontal_uncalibrated` | 50 of 50 | 12.18 | 23.09 | 51.84 | 0% / 0% / 2% | 0.22 / 0.23 / 0.23 |
| `lateral_uncalibrated` | 39 of 50 | 17.06 | 38.25 | 52.95 | 0% / 0% / 2% | 0.20 / 0.56 / 0.74 |

The entered sizes were wrong by 15% and 20%. The fitted sizes were wrong by about 20% at the median, so the fit did not improve on the entry. In the frontal arm 20 of 50 fits ended within 1% of the upper limit of the scale range, 1.45.

The 16 runs with no proposal all failed the same way. The search took the detector scale high enough that the fitted detector was wider or taller than the 600 mm the view model accepts, and the engine raised an error instead of returning a pose. Both engines share this behavior. It fails closed, and it is recorded here as a defect to fix in a later method version.

## The engines' own scores

| | Mean distance to a 2D line (mm), median | Points within 2 mm of a 2D line, median |
| --- | --- | --- |
| `biplane`, at the perturbed start | 6.48 | 10% |
| `biplane`, at the result | 5.97 | 14% |
| At the reference pose | 6.08 | 15% |

Every run in these arms returned a proposal, so the medians are over all runs. The mean distance is capped at 8 mm per point. At the reference pose the share of 3D points within 2 mm of an extracted 2D line ranged from 4% to 35% across the twenty frames.

The score at the reference pose is about as poor as at a pose 11 mm away. It does not mark the reference as a good pose, and a result's score says little about whether the result is right.

## Further observations

These were computed from the per-run detail after the run. They were not planned in the protocol.

- 40 of the 50 `biplane` runs ended closer to the reference than they started.
- Results for one subject were usually similar across its five starts: the spread between a subject's best and worst run had a median of 2.0 mm across subjects, and the largest spread was 31 mm.
- In 2 of 10 subjects every `biplane` run ended more than 30 mm from the reference.
- In `biplane_from_reference`, 8 of 10 runs moved more than 1 mm from the reference. In 6 of those 8 the engine's score at the result was no worse than at the reference.

Taken together: from 10 mm and 10 degrees away the search usually reaches a similar answer for a subject, and that answer is often not the reference. This points to the score, not the reach of the search, as the limit.

## What the evaluation does not separate

At the reference pose few projected 3D points lie near an extracted 2D line. This run cannot say how much of that comes from each of:

- the 3D point set holding vessels and other bright structure that the one 2D frame does not show,
- the 2D line extraction missing vessels or adding lines that are not vessels,
- error in the reference pose or in this project's reading of the stored cameras.

The reading of the stored cameras is checked against a phantom and, before the protocol was fixed, against image intensity in all twenty frames. It is the only one of the three that was checked, and it is not excluded.

## Limits

- Ten subjects from one center. Five starts on one subject are not independent runs.
- The 3D image is a rotational angiogram from the same examination as the 2D frames. A CTA or MRA from another day, which is what the planner is built around, shows different vessels at different filling and is a harder case. These numbers are likely optimistic for it.
- The mask is every voxel the public copy left above zero. No vessel segmentation was reviewed.
- One frame per plane, with no choice of frame.
- The reference pose comes from fiducial registration. Errors near its own accuracy cannot be resolved.

## Deviations from the protocol

None in the procedure. The section "Further observations" is additional and is labelled as such.

## Consequences

- A two-plane proposal remains a starting point for an operator to correct. Nothing here supports using it without review.
- The score must not be shown or used as a sign that a proposal is right.
- The detector-size fit should not be relied on. An uncalibrated plane needs the field size from another source.
- Work on the method should start with the score and the two line sets it compares. Any change is a new method identifier and a new run of this protocol.
