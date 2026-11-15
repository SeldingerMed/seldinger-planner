# Ljubljana known-pose evaluation: protocol

Protocol `ljubljana-known-pose-v1`. Fixed on 2026-11-14 and committed before either registration engine was run on this data. The results are recorded separately in [ljubljana-known-pose-results.md](ljubljana-known-pose-results.md). Anything done differently from this page is listed there as a deviation.

## Purpose

Step C1 gated the single-plane registration proposal on a synthetic phantom and found, on one public frame pair, that its score could not tell a right view from a wrong one. Step C2 adds a proposal that fits one patient pose to two planes at once. Both engines have so far been measured only against phantoms they were developed on.

This evaluation measures both engines on ten public clinical subjects with a reference pose, from starts a fixed distance away. It reports numbers. It sets no pass mark, and it is not a validation study: ten subjects from one center, one start distribution, and a reference pose with its own error.

## Data

The Ljubljana 3D-2D cerebral angiogram set (Mitrović, Špiclin, Likar and Pernuš, IEEE Transactions on Medical Imaging 32(8), 2013): ten patients, each with a 3D rotational angiogram, one frontal and one lateral 2D subtraction angiogram, and a reference pose for each 2D view from fiducial markers.

The copy used is the folder `ljubljana/` of the Hugging Face dataset `eigenvivek/xvr-data` at revision `7a46053ffba5cd3e10779b27cb0d010d0c06178b`, 92 files and 379,301,676 bytes. Its README states that the original is CC BY-NC-ND and that this copy is released with the authors' permission. The copy stores, per subject, the volume with voxels under 1000 already set to zero, the two frames, a camera pose and intrinsics per frame, and a list of 3D evaluation points.

Handling:

- The files are fetched by `scripts/research/fetch_ljubljana.py`, which checks every file against the size and, where given, the SHA-256 the Hub lists, and writes a manifest. They are decoded by `scripts/research/prepare_ljubljana.py`. Both refuse a destination inside this repository or on its storage device.
- No image, volume, pose, point or per-subject number from this set enters the repository. The repository holds code, this protocol and aggregate scalar results.
- The license is non-commercial. The results are for internal research use and are not to be used in commercial, pitch or grant material without the owners' agreement.

## Before the protocol was fixed

Neither registration engine was run on this data before this page was committed.

The stored camera conventions had to be established first, and that used the data. The vessel points of every subject were projected at the stored reference pose onto each of the twenty frames, and slid across the frame to find where the pixels under them were darkest, with the frame mirrored and not. The darkest alignment fell where the conventions in `web/src/research/ljubljanaGeometry.ts` put the central ray: within the six-pixel search step in eighteen frames, and within fourteen stored pixels in both frames of one subject. No mirrored frame aligned as well. This fixed one sign that the renderer's current source reads the other way, and it showed that vessels are darker than background in every frame.

That check looked at image intensity under the reference pose. It did not run a registration, extract 2D centerlines, or compute either engine's score. One thing was learned from it that bears on the results: in both frames of one subject the darkest alignment sits up to fourteen stored pixels, about 1.3 mm at the isocenter, from the stored offset, so that subject's reference pose or frames may agree less well than the others. No subject is excluded.

## Engine settings

Both engines run as committed, with every setting at its default. The single-plane engine is `centerline_distance_compass_v1` from Step C1, unchanged. The biplane engine is `centerline_distance_compass_biplane_v1`. Its settings were chosen on the synthetic phantom alone. No setting may be changed in response to these results; a later change is a new method and needs a new run.

## Inputs

Each input is produced by the code the application uses, from the stored files, with no step chosen per subject.

- **Vessel mask**: every voxel above zero in the volume as distributed.
- **3D points**: `medialPoints` on that mask.
- **Frames**: `frontal.dcm` and `lateral.dcm`, the two with stored poses. The `_max` variants are not used.
- **Frame window**: the largest window of whole pixels centered on the central ray, because the view model has no principal-point offset. The window is centered to within half a stored pixel, which is 0.08 mm on the detector.
- **Frame pixels**: block means over the smallest whole factor that brings the longer side to 1024 pixels or fewer, then the high byte of the 16-bit value. No contrast window is chosen.
- **2D target**: `vesselTarget` with dark vessels and default sensitivity.
- **Views**: source-to-detector distance and pixel pitch as stored. The two stored camera orientations are written as primary and secondary angles in one C-arm frame, which is always possible and is checked in `ljubljanaGeometry.test.ts` against an independent projection. Each plane's isocenter is the point of its central ray nearest the volume center.

## Reference and error

The reference pose is the stored one. The error of a proposal is the mean distance, in millimeters in three dimensions, between where the proposal and the reference put the copy's stored evaluation points: the mean target registration error at those points.

The reference comes from fiducial registration and has its own error, which this evaluation cannot measure. Errors near or below that level cannot be told apart.

## Starts

Five starts per subject, the same five for every arm. Each start is the reference pose turned about each C-arm axis and shifted along each, about the centroid of the vessel points, by amounts drawn evenly from -10 to 10 degrees and -10 to 10 mm in tenths. The draws come from a fixed generator with seed 20261114 and are pinned in `ljubljanaProtocol.test.ts`. The drawn poses in the biplane engine's synthetic gate use the same distribution.

## Arms

| Arm | Engine | Planes | Start | Runs |
| --- | --- | --- | --- | --- |
| `biplane` | biplane | frontal and lateral | perturbed | 50 |
| `frontal`, `lateral` | single-plane | one | perturbed | 50 each |
| `biplane_uncalibrated` | biplane, fitting both detector scales | both, detector sizes entered 0.85 and 1.2 times the stored size | perturbed | 50 |
| `frontal_uncalibrated`, `lateral_uncalibrated` | single-plane, fitting the detector scale | one, entered 0.85 or 1.2 times the stored size | perturbed | 50 each |
| `biplane_from_reference`, `frontal_from_reference`, `lateral_from_reference` | as above, calibrated | as above | the reference pose | 10 each |

The `from_reference` arms show the engine's own score at the reference pose and how far the engine moves away from it.

## What is reported

For each arm, over all its runs:

- Target error: median, mean, 90th percentile and maximum.
- Share of runs with target error under 1, 2 and 5 mm. A run in which the engine returns no proposal counts as a failure at every threshold and is left out of the error statistics; such runs are counted.
- Number of subjects, out of ten, with every run under each threshold. Five starts on one subject are not independent, so run-level shares overstate the sample.
- In-plane error per plane: the mean distance between where the proposal and the reference put the evaluation points on that plane's detector, in millimeters at the isocenter. One plane determines this and leaves depth open, so it is the fair measure for the single-plane arms.
- Start error, for scale.
- For the uncalibrated arms, the absolute error of the fitted detector scale.
- The engine's own mean distance and matched fraction at the start and at the result.
- Median run time, and the text of any failure.

All of this is reported, not gated. The synthetic gates in the test suite are the only gates.

## How the harness is checked

`ljubljanaEvaluation.test.ts` writes a phantom subject in the prepared layout, with its two cameras stored the way this copy stores them and the central ray off the middle of both frames. It then runs the whole evaluation on those files. The evaluation has to recover the reference pose from the files alone, and the biplane arm has to come back under 1 mm. Reversing either principal-point sign, the beam direction or the volume centering makes that test fail.

## Commands

```
python3 scripts/research/fetch_ljubljana.py <raw>
.runtime/ml-runtime/bin/python scripts/research/prepare_ljubljana.py <raw> <prepared>
cd web && LJUBLJANA_PREPARED=<prepared> LJUBLJANA_RESULTS=<results> \
  npx vitest run --config vitest.research.config.ts
```
