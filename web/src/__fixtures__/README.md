# Territory contract fixtures

The JSON files were captured from the actual default FastAPI application using `tests/test_territory_workflow_server.py::configured` and its generated 32³ signed-short NIfTI source. No patient images, partner records or public anatomical cases are embedded here.

- `territory-tavr.json`: response to a successful TAVR PUT using `tests/test_territory_workflows.py::tavr_inputs`.
- `territory-native-source.json`: the actual case image-source metadata response for the generated installed source.
- `territory-path-workflows.json`: actual successful TAVR, coronary and aortic PUT responses from one fresh generated-source case, each read back by GET. Uses `tavr_inputs`, `coronary_inputs` and `aortic_inputs`; path coordinates are scaled by 0.1 and translated by [5,16,16] mm to fit the source, as in the actual all-mode API test. Supports index-preflight integration tests without invented calculation envelopes.

- `step-a-projection-plans.json`: actual `not_confirmed`, `current` and `stale` responses of the default application's C-arm projection-plan route for one generated-source case. The current plan holds three views over a 10 mm L-shaped target; the stale response followed a notes edit that advanced the case version.
- `step-a-projection-series.json`: actual `GET /api/projection-series/{source_id}` responses for two bundles written by the real `planner.projection_ingest` converter from synthetic XA headers: a cross-referenced biplane pair and an uncalibrated rotational run.
- `carm-geometry-vectors.json`: known C-arm frames, projections and foreshortening values. Derived with NumPy by `tests/ingest_runtime/test_carm_vectors_independent.py` (`--write` regenerates it), independently of the Python and TypeScript implementations that are both tested against it.

Case/result identifiers are random synthetic test identifiers, not credentials. Regenerating the fixtures can change those identifiers. The frontend tests derive their expected identity from each captured fixture rather than substituting an image hash for its manifest revision.

The separate browser receipt used a generated linear intensity ramp; that raster and its temporary database are not repository assets.
