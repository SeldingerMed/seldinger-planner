# Territory contract fixtures

The JSON files were captured from the actual default FastAPI application using `tests/test_territory_workflow_server.py::configured` and its generated 32³ signed-short NIfTI source. No patient images, partner records or public anatomical cases are embedded here.

- `territory-tavr.json`: response to a successful TAVR PUT using `tests/test_territory_workflows.py::tavr_inputs`.
- `territory-native-source.json`: the actual case image-source metadata response for the generated installed source.
- `territory-path-workflows.json`: actual successful TAVR, coronary and aortic PUT responses from one fresh generated-source case, each read back by GET. Uses `tavr_inputs`, `coronary_inputs` and `aortic_inputs`; path coordinates are scaled by 0.1 and translated by [5,16,16] mm to fit the source, as in the actual all-mode API test. Supports index-preflight integration tests without invented calculation envelopes.

Case/result identifiers are random synthetic test identifiers, not credentials. Regenerating the fixtures can change those identifiers. The frontend tests derive their expected identity from each captured fixture rather than substituting an image hash for its manifest revision.

The separate browser receipt used a generated linear intensity ramp; that raster and its temporary database are not repository assets.
