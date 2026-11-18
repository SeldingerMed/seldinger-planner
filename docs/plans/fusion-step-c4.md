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
- [x] 1.7 Studio, docs, verification record, mutation pass, independent review, automated review. Built on `feat/step-c4-studio` and merged on 2026-11-17 as `2cd9058` (#14).

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

## Part 4: learned view initializer

Started 2026-11-17, ahead of parts 2 and 3, on Colin's decision.

### Why

A frame with no geometry tags gets its view from the operator, and the search then looks only within 15 degrees and 60 mm of that. The TAIR review of part 1 ended with no proposal on the filled arteries, and its log entry names a starting pose from elsewhere as one of two ways forward. This part builds that start: a small network that reads one frame and proposes which way the frame looks at the head.

### What it is and is not

- It proposes views. For each frame it returns up to five ranked views (primary angle, secondary angle and in-plane turn), each with the network's own score. The operator picks one or none. The registration search, its record and the confirmation of a proposal are unchanged, and the search refines whatever start it is given.
- It is general, not trained per patient. It never sees the patient's 3D model: it reads the frame and answers in patient axes, which is where a CTA or MRA volume already is. Position and field size stay with the existing search, whose scan covers 60 mm.
- It is a research artifact. The training data includes sets released for research use only, so the weights are for internal research and are not cleared for commercial use.

### Acceptance criteria

1. The network reads the vessel evidence of one frame, the same map the part 1 methods score against, and nothing else from the frame.
2. It is trained only on synthetic projections of vessel models from public volumes. No Ljubljana and no TAIR frame or volume is used for training or for choosing a checkpoint.
3. The Python copy of the evidence filter used to make training frames agrees with `vesselEvidence2d.ts` on shared fixtures to within 1e-4 at every pixel of every level.
4. The browser forward pass agrees with the training framework on a shared fixture to within 1e-4 on every output.
5. Synthetic gate, firm, on vessel models held out from training: over at least 2,000 frames drawn as in training, the best of the five proposed views lies within 15 degrees of the true viewing direction in at least 80%, and the first proposal in at least 50%. If the gate fails the part reports a negative result and nothing is offered in the studio.
6. Ljubljana, reported and not gated. Subjects 01 to 05 may guide the design. A protocol is committed before one run on subjects 06 to 10, and nothing is tuned on that run. Reported: the angle between each proposed view and the reference view, and the target error of the part 1 registrations started from a proposed view against the same registrations started from the studio's default views.
7. TAIR, five fixed cases, one reading under a rule written before the first proposal is drawn. It is not accuracy evidence.
8. The weights enter the planner as one file whose size and SHA-256 are fixed in code, with a record of the training code commit, the settings, the seed, the training volumes and their licences. A request never names a file or a hash.
9. Every training output (prepared vessel models, generated frames, checkpoints, logs, caches, temporary files) is written to the external volume, checked by its identifier before each run. No fallback to the internal disk.
10. Saved records of every earlier version still replay to the same numbers. Anything a record gains is a new version.

### Phases

- [x] 4.1 Scope, criteria and design written here before code.
- [x] 4.2 Vessel models prepared from the public volumes, on external storage, with a manifest of sources and licences.
- [x] 4.3 Python evidence filter with the fixture check of criterion 3; frame generator; network; training; export.
- [x] 4.4 Browser forward pass with the fixture check of criterion 4, and the decoding of its output into views.
- [x] 4.5 Synthetic gate of criterion 5 on held-out vessel models.
- [x] 4.6 Ljubljana: development on 01 to 05, protocol committed, one run on 06 to 10, results page.
- [ ] 4.7 First pull request: everything above, nothing offered in the studio.
- [ ] 4.8 Second pull request: weights under their contract, the studio's view proposals, the TAIR reading, the verification record, mutation pass and reviews.

### Design

Written on 2026-11-17 after a scan of the data on hand and of the published work, and before any code.

What the published work says. The learned initializers with public code train one network per patient on synthetic X-rays of that patient's own volume (DiffPose, Gopalakrishnan and others, CVPR 2024, doi 10.1109/CVPR52733.2024.01108; xvr, Gopalakrishnan and others, arXiv 2503.16309), and xvr, which pretrains one network across many patients, still fine-tunes it on each patient before use. The closest work on cerebral CTA to DSA trains on projections of segmented vessels and segments the real frame first, so that both sides are vessel pictures and not gray levels (Downs and others, Int J CARS 2025, doi 10.1007/s11548-025-03412-2). No published method was found that trains on injections of one territory only. A general network is therefore the less proven choice. It is taken because the planner cannot train per case, and because the question it answers is coarser than those papers ask: which way the frame looks, to within the search's own reach, and not the pose.

1. **Input.** The vessel evidence of the frame from `vesselEvidence2d.ts`, at two of its blur widths, 8 and 2 working pixels, reduced to 128 by 128 with the frame centred and its longer side filling the grid. Both sides of the synthetic gap go through the same filter.
2. **Output.** Views are binned every 10 degrees: primary from -120 to 120 and secondary from -50 to 50, 275 bins. For each bin the network gives a score and, for a frame that belongs in that bin, the offset of the view from the bin centre and the in-plane turn. The proposals are the highest-scoring bins, none within 20 degrees of a better one, at most five. Binning is used because one frame can have more than one reading: a left carotid seen from the front and a right carotid seen from behind give mirrored pictures.
3. **Network.** A small residual network, four stages of 24, 48, 96 and 192 channels, about 2 million weights, with its normalization folded into the convolutions at export. The browser forward pass is plain loops over typed arrays with no new dependency.
4. **Vessel models.** Whole-brain artery masks of public TOF-MRA volumes. Arteries are what an arterial-phase frame shows, and MRA masks carry no veins or bone. Each mask is split into territories by growing along the mask from the vessels that enter at the bottom of the volume, which also gives every voxel its distance along the vessels from the entry. Entries within 10 mm of each other count as one. A mask is first checked for which way it faces (see the decisions log, 2026-11-18): one stored back to front is turned, and one whose facing is not clear is left out.
5. **Synthetic frames.** A mask is projected through the planner's own camera model at a random view (primary within 125 degrees, secondary within 55, in-plane turn within 25), source distances, field size, frame size and offset from the isocenter. Each voxel adds its volume to the pixel it lands on, so a thick vessel is darker. Then, at random: all territories, or one, or one with part of another; filling only up to a distance from the entry, as early in an injection; the top or bottom of the model cut away; lines that are not vessels, for catheters and tubes; a low-frequency background and noise. The 8-bit frame goes through the Python copy of the evidence filter.
6. **Use.** The proposal turns a view into a start for the search under the views the operator entered: the rotation that makes the entered view see the model as the proposed view would, about the centre of the vessel points. The search then scans position and refines.
7. **Ranking.** Proposals are ranked by the network's score. The registration score is not used to pick among them, because the TAIR review showed it does not tell a right pose from a wrong one.

Not taken up now: a territory answer (which artery was injected), restricting the 3D model to that territory, and position or field size from the network.

Limits known before the first run. TOF-MRA volumes cover a slab of about 7 to 10 cm, so the synthetic trees lack the far cortical branches and the neck. Ljubljana frames were taken close to straight frontal and lateral views, so the studio's default views are already near the reference there (once its volumes are read in patient axes, see the log of 2026-11-18) and Ljubljana can show that the network tells those views apart and how far off its angles are, but not that it helps from a far start. TAIR has no reference pose.

## Parts 2 to 6

Each gets its own acceptance criteria here when it starts. Known inputs:

- Part 2. 16 of 150 uncalibrated Ljubljana runs raised an error when the fitted detector passed the 600 mm the view model accepts. Fitted sizes were no closer than entered sizes.
- Part 3. Candidate public data: Guide3D and CathAction (guidewires and catheters). Licences are checked before any download. No public labelled set for implanted devices has been identified.
- Part 4. Started; see its own section above.
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
- 2026-11-17. Second pull request merged as `2cd9058` (#14). Part 1 is complete.
- 2026-11-17. Colin chose part 4, the learned pose initializer, as the next part, ahead of parts 2 and 3. Branch `feat/step-c4-pose-initializer` cut from `2cd9058`.
- 2026-11-17. Part 4 design. A general view network on vessel evidence, binned views with up to five proposals, trained on synthetic projections of public TOF-MRA artery masks with single-territory and early-filling frames. Training code lives in this repository under `research/pose_initializer`; training runs with the main checkout's model runtime and writes only to the external volume. The public masks at hand with whole-brain arteries are COSTA's (Zenodo 11025761, released for academic research use), so the weights are a research artifact and are not cleared for commercial use; clearing them means retraining on masks made from CC0 or CC BY volumes or getting the owners' agreement.
- 2026-11-18. Entries of a vessel model that lie within 10 mm of each other count as one. At 18 mm a third of the masks were left with a single entry, because a carotid was joined to the basilar artery.
- 2026-11-18. Found before any network was trained: 159 of the 355 COSTA masks, as stored in the pooled set, have the front of the head at the back (every mask of one centre and most of two others). Training on them as labelled would have taught the network views that are wrong by half a turn. The frames generated up to then were discarded. The cause, in the source files or in how the pooled set was built, was not looked for, and the pooled set was not changed.
- 2026-11-18. Rule for which way a mask faces, in `orientation.py`: two indicators that share nothing, the position of the upper midline arteries and the fit to 16 artery masks of other people from the TopCoW-curated IXI cases of the same pooled set, each of which is first checked to have its named arteries where their names say. A mask is turned or kept only when both are clear and agree: 185 kept as labelled, 159 turned, 11 left out. The reference masks are not trained on. Checks of the rule: for the 62 people who are in both sources, a comparison of the two image volumes gave the same answer as the rule in all 62 (57 back to front); and after turning, the entry of the basilar artery lies behind the carotid entries in 91% to 100% of three-entry models at every centre, against 0% to 9% at three centres before. Neither indicator tells left from right. A turned mask is mirrored front to back, so if a file was in truth turned half round its model is a mirrored head.
- 2026-11-18. Vessel models after the rule: 253 for training, 34 for choosing a checkpoint and 57 held out (the source's own test cases). Frames per model: 400, 100 and 40, seed 1, which gives 2,280 held-out frames for the gate. 400 and not more because of generation time; the number was set before any network was trained.
- 2026-11-18. Network trained once: 101,200 frames of 253 vessel models, 30 epochs, seed 1, 23 minutes. The checkpoint was chosen on the 3,400 validation frames (epoch 12: best of five within 15 degrees in 88.2%, first proposal in 59.7%). File of 7,097,120 bytes, SHA-256 `1c76811c...2b8b56`, training code at `c9e01d2`. Later epochs fit the training frames further without gain on validation.
- 2026-11-18. **Synthetic gate (criterion 5): passed.** 2,280 frames of the 57 held-out vessel models, run once on the chosen checkpoint: best of five within 15 degrees in 88.4% (needed 80%), first proposal in 63.1% (needed 50%). Median error of the first proposal 10.5 degrees, of the best 7.9. By filling: everything filled 98.3% and 79.1%; one territory with part of another 93.5% and 72.8%; one territory only 81.0% and 50.2%. One territory only is the hardest case and is what the Ljubljana and TAIR frames show. This is a result on synthetic frames and says nothing yet about real ones.
- 2026-11-18. Ljubljana volumes are not stored in patient axes. Their files give the world axes as right, front, up, but the front of the head lies toward -y. Found on subjects 01 to 05 without the network: in the lateral frame of each, the face is on the left of the picture (teeth and face in four, less clear in the fifth), and under the stored geometry the -y end of the 3D mask lands on that side in all five. With up unchanged, the volumes are in patient axes turned half round about the vertical, which also puts the stored frontal views at 0 to 22 degrees and the lateral views at 88 to 90 degrees, the usual biplane arrangement. The view evaluation reads the set that way (`volume_axes` in its protocol). Left and right cannot be checked without knowing the injected side. The part 1 results do not depend on this: they compare poses inside the volume's own frame.
- 2026-11-18. Ljubljana development run of the network (subjects 01 to 05, 10 frames, harness at `3870bea`). First proposal within 15 degrees of the stored view in 1 of 10 frames (median 28 degrees); best of five in 8 of 10 (median 9); the studio's default views in 8 of 10 (median 1.3). Two-plane registrations under 1 mm: 3 of 5 from the default views, 0 of 5 from the first proposal, 4 of 5 from the best of five. So on real frames the proposals usually contain a near view but do not rank it first, and on this set the network adds nothing over the default views, as expected of frames taken at standard views.
- 2026-11-18. What the development frames showed about the gap, and what they did not. On four of the five frontal frames the first proposal reads the view as 21 to 31 degrees caudal of the stored one. Clean projections of the same subjects' own 3D masks at the stored views give a first proposal within 15 degrees in 6 of 10 (median 12.5), with the same caudal reading on the frontals, so most of it comes with the tree and not with what else is in a real frame. On held-out synthetic frames near frontal there is no such lean (median -2 degrees). Cutting the neck or the top off the masks made the answers worse, not better. Whether the lean is a different head position in the two kinds of volume or a difference between a 3D angiography tree and an MRA tree was not settled. Nothing was changed in the generator or the network on this evidence.
- 2026-11-18. The one protocol run on subjects 06 to 10 (`ljubljana-view-initializer-v1`, commit `6d89223`). First proposal within 15 degrees in 4 of 10 held-back frames, any of five in 7 of 10, default views in 9 of 10. Two planes under 1 mm: 4 of 5 from the default views, 1 of 5 from the first proposal, 4 of 5 from the nearest of five. Read as: the proposals are a short list that usually holds a near view, the ranking is not reliable on real frames, and this set cannot show a gain. Nothing is tuned on it. Results in `docs/research/ljubljana-view-initializer-results.md`.
- 2026-11-18. Review of the first pull request. Fixed: the turn error is now measured the short way round (no reported number changes; the gate rerun on the same frames gives the same result), a mask of small fragments only is refused instead of stopping the preparation, and too few training frames are refused by name. Left as evaluated: the browser feeds the network unrounded grid values while training frames were stored in 8 bits. On the ten development frames the difference moved no first proposal by more than 0.03 degrees and changed the order of the lower proposals in two. Rounding it would change the method the protocol run read, so it waits for the next network and a new protocol. Also left: the Ljubljana harness stops if the filter refuses a frame. All 20 frames were accepted in the one run, and the harness is not changed after it.
