# Operator geometry controls: actual application verification

Internal technical verification, not clinical or anatomical validation.

## Working application path

`MorphometryInputs.tsx` is wired into the fresh planner beside the source-bound result component. Operators can capture a sac-component seed and neck-plane origin from the native CTA crosshair, define a direction from that origin, capture a bounded parent path, choose interior station indices, discard edits, save inputs, and compute geometry from saved inputs. Saved seed/origin controls locate those world-space points in the viewer. No landmarks or dimensions are invented automatically.

Dirty geometry drafts hide materialized numbers and disable competing case writes, model actions, source switches, and Muse. Discard restores saved inputs without a write. A successful PUT waits for the parent's authoritative case-version readback before computation becomes available. Compute sends only the saved case/source versions. The result component refreshes without changing case revision itself.

The section diagrams represent the computation planes. The CTA viewer's Locate ... origin buttons position its crosshair, not an oblique CTA reslice. Their labels were changed from Go to ... section to avoid implying that reslicing was implemented.

## Incoming patch and parent repairs

The delegated component stopped at its iteration cap with three passing tests and two failing assertions. Parent reran those failures and TypeScript before integration. The two original failures were stale mock-reference and outdated validation-message assertions, but those were not the only integration issues.

Parent reproduced and repaired:

1. Propagating `onBusy(true)` to the component's `disabled` prop changed its scope identity, canceled its own request epoch and discarded a successful response. A controlled-parent regression failed before separating scope identity from temporary action locking.
2. Exact JSON comparison of a returned normal rejected valid oblique saves. Actual `OperatorGeometryInputs.model_validate` changed a JavaScript unit vector `[0.5773502691896258, ...]` to `[0.5773502691896257, ...]` through Python normalization. A regression failed before permitting at most `1e-12` roundoff per normal component. Coordinates, path entries and indices must still match exactly; the tolerance is not an anatomical or measurement tolerance.
3. The pre-save case version could be reused while the parent was still loading the successful PUT's new version. A regression failed before keeping the component unavailable until the new case scope arrives.
4. There was no explicit way to discard an incomplete draft. Added and tested a non-writing discard control.

Parent also moved note-setting out of state updater functions, added tested source-point focus controls, integrated geometry draft locks, and applied existing Prettier formatting. These changes are not a general claim that every concurrent UI interleaving has been verified.

## Actual public-case browser lifecycle

Case: `IkEMF5YWYSm7LeodOXBSbQ`; pinned broader calibrated image source unchanged.

- Restored the existing v5 current result.
- Located the saved neck origin in the native CTA, captured that crosshair as the operator origin, located the saved sac seed and captured a direction toward it. These are technical test actions, not expert neck/dome annotation.
- Confirmed the dirty draft hid numbers, disabled source/model actions, and disabled computation.
- Actual UI PUT returned HTTP 200 and case version `6`. Actual GETs returned `stale` with no materialized numbers.
- Actual UI POST sent only `artifact_version: "6"` and the pinned `reference_revision`. It ran the real fixed-runtime geometry worker, returned HTTP 200/current, and the application refreshed the numbers.
- Current persisted result: `1-iIioo-IcGi-TE8xCjDuA`.
- Technical plane change produced displayed sac height `12.36 mm`, width `15.55 mm`, and neck maximum/minimum diameters `12.46 / 8.70 mm`. Their change from the prior plane demonstrates operator-input dependence, not accuracy.
- Captured one additional parent-path point from the actual crosshair, observed seven draft points and suppressed numeric results, then discarded back to six saved points without another PUT.
- Independent HTTP readback confirmed current result ID, case/image/source/version binding and exact saved operator inputs.
- A full source reopen restored v6/current, three finite contour paths and correct origin navigation. An initial verification script's fixed two-second wait was too short; subsequent inspection found the completed readout with no alert, and the resumed verification passed without another mutation.

Receipts under `artifacts/calibrated-source-integration/`:

- `geometry-editor-browser.json`: actual requests/responses, draft locks, path capture/discard.
- `geometry-editor-api-readback.json`: independent live endpoint readback.
- `geometry-editor-reopen.json` and `geometry-editor-reopen.png`: reopened final application.
- `geometry-editor-browser.png`: computation state before the later origin-button label refinement.

## Observed checks

- Nine focused input-component tests passed.
- Entire frontend: 69 tests in 18 files passed.
- TypeScript and production Vite build passed. Existing >500 kB chunk warning remains.
- Targeted Prettier checks and git whitespace checks passed.
- Most recent backend checkpoint, unchanged by these frontend edits: 366 base tests passed with 96 skipped; 20 native imaging checks passed separately; Ruff and Python format checks passed.

## Boundaries and remaining work

This is an exercised technical planning workflow, not a completed clinical measurement study. Independent anatomical/reference evaluation, clinical suitability, device catalog/sizing product integration and its invalidation chain, and independent full-head aneurysm localization/performance evaluation remain open. The current follow-up source/geometry work is local and unpublished; earlier published CI does not certify these edits. The focused independent input-control review was subsequently reconciled in `docs/reviews/geometry-operator-controls.md`, including new busy ownership, reload-required save-failure and station-display repairs. Its final frontend checkpoint is 73 passing tests. The result ID above records this document's original checkpoint, not the later review recomputation.
