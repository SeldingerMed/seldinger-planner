# Planning-core review reconciliation

Internal engineering review only. No clinical validation, current-device commercial-catalog completeness, product-integration clearance or merge approval is implied. Source is uncommitted on `feat/fresh-planning-workspace`, based on `c65273619544e7b9eb8da199cd6d3710b0ddc6a8`.

## Scope

Incoming patches: `planner/morphometry.py`, `planner/device_sizing.py` and their tests. Independent read-only review returned in `deleg_afe8059e`. Its inspected snapshot predates some parent fixes, so its line references and pass count are not an exact-current-revision clearance.

## Established findings and disposition

- **Plane-local convex hull:** confirmed and fixed. Section contours are projected into their actual plane basis before hull construction, including vertical planes. Parent regression observed the incorrect minimum diameter before the fix.
- **Minimum Feret direction:** retained the parent fix to edge-normal projections. The review's assertion that minimum extent along edge directions always equals minimum width is false. A triangulated prism with section vertices `(0,0),(4,0),(1,1)` gave 2.82842712474619 with the old tangent-direction code versus analytic minimum width 1.0. The RED/GREEN asymmetric-triangle regression proves this independently of the regular-polygon fixtures. Do not revert it based on the review's symmetry argument.
- **Centroid:** confirmed and fixed with polygon area moments, not vertex-density-weighted means. Trapezoid regression distinguishes these definitions. Plane coordinates are relative to the plane origin to avoid unnecessary large-offset cancellation.
- **Input cap:** parent separately proved that the original post-consumption triangle-count check did not bound streams. The cap now stops consuming at the first excess triangle, before downstream work.
- **Boolean centerline index:** reproduced as an accepted index and fixed with strict integer type validation. Observed failing regression precedes the fix.
- **Malformed versus missing sizing inputs:** reproduced 15 invalid-input variants returning `missing_inputs` instead of explicit rejection. Invalid finite/positive/type checks now propagate `DeviceSizingError`; absent/None values and missing/unknown units remain nonnumeric `missing_inputs`. Blank strings are invalid, not absent. Incoming tests that encoded the wrong behavior were corrected before the implementation, and failed as expected.

Focused reconciled suite: 54 passed. Combined base suite: 212 passed, five intentionally skipped opt-in ML tests. The five opt-in ML tests were independently enabled and passed in the isolated runtime before this validation-only patch. Ruff, formatting and diff checks pass.

## Retained limitations

- Absolute geometric tolerance/coordinate quantization is not generally scale-invariant. Very small or large source-coordinate scales need dedicated tolerance policy and validation before broader use. Explicit failure is not clinical validity.
- Sac dimensions use an operator-defined plane and positive-side mesh-vertex geometry, not a validated automatic anatomical neck definition.
- Parent sections are normal to a supplied centerline; automatic centerline extraction and anatomical adequacy remain separate tasks.
- Device outputs contain historical Pipeline rows and approximate WEB targets, not a complete current catalog, WEB manufacturer model IDs, catheter compatibility or clinical suitability determination.
- A WEB input can fail more than one family/target check. The current single status is not a comprehensive clinical exclusion list; no unsupported case yields a nominal target.
- Source-unknown units remain unknown and produce no millimeter sizing. Case/API/UI integration and actual revision-linked derived-result invalidation are unfinished.

No legacy source/assets were imported. The independent reviewer made no repository edits.
