# Operator-reported sizing-input persistence and HTTP verification

Internal engineering evidence only. New build `seldinger-planner`, branch `feat/fresh-planning-workspace`; local/uncommitted follow-up to published `363e0956e4e8c17b294dddd933d6c17be862b9fe`. This does not establish clinical measurement validity, a complete sizing workflow, device selection or compatibility.

## Implemented and exercised

`DeviceInputsLedger` retains immutable, independently revisioned input records in the existing SQLite workspace. It accepts six explicit numeric-or-null millimeter fields and unvalidated `operator_reported` provenance. It does not populate dimensions from segmentation metrics or choose a parent sizing diameter. Numeric inputs must be finite positive non-bool numbers <=100 mm, a prototype software-input cap, not a clinical range.

Each record binds the exact current geometry dependency snapshot: case/image/source/version, accepted mask IDs/hashes/revisions, operator geometry hash and calculation version. Save compares that snapshot and expected input revision inside one BEGIN IMMEDIATE transaction. Saving does not bump the case version or invalidate current mask geometry. Subsequent dependency changes hide stored scalar values and provenance. A current record means its bookkeeping dependencies match, not that its measurements are filled or validated.

HTTP endpoints in the default application:
- GET `/api/cases/{case_id}/device-sizing-inputs`
- PUT the same URI with case/source versions, expected input revision, explicit measurements and provenance.

The API reuses the coherent geometry reader and existing geometry-evidence validation, freezes provider JSON before use and rereads it before confirming responses. Requests accept no query selectors or arbitrary paths/URLs. PUT requires streamed JSON <=8192 bytes, validates content type/content length and returns sanitized errors. Stale case/source/input versions return409; malformed requests422; oversized bodies413; wrong content type415; trusted-provider integrity failures503. Responses, including propagated source errors, are no-store. A PUT confirmation failure can occur after commitment: clients must reload saved state before another write, not blindly retry.

## Parent reconciliation of incoming store

Original 20 focused tests passed independently. Parent RED/GREEN regressions then reproduced and fixed:
- A caller-owned geometry snapshot could change after scope hashing but before database entry, allowing a different snapshot to be persisted under the old hash. Save now validates/persists an independent parse of the exact frozen scope bytes.
- Current input reads returned modified stored values/version/hash without verifying their coherence. Reads now validate the schema and recompute the canonical scope/data hash before exposing values.
- Postcommit `inputs()` could acknowledge a later writer's latest record rather than this write. Acknowledgement now comes from the same write transaction.
- Added an exercised `read_in_transaction` composition point, preserving the caller connection/transaction for atomic result-layer comparisons.

Hash checks establish data coherence, not clinical authenticity or tamper-proof institutional approval. SQLite write authority remains trusted.

## Actual public-CTA API proof, without invented measurements

On public case `IkEMF5YWYSm7LeodOXBSbQ`, v8, real GET/PUT/GET sequences saved and reopened records with **all six scalar values deliberately null**. Technical provenance explicitly records that no independent measurement values were supplied. No synthetic numbers were entered into the real CTA case.

The first actual input revision was `xEasu4qG5t5OVe0iqmP33A`; another confirmed save after restarting the latest backend produced `SoQe9PUJ2vh_rV_GQqcUjg`. Both writes used the actual last input revision as the optimistic token. Exact-target readback matched each acknowledgement. Case metadata/notes, artifact version8, accepted masks and current geometry result `nT6RqCsbkOZ9SG5-o38ETg` remained unchanged. Application-origin browser GET also returned200, no-store, v8 and the latest revision with six absent values.

Receipts under ignored `artifacts/device-range-integration/`:
- `device-inputs-live-null-roundtrip.json`
- `device-inputs-live-restarted-roundtrip.json`
- `device-inputs-browser-readback.json`

`web/src/fixtures/device-inputs-current-metadata.json` is a genuine point-in-time API payload for the first saved all-null record, not a source of fabricated real-case dimensions. Input revisions are opaque IDs, distinct from hashes and case artifact versions.

## Observed checks

- Input-state suite: **26 passed**, 0.38s.
- Input HTTP suite: **17 passed**, 0.37s.
- Operator-reported pure arithmetic adapter: **15 passed** on explicitly synthetic scalar inputs; this unbound calculation function is not yet the case-bound result API.
- Base suite excluding the separately delegated/in-flight `tests/test_device_results_state.py`: **462 passed, 96 skipped**, 3.44s. The exclusion is explicit, not a claim that the new result-store layer is reviewed or tested.
- Targeted Ruff, formatting and diff whitespace checks passed. Existing frontend checkpoint88 tests/build is separately scoped; the new input component is delegated and not yet wired or browser-verified.

Remaining: reconcile independent input API review, verify/integrate materialized sizing-result state, bind the arithmetic adapter through HTTP, integrate the operator-input/result UI, and exercise full invalidation without fake real-case dimensions. Clinical/anatomical validation, complete current catalogs and broader compatibility remain unestablished. No publication or external deployment occurred.
