# C-arm views and projection geometry (fusion Step A)

Step A adds the geometry layer that later 2D/3D fusion work depends on. It does three things:

1. Admits the acquisition geometry of a projection angiography run as its own source kind.
2. Models a C-arm view in the patient frame of an admitted volume.
3. Plans working views on that volume: per-view foreshortening of a target path, field coverage, a low-foreshortening angle proposal and a simulated projection preview.

Nothing in Step A registers a volume to an acquired angiogram. No angiographic pixel is stored or displayed. A simulated projection is computed from the admitted volume only.

## Angle convention

The convention ID is `dicom_xa_patient_longitude_latitude_ras_v1`. It follows the patient-referenced positioner angles of the DICOM XA Positioner module (PS3.3 C.8.7.5.1.2):

- Primary angle: longitude of the detector about the patient's long axis. Zero is perpendicular to the chest, +90 is the patient's left (LAO), -90 is the patient's right (RAO). Range -180 to 180 degrees.
- Secondary angle: latitude of the detector. +90 is cranial, -90 is caudal. Range -90 to 90 degrees.
- At 0/0 the detector is anterior to the patient.
- Image axes at 0/0: image right is the patient's left, image up is cranial. The image frame is right-handed with `u x v` pointing from the isocenter to the detector.

The convention is declared from the standard. It has not been verified against any vendor system, table position, detector rotation or image flip. Step C must establish that per acquisition before any overlay claim.

## Planned views

A plan holds one isocenter, one target path of 2 to 128 points (at most 10 m long) and up to eight named views, all in the RAS millimeter frame of the verified source. A view is six numbers:

| Field | Bounds |
|---|---|
| `primary_deg` | -180 to 180 |
| `secondary_deg` | -90 to 90 |
| `source_detector_mm` | 300 to 2000 |
| `source_isocenter_mm` | 100 to 2000, and at least 1 mm short of the detector |
| `detector_width_mm`, `detector_height_mm` | 50 to 600 |

For every view the server derives:

- `foreshortening_percent`: `100 * (1 - projected length / true length)` of the target path, using the central-ray direction for every segment (`central_ray_parallel_approximation`). Perspective variation across the field is ignored.
- `magnification_at_isocenter`: `source_detector_mm / source_isocenter_mm`.
- `target_in_field`: whether every target point projects inside the detector under the full pinhole model.

Every target point must lie between the source and the detector plane of every view. A view that would put the source or the detector inside the target path is rejected, in the studio and at save.

`GET /api/cases/{case_id}/projection-plan` returns the saved plan or `not_confirmed`. `PUT` saves an operator-confirmed plan (`confirmed: true`) against the exact case version, source revision and prior plan revision. Saved plans are immutable; a later source or case change reports the plan as `stale` and withholds its values. The isocenter and target points must lie inside the admitted image grid.

The **C-arm views** studio builds the plan from the viewer crosshair or from the current saved reformat path. **Propose low-foreshortening angles** searches whole-degree views within 120 degrees primary and 45 degrees secondary, treats views within 0.5 percentage points of the minimum as tied, and returns the least angulated of them. It fills the editor only. It does not consider vessel overlap, table or gantry reach, or dose.

The Python geometry (`planner/carm_geometry.py`) and its browser mirror (`web/src/carmGeometry.ts`) are both checked against `web/src/__fixtures__/carm-geometry-vectors.json`. That fixture is derived independently with NumPy (Rodrigues rotations and a linear ray/plane solve) by `tests/ingest_runtime/test_carm_vectors_independent.py`, which also fails if the committed file drifts.

## Simulated projection

The preview integrates source intensity above an operator threshold along each ray from the source to a detector pixel, at 1 mm steps with trilinear sampling. It is a display aid for judging a view:

- It is computed in the browser from the verified volume bytes. Nothing is uploaded.
- Bone and calcium are not removed, and it is not a physical attenuation model.
- A nonfinite source sample stops the projection instead of being skipped.
- The target path and isocenter are drawn with the full pinhole projection.

## Projection-series geometry

Convert one projection XA instance, or the two cross-referenced instances of one biplane acquisition:

```sh
env -u PYTHONPATH -u PYTHONHOME .runtime/ingest-runtime/bin/python \
  -m planner.projection_ingest .runtime/installed-projections \
  /approved/synthetic-xa/plane-a.dcm /approved/synthetic-xa/plane-b.dcm \
  --source-id synthetic-biplane --scope synthetic
```

`--scope` records the operator's declared scope and grants no data-use permission. For clinical or partner material, establish the approved environment, approvals, rights, retention and privacy requirements before selecting any file.

A successful conversion writes only `SOURCE_ID/projection.json`. The manifest holds, per plane: positioner angles, source-to-detector and source-to-isocenter distances (see the note below), imager pixel spacing, matrix size, frame count, frame time, positioner motion, the burned-in-annotation flag, and the hash and size of the input file. It holds no pixel data, no patient or study identifiers and no free-text DICOM values. Classic XA and Enhanced XA are accepted. Compressed transfer syntaxes are accepted because pixel data is never decoded.

A plane is `calibrated` only when both angles, both distances and the imager pixel spacing are present and consistent and the positioner was static. Otherwise it is `uncalibrated` and lists what is missing. Biplane linkage is `cross_referenced` only when each instance references the other. One half of a biplane run converted alone keeps its `a` or `b` label with linkage `not_applicable`; the studio lists it as one plane of a biplane acquisition whose pairing is not verified.

Frame timing is Frame Time and Frame Time Vector as the header declares them, for both storage classes. Per-frame acquisition times in the Enhanced XA Frame Content functional group are not read in Step A, so an Enhanced XA plane without those two attributes records no timing.

Source-to-isocenter provenance differs by storage class, and `sop_class` records which applies. Enhanced XA (`enhanced_xa`) carries Distance Source to Isocenter. Classic XA (`xa`) has no isocenter attribute: its value is Distance Source to Patient (0018,1111), defined in PS3.3 C.8.7.5 as the distance from the source to the center of the field of view, which the standard notes is typically the isocenter distance on cardiovascular equipment. It equals the isocenter distance only for an isocentric acquisition, so magnification derived from a classic XA plane is approximate, and the studio says so when it lists one. Step C must not treat the two as interchangeable.

`GET /api/projection-series/{source_id}` serves the validated manifest read-only. In the studio, **Load run geometry** lists the planes and can copy a calibrated plane into the view editor as a starting view. That copy means "the same gantry angles in this volume's patient frame under the declared convention". It is not a registration.

## Brief export

The source-bound brief gains a scalar-only C-arm section: view names, angle labels, distances, detector size, foreshortening, magnification, field coverage, the plan ID and revision, and the method labels. It excludes the isocenter and target coordinates.

## Limits

- Not a clinical working-projection recommendation. Foreshortening is one input; overlap, reach and dose are not modelled.
- The angle convention is unverified against vendor systems.
- No registration, overlay, or comparison with an acquired angiogram exists yet. Those are Steps B to E.
- Rotational (dynamic) acquisitions are admitted as uncalibrated. Per-frame angles are not used.
- All tests use synthetic volumes and synthetic DICOM headers.

## Tests

```sh
env -u PYTHONPATH -u PYTHONHOME uv run pytest -q \
  tests/test_carm_geometry.py tests/test_projection_server.py tests/test_projection_source.py
env -u PYTHONPATH -u PYTHONHOME SELDINGER_RUN_INGEST_TESTS=1 \
  .runtime/ingest-runtime/bin/python -m pytest -q tests/ingest_runtime
cd web && npm test
```
