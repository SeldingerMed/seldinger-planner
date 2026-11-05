# Historical device range API: technical verification

Internal engineering evidence. This read-only layer is not a completed device-sizing or clinical-compatibility workflow.

## Reconciled extraction

The extraction accurately identified the existing historical Pipeline rows, WEB target-only helper and missing dimensions. Two suggested shortcuts were rejected:

- `/api/cases/{id}/geometry/current` is not an existing producer route. The implementation reuses the coherent morphometry reader underlying `/api/cases/{id}/morphometry`, without duplicating source/mask/lineage selection.
- One operator-plane maximum sac height is not evidence of the minimum of independent height measurements. No such mapping is made. Similarly, one projected width is not an average of independent diameters, and neck-plane width is not longitudinal neck extent. Pipeline's existing helper adds its historical 6 mm margin after the longitudinal extent input; that input must not already include the same margin.

## Implemented artifact

- `planner/device_checks.py`: fresh independent historical catalog data, canonical catalog/rule SHA-256 version and explicitly partial per-case geometric comparisons.
- `planner/device_server.py`: GET `/api/device-catalog` and GET `/api/cases/{case_id}/device-checks`.
- `planner/geometry_server.py`: exposes the already-tested coherent reader closure for downstream composition.
- `planner/server.py`: composes device routes with that actual reader.

The catalog has 11 historical Pipeline diameter rows from the already source-verified 12/2018 label. Internal identifiers are not manufacturer SKUs. WEB has a source/target-rule description but no verified catalog rows here. The catalog version binds canonical data/rules, not a claimed checksum of source PDF bytes. It is not a current complete commercial catalog.

Case checks show actual operator-path-normal mask-section minimum/maximum Feret diameters, equivalent diameter and area, with extrema arithmetic comparisons to the historical 2–5 mm family interval. They do not choose an appropriate clinical sizing diameter or infer eligibility, compatibility, device selection or treatment suitability. Current outputs are `partial_inputs`, `validated_sizing=False`, `clinical_suitability_established=False`.

The missing fields remain explicit: longitudinal `neck_coverage_length`, `average_sac_diameter`, `smallest_sac_height`, and separately recorded `dome_diameter`. No nominal device targets are synthesized.

## Binding and invalidation

Each current report binds case/image/source/artifact versions, current geometry result ID and exact geometry dependencies, catalog version, and device-check calculation version. Every read consults the current geometry ledger; stale/not-computed geometry returns no case comparisons or dependent numbers. Nothing is independently materialized as a device-sizing result in this layer.

The handler freezes the complete geometry-envelope token before projection, rereads the same trusted reader and catalog afterward, and returns409 if either changed. Tests include in-place shared-object mutations, case/source/result/value changes and catalog revision changes. Current-result units, false validation flags, section method, finite positive numeric types and min/max ordering are checked. Unsupported selectors are refused; responses are no-store; provider failures are sanitized.

## Observed verification

- Vertical RED/GREEN observed for catalog creation, current-case projection, stale/no-result suppression, strict evidence validation, versioned catalog integrity, HTTP race/error handling and real app composition.
- Full base suite: 397 passed, 96 skipped. Ruff, Python formatting and git whitespace checks passed.
- Actual `TestClient(build_app(.runtime/workspace.sqlite3))` returned200 for both default composed endpoints using the installed public case and geometry. These actual responses were saved as frontend fixtures, not invented schemas.
- Verified and stopped task-owned backend PID72950. Restarted current code using `uv run python -m planner.server`, tracked process `proc_f3452f7ffcaa`, launcher PID92837.
- Live HTTP and browser-origin requests returned200 for catalog and case checks. Public case `IkEMF5YWYSm7LeodOXBSbQ`, artifact version6, geometry result `TB7cH69mFvVtkwKfO4_D3A`.
- Catalog version `c697cac424e72db7f60edc90e7c2a5c3547802fa89022cc1890527b48a8d21bf` matched across catalog and case responses.
- Both selected parent sections' extrema comparison was outside the historical interval; this is not a clinical exclusion.
- Legacy unknown-unit case `WzFtr9iVULfwb0B6HB2KGg` returned409 and no comparisons. A synthetic uninstalled source is rejected404 before reaching the unit gate; the test was corrected to reflect that actual ordering.

Receipts: `artifacts/device-range-integration/{live-catalog.json,live-case-checks.json,live-unknown-unit-refusal.json,browser-api-readback.json}`. Fixtures: `web/src/fixtures/{device-catalog-metadata.json,device-checks-current-metadata.json}`. No source image bytes, model weights or source PDFs were added to git.

## Still unfinished

The separate device-reference component and independent backend review were dispatched after actual producer fixtures existed. App UI integration and browser rendering are not established by these API checks. Complete source-bound input collection, actual sizing calculations with their required independent dimensions, materialized device-result persistence/invalidation, catheter/other compatibility scope, current commercial catalog coverage and clinical/anatomical validation remain separate work. Current follow-up code is local/unpublished; prior published CI does not certify it.
