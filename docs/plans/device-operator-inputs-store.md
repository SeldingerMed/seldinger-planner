# Operator-reported device measurements: persistence tracer

Fresh code in this repository only. This is a software calculation workflow, not clinical validation or treatment/device selection. Current CTA geometry does NOT supply the independent scalar dimensions required by the historical rules. Never map neck-plane width to longitudinal coverage, sac width to average diameter, maximum height to minimum independent height, or choose a parent sizing diameter from Feret extrema.

## Bounded input-store layer

Implement only `planner/device_inputs_state.py` and `tests/test_device_inputs_state.py`. Parent owns API, arithmetic adapter and frontend. No pixels, models, .env, installs, network, commit or changes to existing files. Follow strict vertical RED/GREEN and run focused pytest plus Ruff. Finish a compiled input-store tracer, not materialized calculation or a UI.

`DEVICE_INPUTS_VERSION = "operator-reported-device-inputs-v1"`.
`DeviceInputsConflict(ValueError)` for revision/scope conflicts. Malformed values are ValueError.

`DeviceInputsLedger(db_path)` composes the existing `GeometryLedger`; use `GeometryLedger._capture(conn, case_id, source_revision)` inside the SAME SQLite transaction to avoid duplicating source/mask/lineage logic. Existing `workspace._connect` is the connection primitive. Tables are separate from geometry and case state. Preserve immutable input history and obtain the latest by rowid; use opaque `secrets.token_urlsafe(16)` input revisions, not an independently scheduled job.

`save_inputs(case_id, geometry_dependencies, measurements, provenance, expected_revision)`:
- Six exact allowed measurement keys: `proximal_parent`, `distal_parent`, `neck_coverage_length`, `average_sac_diameter`, `smallest_sac_height`, `dome_diameter`. Each may be None/missing (normalize to all six keys), or a non-bool int/float, finite, >0 and <=100 mm. The 100mm limit is a prototype software-input cap, not clinical eligibility. Reject unknown keys, strings, booleans, arbitrary-size integers before unsafe float conversion and nonfinite values. No automatic fallback to current geometry dimensions.
- Exact provenance keys `{kind:"operator_reported", note:<nonblank plain string <=512 chars>}`. This records unvalidated operator-reported values, never a verified measurement, clinician identity, annotation, external URL or image-derived calculation. Do not invent evidence.
- Canonical JSON/hash includes inputs version, supplied geometry snapshot, normalized measurements and provenance; allow_nan=False. Bound serialized scope to <=16KiB and reject malformed scope data. Source snapshot is trusted only after exact comparison against `_capture` in BEGIN IMMEDIATE.
- Before inserting, compare the latest stored input revision with `expected_revision` (None only if no record yet), and compare `_capture(...)` exactly with supplied geometry dependencies, including case version, image, source, masks and geometry operator input hash. Any mismatch -> DeviceInputsConflict and no write.
- Insert immutable record containing case, revision, geometry snapshot, measurements, provenance, inputs_sha256, inputs_version. Return current input envelope described below.
- Do NOT increment case artifact_version or mutate geometry results. Independent input revision avoids self-invalidating current geometry; the calculation result will separately bind this input revision.

`inputs(case_id, source_revision)`:
- One read transaction. Verify case existence. Return `{status:"not_saved",input_revision:None,inputs_sha256:None,measurements:None,provenance:None,inputs_version:DEVICE_INPUTS_VERSION}` if no record.
- If latest input scope differs from `_capture(...)`, or capture fails due to changed masks/units/operator inputs, return `{status:"stale",input_revision:<last opaque revision>,inputs_sha256:None,measurements:None,provenance:None,inputs_version:...}`. Do NOT expose old numeric values or provenance on stale reads, and do not resurrect an older matching history row.
- Otherwise `{status:"current",input_revision,inputs_sha256,geometry_dependencies,measurements,provenance,inputs_version}`. Return independent parsed JSON, not mutable internal aliases. Input hash is data coherence only, not clinical authenticity.

Tests use real temporary SQLite and clearly SYNTHETIC fixture metadata, e.g. `test_geometry_state.materialized(tmp_path)` supplies accepted masks/operator inputs/case/snapshot. Do not touch the live .runtime DB. Test current save/reopen/hash/independence/no case-version bump, optimistic input revision conflict, wrong/stale case snapshot refuses save, notes/mask/source/unit/operator changes suppress numbers, malformed numbers/provenance, immutable history and no resurrection. Keep work <=4 minutes, <=16 tool calls. Parent will exercise API on actual public CTA, retaining missing real dimensions rather than supplying synthetic numbers to a real case.
