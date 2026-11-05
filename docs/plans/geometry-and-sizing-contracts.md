# Geometry and sizing core contracts

These are fresh implementation contracts for two independent writers, not clinical validation or a permission to copy legacy code. Parent owns API/UI integration. Use TDD, stdlib only for these core modules, and synthetic fixtures clearly labeled as such. Keep actual publisher PDFs and all clinical/public image data out of git.

## Geometry writer scope

Only `planner/morphometry.py` and `tests/test_morphometry.py`.

Input mesh is a sequence of triangles, each three finite xyz points in the source's world coordinates. Planes and supplied centerlines are in the same frame. No assumed millimeters. Invalid/non-finite/degenerate input, ambiguous multiple contours, open contours and coplanar surface patches must fail explicitly rather than yielding a plausible diameter.

Expose:

```python
class MorphometryError(ValueError): ...


def section_metrics(triangles, origin, normal, *, spatial_units="unknown") -> dict: ...
def sac_metrics(triangles, neck_origin, neck_normal, *, spatial_units="unknown") -> dict: ...
def parent_section(triangles, centerline, index, *, spatial_units="unknown") -> dict: ...
```

`section_metrics`: intersect triangles with plane; deduplicate and join segments into exactly one closed contour. Return `contour_world`, `centroid_world`, `area`, `max_diameter`, `min_diameter`, `equivalent_diameter`, `spatial_units`, `method="plane_mesh_intersection"`, `validated_morphometry=False`. Numeric distances are in declared source coordinates, not always mm. Area is squared source units. Compute max/min planar Feret diameter from the contour's convex hull, not axis-aligned extents. Equivalent diameter is sqrt(4*area/pi). No arbitrarily choosing the largest of disconnected loops. Limit triangles <=50000 and unique contour/vertex points <=4096 before quadratic work.

`sac_metrics`: operator-defined neck plane and positive-normal dome side. Return positive-side maximum perpendicular `height`, maximum planar projection diameter `width`, `spatial_units`, `method="operator_plane_sac_geometry"`, `validated_morphometry=False`. State this exact definition in docstrings. It is not an automatically validated anatomical neck definition. Reject no positive-side sac geometry.

`parent_section`: normal from supplied centerline's neighboring points at an interior index; delegate section measurement at that point. Return section fields plus `method="supplied_centerline_normal_section"`. Reject endpoint/zero tangent and non-finite centerline. The centerline's extraction/clinical adequacy is a separate acceptance criterion.

Synthetic validation: polygonal cylinder analytic area/diameters with discretization tolerance; oblique/translated/axis-reflected equivalents; sac geometry with analytically known plane height/projection width; invalid normal/NaN, open and multiple contours, and bounds. Generate meshes in tests, no downloads. Run `uv run pytest tests/test_morphometry.py -q --basetemp artifacts/pytest-morphometry` and Ruff checks before reporting.

## Sizing writer scope

Only `planner/device_sizing.py` and `tests/test_device_sizing.py`. Do not implement UI/API or modify any other files.

Use immutable dataclasses/typed records as appropriate. Expose `pipeline_catalog() -> dict`, `evaluate_pipeline(measurements:dict) -> dict`, and `web_sizing_targets(measurements:dict) -> dict`.

All output must include `clinical_suitability_established=False`, source references and `status` (`missing_inputs`, `out_of_family_range`, or `geometric_checks_only`). Missing/unknown/non-mm units yield no numeric sizing targets or device comparisons. Reject non-finite/nonpositive numeric inputs; do not silently coerce strings/bools. A geometric pass never means clinical compatibility or treatment suitability.

### Verified Pipeline historical catalog

Source: https://www.accessdata.fda.gov/cdrh_docs/pdf10/P100018S015C.pdf, revision `71012-001 Rev. 5 (12/2018)`, Table 1, Directions for Use 2-3, Q&A on differing proximal/distal diameters. Parent directly retrieved the source.

Labeled diameter rows: 2.50,2.75,3.00,3.25,3.50,3.75,4.00,4.25,4.50,4.75,5.00 mm. Self-expanded diameter is labeled diameter+0.25. For 2.50/2.75, labeled lengths are 10,12,14,16,18,20 mm. For every diameter >=3.00, lengths additionally include 25,30,35 mm. Use Decimal/integer steps to construct exact rows. Generate INTERNAL IDs explicitly, not invented manufacturer SKUs. Include historical-source scope; do not claim this is a current complete commercial catalog.

Source instructions: labeled diameter approximates target vessel; fully expanded diameter equivalent to largest target vessel; if proximal/distal differ match the larger vessel. Labeled length at least neck length+6 mm. Family parent-vessel range in the specified small/medium indication is 2.0–5.0 mm. Do not invent a numeric tolerance for approximates or silently conflate labeled/self-expanded diameter.

`evaluate_pipeline` inputs: `spatial_units`, `proximal_parent`, `distal_parent`, `neck_coverage_length` (longitudinal coverage length, not automatically neck-plane Feret width). Return largest measured parent, minimum labeled coverage length and per-row explicit nominal differences/length-check outcome; mark diameter equivalence unresolved unless exact, without converting that into clinical eligibility. Do not recommend/rank treatments or auto-select a device. Missing antiplatelet/anatomy/location/other clinical information remains outside geometric checks.

### Verified WEB target calculation only

Source: https://www.accessdata.fda.gov/cdrh_docs/pdf17/P170032C.pdf, revision `LBA0040, Rev Q 12/2018`, sizing instructions. Parent is verifying full table/model IDs separately; do not invent any WEB catalog rows.

Inputs: `spatial_units`, `average_sac_diameter`, `smallest_sac_height`, and separately recorded `dome_diameter`. Return approximate nominal target diameter=average diameter+1 mm; approximate nominal height=smallest height-1 mm. Mark `approximate=True` and not a recommendation. Do not silently equate average sac diameter with the separately defined dome-diameter field. If height target <=0 or the recorded dome diameter is outside the historical 3–10 mm family range, return explicit unsupported/out-of-family status, not a device. Clinical location, neck criteria, rupture/previous treatment and catheter compatibility are not inferred by this calculation.

Tests: exact Pipeline table boundaries and two length groups; labeled vs expanded distinction; missing/unknown units no numeric outputs; stale/invalid/bool/NaN/negative values; neck coverage+6 boundary; proximal/distal maximum; correct WEB arithmetic; no silent clinical clearance. Run `uv run pytest tests/test_device_sizing.py -q --basetemp artifacts/pytest-device-sizing` and Ruff checks. Both writers must return executed RED/GREEN evidence and limitations; no commits.
