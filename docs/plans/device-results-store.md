# Materialized operator-reported sizing: state tracer

Own ONLY `planner/device_results_state.py` and `tests/test_device_results_state.py`. Fresh repo code, strict vertical RED/GREEN, no pixels/models/.env/network/install/live DB/commit. <=4 minutes, <=16 tools. Parent owns input-store corrections, arithmetic and API. Complete a compiled state tracer, not other layers. Use the real temporary SQLite synthetic fixtures in test_device_inputs_state.fixture or equivalent; no real-case scalar fabrication.

## Stable interface

`DeviceResultsConflict(ValueError)`.
`DeviceResultsLedger(db_path)` composes `DeviceInputsLedger` / its `geometry` ledger, creates separate immutable `device_results` table. Do not change case versions, geometry or input records.

`store(case_id, dependencies, result)` -> current result envelope.
`current(case_id, source_revision, catalog_version, calculation_version=DEVICE_SIZING_CALCULATION_VERSION)` -> result envelope.
Import `DEVICE_SIZING_CALCULATION_VERSION` from planner.device_calculation; parent has exercised that pure adapter on synthetic inputs only.

Dependencies exact structure:
```
{
 "geometry": <GeometryLedger._capture snapshot>,
 "geometry_result_id": <current materialized geometry result id>,
 "input_revision": <latest saved operator input id>,
 "inputs_sha256": <validated input data hash>,
 "catalog_version": <64 lowercase hex canonical catalog hash>,
 "calculation_version": DEVICE_SIZING_CALCULATION_VERSION
}
```
Only API/server supplies these. No client paths, model selection or arbitrary URLs. Require exact keys and finite JSON <=16KiB. Freeze via canonical encode+parse before any later use, not caller-owned aliases.

Inside SAME SQLite transaction:
- Capture live geometry with existing GeometryLedger._capture(conn,case_id,source_revision), no duplicate mask/lineage logic.
- Select latest geometry_results row by rowid for case; require its stored dependency JSON equals captured geometry. Its result id is the live geometry_result_id. No numeric result needed for this comparison.
- Parent is adding `DeviceInputsLedger.read_in_transaction(conn,case_id,source_revision)` with the SAME output shape as `inputs`, without beginning/committing/closing the caller connection. Require its status current, geometry_dependencies == capture; take its latest input_revision and inputs_sha256. Its validation includes current scope and recomputation of the stored input coherence hash. Do not use a separate input-reader connection during persistence.
- Combine these live fields with the caller's catalog_version and calculation_version. Compare exact dependencies before writing. Catalog authenticity is outside this layer; API owns trusted provider/race checking, while current reads take the actual live catalog version.

Store: BEGIN IMMEDIATE; validate result JSON <=64KiB and result.clinical_suitability_established is False, result.validated_sizing is False, result.binding_status == "case_bound_calculation". No clinical/device-selection semantics inferred here. Store independent finite JSON plus opaque result ID and frozen dependencies, immutable history. Reject mismatches with DeviceResultsConflict, no write. Return current result envelope without self-invalidating.

Current: one BEGIN read transaction; case must exist. No row -> {status:"not_computed",result:None}. Latest row only. Compare all live dependencies (case/image/source/masks/operator hash, latest geometry ID, latest input revision/hash, catalog/calculation version). Any mismatch or missing/current-capture failure -> {status:"stale",result_id:<opaque>,result:None,stale_reasons:["device_sizing_dependencies_changed"]}, no old numbers/dependencies. Otherwise {status:"current",result_id,dependencies,result}. Never resurrect older matching history. Values must be independently parsed, not aliases. Changing source or catalog version must suppress cached numeric output. Rejected previews must preserve it, accepted mask/notes/operator/input changes must invalidate it. Store must reject stale snapshot/input revision on race.

Tests: successful current roundtrip and no case bump; input replacement invalidation; notes/mask/source/catalog/calculation/geometry-result-id changes suppress results; rejected preview preservation; raced store refuses write; unsupported validation flags/bad binding/nonfinite/oversize data refused. Minimize fixture duplication. If the new read_in_transaction method is not yet present while you begin, write against its contract and continue other tests; parent is implementing it now. Run focused pytest and Ruff; report exact commands/count/gaps, no blanket clearance.
