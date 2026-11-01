# Operator sizing-input UI application verification

Internal technical prototype evidence, not anatomical/clinical validation or a completed sizing product. Fresh `seldinger-planner` build, local/uncommitted branch `feat/fresh-planning-workspace`; no new publication/CI claim.

## Incoming-patch reconciliation

The worker returned a truncated patch with4/7 tests passing, no successful TypeScript check, and claimed the remaining issues were test-side only. Parent reproduced the failing run and found substantive functional gaps as well. The worker exceeded both requested runtime and tool-call limits (reported293.66seconds and25calls versus4minutes/16calls); this was not treated as a completed or cleared component.

Baseline test repairs corrected missing readiness waits, a post-save assertion that wrongly expected a clean Save button to remain enabled, and an own-busy test that did not actually feed disabled back from the parent. The parent then added RED/GREEN regressions and repaired:
- Actual `not_saved` and `stale` producer shapes omit geometry_dependencies rather than supplying null. They now load blank forms, retain the CAS tag, and permit new values when upstream geometry is current.
- Input-record status is not upstream geometry readiness. Actual geometry_status controls editing/saving and the recompute instruction.
- Nested case/image/source/version/calculation/operator-hash bindings, exact measurement/provenance keys, nonblank provenance, known geometry status, valid revision tokens and source schema are checked before rendering.
- Initial disabled state issues no GET, then loads once enabled without cancelling its own subsequent busy mutation.
- Hexadecimal/non-decimal text, nonfinite/negative/over-cap values cannot enable Save. Blank fields remain null, never zero or a geometric substitute.
- Exact provenance text is retained during save and in the request/echo; it is not silently trimmed or cleared.
- Source changes reset the save lock. Discard restores blank or confirmed inputs without a write. A truly deferred old GET is now tested against a newer valid version, replacing an ineffective late-response test.
- Invalid CSS content was replaced with scoped compact styles. The original CSS began with a TypeScript import and was not production-build evidence while the component remained unimported.

Unconfirmed PUTs lock further saves and require reload, including409-after-commit cases documented by the input API regression. Busy-owner release remains captured per request, not looked up from newer callbacks. Additional independent component review is pending and not presumed passed.

## App integration

The Devices section has a collapsed **Enter independent sizing values** editor with six explicitly operator-reported fields and provenance. No auto-fill from neck-plane width, projected sac width, maximal height or parent Feret extrema. A dedicated device-busy channel prevents unrelated renderer/workspace completion from releasing its write lock. Drafts lock source changes, geometry/model/plan/notes writes and Muse; the input form itself stays editable. Reload/geometry recompute epochs refresh the form; saving input revision does not mutate case version or mask geometry.

Synthetic frontend integration verifies the form mounts through the real App, can become dirty without disabling its own Save, locks source/model actions, and Discard restores unlocked state. Synthetic edits are not measurements of the public case.

## Actual browser/API path

The browser opened the real public Zenodo case006 planning CTA and expanded the new form. All six scalar fields were blank. Only provenance text was edited; dirty source/model guards activated while Save remained available. A real PUT returned200 and released the component's own parent busy/dirty feedback. Original technical provenance was restored by a second real UI save.

Exact-target GET readback matched the final UI acknowledgement, revision `e6tj8v8pAXOtNvLF51KL2Q`. All six values remained null. Case version8, empty case notes and current geometry result `nT6RqCsbkOZ9SG5-o38ETg` were unchanged. Fresh app/case reopen restored the same saved input revision, blank fields and disabled clean Save, with no visible alerts. The guarded save session recorded no JavaScript errors. No real-case sizing dimensions were fabricated.

Receipts under ignored `artifacts/device-range-integration/`:
- `device-inputs-ui-first-save.json`
- `device-inputs-ui-restored-readback.json`, `device-inputs-ui.png`
- `device-inputs-ui-reopened.json`, `device-inputs-ui-reopened.png`

## Observed checks and remaining scope

- Component suite:23 passed.
- Component + App integration:26 passed.
- Full frontend:111 passed in20files; TypeScript, Prettier and production build passed. Existing large-bundle warnings remain.
- Backend checkpoint490passed/96skipped is separately documented before the newly delegated result-read service; no claim about an unreviewed/in-flight helper.

The form and persistence now work. Source-bound calculation/result HTTP composition and results UI remain unfinished, as do broader compatibility, complete current catalogs, independent localization, anatomical reference evaluation and clinical validity. The pure arithmetic adapter has synthetic evidence only. No external deployment or demo publication occurred.
