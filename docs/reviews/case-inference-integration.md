# Case-inference integration review reconciliation

Internal engineering review, not clinical clearance. Original reviewed revision: `49d852826af66ddbb8d2466290150bfadb80a35a`; later preprocessing changes require their own review.

Read-only integration review `deleg_e0ee536c` inspected App, Viewer, SegmentationPanel, segmentation mask loading and the original aneurysm weight loader, with spot checks of backend contracts. It reported no blocking issue within that scope. It did not review all geometry/device code or validate clinical behavior. The report used nine calls against the requested eight-call cap; retain that limitation rather than describing the delegation as fully limit-conformant.

## Actionable parent follow-up

The review noted that a successful HTTP response missing its acceptance artifact version could update current state and the overlay before the existing missing-version check threw. Parent wrote a regression returning an otherwise accepted-shaped response with no artifact version. The observed RED showed `onOverlay` was called with that malformed entry. Parent moved the version check ahead of candidate clearing/current-state/overlay changes, and the focused three-test panel suite passed. The regression also confirms that the candidate remains visible and `onAccepted` is not called after this malformed response. TypeScript and the production build passed after the fix.

## Retained boundaries

- Canonical source paths are `planner/aneurysm_inference.py` and `planner/model_assets.py`; the child report's `planeurysm_inference.py` spelling was only a summary typo, not a file to create.
- The acquired model version handle and its upstream source-code commit are separate identities; do not collapse them into one revision.
- SHA formatting micro-optimization is unnecessary for correctness. Its input is a digest, not the entire 16 MiB buffer.
- NumPy private scalar support is constrained by the installed runtime and actual original-checkpoint load. Dependency changes still require explicit runtime tests; no new dynamic symbol resolution was introduced.
- This review covered the initial loader only. New LPS/ZYX preprocessing, restoration and actual CTA execution are separately tracked, not retroactively cleared by this verdict.
- No automatic aneurysm, calibrated morphometry or device-suitability claim follows from this review. No merge or deployment is authorized by it.
