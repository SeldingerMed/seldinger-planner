# Ljubljana known-pose evaluation of the vessel evidence methods: results

Protocol `ljubljana-evidence-v1`, as written in [ljubljana-evidence-protocol.md](ljubljana-evidence-protocol.md). Run once on 2026-11-16 at commit `c0e2ee1` with a clean working tree. 480 registrations, 3 minutes 45 seconds in all on one desktop machine. Every run returned a proposal and none failed.

Status: a completed run of a small, fixed protocol on data that is not unseen. It is not a validation study. Subjects 01 to 05 are the subjects the methods were built against. Subjects 06 to 10 were held back from that work, but all ten were part of the first run with the older methods.

Only aggregate numbers are recorded here. Per-run detail is kept outside the repository. The data license is non-commercial: these numbers are for internal research use and are not to be used in commercial, pitch or grant material without the owners' agreement.

## Summary

- **The held-back group came out clearly worse than the development group.** By the reading fixed in the protocol, that means the methods were fitted to the development subjects, and their development numbers overstate them.
- With both planes calibrated, four of the five held-back subjects registered: 20 of their 20 runs ended under 2 mm and 18 under 1 mm. The fifth did not register in any run in any arm, and when started on the reference pose the method moved 17.7 mm away from it.
- Against the older methods on the same five held-back subjects, runs under 1 mm went from 5 of 25 to 18 of 25 and the median target error from 4.0 mm to 0.5 mm.
- The detector-size fit did not carry over. On the development subjects it was kept in all 25 two-plane runs and 23 ended under 1 mm. On the held-back subjects 10 of 25 did. No run raised an error, which was the defect of the older methods.
- A fit requested when the entered size was already right changed nothing in 148 of 150 runs.

## Two planes, calibrated, perturbed starts

Target error is the mean 3D distance at the stored evaluation points. 25 runs per group, 5 per subject, from the starts of the first protocol (median 11.3 and 11.6 mm from the reference in the two groups). The older methods' rows are the first run's saved results regrouped; nothing was run again.

| Group | Methods | Median (mm) | Mean | 90th pct | Largest | Runs under 1 / 2 / 5 mm | Subjects with all five runs under 1 / 2 / 5 mm |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Held back | vessel evidence | 0.46 | 4.87 | 21.42 | 30.81 | 18 / 20 / 20 of 25 | 3 / 4 / 4 of 5 |
| Held back | older | 3.97 | 20.41 | 54.71 | 65.41 | 5 / 9 / 15 of 25 | 1 / 1 / 3 of 5 |
| Development | vessel evidence | 0.39 | 0.35 | 0.56 | 0.63 | 25 / 25 / 25 of 25 | 5 / 5 / 5 of 5 |
| Development | older | 3.00 | 3.42 | 6.58 | 7.61 | 7 / 7 / 17 of 25 | 1 / 1 / 3 of 5 |

Over all ten subjects, for comparison with the first run: 43, 45 and 45 of 50 runs under 1, 2 and 5 mm, against 12, 16 and 32 for the older methods.

The seven held-back runs over 1 mm are in two subjects. One accounts for five, at 15 to 31 mm. The other has two, at 1.3 and 1.5 mm.

## Started at the reference pose

How far the two-plane method moved when it was started on the reference pose, one run per subject.

| Group | Methods | Median (mm) | Largest | Subjects that stayed within 1 mm |
| --- | --- | --- | --- | --- |
| Held back | vessel evidence | 0.26 | 17.73 | 4 of 5 |
| Held back | older | 2.93 | 67.13 | 0 of 5 |
| Development | vessel evidence | 0.40 | 0.53 | 5 of 5 |
| Development | older | 2.12 | 6.18 | 2 of 5 |

The subject that moved 17.7 mm is the one that failed from every perturbed start. So the failure is in what the score prefers on that subject, not in how far the search reaches.

## The score and the reference pose

In every calibrated arm with perturbed starts, in both groups, the method's score at the reference pose was higher than at the start in 25 of 25 runs. The older score did not have this property.

It is not enough. On the failing held-back subject the score also ranked the reference above all five starts, and the method still ended at poses it scored higher than the reference. On that subject the mean evidence under the projected points at the reference pose was 0.08 and 0.10 on the two planes. On the other nine subjects it was 0.16 to 0.27. The subject was not opened to find out why, so no cause is given here. The same subject was the worst of the ten under the older methods (34 to 65 mm).

## One plane, calibrated

One plane does not determine depth, so these arms are read by in-plane error: the mean distance on that plane's detector, in millimeters at the isocenter. 25 runs per group.

| Group | Arm | Methods | Median (mm) | 90th pct | Largest | Runs under 1 / 2 / 5 mm |
| --- | --- | --- | --- | --- | --- | --- |
| Held back | `frontal` | vessel evidence | 0.34 | 8.02 | 9.29 | 20 / 20 / 20 |
| Held back | `frontal` | older | 4.62 | 42.25 | 46.02 | 0 / 2 / 14 |
| Held back | `lateral` | vessel evidence | 0.33 | 15.26 | 20.55 | 18 / 19 / 21 |
| Held back | `lateral` | older | 8.18 | 46.59 | 49.43 | 1 / 3 / 8 |
| Development | `frontal` | vessel evidence | 0.36 | 0.60 | 0.71 | 25 / 25 / 25 |
| Development | `frontal` | older | 4.40 | 16.37 | 39.10 | 3 / 5 / 14 |
| Development | `lateral` | vessel evidence | 0.29 | 4.04 | 5.45 | 21 / 21 / 24 |
| Development | `lateral` | older | 6.43 | 25.06 | 34.07 | 4 / 6 / 11 |

Target error stayed several millimeters, as expected with depth open: medians of 4.6 and 4.8 mm in the held-back group and 5.2 and 4.9 mm in the development group. No subject had every single-plane run under 5 mm.

The lateral plane was the weaker one in both groups. One development subject had four of five lateral runs over 1 mm in-plane; that was known before this run.

## Detector size entered wrong, fit requested

The entered sizes were 0.85 times the stored size on the frontal plane and 1.2 times on the lateral. Scale error is the absolute error of the detector scale the proposal ended with, as a fraction; a dropped fit leaves it at 0.15 or 0.2.

| Group | Arm | Fits kept | Scale error: median / 90th pct / largest | Runs under 1 / 2 / 5 mm | Measure |
| --- | --- | --- | --- | --- | --- |
| Held back | `biplane_uncalibrated` | 15 of 25 | 0.07 / 0.20 / 0.21 | 10 / 10 / 10 | target error |
| Held back | `frontal_uncalibrated` | 18 of 25 | 0.01 / 0.19 / 0.23 | 14 / 14 / 14 | in-plane |
| Held back | `lateral_uncalibrated` | 14 of 25 | 0.14 / 0.20 / 0.20 | 10 / 10 / 10 | in-plane |
| Development | `biplane_uncalibrated` | 25 of 25 | 0.00 / 0.01 / 0.10 | 23 / 23 / 23 | target error |
| Development | `frontal_uncalibrated` | 25 of 25 | 0.01 / 0.02 / 0.02 | 25 / 25 / 25 | in-plane |
| Development | `lateral_uncalibrated` | 22 of 25 | 0.01 / 0.15 / 0.20 | 15 / 16 / 20 | in-plane |

In the held-back two-plane arm, two subjects registered in all ten runs. In two subjects the fit was dropped in every run, which leaves the wrong entered size in place: one is the subject that failed when calibrated, the other registers when calibrated. In the fifth subject the fit was kept and the result was 6 to 10 mm off.

For the older methods the same arms had no two-plane run under 5 mm in either group, and 16 runs over the ten subjects returned no proposal. Here every run returned one.

## Detector size entered right, fit requested

| Group | Arm | Fits kept | Result against the same arm with no fit requested |
| --- | --- | --- | --- |
| Held back | `biplane_fit_right_size` | 0 of 25 | identical |
| Held back | `frontal_fit_right_size` | 0 of 25 | identical |
| Held back | `lateral_fit_right_size` | 1 of 25 | one run differs; fitted scale off by 0.02 |
| Development | `biplane_fit_right_size` | 0 of 25 | identical |
| Development | `frontal_fit_right_size` | 0 of 25 | identical |
| Development | `lateral_fit_right_size` | 1 of 25 | one run differs; fitted scale off by less than 0.005 |

## Time

Median time per registration: 0.3 seconds for two planes and 0.1 for one, on a 768 pixel working grid, and 1.2 and 0.3 seconds when a fit is requested, since that runs the search twice.

## Deviations from the protocol

None in the run.

Between the protocol's commit (`0cca942`) and the run's commit, the methods changed as the protocol allows, for reasons that did not come from subjects 06 to 10:

- `fd7aba4`: the search no longer starts extra descents from turned poses. A mutation pass showed that no synthetic gate needed them, and a rerun on subjects 01 to 05 showed that no arm there did either. The fitted search now also refines the entered-size result, so a fit never ends at a higher cost than the entered size.
- `c0e2ee1`: tests and comments only, from an independent code review.

## What this does not show

- Ten subjects from one center, five of them the subjects the methods were built on. Five starts on one subject are not independent runs.
- The 3D image and the frames come from one session. A CTA or MRA from another day, as in a real procedure, is harder.
- These are non-selective runs. A selective injection fills part of the tree. One synthetic gate covers a third of the tree absent; no real selective case is measured here.
- The reference pose has its own error, which the owners report as under about 0.3 mm. Differences of a few tenths of a millimeter between rows mean nothing.
- One held-back subject of five failing says the method fails on some real cases. It does not give a rate.

## What follows

- The methods stay at version 1. No setting is changed in response to this run.
- A change to either method is a new version with a new protocol. If the failing subject is opened to find the cause, it becomes development data and the held-back group shrinks to four.
- The two options the design set aside are still available for a next version: a term for vessel direction, and dropping non-vessel points from the 3D set.
- The detector-size fit is not solved. It no longer raises an error and it does no harm when the entered size is right, but on the held-back subjects it recovered a wrong entered size in two of five.
