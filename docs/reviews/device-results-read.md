# Result-reader independent review reconciliation

Reviewer read the earlier143-line reader and bounded neighboring definitions, not the current172-line parent-repaired reader, POST or UI. It reported7 calls/164seconds versus5reads/2minutes requested; no edits. Its review is not whole-product or clinical clearance.

## Reread503 versus409

The reviewer proposed treating validation failures during the second read as normal concurrent-change409s. That change is NOT applied. A well-formed changed snapshot and a malformed provider payload are different evidence:

- A valid new stale snapshot with result:null is recognized and produces409 because the frozen tokens differ. Reload is the correct action.
- A stale status retaining numeric geometry, invalid identity, or invalid canonical catalog is a provider/data integrity failure, not proof of an ordinary revision change. It stays503/no-store and never projects numbers.

New actual HTTP conformance tests independently exercised BOTH second-read cases and passed without a production change. Also, wrapping only _ERRORS at the reread caller would not implement the suggested mapping: read_frozen already converts those exceptions to HTTPException503. Blindly changing that boundary could hide persistent provider corruption as a harmless reload race. An ambiguous mutation is locked until explicit reload irrespective of generic failure class; no blind retry is implied.

## Identity ordering

Requested-case equality follows source/catalog validation; both wrong-case and malformed source paths return sanitized503/no-store with no numbers. The reviewer identified no externally observable leak or recovery difference. Existing wrong-case regression remains green; no behavior-free ordering churn was needed.

## Actual scope and counts

Parent already independently reproduced/fixed mutable geometry/result projection, current-input geometry mismatch, input encoding failures and malformed store envelopes. The review's assertion that compose cannot throw on shape errors was not relied upon; dedicated parent tests proved the earlier failures and verify sanitized handling now.

Result GET suite now **19 passed**; Ruff format/check and diff whitespace passed. POST retains its separate21-test checkpoint, and the preceding whole base was528passed/96skipped before these two added conformance cases. No new whole-suite total is asserted here. Existing actual v8 API/browser metadata receipts remain applicable because this reconciliation changes tests/docs only. Pure results presenter is still pending delivery, controller/App wiring unfinished. No clinical validation or external publication occurred.
