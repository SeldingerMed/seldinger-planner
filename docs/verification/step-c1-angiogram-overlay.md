# Fusion Step C1 verification

Step C1 adds bounded pixel-frame admission, a 2D-to-3D registration proposal engine, an overlay studio and an immutable operator-confirmed record. The behavior is described in [Angiogram overlay and 2D-to-3D registration proposal](../angiogram-overlay.md). This note records what was checked and what each check does and does not show.

Evidence classes used below: unit evidence on synthetic data, a synthetic known-pose gate, mutation checks of the new guards, and one smoke test on a public frame. Nothing here is a validation study, and no registration accuracy on patient data is claimed.

## Delivered surface

- `planner/frame_source.py`, `planner/frame_ingest.py`: the frame bundle contract, the installed store and the local admission command.
- `planner/projection_registration.py` and the frame and registration routes in `planner/projection_server.py`.
- `web/src/distanceTransform.ts`, `maskPoints.ts`, `vesselness2d.ts`, `projectionRegistration.ts`, `projectionOverlayJob.ts`, `projectionFrames.ts`, `ProjectionOverlayStudio.tsx`.
- `scripts/extract_angio_frames.py`: frame extraction outside the app, with a pinned ffmpeg install when none is on PATH.

Not delivered, and left for Step C2: the vessel-presence report, joint refinement across two planes, the brief section, and any evaluation against data with a known pose.

## Acceptance criteria and where each is checked

| Criterion | Check |
| --- | --- |
| At most two planes, eight frames per plane, 64 to 1024 pixels per side, 8-bit grayscale, each frame bound by SHA-256 | `tests/test_frame_source.py`, `tests/ingest_runtime/test_frame_ingest.py` |
| DICOM XA admitted without redaction only when it declares no burned-in annotation; every other plane needs a recorded crop or redaction and an operator attestation | `test_dicom_burned_in_annotation_needs_attested_redaction`, `test_png_requests_are_rejected_without_installing` |
| No source metadata retained; publication is staged, read back and never replaces an existing bundle | `test_dicom_frames_keep_calibrated_geometry_and_no_metadata`, `test_a_published_bundle_that_fails_the_installed_reader_is_withdrawn`, `test_an_occupied_destination_is_never_replaced` |
| The browser draws a frame only after its digest matches the manifest, and no pixel enters a write request | `web/src/projectionFrames.test.ts`, `web/src/ProjectionOverlayStudio.test.tsx` |
| Projection of registered points agrees with an independent derivation | `tests/ingest_runtime/test_registration_vectors_independent.py` and the fixture it writes |
| Synthetic known-pose gate: from about 10 mm and 10 degrees off, under 1 mm mean projected distance and under 1 degree in-plane | `web/src/projectionRegistration.test.ts`, table below |
| A proposal is saved only after the operator reviews and confirms it, is immutable, and always reads as not validated | `tests/test_projection_registration_server.py`, `web/src/ProjectionOverlayStudio.test.tsx` |
| Missing ffmpeg is downloaded, checked against a pinned SHA-256 and size, and installed locally | `tests/test_extract_angio_frames.py`, real install below |

## Synthetic known-pose gate

A tube phantom is rendered to a frame at a known pose, and the engine starts from the unmoved volume. The gate is on what one plane can determine: mean projected distance of the 3D points from their true positions on the detector, and the in-plane turn. Depth and the two out-of-plane turns are reported, not gated, because one plane sees depth only as a small change of magnification.

Measured on 2026-11-11 with the committed test file:

| Case | Projected error (mm) | In-plane error (deg) | Rotation error (deg) | Depth error (mm) | Mean distance, start to end (mm) | Evaluations |
| --- | --- | --- | --- | --- | --- | --- |
| AP, turn about the viewing axis | 0.12 | 0.00 | 0.3 | 0.3 | 5.33 to 0.34 | 3915 |
| AP, turn about the image-up axis | 0.55 | 0.81 | 5.1 | 1.6 | 6.80 to 0.55 | 4213 |
| AP, mixed | 0.20 | 0.02 | 0.5 | 7.5 | 5.78 to 0.36 | 5023 |
| AP, turn about image-right and depth | 0.24 | 0.22 | 3.3 | -9.3 | 4.69 to 0.38 | 4308 |
| Lateral | 0.76 | 0.41 | 7.7 | -3.8 | 5.32 to 0.71 | 4070 |
| LAO 30 CRA 20 | 0.10 | 0.10 | 0.5 | 1.7 | 6.65 to 0.32 | 3644 |
| RAO 40 CAU 25 | 0.20 | 0.09 | 1.0 | 6.5 | 3.84 to 0.33 | 4135 |
| Bright vessels | 0.20 | 0.02 | 0.5 | 7.5 | 5.78 to 0.36 | 5023 |
| Heavy noise | 0.21 | 0.37 | 1.2 | 7.5 | 5.77 to 0.38 | 5029 |
| 0.5 mm mask, 1024 pixel frame | 0.15 | 0.12 | 0.8 | 6.5 | 5.03 to 0.18 | 3547 |
| 14 mm and 14 degrees off | 0.36 | 0.11 | 1.2 | 12.5 | 6.31 to 0.48 | 5880 |

All eleven cases pass the gate. The rotation and depth columns show the single-plane ambiguity directly: a full 3D rotation error of up to 7.7 degrees and a depth error of up to 12.5 mm coexist with sub-millimeter agreement on the detector. A phantom with clean tubes and a matching vessel set is far easier than a clinical frame, so this table establishes the stated synthetic conformance checks, not how the method performs on patients.

## Independent fixture

`tests/ingest_runtime/test_registration_vectors_independent.py` derives detector pixel positions for registered points with NumPy only: a Rodrigues rigid matrix, the view frame built by rotating the 0/0 frame, and a linear ray and plane solve. It shares no code with the TypeScript engine. Its output is `web/src/__fixtures__/registration-projection-vectors.json`, and `projectionRegistration.test.ts` pins `projectRegistered` to it. The test also fails if the fixture on disk differs from a fresh derivation.

## Mutation checks

The original mutation pass, completed before review fixes at `0731068`, changes one guard in a throwaway copy of the tree, runs the tests that cover the file and is then restored. A mutant that the tests still pass is a survivor. The unmodified copy was run first and after the last mutant, and passed both times.

| Set | Mutants | Killed, first pass | Killed, final | Left |
| --- | --- | --- | --- | --- |
| Python guards (admission, store, ledger, routes, extraction helper) | 53 | 34 of 51 | 53 | 0 |
| TypeScript guards (frames, engine, mask points, 2D target, distance transform, job, studio) | 53 | 41 | 51 | 2 |

The first pass left 17 Python and 12 TypeScript survivors. Most Python survivors were guards whose rejection a later, more general check also produced, so the tests could not tell which guard had refused. The rejection tests now assert each guard's own message. The rest were untested cases, now covered: compressed transfer syntaxes, path traversal, byte bounds, an occupied destination, the read-back of a published bundle, the scale and score bounds, a changed case identity, an oversized download, a directory given as the video, the ffmpeg metadata flags, a frame whose bytes match their digest but do not fill the frame, a cropped DICOM plane carrying geometry, the minimum point count, slice-by-slice yielding of the search, and the studio's saved-overlay bindings, busy lock, review tick and caption. Two Python guards were added after the first pass (an attested plane with no recorded crop or redaction, and a PNG plane with no crop), which is why the Python set grew from 51 to 53.

Two TypeScript mutants remain and are recorded as equivalent, not killed:

- `distanceTransform.ts`, `s > z[k]` changed to `s >= z[k]`: this differs only when a new parabola meets the envelope exactly at an existing breakpoint. It then keeps a zero-width interval whose parabola has the same value at that point, so the output is unchanged.
- `ProjectionOverlayStudio.tsx`, the `!reviewed` test inside `save()`: the save button is disabled until the review box is ticked, and that button is the only caller, so the inner test cannot be reached. The button's own gate is tested, and the server separately refuses a record that is not confirmed.

Two TypeScript mutants in the distance transform were killed by the 400 s timeout, not by an assertion: with the buffer sized wrongly or the first breakpoint inverted, the transform does not terminate.

### Review-fix mutation checks

After review, 31 additional single-site mutants were exercised in throwaway copies. Thirty were killed by assertions; none required a timeout. These cover DICOM odd-length padding, anticipated extraction-command failures, ancestor replacement during an installed read, fitted-field distance and match units, frame-edge inclusion, workspace/input locks during computation, captured request-owner cleanup, proposal-bound review confirmation, hidden-overlay accessibility text, closed response schemas and bindings, finite result scalars, rectangle/redaction limits, and yielding during a large mask scan. All baseline and restored-copy runs passed.

The one survivor removes the extra check that a projected point's y coordinate is finite before drawing. `projectRegistered` emits either two finite coordinates or two NaNs, so the existing x check already excludes the same points. The extra y check is defensive, not an independently exercised integrity boundary.

The final fitted-match regression uses a noisy 150-pixel phantom and independently interpolates the 2D distance map at the returned projected points in the fitted view. It counts 0.959349593495935 of points within the physical 2 mm threshold. Removing the scale conversion reports 0.967479674796748 instead and fails the test. This is a synthetic units check, not an accuracy estimate.

### Independent review dispositions

The backend ancestor-swap finding was reproduced with matching synthetic manifests outside the store and repaired by opening ancestry through held directory descriptors. Interrupted admission remains fail-closed and documented; cached local ffmpeg executables and PATH remain within the operator's local trust boundary. A later evidence removal cannot be prevented atomically across the filesystem and ledger; reads recheck the retained identities and report unavailable evidence.

The studio now holds an editing lock during sliced computation, releases captured request owners on identity change/unmount, and binds the review tick to the exact displayed outcome. Parsers reject unknown owned DTO fields, contradictory bindings and nonfinite display scalars. A synchronous binary-mask scan now yields between bounded chunks. The alleged NMS row-wrap defect was declined: its loop visits only x=1 through width-2 and y=1 through height-2, and its neighbor offsets are at most one pixel, so neither neighbor can wrap a row. The alleged live-input save mismatch was also declined: the displayed proposal is already gated by an exact input scope and is dropped when those inputs change.

## ffmpeg install

With ffmpeg hidden from PATH, `ensure_ffmpeg` downloaded the pinned `imageio-ffmpeg` 0.8.1 wheel for this machine, matched its SHA-256 and size, installed the binary into a scratch directory, ran `-version` and reused the installed copy on the second call. The five pinned wheel names, digests and sizes (macOS arm64 and x86_64, Linux x86_64 and aarch64, Windows AMD64) matched the PyPI release record on 2026-11-11. The wheel packages a third-party static ffmpeg build under that build's own license. The repository contains neither the wheel nor the binary.

The helper passes `-map_metadata -1`, `-map_chapters -1` and the bit-exact flags on every call, and a test asserts the request itself. On the ffmpeg build used here, a container title did not reach the PNG with or without those flags, so the byte check alone would not have detected their removal.

## Smoke test on one public frame

This is a smoke test. It shows that the path from a real video frame to a saved, reloaded overlay runs. It is not evidence of registration accuracy, and the overlay it produced is not a credible registration (see the finding below).

Source: TAIR clinical data, version 1.0 (Kitware), CC BY 4.0, case 00028. Nothing from the dataset, and nothing derived from it, is in the repository. The paired subset was recomputed from `manifest.csv`: 495 patients, 69 with both scans and fluoroscopy, 52 of those biplane.

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `manifest.csv` | 16,565 | `a2e23f443ac180c3d42ed7fec8a07bbc24fb60ff7daf47ef2b99b9ed8955b4f2` |
| `00028/FLUORO/A/A1_t00_masked.mp4` | 5,099,113 | `b1824c76e6d4e9b4fac44c4e876be6d1731413f3dd6e660ed1c38659fb3877e5` |
| `00028/SCANS/CTA-H_defaced.nii.gz` | 18,935,124 | `8fb9f845372e3cc0b37a2401c048533931c0422bdd9ea9f997bb7461ad83b12e` |
| Frame 1700 as extracted (PNG) | | `45de4a5b53d3c96d3e315278589474b5af377812824087a3349f508b5ccc61bf` |
| Frame 1700 as admitted (raw gray) | 182,928 | `9dde80fdc29be95d8a496179bacd1fb0bb36ea71a9f6834a100f34be07d16e93` |
| Derived CTA source | | `bf52803988b961b3cdf70654b7cf450e9aa9d317165244469b9381d6c5f1e179` |
| Accepted vessel mask | | `9fb8b70095c89a0ff37ccb28a8967b87614e6429fa70ccd3bde36d92b8139679` |

What was done, and the departures from a clean case:

- The clip is a 720 by 480 screen capture of 4,650 frames that mixes blank frames, native fluoroscopy and subtracted runs, with text burned into the margins. Frame 1700 is a subtracted frame. It was extracted with the helper, cropped to columns 206 to 617 and rows 32 to 475 (412 by 444 pixels) to remove the margins, attested and admitted as a public-scope PNG bundle.
- The clip sits under `FLUORO/A/`, but the text on the frame reads plane B. The dataset has no DICOM geometry. Its per-frame text table gives "RAO 44°/0°" and "cm 32" for this frame, which is a reading of screen text, not a calibrated angle.
- The app's model worker refuses sources above 8,000,000 voxels, so the CTA was resampled by trilinear interpolation onto a 0.8 mm RAS-aligned grid of 200 voxels per side, centered on the head, and installed as a local source.
- The pooled vessel model did not finish on CPU within 420 s on this machine. The RSNA vessel model was used instead, and its candidate was accepted in the app: 9,269 voxels, 1,120 medial points, no coarsening. This is a limit of the smoke environment, not of the overlay feature.
- Geometry was entered by hand and is assumed, not measured: source to detector 1200 mm, source to isocenter 750 mm, field width 244 mm, secondary angle 0, with the field-size fit on, dark vessels and sensitivity 0.8.

In the browser, against the local server: the bundle opened and the frame was drawn after its digest check; a proposal ran; changing an input cleared the proposal and disabled saving; saving was unavailable until the review box was ticked; the confirmed proposal saved as revision 1; after the fitted-scale unit correction, the browser smoke was repeated and saved revision 2; the final parser and lock changes were exercised in another browser session, saving revision 3; and after a full reload the saved overlay redrew from the installed frame and mask. The saved record reads "operator-confirmed proposal", `validated: false`, geometry "operator_entered" and scores "browser_reported_not_recomputed". Each of the three browser smoke sessions recorded one successful `PUT`. The final session also confirmed that source replacement and frame inputs were locked during computation, Cancel remained available, the workspace unlocked after saving, and hiding projected points removed them from the canvas accessibility label. The saved overlay was inspected at desktop and narrow viewport sizes. With the frame bundle moved aside, the read route kept the record and reported its evidence as `unavailable`. With the bundle restored it reported `verified` again.

### Finding: the score does not identify the view on this frame

The same inputs were run from four starting angles. These values include the fitted-field unit correction. The RAO 90 row is the proposal saved as revisions 2 and 3 in the repeated browser smokes, and an offline replay of the same job code on the same installed bytes reproduced its saved numbers. The earlier revision 1 retains the scores reported by the earlier implementation; it is not rewritten.

| Starting primary angle | Mean distance, start to end (mm) | Matched, start to end | 2D centerline left uncovered at end | Rotation applied (deg) | Isocenter shift (mm) | Fitted field scale |
| --- | --- | --- | --- | --- | --- | --- |
| RAO 44 (the on-screen text) | 3.94 to 1.86 | 31% to 64% | 50% | 4.0 | 24.9 | 0.905 |
| RAO 90 (saved) | 3.68 to 1.69 | 35% to 66% | 45% | 8.7 | 20.1 | 0.944 |
| LAO 90 | 4.32 to 2.32 | 26% to 54% | 61% | 11.6 | 55.3 | 1.167 |
| AP | 3.94 to 1.53 | 31% to 75% | 46% | 13.2 | 25.9 | 0.805 |

Starts 44 to 134 degrees apart all end between 1.5 and 2.3 mm with 54% to 75% of points matched. At most one of them can be right, so on this frame the score cannot tell a correct view from a wrong one, and a low mean distance is not evidence of a correct registration. On inspection of the overlays, the projected points lie along some branches in the RAO starts and are visibly misplaced in the LAO start. In none of them do the points follow the carotid trunk and siphon that dominate the frame, and about half of the extracted 2D centerline has no 3D partner.

Likely contributors, none of them tested here: the frame is a selective injection of one territory while the mask covers both sides of the head; the mask is sparse; the angle, distances and field size are assumed; and one plane leaves depth and out-of-plane turns weakly determined. Saving this proposal exercised the confirm and save path. It does not mean the overlay was judged correct.

These scores are not external-reference errors and cannot establish whether the several-millimeter accuracy expectation in the plan was met. Step C2 adds a vessel-presence report and joint refinement across two planes, and evaluates against data with a known pose before anything is said about accuracy.

## Limits

- No accuracy claim on patient data. The only quantitative evidence is synthetic.
- The angle convention `dicom_xa_patient_longitude_latitude_ras_v1` is declared from DICOM and has not been verified against a vendor system.
- Stored scores are the browser's own report. The server checks their ranges and does not recompute them.
- The deidentification of a PNG plane rests on the operator's attestation. The software records the crop and redactions and cannot detect an identifier that was left in.
- One smoke case, one frame, one plane, one vessel model. Two-plane bundles are admitted and displayed one plane at a time.

## Observed checks

Run on 2026-11-11 on macOS, on the branch head.

| Check | Result |
| --- | --- |
| `uv run ruff check .`, `uv run ruff format --check .` | clean |
| `uv run pytest -q` | 1219 passed, 127 skipped |
| Ingest runtime, `tests/ingest_runtime` | 165 passed |
| Physics runtime, the workflow's 15 files | 239 passed |
| `npm test` | 84 files, 878 tests passed |
| `npm run build`, `npm audit --omit=dev --audit-level=high` | built, 0 vulnerabilities |
| Real-browser smoke on one public frame | ran end to end, see the finding above |

On main before this step the same suites gave 1071 passed and 125 skipped, 81, 239, and 698 tests in 77 files.
