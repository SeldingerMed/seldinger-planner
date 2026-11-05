# Calibrated source registry: contract reconciliation and backend slice

Internal implementation checkpoint. No real calibrated source has yet been exercised through this new API/worker path or the browser at this checkpoint. Existing reference data is unchanged; no clinical clearance is implied.

## Reconciled inspection

`deleg_86c81864` correctly identified that the existing reference store, worker and frontend are coupled to the old unknown-unit CMHA bundle. Its field-level proposal is not accepted verbatim:

- Actual prepared schema is `version:1`, not the old curated manifest schema. It contains `image.shape_xyz`, `image.dtype`, `image.spatial_units`, `image.affine_ras`, crop bounds and separate source provenance. There is no prepared `source_header`, slope/inter or explicit spacing field; spacing must be derived from the actual saved affine.
- `clinical_validation` and `application_installation` are **false** historical preparation facts. Turning them true to permit serving would fabricate evidence. Operational permission and source installation are separate from clinical validation.
- A calibrated image-only source must not be represented as a curated annotation bundle. Old `ReferenceStore`, its two meshes and `/api/reference*` endpoints stay intact. The new source has a separate metadata/volume route and no annotation/focus/transform fields.
- Requiring a user-uploaded copy instead of serving the approved local artifact would leave the requested app flow unfinished. The backend adds a fixed local volume endpoint, not arbitrary path/URL access.

## Implemented parent-owned backend slice

- `planner/source_registry.py`: chooses the fixed calibrated image SHA or the existing reference source from case identity; checks case units/dimensions and calibrated spacing against server-owned geometry. Known source ID/path comes from trusted configuration, never request input.
- `planner/server.py`: composes the registry and new `/api/image-sources/zenodo-case006-calibrated` metadata/volume and case-bound `/api/cases/{case_id}/image-source` routes. Calibrated source metadata is separate from `reference_annotation`. Agent source-revision checks include that image-only source.
- `planner/segmentation_server.py`: resolves the selected source at inference, post-inference, decision and mask fetch; sends only the server-selected opaque `source_id` in addition to existing identity fields. Case/image/revision and accepted-base checks remain.
- `planner/segmentation_worker.py`: resolves only the two installed source identities, with existing legacy-job default preserved. New source uses the separately pinned pure-Python provider; job paths are ignored. Native-mm declaration is checked, image SHA/revision are independently reverified, and new-source metadata does not claim a curated annotation or validated registration. Runtime/checkpoint/memory caps are unchanged.

Observed RED/GREEN: new registry selection/binding, API case→inference dispatch, fixed worker source resolution and source-context metadata. Synthetic API fixtures are explicitly not real image/model evidence.

## Observed checks and pending work

- 69 focused base reference/registry/API/worker/correction tests passed.
- 23 existing isolated-runtime worker/correction tests passed after the worker dispatch changes.
- Ruff lint/format passed on parent-owned changed files.
- No publication, service restart, actual new-source model execution or browser integration is claimed here.

Separate bounded child ownership:

- `deleg_40a4420f`: `planner/image_source.py` + `tests/test_image_source.py` only, per `docs/plans/calibrated-image-source-contract.md`. Parent must verify exact producer shape, hashes/flags and actual source load before reliance.
- `deleg_a358715e`: `web/src/calibratedSource.ts` + focused transport tests only, per `docs/plans/calibrated-source-frontend-contract.md`. Parent owns App/SegmentationPanel integration, producer-shape conformance, real backend/model path and browser verification.

The calibrated image-preparation artifact remains valid independently. Source delivery/inference integration, clinical morphometry, device catalog/sizing and real dependency invalidation remain unfinished.
