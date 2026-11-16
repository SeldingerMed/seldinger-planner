# Ljubljana reference-pose diagnostics: results

Protocol `ljubljana-reference-diagnostics-v1`, as written in [ljubljana-reference-diagnostics-protocol.md](ljubljana-reference-diagnostics-protocol.md). Run on 2026-11-16 at commit `278e234` with a clean working tree. Subjects 01 to 05, ten frames, 16 seconds on one desktop machine.

Status: a diagnostic on development data. It runs no registration and says nothing about registration accuracy. Five subjects from one center, and a 3D image from the same examination as the frames.

Only aggregates over the ten frames are recorded here. Per-frame detail and the pictures are kept outside the repository. The licence terms of the known-pose evaluation apply.

## Summary

- The reference pose agrees with the image. In all ten frames the projected 3D points lie on the darkest pixels at the reference pose itself, on a 1 mm grid.
- The frame conversion is not the limit. The high byte keeps 177 to 249 gray levels.
- The 2D extraction is right about what it marks and misses most of what is there. Nine in ten of its pixels have a projected 3D point within 2 mm, and one in five projected 3D points has a 2D line within 2 mm.
- The 3D point set follows the vessels, including the small ones the 2D extraction misses, and also holds points that are not vessels.
- A plain two-way distance does rank the reference above the perturbed starts. The poor score of the known-pose run is a matter of absolute level and of what the engine's cost rewards, not of the two line sets disagreeing about where the reference is.

## Frame conversion

| | Least | Median | Most |
| --- | --- | --- | --- |
| Stored 16-bit value, 1st percentile | 31,234 | | 51,234 |
| Stored 16-bit value, 50th percentile | 62,764 | | 64,117 |
| Stored 16-bit value, 99th percentile | 65,535 | | 65,535 |
| Gray levels left by the high byte | 177 | 234.5 | 249 |

Stretching the frame's own range onto 0 to 255 changed the extraction little (the `stretched` rows below).

## Reference against the image

The projected 3D points were slid over the frame in 1 mm steps out to 10 mm each way. The lowest mean frame value under the points was at no shift in ten frames of ten. This agrees with the check made before the known-pose protocol was fixed, at a finer step. It rules out an error of a millimeter or more in the image plane in the reference pose or in the reading of the stored cameras, for these five subjects. It says nothing about depth or about a turn out of the plane.

## The two line sets at the reference pose

One frame pixel is 0.19 to 0.30 mm at the isocenter. The extraction works on a grid two or three times coarser, 0.54 to 0.91 mm per pixel.

| Input | 2D centerline length (mm), least / median / most | 3D points with a 2D line within 2 mm | 2D pixels with a 3D point within 2 mm |
| --- | --- | --- | --- |
| `protocol` | 200 / 340 / 530 | 6% / 20% / 35% | 75% / 90% / 100% |
| `stretched` | 212 / 359 / 544 | 7% / 21% / 37% | 72% / 91% / 100% |
| `stretched_sensitive` | 510 / 687 / 1,610 | 21% / 32% / 62% | 66% / 81% / 97% |

Shares are least / median / most over the ten frames. Raising the sensitivity about doubles the length found, raises the share of 3D points with a partner and lowers the share of 2D pixels with one.

## Does a two-way distance know the reference

The score here is the mean capped distance from 3D points to 2D lines plus the mean capped distance from 2D pixels to 3D points, both capped at 8 mm. It is a measurement for this diagnostic. It is not the cost either engine minimizes.

| Input | Frames in which all five perturbed starts score worse than the reference | Frames in which no pose shifted 1 to 5 mm in the plane scores better | Largest shift that scores best |
| --- | --- | --- | --- |
| `protocol` | 9 of 10 (4 of 5 starts in the other) | 4 of 10 | 5 mm, in one frame; 1 mm in five |
| `stretched` | 9 of 10 | 4 of 10 | 5 mm, in one frame; 1 mm in five |
| `stretched_sensitive` | 10 of 10 | 7 of 10 | 1 mm, in three |

Each frame had 32 shifted poses. With the `protocol` input the number that scored better than the reference was 0 to 2 in nine frames and 6 in one.

## Read by eye

One picture from each of the five subjects was read, three frontal or lateral views at the higher sensitivity and two at the default. One reader, not a clinician.

- The extracted lines follow the carotid trunk and the first branches. Most of the smaller branches that the frame plainly shows are not marked.
- On the widest trunk the higher sensitivity draws a line down each edge instead of one down the middle.
- Some extracted lines are not vessels: the outline of the skull, tubing and dental work, and a frame edge.
- The projected 3D points follow the filled vessels, the small ones included.
- Some 3D points are not vessels: bands and scattered points across the face and skull base, and points on dental metal.
- The frame reaches further down the neck than the volume does, so part of the carotid trunk has a 2D line and no 3D point.

## What this means for the rework

1. The reference pose and the camera reading can be used as the target for development on these subjects.
2. The 2D target should come from a finer grid and should not be a thresholded line set alone. Most of the vessel evidence in the frame is below the threshold. The image itself under the projected points found the reference in every frame.
3. The cost should not let 3D points with no 2D partner dominate. They are four in five of the points here, where the 3D image shows the same injection as the frame. They will be more against a whole-head CTA.
4. Each side holds things the other cannot explain: non-vessel points in 3D, non-vessel lines and out-of-volume vessel in 2D. The cost has to bound what each can cost.
5. The 3D point set needs a way to drop points that are not vessels.

## Not covered

- Depth, and turns out of the image plane. Every probe here moved the projection in the plane.
- The engines' own cost. That is the first probe of the rework.
- Subjects 06 to 10.

## Deviations from the protocol

- A first run at commit `ffcdb42` counted gray levels wrongly: a level used more than 255 times was counted again. The counting was fixed and the run repeated at `278e234`. Every other number was identical between the two runs. The first run's output was removed.
- The protocol named the first input's conversion "the high byte". The run used the known-pose evaluation's own conversion function for it, which is that conversion.
