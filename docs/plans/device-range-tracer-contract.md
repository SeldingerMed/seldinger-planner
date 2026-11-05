# Historical device catalog and case-range tracer

Fresh implementation, public/synthetic metadata only. This layer is read-only and is not the completed sizing workflow. No old application code, models, image bytes, credential access, network model calls, clinical clearance, device selection or treatment ranking.

## Exact producer and boundaries

Use the existing coherent `GET /api/cases/{case_id}/morphometry` service, not the extraction helper's invented `/geometry/current` route. Expose its existing reader closure from `register_geometry_routes` for in-process composition; do not duplicate its source/mask/lineage logic.

The current sac height is a maximum perpendicular to one operator plane, NOT a minimum independent height. One sac width is NOT an average of independent diameters. A neck-plane Feret width is NOT the longitudinal neck span. The existing Pipeline `neck_coverage_length` input denotes longitudinal neck extent before the helper adds the historical 6 mm margin; do not add landing-zone allowance twice. Historical helper rows have internal IDs, not manufacturer SKUs. WEB has target rules but no verified catalog rows here.

## Pure layer: planner/device_checks.py

- `DEVICE_CHECKS_VERSION = "historical-label-range-checks-v1"`.
- `device_catalog()` returns fresh independent JSON with `catalog_version` (SHA-256 of canonical catalog/rule data, not a claimed PDF checksum), `version_basis="canonical_catalog_and_rule_data_sha256"`, `device_checks_version`, `clinical_suitability_established=False`, `validated_sizing=False`, `pipeline=pipeline_catalog()`, and `web={source,rows:[],catalog_status:"not_available",required_inputs:[average_sac_diameter,smallest_sac_height,dome_diameter]}`. Include existing numeric rule constants in versioned `rules`. Source revisions remain explicitly historical 12/2018; never call this a current complete commercial catalog.
- `case_device_checks(geometry_envelope, catalog)` returns envelope identity (`case_id,image_sha256,reference_revision,artifact_version`), catalog/version, geometry status, false clinical/sizing flags, missing dimensions and either `checks:null` (stale/not_computed) or a bounded partial result.
- Current result must have matching nested dependencies, mm units, false validation flags and the existing native-mask/operator-path section methods. Reject malformed/nonfinite/bool/nonpositive data; require max>=min. Use actual parent max/min/equivalent diameters and areas, clearly named, without choosing one as a clinical sizing diameter.
- Report per-parent min/max Feret-extrema comparisons to the historical 2–5 mm family interval, with basis `operator_path_normal_mask_feret_extrema`. Labels `within_historical_range` / `outside_historical_range` mean arithmetic comparisons only, NOT eligibility/compatibility or device selection. Do not call evaluate_pipeline without its missing longitudinal input.
- Exact missing dimension keys: `neck_coverage_length`, `average_sac_diameter`, `smallest_sac_height`, `dome_diameter`; status `missing` and source-faithful reasons. WEB catalog availability remains false. Never synthesize sizing targets.
- For current partial reports, dependencies include current geometry result ID, exact geometry dependencies, catalog_version and device_checks_version. No caller-supplied measures or paths.

## HTTP layer: planner/device_server.py

`register_device_routes(app, read_geometry, *, catalog_provider=device_catalog)`:
- GET `/api/device-catalog`: actual versioned historical catalog.
- GET `/api/cases/{case_id}/device-checks`: current case comparison, no request body or source/path selector. Reject unexpected query parameters. Cache-Control no-store.
- Capture a canonical token of the complete geometry envelope before projection, reread the same trusted geometry reader and catalog version afterward; reject case/source/result/catalog races with409. Preserve underlying 404/409 and sanitize invalid provider payload errors to503, no numbers.
- Return no cached device numbers. Stale geometry suppresses comparisons immediately on every read. This is not yet independently materialized sizing persistence.

## Verification

Strict vertical RED/GREEN: actual producer fixture (contours may be reduced only in test setup), catalog version/independence, partial current shape, honest missing inputs, stale/not_computed suppression, finite/bool/units/validation guards; HTTP exact default reader composition, race and unknown-source guards. Exercise real calibrated case via ASGI then actual live API/browser after restart of only the verified task-owned backend. Frontend follows actual recorded API fixture, checks both source/case versions and catalog version, hides old-scope numbers synchronously, and shows historical source links/internal IDs without clinical claims. No mutable-input or persistent sizing-completion claim in this layer.
