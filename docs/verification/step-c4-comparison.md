# Step C4 part 5: the 2D and 3D comparison

Verification record for part 5 (2026-11-21).

## What was built

| Piece                                                                                                   | Where                                                                                            |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Where the axis samples of the 3D model lie in a frame, and the size of a pixel there                    | `web/src/framePlacement.ts`                                                                      |
| A mark in a frame carried to the 3D vessel axis, from one plane or two                                  | `web/src/carryPoint.ts`                                                                          |
| Vessel diameter from the mask (`mask_vessel_slab_area_v1`)                                              | `web/src/axisDiameter.ts`                                                                        |
| Vessel diameter from a frame (`profile_half_depth_v1`)                                                  | `web/src/frameDiameter.ts`                                                                       |
| Median diameter per segment and the narrowest place of each unbranched run, for the mask and each frame | `web/src/diameterComparison.ts`                                                                  |
| The frame at which contrast reaches each segment (`segment_half_peak_v1`)                               | `web/src/contrastArrival.ts`                                                                     |
| Planned against deployed device (`ends_on_planned_path_v1`)                                             | `web/src/deviceComparison.ts`                                                                    |
| The computation as a job that yields to the page, and the section in the studio                         | `web/src/comparisonJob.ts`, `web/src/ComparisonPanel.tsx`, `web/src/ProjectionOverlayStudio.tsx` |
| Development look on public subjects with a reference pose                                               | `web/src/research/comparisonDev.eval.ts`                                                         |

The section **2D and 3D comparison** sits under the vessel-presence report of a current saved proposal. Nothing is saved, so no record version is added; records of versions 1 to 8 and the presence report are as they were.

## Results

Development subjects 01 to 05 of the Ljubljana set at their reference pose, two planes each (`fusion-c4/comparison/dev-9`; the run repeated on the head of this pull request gives the same file byte for byte):

| Diameter from the frame against the mask | Segments measured | Within 0.5 mm | Within 1 mm | Median difference | Median absolute difference |
| ---------------------------------------- | ----------------- | ------------- | ----------- | ----------------- | -------------------------- |
| Both planes                              | 1,136             | 785           | 1,009       | 0.22 mm           | 0.30 mm                    |
| Frontal                                  | 415               |               |             | 0.33 mm           | 0.40 mm                    |
| Lateral                                  | 721               |               |             | 0.17 mm           | 0.27 mm                    |

On the synthetic phantom, whose tube radii are known, the tests hold the acceptance criteria of the plan: a mark carried from two planes returns the sample it was made on; segment diameters from the frame and from the mask are each within 0.6 mm of the tube's; a narrowed stretch is found as the narrowest place of its run in both; segments fill in the order contrast was drawn to reach them.

In a browser on the public case TAIR 00132 with its saved two-plane proposal, the comparison of both frames against the mask took 0.6 s. Of 35 segments, 34 have a mask diameter, 14 were measured in plane A and 6 in plane B, and 8 runs have a narrowest place. A cursor moved over plane A with the arrow keys and marked with Enter was carried to segment 9, 2.7 mm from the mark, and drawn in both planes.

## Tests

- `web/src/carryPoint.test.ts` (7): the pixel of each axis sample under the registration and the size of a pixel there; a sample that cannot be projected is marked, and detector pixels that are not square are refused; a mark in one plane returns the sample under it; marks in two planes return the sample both agree on; a mark with no vessel within reach carries nothing; the other vessels under a mark in one plane are counted, and a second plane tells them apart; a mark outside its frame on any side is refused.
- `web/src/diameterComparison.test.ts` (19): the mask and the frame each give the phantom's tubes their diameters, a bright vessel as a dark one, wherever the grid lies; the cut holds only the mask that joins the sample, and the vessel the sample lies in where two run side by side and touch; a sample off the mask, with no cut, seen end-on, under 8 brightness levels deep, at the frame's edge, or with a profile that would leave the frame is not measured; a vessel is measured through a much thinner one over it and not through one of its own size, and beside a short bend of its own run; the profile is read where the mask's cut is centered; a narrowed stretch is found in the mask and in the frame at the same place, and a run measured at too few samples has no narrowest place.
- `web/src/contrastArrival.test.ts` (4): segments in the order contrast was drawn to reach them, a bright vessel as a dark one; segments filled from the first frame, without change, or outside the field read as such; frames that are not a run are refused.
- `web/src/deviceComparison.test.ts` (3): no shift when the ends are marked where they were planned; each end measured along the path, round its bend, in either order of marking; a device that does not fit its path, and ends that are not two points, are refused.
- `web/src/ComparisonPanel.test.tsx` (15): a row per segment with both diameters and the frame at which contrast arrives; the largest narrowing first; a clicked place carried to the 3D model and a planned device measured against its two marked ends; a comparison without a planned device, and with one frame; a mark from the keyboard, with the frame's picture built once and drawn again under the cursor; frames that are not the confirmed ones, stored bytes that fail their integrity check, a mask that cannot be fetched, and a reading that took too long, each with its own message; nothing started while the studio is busy or the mask has changed; a reading given up when the saved proposal is replaced, and nothing of a comparison shown once the proposal is another.
- `web/src/ProjectionOverlayStudio.test.tsx`: the comparison runs under a saved proposal while the report waits, and saves nothing; each panel under a saved proposal holds the other and the saved overlay while it reads and while it computes.

Seventy-eight single-site changes of the new code were made by hand (limits, the slab and its center, the fill, the half-depth width and its 0.866, the clearance rule, the smoothing and run length, the half-peak rule, the field and peak limits, the path drop, the abort and deadline handling, the keyboard cursor, the studio's busy flags). Each made at least one test fail.

An independent read of the whole change found eight points, none in the numeric core. Seven were taken up: requests given up when the proposal is replaced, distinct cell keys, keyboard marking, a test for a replaced proposal, the guide's wording of the slab, the deadline's own message, and the wording for a vessel that passes under a mark twice. The eighth, the cost of the overlap scan, stays: the whole comparison of a real case takes 0.6 s.

The review on the pull request added three points, all taken up: a failure names its cause (frames that are not the confirmed ones, an integrity failure, or files that cannot be had); the mask's cuts can be stopped after every sample; the frame's picture is built once and drawn again as the cursor moves. A second pass added two: every run with a narrowest place is listed, and device plans that could not be read are said so, apart from a case without measurements, which has none. A review of that last commit added one: the server gave the answer of a case without measurements also where the plans changed while it read them. It now names the first in a header (`X-Conflict-Reason: measurements-not-current`); the comparison takes that as a case with no plans, asks once more after any other 409, and says the plans could not be read where that one stands; the last read decides, and the second waits a quarter of a second for a change under way to be over.

## Checks

On the head of this pull request:

- Backend: 1483 passed and 133 skipped; Python lint and format checks clean.
- Frontend: TypeScript typecheck clean and the changed files formatted; the seven test files of the touched code, 126 of 126, and `web/src/api.test.ts`, 9 of 9; production build and dependency audit clean. The full frontend suite is the frontend job in CI.
