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
7. The studio offers the new methods and labels the result a proposal. The score is shown as the mean vessel evidence under the projected points, and the studio says it is not registration accuracy.

### Phases

- [x] 1.1 Baseline suites on the branch point, recorded. On `5f8b9c6`, 2026-11-16: backend 1363 passed and 127 skipped, lint and format clean; frontend 1096 tests in 94 files, build and dependency audit clean; native ingestion 171; physics 239.
- [x] 1.2 Diagnostic protocol committed (`ffcdb42`), then run on subjects 01 to 05 (`278e234`). Aggregate findings in `docs/research/ljubljana-reference-diagnostics-results.md`.
- [x] 1.3 Method design from the findings and the literature scan, written below before code.
- [x] 1.4 New methods `vessel_evidence_compass_v1` and `vessel_evidence_compass_biplane_v1`, with the synthetic gates of the older methods, a partial-filling gate, a wide-field gate and a gate for a pose only the scan reaches (`208e3fa`, `e01ae92`, `fd7aba4`). Mutation pass: 25 of 28 changes caught; the three that survive are listed in the decisions log. Independent review: no wrong-result defect; its four findings are closed in `c0e2ee1`.
- [x] 1.5 Protocol `ljubljana-evidence-v1` committed (`0cca942`), then one run at `c0e2ee1`. Results in `docs/research/ljubljana-evidence-results.md`. Two planes, calibrated, runs under 1 mm: held back 18 of 25 (older methods 5), development 25 of 25 (older 7). One held-back subject fails in every arm. The held-back group is clearly worse than the development group, and the detector-size fit did not carry over.
- [x] 1.6 TAIR five-case review, 2026-11-17, under the rule below (`52fe264`). One proposal per case, each saved, reloaded and redrawn. In none of the five do the projected vessels visibly lie on the filled arteries, two read worse than the centerline distance proposal of the same frames, and the fit of the field size was dropped in all five. Record in `docs/verification/step-c4-vessel-evidence.md`.
- [ ] 1.7 Studio, docs, verification record, mutation pass, independent review, automated review. Built on `feat/step-c4-studio`; open until the second pull request merges.

### The TAIR review, fixed before the new method is run on a TAIR frame

Written on 2026-11-17, before the vessel evidence method was run on any TAIR frame. It is the same five cases as the Step C3 note, read the same way: one reading by the agent that built this step, not accuracy evidence, with no pass criterion.

- Cases, bundles, frames, accepted vessel masks and entered geometry are those of the proposals the Step C3 note saved: 00164, 00132, 00151, 00161 and 00146, the frame of each plane that note used, the geometry it entered. Nothing is chosen again.
- Method: vessel evidence, two planes, from the on-screen angles, dark vessels, the field-size fit on for both planes as in the Step C3 note. The sensitivity does not apply.
- One proposal per case, saved as proposed with the same attestation, then the saved record reloaded and redrawn once. No retries with other settings.
- It runs in the studio against the running server, on a shadow copy of the Step C3 runtime, so the Step C3 records stay as they are.
- Recorded per case: what the studio reported (movement, each plane's mean evidence at the start and at the result, the fit outcome and fitted sizes), the overlay images, and whether the saved record read back and was redrawn.
- Read per case, by eye: whether the projected vessels visibly lie on the filled arteries, in one or two sentences, beside what the Step C3 note said of the same frames.
- A software fault found by a real case is fixed with a test that fails without the fix, the case is run again, and the note says so. There are no other reruns.
- Whatever it shows, the methods stay at version 1. A finding is an input to the next version.
- Images, per-case files and the runtime stay on external storage. The repository gets the table and the reading.

### Design

Written on 2026-11-16 after the diagnostics, a literature scan and one design probe, and before any method code.

What the published work says. The Ljubljana group's most robust method on this data matches a 3D vessel model to the intensity gradients of the 2D image, not to extracted lines (Mitrovic and others, IEEE TMI 2013, doi 10.1109/TMI.2013.2259844). Their ten-method comparison found intensity-based methods the most accurate and one-plane registration much less robust than two-plane (Int J CARS 2018, doi 10.1007/s11548-017-1678-2). Both agree with the diagnostics: use the image, not a thresholded line set.

The method.

1. **2D target: vessel evidence.** A multi-scale ridge response on a working grid of up to 768 pixels a side (the old target used 384), with no threshold. It is compressed between its own 75th and 99.5th percentile with a square root, so a faint small vessel counts for a useful share of what the carotid trunk counts for. The map is then blurred to five widths, 16, 8, 4, 2 and 1 working pixels.
2. **Cost.** For each plane, one minus the mean evidence under the projected 3D points. A point outside the frame counts as zero evidence. A 3D point with no vessel under it therefore costs the same wherever it lands, which is what the diagnostics asked for: four in five 3D points had no 2D partner.
3. **Coverage term.** The share of strong-evidence pixels with no projected point nearby, added at a fixed weight. It bounds what unexplained 2D lines can cost and resists a pose that gathers the points onto the densest evidence. Whether it earns its place is decided on subjects 01 to 05 and the synthetic gates and recorded in the decisions log.
4. **Search.** A translation scan at the widest blur, then a compass descent through the five widths from widest to narrowest. One implementation serves one plane and two. With one plane the weak pull toward the start in depth and in out-of-plane turns is kept from the old method, because one plane does not determine them.
5. **Identifiers.** `vessel_evidence_compass_v1` for one plane and `vessel_evidence_compass_biplane_v1` for two. The old methods, their targets and their saved records are untouched.
6. **What the score is.** The mean vessel evidence under the projected points, from 0 to 1. It says how much of the projected model lies on line-like structure in the frame. It is not registration accuracy, and the studio says so. Acceptance criterion 7 was written before the design, assumed two extracted line sets, and now carries this wording.

Design probe (subjects 01 to 05, development evidence, added after the diagnostics protocol; code in `web/src/research/evidenceProbe.eval.ts`). A bare version of items 1, 2 and 4 with no scan and no bounds, from the 25 protocol starts (6.6 to 16.7 mm off): the two-plane cost ended under 1 mm from the reference in 25 of 25 runs, median 0.4 mm, and moved 0.1 to 0.4 mm when started on the reference. With one plane and no pull toward the start it ran off in depth, as expected.

Not taken up now: an orientation term (projected vessel direction against the 2D line direction) and dropping non-vessel 3D points. Both stay available if the Ljubljana run or the TAIR review shows the need.

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
- 2026-11-16. Diagnostics, subjects 01 to 05: the reference pose agrees with the image in every frame; the 2D extraction marks vessels correctly and misses most of them; the 3D points follow the vessels and include non-vessel points; a plain two-way distance ranks the reference above the perturbed starts. The rework therefore keeps the reference as its development target and changes the 2D target and the cost, not the camera reading.
- 2026-11-16. Design: a continuous vessel-evidence map replaces the thresholded line set, and the cost is one minus the mean evidence under the projected points plus a bounded coverage term. Method identifiers `vessel_evidence_compass_v1` and `vessel_evidence_compass_biplane_v1`.
- 2026-11-16. The coverage term stays, at weight 0.5. Without it on subjects 01 to 05 the calibrated two-plane arm lost one run (24 of 25 under 1 mm against 25) and no run with a fitted detector size ended under 5 mm in any plane. Weights 0.1 and 0.25 were also tried there.
- 2026-11-16. The detector-size fit (part 2) is handled inside the new methods: the fitted detector stays inside the sizes the view model accepts, and a fit is kept only when it lowers the cost by at least 0.02 against the same search at the entered size.
- 2026-11-16. Mutation pass on the two modules, 28 changes. Three survive the unit tests. Removing the weak pull on out-of-plane turns for one plane: no synthetic gate needs it, and it is kept because without it on subjects 01 to 05 the lateral arm fell from 24 to 21 of 25 runs under 5 mm in-plane. Removing either one of the two refinements of the entered-size result in the fitted search: each alone meets the gates, and removing both is caught.
- 2026-11-16. The extra descents from turned poses were removed before the protocol run. No gate and no arm on subjects 01 to 05 needed them.
- 2026-11-16. Protocol `ljubljana-evidence-v1` run once at `c0e2ee1`. The held-back group is clearly worse than the development group: one of its five subjects fails in every arm, and the detector-size fit recovers a wrong entered size in two of five. The methods stay at version 1 and no setting is changed in response. The failing subject was not opened; opening it would make it development data.
- 2026-11-16. Part 1 lands as two pull requests. The first holds the methods, the diagnostics and the Ljubljana evaluation, with nothing offered in the studio. The second holds the studio, the TAIR review and the verification record.
- 2026-11-16. Review of the first pull request, after the protocol run. The methods are frozen as run, so findings that would change what either method computes are recorded here for the next version and not applied: (a) the value 2 that marks a pose as not scored can be reached by a scored one-plane pose at the far end of the depth range with no evidence under it, which then reads as not scored; (b) `detector_fit: kept` says the fitted search's result was kept, not that the size moved, and a next version should report the two apart. Comments in the code now say both. Findings on the tests, the evaluation summary and this page were applied; the built code of the two method files is unchanged.
- 2026-11-17. First pull request merged as `bc3a825` (#13).
- 2026-11-17. Records of the vessel evidence methods get their own versions, `step-c4-evidence-registration-v3` and `step-c4-evidence-biplane-registration-v4`, with their own score, no sensitivity and a stored fit outcome. Versions 1 and 2 are untouched.
- 2026-11-17. A vessel evidence record carries no vessel presence report. The report reads the 2D line set of a centerline distance proposal at the sensitivity its record states, and a vessel evidence record has neither. The server refuses a report bound to one. A report on a vessel evidence proposal would need its own method and is not part of this step.
- 2026-11-17. The studio's default method stays centerline distance. The TAIR review gives no reason to change it.
- 2026-11-17. TAIR review, five cases, one proposal each. No proposal visibly lay on the filled arteries, as with the centerline distance proposals of the same frames. Two (00151, 00146) read worse than those. The methods stay at version 1. Inputs to the next version, none applied: (a) the result scores, 0.11 to 0.25, lie on both sides of the 0.19 median of the held-back reference-pose runs, so the score does not flag a poor pose; (b) in 00151 part of the projected tree settled on a tube, so line-like structure that is not a vessel can decide a result; (c) the fit of the field size was dropped in all five, where the entered size is believed to be about 7% small; (d) with a selective injection most of a whole-head mask has no partner at any pose, and the cost alone does not find which part was injected. A next version needs either a restriction of the mask to the injected territory or a starting pose from elsewhere, which is what part 4 is for.
- 2026-11-17. Mutation pass on the studio, the record parser, the job runners and the server contract: 43 changes, 41 caught after four tests were added. The two that survive remove a second guard behind a first one.
