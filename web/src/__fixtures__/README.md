# Territory contract fixtures

Both JSON files were captured from the actual default FastAPI application using `tests/test_territory_workflow_server.py::configured` and its generated 32³ signed-short NIfTI source. No patient images, partner records or public anatomical cases are embedded here.

- `territory-tavr.json`: response to a successful TAVR PUT using `tests/test_territory_workflows.py::tavr_inputs`.
- `territory-native-source.json`: the actual case image-source metadata response for the generated installed source.

Case/result identifiers are random synthetic test identifiers, not credentials. Regenerating the fixtures can change those identifiers. The frontend tests derive their expected identity from each captured fixture rather than substituting an image hash for its manifest revision.

The separate browser receipt used a generated linear intensity ramp; that raster and its temporary database are not repository assets.
