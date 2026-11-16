# Fusion Step C4

Working checklist for the step. Scope was set by Colin on 2026-11-16. Tick an item only when its check has run. The step lands as several pull requests, one or more per part.

## What the step adds

Six parts, in build order. Later parts rest on the registration that part 1 reworks.

1. Registration score rework.
2. Detector-size fit: no raised error, then either a fit that beats the entered size or no fit.
3. 2D device detection.
4. Learned pose initializer for frames with no geometry tags.
5. Rest of the comparison layer: diameter and stenosis per segment, planned against deployed device, contrast timing on the 3D model, 2D findings carried into 3D.
6. Live overlay on a replayed frame stream.

## Boundaries

- Every result is a proposal the operator confirms. Nothing is accepted automatically, and no cause is asserted for a difference.
- No dataset files, derivatives or weights in the repository. Data, per-run detail, images and training outputs stay on external storage.
- Ljubljana data is the Hugging Face copy only, for internal research evaluation. The original is not requested. Its numbers stay out of commercial, pitch and grant material.
- The saved `centerline_distance_compass_v1` and `centerline_distance_compass_biplane_v1` records still replay to the same numbers. A changed score, point set or 2D target is a new method identifier.
- Part 6 reads replayed public recordings. No connection to an angiography system, no use in a procedure room, no deployment, no clinical or regulatory claim.

## Part 1: registration score rework

### Why

On the Ljubljana run (`ljubljana-known-pose-v1`) the score at the reference pose was about as poor as at a pose 11 mm away, and the two-plane engine moved more than 1 mm off the reference in 8 of 10 subjects when started on it. On the five TAIR cases of Step C3 no overlay followed the filled arteries.

### Evidence status of anything measured on Ljubljana from here on

The ten subjects were run once in Step C2 and the per-run detail was read. Part 1 also looks at subjects 01 to 05 at the reference pose to find out why the score fails (see `docs/research/ljubljana-reference-diagnostics-protocol.md`). So:

- Subjects 01 to 05 are development data. A result on them is development evidence.
- Subjects 06 to 10 are not opened by any diagnostic or tuning code. They were part of the Step C2 run, so they are not unseen, but no design choice in part 1 is made from them.
- Each new method version gets one run of a committed protocol on all ten, reported for the two groups separately.

### Acceptance criteria

1. The causes of the poor score at the reference pose are measured on subjects 01 to 05 before the score is changed: what the frame conversion keeps, what the 2D extraction finds, what the 3D point set holds, and whether the reference pose agrees with the image.
2. A new single-plane method and a new two-plane method, under new identifiers, with the old methods and their saved records unchanged.
3. Synthetic gates, firm: the existing single-plane and two-plane phantom gates are met by the new methods. A new gate for partial filling: with part of the 3D tree absent from the frames, the new two-plane method returns within 1 mm and 1 degree.
4. A new Ljubljana protocol is committed before the new methods run on subjects 06 to 10.
5. Reported, not gated: target error by arm, the share of runs under 1, 2 and 5 mm, how far the method moves when started at the reference pose, and whether its score ranks the reference pose above the perturbed starts.
6. Reported, not gated: the five Step C3 TAIR cases reviewed again with the new method, as operator review.
7. The studio offers the new methods and labels the result a proposal. The score is shown as agreement between two extracted line sets, as now.

### Phases

- [ ] 1.1 Baseline suites on the branch point, recorded.
- [ ] 1.2 Diagnostic protocol committed, then run on subjects 01 to 05. Aggregate findings in `docs/research/ljubljana-reference-diagnostics-results.md`.
- [ ] 1.3 Method design from the findings and the literature scan, written here before code.
- [ ] 1.4 New method, test first, with the synthetic gates.
- [ ] 1.5 New Ljubljana protocol committed, then one run.
- [ ] 1.6 TAIR five-case review.
- [ ] 1.7 Studio, docs, verification record, mutation pass, independent review, automated review.

## Parts 2 to 6

Each gets its own acceptance criteria here when it starts. Known inputs:

- Part 2. 16 of 150 uncalibrated Ljubljana runs raised an error when the fitted detector passed the 600 mm the view model accepts. Fitted sizes were no closer than entered sizes.
- Part 3. Candidate public data: Guide3D and CathAction (guidewires and catheters). Licences are checked before any download. No public labelled set for implanted devices has been identified.
- Part 4. Trained on synthetic projections of public CTA at known poses. Training runs outside this repository with outputs on external storage; a trained model enters the planner only under its own artifact provenance contract.
- Part 5. Frame admission is capped at 8 frames per plane, so contrast timing needs a bounded time-series path. TAIR has no calibrated pixels and no trusted frame times.
- Part 6. Latency is measured and reported.

## Decisions log

- 2026-11-16. Step created by Colin with the six parts above. The original Ljubljana data will not be requested.
- 2026-11-16. Branch `feat/step-c4-score-rework` cut from `5f8b9c6`, the Step C3 merge commit.
- 2026-11-16. Ljubljana subjects split by number, 01 to 05 for diagnosis and design and 06 to 10 held back from both, before any diagnostic was run.
