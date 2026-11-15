# Fusion Step C3 verification

Step C3 adds a vessel-presence report beside a saved overlay proposal: the accepted vessel mask is cut into unnamed geometric segments, each segment is classed per plane by whether the frame shows a vessel where it projects, the report is saved as an append-only record bound to the proposal, and the local brief gains a scalar-only section. The behavior is described in [Angiogram overlay and 2D-to-3D registration proposal](../angiogram-overlay.md#vessel-presence-report). This note records what was checked and what each check does and does not show.

Evidence classes used below: unit evidence on synthetic data, a synthetic gate with known answers, mutation checks of the new guards, and one reading of five public clinical cases chosen by a rule fixed beforehand. Nothing here is a validation study. No registration accuracy and no diagnostic performance on patient data is claimed.

The headline result is mixed, and it is the result Step C2 predicted. On synthetic data the report classes every segment as constructed, at the true pose and at the recovered pose. On the five public clinical cases the saved proposals did not visibly lie on the filled arteries, and the reports there describe that misfit and not the anatomy: between 6% and 18% of segment length was classed as having 2D support in any plane. The report is a correct reading of a proposal that is not yet good enough to read anatomy from.

## Delivered surface

- `web/src/vesselSegments.ts`: mask to unnamed segments, method `mask_band_sweep_v1`.
- `web/src/vesselPresence.ts`: classes per segment and plane, and unmatched 2D pieces, method `segment_centerline_support_v1`.
- `web/src/vesselPresenceJob.ts`: the computation as a resumable job.
- `web/src/presenceReport.ts`: the closed parser for the saved report, the summary, and the read-back comparison.
- `web/src/VesselPresencePanel.tsx`, hosted by `web/src/ProjectionOverlayStudio.tsx`: compute, review, save and read back.
- `planner/vessel_presence.py`, `planner/vessel_presence_server.py`: record version `step-c3-vessel-presence-v1` and its two routes.
- `planner/fusion_brief.py`, wired into `planner/local_brief.py`: the brief section.

The registration engines, the Step C1 and C2 record contracts and the Ljubljana protocol are not changed in this step.

## Acceptance criteria and where each is checked

| Criterion | Check |
| --- | --- |
| Segments are derived from the accepted mask, each with an index, a length and a mean radius, and are not named | `web/src/vesselSegments.test.ts` (15 tests) |
| Each segment is classed per plane as supported, no 2D support, outside the field or indeterminate, and 2D pieces with no 3D counterpart are listed separately | `web/src/vesselPresence.test.ts`, block "the rules, on a hand-made frame" |
| Synthetic gate, firm: every segment classed as constructed with a vessel removed from the frame, a vessel only in the frame and a vessel outside the field, at the true pose and at the recovered pose | `web/src/vesselPresence.test.ts`, block "the synthetic gate: every segment classed as constructed", below |
| The report is an append-only record bound to the registration revision, recomputed and checked on reload | `tests/test_vessel_presence_server.py` (73 tests), `web/src/presenceReport.test.ts`, `web/src/VesselPresencePanel.test.tsx`, and the read-back on real data below |
| The brief has a scalar-only section with no images and no coordinates | `test_local_brief_reports_registration_and_presence_without_coordinates` and three more brief tests in `tests/test_vessel_presence_server.py` |
| A qualitative note on five public TAIR cases, labelled as operator review and not accuracy evidence, with the case rule fixed in advance | below |
| Reported, not gated: class counts and lengths on those cases | table below |

## Synthetic gate

The phantom is the vessel tree used by the registration tests, rendered into a frontal plane and a plane 60 degrees from it. Four constructed cases: a vessel three segments long removed from the frames, a vessel one segment long removed from the frames, a vessel drawn only in the frames, and a smaller field that leaves the foot of the trunk outside. The expected class of every segment follows from the construction and is computed through the reference camera, not through the code under test.

Each case is run at three poses: the true pose, the pose the single-plane engine recovers from one frame, and the pose the two-plane engine recovers from both. At each, every segment in every plane must have exactly its constructed class, and the unmatched 2D pieces must be none, or exactly one piece along the vessel that is only in the frames, within 10% of its length. All twelve pass.

The single-plane pose is more than 1 mm from the true one in these cases (one plane leaves depth loose), and the classes in that plane still hold. That is a property of this phantom and this view, not a tolerance that can be relied on: the test "reads a wrong registration as missing and unmatched vessels" shows that a pose 10 mm off turns more than half of the segments to no 2D support and leaves unmatched 2D pieces in both planes.

Three tests record what the classes cannot tell: a vessel seen end-on stays indeterminate whatever the frame shows, a vessel that is only in the frame can lend its support to a segment it crosses, and a wrong registration reads as missing vessels.

### What was changed while the method was being fixed

- The segment step was first built on the medial points the registration uses. They leave gaps along thin oblique vessels, and a gap ends a segment where the vessel does not end. It was rebuilt on the mask voxels before any presence test was written.
- Four distances in the hand-made presence tests were changed after their first run (45, 50 and 55 mm to 25, 30 and 35 mm).
- The frame-bounds convention was corrected by half a pixel: frame coordinates run from 0 to the width or height.
- One check in the panel test, that plane B's saved sensitivity changes the result, was replaced by a check that the job is given each plane's own saved frame, view, polarity and sensitivity, which tests the wiring directly.
- The mean-radius rule was changed after real masks exposed a fault (below).

## Saved record

The server checks listed in the guide were each exercised: impossible counts, a class its counts do not give, runs out of order, a report naming a registration that is not the latest, a report whose frame hash is not the registration's, a registration whose frame or mask is gone, a revision conflict, an oversized body, and thirteen ways of tampering with a stored row, each of which reads as unavailable (503) from the report route and from the brief. A stored row nested too deeply to decode also reads as unavailable. A read is given out only when two reads in a row agree.

The class rule exists twice, in `classifyPresence` in the browser and `classify` on the server. The limits were compared by reading both (0.5, 3, 0.3, 0.7, 0.3, and 5 mm for an unmatched piece), each side's boundary tests pin them, and `holds the same bounds as the server` pins the list bounds.

## Mutation checks

Single-site mutants of the new guards were applied one at a time to a throwaway copy and the relevant test files run. First pass: 65 mutants, 54 killed, 9 survived, 2 not applied because their text matched twice. After new tests and two more mutants: 67 mutants, 63 killed, 4 survived.

Tests added because of survivors:

- `test_the_brief_checks_the_envelopes_it_is_given`: the brief's own integrity checks were reachable only after the report reader had already refused the same input, so nothing tested them. Six brief mutants went from surviving or unapplied to killed.
- `test_a_read_that_changes_between_two_looks_is_refused`: the double read.
- "leaves no piece empty on a grid coarser than its pieces": the spreading of a node's volume along its links.

The four survivors are guards behind another guard, kept as a second line:

- `V17`: the stored dependencies are compared a second time after the stale test and the binding test have together fixed them.
- `S7`: the acknowledgement compares the report identifier after the revision, and a case cannot hold two reports at one revision.
- `R8`: the browser parser's list of allowed plane names is followed by the comparison with the registration's own planes.
- `N2`: the save handler requires the review tick, and the button that calls it is disabled without the tick. The mutant that enables the button (`N4`) is killed.

## Five public clinical cases

This is one reading of five cases. It shows that the path from a real biplane run to a saved, reloaded report runs, and what such a report looks like today. It is not accuracy evidence. The overlays were looked at by the agent that built this step. No clinician reviewed them.

Source: TAIR clinical data, version 1.0 (Kitware), CC BY 4.0. Nothing from the dataset, and nothing derived from it, is in the repository: frames, masks, overlays and per-case files are on external storage.

### The rule, fixed before a frame was opened

The rule was committed as `0b09fb1` after reading the dataset's file sizes and per-frame text tables and before extracting a frame. The frame choice was committed as `1b2ece0` before any registration. In short:

- Cases: the five smallest two-plane head-CTA cases other than 00028, by the bytes of the files needed: 00164, 00132, 00151, 00161, 00146.
- Run pairs: one contrast run in each clip with the same on-screen time, both at least 15 frames, in time order, at most the first four.
- Frames: the frame at 30% of each run, then 40%, then 50%. The first at which both frames show filled arteries is used. This is the only judgement, made before any registration.
- Planes and angles from the on-screen text, not the folder letter. In 00164 and 00132 the clip under folder B carries the on-screen plane A.
- CTA resampled to a 0.8 mm grid of 200 voxels per side. Vessel mask: the RSNA vessel model's candidate, accepted as produced.
- Geometry assumed: source to detector 1200 mm, source to isocenter 750 mm, the on-screen field size taken as the diagonal of the cropped image area, field-size fit on, dark vessels, sensitivity 0.5.
- One two-plane proposal per case from the on-screen angles, saved as proposed, then one report. No retries with other settings.

No case was excluded. 00164 used its second run pair, because the first showed devices in the neck and no clearly filled artery. The other four used their first run pair. All five used the 30% frames, dark vessels and sensitivity 0.5, and each case has exactly one saved proposal.

### Departures and what they were

- The first crop left the end of the on-screen angle text inside the image area in three cases (00132, 00161, 00146). It is acquisition text on public, already masked clips, not an identifier, but the rule says the crop removes it. Those three bundles were admitted again with a narrower crop at the same millimeters per pixel before any registration on them. The check that missed it counted near-black pixels, which finds the dataset's masking boxes and not grey text.
- The crop leaves out the rows beside the dataset's two masking boxes, so "the diagonal of the cropped image area" understates the field by about 7%. It was left as the rule fixed it, with the field-size fit on.
- The two clips of a run are screen captures of different lengths. The same fraction of each is not the same instant, and the two frames of a pair can differ in phase. In 00132 the lateral frame is late arterial and in 00161 it shows some venous filling.
- 00151's lateral frame shows a short marking on an object in the X-ray image itself. It is part of the public image and was left.
- Three reports (00151, 00132, 00146) were saved before the mean-radius fault below was fixed. They were saved again afterwards, so their saved revision is 2.

### What the proposals looked like

Scores as the studio reported them. They compare automatically extracted line sets and are not a registration accuracy.

| Case | Field (cm) | Rays apart | Moved from the start | Plane A: mean distance, share within 2 mm, fitted field | Plane B: mean distance, share within 2 mm, fitted field |
| --- | --- | --- | --- | --- | --- |
| 00164 | 32 | 90° | 24.3 mm, 16.5° | 5.0 mm, 20%, 0.96 | 4.9 mm, 21%, 0.96 |
| 00132 | 32 | 90° | 49.2 mm, 12.9° | 3.5 mm, 44%, 1.04 | 2.1 mm, 52%, 1.01 |
| 00151 | 42 | 83° | 63.7 mm, 15.5° | 6.4 mm, 15%, 1.06 | 6.2 mm, 19%, 1.07 |
| 00161 | 32 | 87° | 18.4 mm, 19.5° | 6.4 mm, 20%, 1.32 | 4.0 mm, 35%, 0.97 |
| 00146 | 32 | 82° | 67.9 mm, 21.2° | 5.3 mm, 18%, 1.00 | 5.5 mm, 26%, 1.10 |

Looking at the overlays, in none of the five cases do the projected vessels visibly lie on the filled arteries.

- 00164: the frames show a catheter, a dark device shadow and few filled arteries. The projected tree sits around the catheter and follows nothing.
- 00132: the injection fills one hemisphere. In the frontal frame the projected tree lies among the filled arteries without tracing them. In the lateral frame it is bunched in one part of a tree that fills the frame. This is the case with the best scores, and the scores do not show the misfit.
- 00151: a carotid injection. One strand of the projected tree runs near the filled carotid. The rest lies across the face and neck where nothing is filled.
- 00161: what looks like a posterior injection, in a steep cranial view. The projected circle of vessels sits over the right region and does not trace the filled arteries. Plane A's field size was fitted at 1.32 times the entered width, toward the limit of its range.
- 00146: the filled arteries are at the top of the frames. The projected tree reaches far down into the neck, where the frames show a catheter and nothing filled.

The injections are selective and the masks are whole-head, so most of each mask has no partner in the frame even at a perfect pose. The proposal engine has no way to know which part was injected. This is the limit Step C1 recorded and Step C2 measured.

### What the reports said

| Case | Segments, total length | Plane | 2D support | No 2D support | Outside the field | Indeterminate | Unmatched 2D pieces |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 00164 | 58, 574.3 mm | a | 5, 61.6 mm | 28, 286.8 mm | 0 | 25, 226.0 mm | 9, 106.0 mm |
| | | b | 3, 40.7 mm | 29, 291.6 mm | 0 | 26, 242.0 mm | 9, 95.7 mm |
| 00132 | 35, 377.3 mm | a | 3, 37.2 mm | 11, 123.2 mm | 0 | 21, 216.8 mm | 12, 163.5 mm |
| | | b | 6, 69.6 mm | 11, 113.8 mm | 0 | 18, 193.8 mm | 28, 437.5 mm |
| 00151 | 76, 790.1 mm | a | 5, 52.8 mm | 50, 540.4 mm | 0 | 21, 196.8 mm | 10, 183.7 mm |
| | | b | 5, 49.8 mm | 46, 532.1 mm | 0 | 25, 208.2 mm | 5, 106.4 mm |
| 00161 | 84, 872.5 mm | a | 9, 101.3 mm | 37, 389.4 mm | 0 | 38, 381.8 mm | 10, 129.3 mm |
| | | b | 8, 83.6 mm | 25, 256.5 mm | 6, 72.2 mm | 45, 460.1 mm | 9, 151.4 mm |
| 00146 | 62, 683.4 mm | a | 4, 38.6 mm | 34, 401.0 mm | 3, 29.2 mm | 21, 214.6 mm | 5, 53.7 mm |
| | | b | 4, 41.6 mm | 25, 287.4 mm | 2, 16.9 mm | 31, 337.4 mm | 6, 148.8 mm |

Between 0.5% and 1.5% of each mask's volume was in no segment.

Reading them against the frames:

- The share of segment length with 2D support was between 6% and 18% in every plane. The few supported segments are where the projected tree happens to cross a filled artery or a catheter.
- "No 2D support" here does not mean unfilled or occluded. With the tree in the wrong place it mostly means misregistered, and the report cannot tell the two apart. The panel and the brief say so.
- A large share is indeterminate, from a quarter to nearly six tenths of segment length. Around the circle of Willis the projected segments lie over one another, and the rule declines to class a segment it cannot see clear of its neighbours.
- The unmatched 2D pieces are, by eye, catheters and wires, skull and device edges, and cortical branches beyond the reach of the mask. In 00132's lateral frame, 28 pieces and 437.5 mm are the filled tree the projection missed.

So the report does what the synthetic test "reads a wrong registration as missing and unmatched vessels" says it does. It does not yet say anything about anatomy on clinical data, because the proposal beneath it does not hold.

### What the cases found in the software

Each of these was found by running a real case and is fixed with a test that fails without the fix.

- The computation ended in silence on the first case. Reading a real 200-voxel-cube mask in a background tab took about 50 s, the 30 s request deadline passed during it, and the panel treated that as a cancel. The deadline now ends when the last request is answered. Test: "decoding the mask is not held to the request deadline".
- The server refused the fourth case's report: one segment had a mean radius of zero. Two of the five real masks produced such segments and no phantom had. A node of the sweep gave its whole volume to the first piece that reached it, so a run between two branchings that earlier runs had reached was left with none. A node now gives an equal share to each of its links, spread along the half of the link next to it. Volume is conserved and no piece is empty. Tests: "gives every piece the volume that lies along it" at three grid spacings, and "leaves no piece empty on a grid coarser than its pieces". The server's refusal of a zero radius was right and stays.
- The panel's message for a refused save told the operator to reload and try again, which cannot work for a report the record does not accept. It now says the report was refused.

### The read-back on real data

All five reports were saved and read back after a reload, and each was shown as reproduced: "the counts agree with the saved report".

The three reports saved before the mean-radius change were read back after it. Each was shown as not reproduced, "the vessel mask gives other segments", with its counts withheld, which is the behavior the record promises when the code that computed a report no longer gives the same answer. They were then computed and saved again. The segment method keeps its name `mask_band_sweep_v1` because no merged code ever wrote a record under the earlier rule.

The brief of one case (00161) was read from the running server and held the registration status, the two planes and their angle, the class counts and lengths above, the two statements of limits, and no image, pose, coordinate or fit score.

## Final local checks

After the UI review corrections: backend 1363 passed and 127 skipped; frontend 1094 passed in 94 files; native ingestion 171 passed; physics 239 passed. Python lint and format checks, TypeScript typecheck, production build, and dependency audit passed (zero vulnerabilities). All 16 changed TypeScript/TSX files pass Prettier. A whole-source Prettier check also reported 53 existing files outside this change; those unrelated files were not reformatted. Browser test logs include jsdom canvas warnings; the five real-case studio runs above provide the separate rendered-path evidence.

## Independent review and corrections

Three independent Hermes reviewers inspected the server, algorithms, and UI/parser. The UI reviewer found that stored counts could be displayed before verification, or when evidence was unavailable. The fallback table has been removed: only a local computation supplies counts. Changes to the accepted mask, source grid or evidence state now invalidate a retained computation synchronously. Regression tests cover withheld counts while disabled, unavailable evidence, and changing the accepted mask after a successful recheck. A transient automatic-recheck failure withholds counts and an explicit retry can recover.

The generic compute-failure message no longer diagnoses a network failure as changed evidence. The network deadline is explicitly an aggregate fetch budget; local decoding remains outside it. The panel may show stored revision metadata without counts when recomputation is not possible.

The server reviewer noted that a brief assembled across different registration revisions fails closed with 503 rather than a reload conflict. This is retained: an inconsistent provider envelope is not assumed to be benign concurrency. A fully coherent malicious database rewrite can also pass self-consistency checks; the record is not signed and does not claim resistance to an administrator rewriting all anchors. Browser recomputation checks the numbers against the actual artifacts.

JSON integers are valid physical-length numbers; count fields require integral JSON values. SQLite INTEGER affinity can normalize `1.0` to `1` before the revision guard sees it. Neither behavior changes the report contract. Algorithm review found no blocking defects; distance-map interpolation remains a pixel-grid approximation, not an exact geometric distance between subpixel locations.

## Limits

- The report is only as good as the saved proposal, and on the clinical cases reviewed that proposal did not hold. Until registration on clinical frames is credible, a report on clinical data describes the registration.
- No cause is asserted, and none can be: unfilled, occluded, outside the injected territory, absent and misregistered all read the same.
- Segments are geometric. A segment's length can read long by up to one band next to a branching, and its mean radius comes from mask volume, so it follows the mask's errors.
- A vessel seen end-on, or lying over another in the frame, is indeterminate.
- The server stores counts it cannot recompute. The check that they are right is the browser's recomputation on read-back.
- Five cases, one frame pair each, one reader who is not a clinician, assumed geometry, and frames from screen captures. None of the numbers in this section is a performance figure.
