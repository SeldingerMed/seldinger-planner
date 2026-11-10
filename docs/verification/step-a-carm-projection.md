# Fusion Step A verification

## Delivered surface

Step A adds a projection-series geometry source, a C-arm view model in the patient frame of an admitted volume, saved working views with per-view foreshortening and field coverage, a low-foreshortening angle proposal and a simulated projection preview. Operator instructions, the angle convention and the limits are in [C-arm views and projection geometry](../carm-projection.md).

Every input used here was generated synthetic data: a 128 x 128 x 96 phantom at 0.8 mm and synthetic XA headers. No patient or partner source, acquired angiogram, model invocation, external data transfer or deployment was used. Nothing here is a registration result or a clinical accuracy claim.

## Geometry known values

The Python geometry and its browser mirror are both checked against `web/src/__fixtures__/carm-geometry-vectors.json`. `tests/ingest_runtime/test_carm_vectors_independent.py` derives those vectors separately with NumPy (Rodrigues rotations and a linear ray/plane solve) and fails if the committed file drifts. The cases cover AP, both laterals, cranial and caudal 90, combined oblique views and a posterior detector.

The declared convention matches the patient-referenced positioner angles of DICOM PS3.3 C.8.7.5.1.2: zero perpendicular to the chest, primary +90 at the patient's left (LAO), secondary +90 cranial. It was not checked against any vendor system.

## Independent projection check

The real converter produced the phantom from 96 synthetic CT slices, and the installed-source reader admitted it. A separate NumPy implementation, with the camera derived from the convention text and its own trilinear sampler, was compared with the browser projector's output for that exact volume at isocenter [0.4, -3.2, -11.5] mm, threshold 300 and 1 mm steps:

| View | Image | Rays through volume | Samples | Peak ray sum | Differing display pixels |
|---|---|---|---|---|---|
| LAO 30 / CRA 20, 1200/750 mm, 200 x 150 mm | 160 x 120 | 17331 = 17331 | 1181159 = 1181159 | 17680.269509 = 17680.269509 | 0 of 19200 |
| RAO 83 / CAU 35, 1000/700 mm, 180 x 180 mm | 96 x 96 | 7302 = 7302 | 460275 = 460275 | 16410.492969 = 16410.492969 | 0 of 9216 |

This establishes that the projector implements its stated ray sum under the declared convention on a synthetic volume. It is not evidence about real angiographic appearance.

## Actual application tracer

The default API and the actual App were run against a scratch database with the phantom and a synthetic cross-referenced biplane geometry bundle (planes at 0/0 and LAO 90/0).

- Three crosshair picks on the phantom vessel gave an L-shaped target of 38.2 mm: an 18.2 mm cranial leg and a 19.9 mm anterior leg.
- AP reported 50.9% foreshortening, which is the anterior leg seen end-on. A left lateral reported 0.0%. The proposal returned RAO 83 / 0 at 0.4%, inside the documented 0.5 point tie band, and changed the editor only.
- The simulated projection painted real canvas pixels and the overlay matched the expected image orientation: at RAO 83 the cranial leg is vertical and the anterior leg runs toward image right.
- **Load run geometry** listed both planes as calibrated. Copying plane B filled the editor with LAO 90, 1200/750 mm and a 153.6 mm field (512 pixels at 0.3 mm).
- Saving three views produced plan revision 1. Source-replacement actions were disabled while the draft was unsaved and returned after the save. Reopening the same volume in a fresh page load restored the three saved views.
- The local brief carried the plan ID, revision, input hash, convention, method labels and per-view scalars, and no isocenter or target coordinates.

## Failure behaviour covered by tests

- Converter: a CT class, a file-meta and dataset class conflict, a non-XA modality, big-endian syntax, an oversize frame count, a missing study, non-DICOM bytes, symlinked inputs or output roots and an existing destination reject without leaving a bundle or staging directory. Sentinel patient and institution values and local paths do not reach the manifest, stdout or stderr.
- Calibration: a missing angle, distance or pixel spacing, inconsistent distances, or a dynamic positioner yields `uncalibrated` with the missing terms listed. A biplane pair without mutual references, with mismatched studies or with inconsistent plane labels is rejected.
- Plan routes: unconfirmed, malformed, out-of-bounds and out-of-grid inputs reject before any write. A stale case version, source revision or plan revision returns 409. A tampered ledger row makes the plan read and the brief fail with 503.
- Browser: a 409, 5xx or mismatched acknowledgement locks the draft until an explicit reload; a 422 keeps it editable. A nonfinite source sample stops the projection instead of painting a partial image. Stale or contradictory plan envelopes and forged derived values are rejected by the client parser.

Mutation checks in a throwaway copy confirmed that the relevant tests fail when each of these is removed: the primary or secondary angle sign in either implementation, the static-positioner calibration term, the grid containment check, the nonfinite sample guard, the client foreshortening recomputation, the ambiguous-save lock, and the cross-studio dirty locks in the App.

## Observed checks

- `uv run ruff check .` and `uv run ruff format --check .`: clean.
- `uv run pytest -q`: 1069 passed, 125 skipped (optional runtimes).
- `tests/ingest_runtime` in the locked ingest runtime: 60 passed.
- `npm test`: 74 files, 623 tests passed. `npm run build`: passed. `npm audit --omit=dev --audit-level=high`: 0 vulnerabilities.
