# Operator-input component independent review reconciliation

Read-only reviewer inspected the component and tests only; no blanket application or clinical clearance. Parent independently reproduced the actionable defect before changing code.

## Stale-geometry PUT echo

A confirmed-save predicate accepted geometry_status:"stale" because it checked the input revision/hash/values/provenance but did not require current geometry. The UI's old GET-derived geometryStatus remained current. A parent regression observed onSaved rather than reload-required handling with a stale echo. The predicate now explicitly requires geometry_status=="current" and refreshes the stored status on confirmed success. Regression now passes; stale echoes enter the same unconfirmed-save lock as malformed acknowledgements.

## Provenance, recovery and late responses

- Defensive validation guards no longer overwrite operator provenance with error strings. Those branches were unreachable through the current validDraft-controlled button; removing the setters preserves the existing contract without introducing a new error text as saveable provenance.
- Disabled toggles intentionally do not clear an unconfirmed-write lock. The parent provides **Reload saved state (discard edits)** and remounts the editor using reloadEpoch even when case/source/artifact identity is unchanged. A temporary disabled cycle is not proof that a committed write has been reconciled.
- Superseded request results remain discarded by source/epoch guards, while the captured busy owner is released. A subsequently loaded input revision remains the authority for CAS. Snapshot guards do not prevent later independent writes.

## Actual browser fault/recovery proof

On the approved public CTA at v8, a deliberately labeled ONE-RESPONSE client fault changed only the acknowledgement geometry_status to stale. The underlying real HTTP200 response was retained separately, and all six measurement values remained null. This was controlled fault injection, not a claimed server response or fabricated sizing result.

Observed sequence: real PUT commits -> injected stale echo -> Save locked and explicit reload action shown -> parent reload at the SAME case version8 -> genuine GET recovers the committed input record -> original provenance restored by another genuine UI PUT. Both actual server writes returned200. Final exact-target readback showed original provenance, six null values, no visible alerts, case version8 and input revision `F_oP_ZN8gjoI9pSDaeLVbg`. No fake real-case measurement values were entered.

Receipt: ignored `artifacts/device-range-integration/device-inputs-unconfirmed-echo-recovery.json` contains the injection label, actual server responses, request bodies and final authoritative GET. This proof addresses parent recovery behavior, not just callback spies.

Final frontend: **112 passed in20files**; TypeScript, Prettier, production build and diff whitespace checks passed. Existing bundle-size warnings remain. The component suite has24 tests, including the new stale-echo regression. Result-read service and case-bound calculation/results composition remain separate, unfinished work. All current follow-up is local/uncommitted; no external deployment or publication occurred.
