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

- [ ] 1. Segment step: mask to unnamed segments with length and mean radius, with tests.
- [ ] 2. Presence classes per plane and unmatched 2D pieces, with the synthetic gate at the true pose.
- [ ] 3. The same gate at the recovered pose, single-plane and two-plane.
- [ ] 4. Report record: append-only, bound to the registration revision, recomputed and checked on reload. Server and parser.
- [ ] 5. Studio: compute, show and save the report beside a saved registration.
- [ ] 6. Brief section, scalar only.
- [ ] 7. TAIR five-case note.
- [ ] 8. Docs, verification record, mutation pass, independent review, automated review.

## Decisions log

- 2026-11-15. Built as approved, on a branch cut from the Step C2 merge commit. Reworking the registration score is recommended separately and does not hold this step.
