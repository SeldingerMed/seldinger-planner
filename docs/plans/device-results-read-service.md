# Sizing result GET/read-service tracer

Own ONLY `planner/device_results_read.py` and `tests/test_device_results_read.py`. Parent owns POST/calculation, App, all existing files. Strict vertical RED/GREEN, <=4min <=14tools, no pixels/models/.env/network/install/live DB/commit. Compile one GET tracer, not a wider feature.

`register_device_result_read_routes(app, inputs, results, read_geometry, *, catalog_provider=device_catalog)` registers GET `/api/cases/{case_id}/device-sizing` and returns its pure in-process `read_report(case_id)` dict-producing closure for parent POST composition. HTTP wrapper returns JSONResponse Cache-Control:no-store. Reject all query selectors422. Preserve trusted geometry HTTP404/409, with no-store. Sanitize provider/SQLite/type/data errors503. Changed snapshots409, no numbers.

Use actual existing services, no invented routes or source selectors:
- geometry is the coherent register_geometry_routes reader; validates confirmed-mm installed source.
- `case_device_checks(frozen_geometry,frozen_catalog)` validates actual current/stale geometry shape, false clinical flags, source/frame/methods; `validate_catalog` for catalog, canonical `encoded` and encode→parse snapshots (not aliases).
- `inputs.inputs(case_id,reference_revision)` is source/mask/case-bound and hash-checked. Current input record geometry_dependencies must equal the current geometry capture when geometry current. Stale/not_saved inputs never expose numeric values.
- `results.current(case_id,reference_revision,catalog_version,DEVICE_SIZING_CALCULATION_VERSION)` is the new materialized state, parent repaired/tested27 focused tests. No store writes here.

Return exact report shape:
```
{case_id,image_sha256,reference_revision,artifact_version,
 geometry_status,geometry_result_id:<current id or null>,
 geometry_dependencies:<current dependencies or null>,
 catalog_version,calculation_version:DEVICE_SIZING_CALCULATION_VERSION,
 inputs:<whole validated input-store envelope>,
 current:<result-store current/stale/not_computed envelope>,
 clinical_suitability_established:false,validated_sizing:false}
```
Current result numeric data may be returned ONLY if geometry and inputs both current and result.dependencies match ALL report context: geometry dependencies/id, input revision/hash, catalog version and calculation version. Otherwise reject409/503, never mix envelopes. Check result false flags and case_bound_calculation marker too (store already does, but provider composition must fail closed).

Before return, reread geometry, catalog and input envelope; compare canonical tokens frozen BEFORE projection to catch changed case/source/result/input/catalog. Result changes alone do not change the source/input context and need not reject an otherwise coherent snapshot. No assertion against future mutations.

Tests real temporary synthetic SQLite, no real-case numbers. Reuse `test_device_inputs_server.setup_api(tmp_path)` (returns client,case,inputs,snapshot,workspace,read_geometry), create DeviceResultsLedger on inputs.db_path, save SYNTHETIC scalar reports if needed, and obtain/store full calculation with explicit dependencies via calculate_reported_sizing(...), binding_status="case_bound_calculation". It is fine to begin with not_saved/not_computed. Test actual GET no-store/shape, current full roundtrip, stale suppression after input replacement/notes, race409, query rejection and sanitized provider error. Run focused pytest+Ruff. Return actual count/gaps. If the layer expands beyond budget, finish the one compiled route with fewer tests rather than returning an uncompiled broad patch.
