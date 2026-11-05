# Sizing results UI and calculation controller verification

Fresh local prototype, not clinically validated sizing or device compatibility. Follow-up remains uncommitted/unpublished after363e095. Public CTA dimensions are not fabricated to make the demo look complete.

## Incoming presenter reconciliation

Capped worker delivered346-line presenter/parser with8 tests, reported6pass/2fail before cleanup and no rerun. It exceeded its4min/14call budget (333seconds/25calls). Parent reran:8pass and TypeScript green, then independently reproduced semantic defects with RED/GREEN tests. A compiled component was not treated as complete:

- Nested source revision/artifact version and valid hashes/IDs were insufficiently checked.
- Zero, over100mm, and extra scalar fields were accepted despite the actual input-store contract.
- Unknown geometry/inner-rule states could be treated as ordinary hidden states or still display retained numeric values.
- A nonfinite target silently disappeared while other numbers remained visible.
- Unknown result status, missing required outputs, missing-input/unsupported statuses retaining targets, unrelated result provenance and a contradictory missing-field list could pass.
- Invalid non-string missing-field lists could fall back to empty and falsely appear complete.
- Captures were compared with order-sensitive JSON.stringify rather than structural equality.

These are now rejected as a whole, not partially rendered. Actual producer partial/stale variants come from temporary synthetic SQLite; the original stale test merely flipped status while retaining invalid numeric inputs and was replaced with a genuine producer shape. Presenter now26focused tests; TypeScript passes. No device is selected; source rows are historical, WEB targets approximate, current SKU coverage and clinical compatibility remain unestablished.

Initial actual screenshot revealed unreadable gray-on-dark text and a bright fallback border. Scoped palette/spacing were repaired, independent gap names made readable and historical source detail collapsed. Fresh screenshot/readback confirms readable actual CTA UI without horizontal overflow. It is an internal prototype render, not a cleared publication artifact.

## Controller/App path

New DeviceSizingPanel owns GET and the bounded7-pointer POST, not dimensions or image data. It uses the source-bound parser before action or display. Source/epoch guards discard late writes; read cancellation may follow disabled feedback without cancelling a mutation's own acknowledgement. Busy-owner callback is captured and released even on discarded completion. An actual regression caught local calculating remaining true after source change; resetting source-local progress fixed it. Unconfirmed409, unchanged result ID or stale echo locks retries until explicit case reload.

App has its own deviceCalculationBusy channel; model/source/geometry/worksheet/Muse writes cannot overlap calculation. The controller excludes its own busy channel from action identity. Input drafts hide results and lock calculation. Input saves and geometry recomputes remount/refetch the result context. Independent controller tests6passed; App integration verifies deferred POST locks and releases source controls plus dirty-input lock. A separate read-only controller/App review is pending delivery, not presumed passed.

## Actual public-case lifecycle

Approved Zenodo case006 planning CTA, `IkEMF5YWYSm7LeodOXBSbQ` v8. All SIX operator-reported dimensions stayed NULL throughout; only provenance-only edits were made and restored. No real numeric sizing target is claimed.

1. Opened actual CTA, clicked **Calculate saved inputs**, real server persisted a new current partial result, UI displayed its exact ID, six gaps, no targets, no JS errors/alerts.
2. Edited provenance in the actual input editor: dirty calculation guard activated. Real save caused current sizing to become stale with result:null. Restoring original provenance did NOT resurrect the old result. Explicit calculation produced a new current partial result.
3. Clicked actual **Compute mask geometry**. Native worker recomputed the public masks at the same case version8, producing geometry `Htj1SQtfc7kgtNjVX_Vwtw`. Saved operator-input revision remained `PRMAMj1xr-hUgxktkgYXjw`, but the new geometry-result ID invalidated sizing. Explicit UI calculation rebound to it.
4. Fresh app/CTA reopen recovered the exact saved result, no visible alerts/JS errors and no horizontal overflow. Screenshot `device-sizing-ui-reopened.png` records this checkpoint (sizing ID NYxPSaJMkApgyaeGjizpIQ).
5. ONE explicitly labeled client-only stale-echo fault then tested calculation acknowledgement failure. The authentic server200 response was retained separately. Calculation locked; parent **Reload saved state (discard edits)** recovered the committed result at the SAME case version. Exactly one POST occurred, no blind retry. This was controlled fault injection, not a claimed server response.

Final independent non-browser readback: casev8/notes empty, geometry `Htj1SQtfc7kgtNjVX_Vwtw`, input revision `PRMAMj1xr-hUgxktkgYXjw`, sizing `mOiDj0lRRf_-oDsLLIstfQ`, partial_inputs/six NULL values. The earlier browser script had a top-level-await evaluation syntax failure before any calculation click; its corrected IIFE completed the real path, no fabricated fallback.

Ignored receipts under artifacts/device-range-integration:
- device-sizing-ui-calculation.json
- device-sizing-ui-invalidation.json
- device-sizing-ui-geometry-invalidation.json
- device-sizing-ui-reopened.json/png (before the final controlled fault)
- device-sizing-ui-unconfirmed-recovery.json
- device-sizing-final-independent-readback.json

## Observed checks and limits

- Whole lightweight backend530passed/96skipped; Ruff and diff whitespace green.
- Whole frontend144passed in22files; TypeScript and production build green; formatted changed UI. Existing large-bundle warnings remain.
- Positive NUMERIC sizing evidence is separate synthetic pure/API/presenter evidence, not of this real CTA.
- Actual native geometry recomputation is technical integration evidence, not anatomical truth or clinical validation.
- Full sizing invalidation through a new actual SAM acceptance remains a distinct unexercised path; result-state dependencies include accepted-mask/SAM lineage but that is not substituted for a complete browser proof.
- Independent full-head aneurysm localization/evaluation, anatomical reference evaluation, six independently defined real-case inputs, full current device catalogs/compatibility and external publication remain open.
