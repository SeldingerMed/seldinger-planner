# Sizing controller/App review reconciliation

Independent read-only review covered DeviceSizingPanel.tsx and the App sizing region, not the entire model/imaging stack. It reported4calls/115seconds against3calls/120seconds requested. Parent did not accept the proposed lock escape without reproduction.

## Claimed deviceEpoch remount escape: not reproduced

The reviewer said editing a device field increments deviceEpoch and clears lockedScope. In this code, edits mark deviceDirty only. deviceEpoch changes after a confirmed input save, and the root conflict state disables that save. Root conflict also disables the calculation controller across any key remount; local lockedScope is not its only authority.

The expanded real-App synthetic integration now triggers an unconfirmed calculation echo, asserts the device field is disabled, attempts a programmatic field change/save anyway, verifies ZERO input PUTs, and confirms calculation remains disabled/locked. Only **Reload saved state (discard edits)** clears the conflict and recovers calculation at the same case version. Test first needed a readiness wait after discarding prior input edits; it then passed without a production lock change. This is stronger than inferring safety from key usage alone.

Actual browser proof already independently exercised the same-version explicit recovery after a real committed POST plus ONE labeled client-only stale acknowledgement. Exactly one authentic POST occurred, no blind retry, and the server response was retained separately.

## Disabled while GET is pending

The read is deliberately canceled and numbers hidden while disabled. Enabling triggers a fresh read. A missing alert during an intentional external action lock is not a write acknowledgement or a permanent busy failure. Mutation identity uses a separate source epoch; actual own-busy feedback and late-completion/captured-owner tests pass.

Reviewer confirmed the separate busy channel and captured-owner release. No actionable production defect remained from this narrow review after reconciliation. This does not establish anatomical/clinical validity, full current catalog/compatibility, independent detection performance or release approval.
