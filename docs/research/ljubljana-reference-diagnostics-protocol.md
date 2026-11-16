# Ljubljana reference-pose diagnostics: protocol

Protocol `ljubljana-reference-diagnostics-v1`. Written on 2026-11-16 and committed before any of it was run.

## Purpose

The known-pose evaluation (`ljubljana-known-pose-v1`) found that the registration score at the reference pose is about as poor as at a pose 11 mm away. It could not say how much of that comes from each of three places: the 3D point set, the 2D line extraction, and the reference pose or this project's reading of the stored cameras.

This is a diagnostic, not an evaluation. It measures those three at the reference pose so that the score rework of Fusion Step C4 starts from causes. It runs no registration and reports no registration accuracy.

## Data and split

The prepared Ljubljana files of the known-pose evaluation, unchanged (same copy, same licence terms, same handling rules).

Subjects 01 to 05 only. The split is by subject number and was fixed before anything here was run. The diagnostic code refuses any other subject. Subjects 06 to 10 are kept back so that no design choice in the rework is made from them.

All ten subjects were part of the known-pose run, and its per-run detail was read. Subjects 06 to 10 are therefore not unseen data. They are data no diagnostic or tuning has looked at.

## What is measured

Per frame (two per subject, ten frames), at the stored reference pose:

1. **Frame conversion.** The 1st, 50th and 99th percentile of the stored 16-bit pixels inside the frame window, and the number of distinct 8-bit levels left by the protocol's conversion (the high byte).
2. **2D extraction.** The number of centerline pixels and their length in millimeters at the isocenter, for each input variant below.
3. **3D to 2D.** The share of projected 3D points within 2 mm of a 2D centerline.
4. **2D to 3D.** The share of 2D centerline pixels within 2 mm of a projected 3D point.
5. **Reference against the image, without line extraction.** The mean frame darkness under the projected 3D points as the projection is slid in the image plane over a grid of 1 mm steps out to 10 mm. Reported: where the darkest alignment falls, in millimeters from the reference.
6. **Does the score know the reference.** The mean capped distance of items 3 and 4 at the reference pose and at the subject's five protocol starts, and at in-plane shifts of 1, 2, 3 and 5 mm in eight directions. Reported: how many of the five starts score worse than the reference, and whether any shifted pose scores better than the reference.

Input variants for items 2 to 4 and 6:

- `protocol`: the frame as the known-pose protocol converts it, default sensitivity.
- `stretched`: the same frame with its 0.5th to 99.5th percentile range mapped linearly onto 0 to 255 before the 8-bit conversion, default sensitivity.
- `stretched_sensitive`: as `stretched`, sensitivity 0.9.

A variant is an input to the diagnostic, not a method. Nothing here changes either registration engine.

## Images

For each frame the diagnostic writes pictures of the frame, the extracted centerlines and the projected 3D points at the reference pose. They are read by eye. They are written outside the repository, on external storage, and never enter it.

## What is recorded in the repository

Aggregate numbers over the ten frames and plain-language findings, in `ljubljana-reference-diagnostics-results.md`. No image, pose, point or per-subject number.

Further probes suggested by the findings are allowed on subjects 01 to 05. Each is listed in the results as added after this protocol.

## Command

```
cd web && LJUBLJANA_PREPARED=<prepared> LJUBLJANA_DIAGNOSTICS=<output dir> \
  npx vitest run --config vitest.research.config.ts src/research/ljubljanaDiagnostics.eval.ts
```
