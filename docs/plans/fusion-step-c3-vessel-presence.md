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
