# SAM correction integration review reconciliation

Independent read-only review `deleg_551e49e9` found no blocking issue within the inspected correction integration diff after `c96c0a9`. It inspected predictor-prior construction, base ownership/blob checks, worker volume splice, request/metadata keys and frontend lifecycle gating. Some related tests were discovered rather than read fully. This is a bounded software review, not whole-product or clinical clearance, an automated review-app approval or authorization to merge.

Parent confirmed the current helper/worker/API/panel files match published `363e0956e4e8c17b294dddd933d6c17be862b9fe` and reran the correction/server/import checks: **48 passed**. The actual public worker/API/browser evidence, full runtime tests and later point-selection repair are recorded separately in `docs/verification/sam-case-correction.md` and `docs/reviews/sam-point-selection.md`. Do not imply this earlier reviewer inspected every subsequent parent addition, including point-compliant selection and durable prompt metadata.

## Reconciled conclusions

- Current accepted base selection is case/role-owned; candidate, image and reference identities are checked. Content-addressed base files are verified and cannot be selected by a product filesystem path.
- Worker checks immutable blob identity, source geometry/units, uint8/binary payload and actual prior use. In/out native-plane transposes and copying the base preserve all unedited slices, verified separately on real public data.
- API→worker→metadata→frontend field names match. The frontend waits for the current-mask snapshot and does not replace an unresolved preview. Real accept/reject/reopen checks are stronger evidence than fixture-only success.
- The ±4 prior remains a disclosed heuristic, not learned decoder logits. Point compliance, model-quality score and operator acceptance do not establish anatomical or clinical correctness.

## Race-observation correction

The review suggested a ledger mutation between the base check and inference-gate acquisition would be caught by the worker. **The worker does not query current ledger acceptance status.** Its immutable blob/image/reference checks can still pass on an older accepted base. The API's post-inference case/reference readback catches the changed artifact version and returns 409 before persistence; the ledger's atomic preview-version guard also closes the final write window. Parent inspected those actual checks and reran their existing server tests. No stronger worker-level race claim is made.

No new source-code change was required by this review. Subsequent metadata hardening and the explicitly unvalidated new calibrated context remain separate work. Computed morphometry/sizing invalidation has not been exercised because those product result pipelines remain unfinished.
