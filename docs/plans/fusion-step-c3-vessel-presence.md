# Fusion Step C3: vessel-presence report

Working checklist for the step. Scope and gates were accepted on 2026-11-14 with Step C2 and are not changed here. Tick an item only when its check has run.

## What the step adds

A report that says, for each geometric segment of the accepted vessel mask and for each plane of a saved registration, whether the frame shows a vessel where the segment projects. It asserts no cause. A segment with no 2D support may be occluded, unfilled, outside the injected territory, absent, or simply misregistered.

The report rests on the saved registration. Step C2 measured that registration against public data with a reference pose: the two-plane proposal was more than 1 mm from the reference in about three runs out of four, and its score did not identify the reference pose. The report therefore inherits the registration's status (an operator-confirmed proposal, not validated) and says so wherever it is shown.

## Acceptance criteria

1. Geometric segments are derived from the accepted vessel mask. Each has an index, a length and a mean radius. Segments are not named.
2. Each segment is classed per plane as `supported`, `no_2d_support`, `outside_field` or `indeterminate`. 2D vessel pieces with no 3D counterpart are listed separately.
3. Synthetic gate, firm: every segment is classed correctly in three constructed cases (a vessel removed from the frame, a vessel only in the frame, a vessel outside the field), at the true pose and at the recovered pose.
4. The report is saved as an append-only record bound to the registration revision. On reload it is recomputed and checked against the saved one.
5. The brief gains a scalar-only section: registration status, planes, geometry source, counts and lengths by class. No images, no per-segment coordinates.
6. A qualitative note on five public TAIR cases, labelled as operator review and not as accuracy evidence. Case rule fixed in advance: the five smallest two-plane head-CTA cases other than 00028 (00164, 00132, 00151, 00161, 00146). A case with no usable contrast frame pair is recorded as excluded and the next smallest is taken.

Reported, not gated: class counts and lengths on the TAIR cases.

## Boundaries

- Every result is a proposal the operator confirms. Nothing is accepted automatically.
- No artery naming and no statement of cause.
- No dataset files or derivatives in the repository. TAIR data stays on external storage.
- The registration engines and the Ljubljana protocol are not changed in this step.

## Phases

- [x] 1. Segment step: mask to unnamed segments with length and mean radius, with tests. `web/src/vesselSegments.ts`, 11 tests.
- [x] 2. Presence classes per plane and unmatched 2D pieces, with the synthetic gate at the true pose. `web/src/vesselPresence.ts`.
- [x] 3. The same gate at the recovered pose, single-plane and two-plane. Four constructed cases, each at three poses.
- [x] 4. Report record: append-only, bound to the registration revision, recomputed and checked on reload. `planner/vessel_presence.py`, `planner/vessel_presence_server.py`, `web/src/presenceReport.ts`.
- [x] 5. Studio: compute, show and save the report beside a saved registration. `web/src/VesselPresencePanel.tsx`, `web/src/vesselPresenceJob.ts`.
- [x] 6. Brief section, scalar only. `planner/fusion_brief.py`.
- [ ] 7. TAIR five-case note.
- [ ] 8. Docs, verification record, mutation pass, independent review, automated review.

## Decisions log

- 2026-11-15. Built as approved, on a branch cut from the Step C2 merge commit. Reworking the registration score is recommended separately and does not hold this step.
- 2026-11-15. Segments are cut from the mask itself, not from the medial points of the registration step. A first version linked the medial points and lost stretches of thin oblique vessels, where those points have gaps. The medial points stay as they are for registration.
- 2026-11-15. A sample is judged only where the frame under it can be put down to its own vessel. Samples within 2 mm in the frame of a sample of another run of the mask, or of a sample of the same run 6 mm or more away in the volume, are left out. Before this rule the first segment of a branch missing from the frame read as indeterminate, because its first millimeters project onto the parent.
- 2026-11-15. The gate views (AP and LAO 60) were chosen so that no segment of the phantom is seen end-on. The lateral view, where one is, has its own test: the segment is indeterminate whatever the frame shows.
- 2026-11-15. Limits found while building, each pinned by a test or recorded for the verification note: a vessel that is only in the frame can take away the support of a mask segment it lies over; a wrong registration reads as missing vessels; with the field edge 3 mm lower than in the gate case, the single-plane registration slid the trunk along itself by 8.4 mm and three segments were misclassed, while the two-plane registration recovered the pose.
- 2026-11-15. The server never sees the frame or the mask, so it cannot recompute the counts. It checks that the counts are possible, that each class follows from its counts under the same rule the browser uses, and that the report names the registration that is the latest one inside the write transaction. The recomputation on reload is the browser's.
- 2026-11-15. The brief leaves out the registration's fit scores. They were shown not to identify the pose, and a number in a brief reads as a measurement.
- 2026-11-15. A saved report is recomputed in the browser when it is read back, once, and is shown as the saved report only when every count agrees. When it does not agree, the recomputation is shown as unsaved and the saved counts are not shown. When the frames or mask are gone, the saved counts are shown and said to be as saved.
- 2026-11-15. An unsaved report is not counted as an unsaved draft of the case. It is recomputed in seconds from saved inputs, and counting it would lock the other studios every time a case with a saved report is opened. Its requests lock the workspace like any other request.
- 2026-11-15. A save with no readable answer, or a server failure, is treated as possibly stored: nothing more can be saved until the report is read back.

## TAIR qualitative note: the rule, fixed before any frame was opened

Written 2026-11-15, after reading the dataset's file sizes and per-frame text tables and before extracting a frame or running a registration on these cases.

- Cases: the five smallest biplane head-CTA cases other than 00028, by the bytes of the two `A1_t00` clips, their text tables and `CTA-H_defaced.nii.gz`: 00164, 00132, 00151, 00161, 00146 (252.1 MiB). A case with no usable pair under this rule is recorded as excluded and the next smallest is taken (00167, then 00174).
- Runs: consecutive frames with the same `frame_type` and `relative_time` in the dataset's text table. A run pair is one run in each clip, both of a `WC` type, both at least 15 frames, with the same `relative_time`. Run pairs are taken in time order, at most the first four.
- Frames: the frame at 30% of each run, then 40%, then 50%, the same fraction in both clips. The first fraction at which both frames show contrast-filled arteries, on inspection, is used. This is the only judgement in the choice and it is made before any registration.
- Planes and angles: the plane letter and angles are the most frequent on-screen reading in the run, not the folder letter. They are screen text, not calibrated geometry. A pair the app refuses as less than 30 degrees apart is skipped for the next run pair.
- Frames are cropped to the image area, which removes the burned-in text, and admitted as a public-scope PNG bundle.
- CTA: resampled by trilinear interpolation onto a 0.8 mm RAS-aligned grid of 200 voxels per side, centered on the centroid of the voxels above -200 HU, as for case 00028.
- Vessel mask: the RSNA vessel model's candidate, accepted as produced.
- Geometry, assumed: source to detector 1200 mm, source to isocenter 750 mm. The on-screen field size is taken as the diagonal of the cropped image area. The field-size fit is on for both planes. Vessel polarity is read off the frame; sensitivity 0.5, or 0.8 if the app finds no vessels at 0.5.
- One two-plane proposal per case from the on-screen angles, saved as proposed, then one presence report. No retries with other settings.
- What is recorded: counts and lengths by class, and what the overlay looks like against the frame. This is one reviewer's reading of five cases. It is not accuracy evidence. No frame, image, pose or per-case file enters the repository.

### Frame choice under the rule, recorded before any registration

- The dataset's two black masking boxes lie inside the image area, at its top left. The rule said only "cropped to the image area". The crop is therefore the largest rectangle of the image area that holds neither box, which is the full width below them. This was decided from the box positions, the same for every case, before any registration.
- The two clips of a run are screen captures of different lengths, so the same fraction of each is not the same instant and the two frames can differ in phase. The rule is applied as written.
- 00164: in the first run pair (0:09:48) the frontal frames show devices in the neck and no clearly filled artery at any of the three fractions. The second run pair (0:10:29) shows filled arteries in both planes at 30% and is used.
- 00132 (0:11:23), 00151 (0:14:17), 00161 (0:01:08) and 00146 (0:20:03): the first run pair at 30% shows filled arteries in both planes and is used. In 00132 the lateral frame is late arterial, and in 00161 the lateral frame already shows some venous filling.
- No case is excluded.

### Found on the first TAIR case, 2026-11-15

- Computing the report on a real 200-voxel-cube mask in a background tab ended with the button offered again and nothing shown. Reading the mask took about 50 s there, longer than the 30 s request deadline, and the panel treated the passed deadline as a cancel. The deadline now ends when the last request is answered; decoding is not a request. Test: "decoding the mask is not held to the request deadline", which fails without the change.- The first crop left burned-in text in three cases (00132, 00161, 00146): the end of the on-screen angle text reaches about 45 pixels into the lower left of the image area, and one glyph sits on its right edge. It is acquisition text on public, already masked clips, not an identifier, but the rule says the crop removes it. Those three bundles were admitted again with 50 columns less on the left and 10 less on the right, at the same millimetres per pixel, before any registration on them. 00164 and 00151 have no text inside the crop. The check that missed it counted near-black pixels, which finds the masking boxes and not grey text; the second check counts sharp edges where the text was and was followed by looking at the frames.
- "The diagonal of the cropped image area" understates the image area, because the crop leaves out the rows beside the masking boxes. The entered field width is about 7% small for that reason. It is left as the rule fixed it: the field size is an assumption and its fit is on.

