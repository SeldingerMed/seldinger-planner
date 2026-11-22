# Step C4 part 6: the overlay on a replayed recording

Verification record for part 6 (2026-11-21).

## What was built

| Piece                                                                                                                                                                                                                                 | Where                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| The frame table of a public recording: kind of frame, C-arm angles and field size per frame (`screen_text_csv_v1`)                                                                                                                    | `web/src/recordingSidecar.ts`                                |
| The saved view turned and sized by what the screen shows since the saved frame, the axis placed in it, the frame at a media time, the crop in the decoded picture, and the likeness of two pictures (`saved_pose_at_frame_angles_v1`) | `web/src/replayOverlay.ts`                                   |
| Time from a frame presented to its overlay drawn, and frames presented but not drawn (`presentation_to_overlay_drawn_v1`)                                                                                                             | `web/src/replayLatency.ts`                                   |
| The replay section: opens a recording and its table, checks the recording against the saved frame, plays with the axis, shows and saves the latency figures                                                                           | `web/src/RecordingReplay.tsx`                                |
| Each plane's place in its source picture kept by the parsed frame bundle; the section mounted under a comparison                                                                                                                      | `web/src/projectionFrames.ts`, `web/src/ComparisonPanel.tsx` |

The recording and its table are read in the browser and are not sent. Nothing is saved, so no record version is added.

## Results

Three public TAIR recordings (720 by 480, 29.97 frames a second) replayed under the saved two-plane proposal of their case, plane A, 20 seconds each from the saved frame, in Chrome on the Mac Studio (`fusion-c4/replay/*-planeA-check.json`):

| Case  | Frames of the recording | Frames drawn of those presented | Presented to axis drawn: median | 95th percentile | Worst   | Placing and drawing: median |
| ----- | ----------------------- | ------------------------------- | ------------------------------- | --------------- | ------- | --------------------------- |
| 00132 | 10,770                  | 600 of 600                      | 8.9 ms                          | 19.0 ms         | 23.9 ms | 2.0 ms                      |
| 00146 | 10,770                  | 600 of 600                      | 8.7 ms                          | 19.1 ms         | 25.0 ms | 2.0 ms                      |
| 00151 | 16,560                  | 600 of 600                      | 8.6 ms                          | 19.0 ms         | 25.4 ms | 2.0 ms                      |

- The admitted frame of plane A of 00132 is the frame ffmpeg extracts at number 3759 from its recording (correlation 1.00 over the admitted crop). For the other recording ffmpeg's frame at that number gives -0.32, the likeness the browser found there.
- In each case the other plane's recording, opened first, was refused at the saved frame (likeness -0.32, 0.09 and 0.02).
- The screen angles at the saved frames read 0, RAO 8 and RAO 7 degrees; the saved views are 0, -8 and -7 degrees.
- With the frame table opened again while the recording stood at the saved frame, the recording was checked again and could be played, in all three (at `af152ed`).
- Along the 20 seconds the screen angles changed in every recording (to LAO 39, LAO 47 and LAO 9 degrees), and in 00151 the field from 42 to 32 cm; the line under the picture followed them.
- At the saved frame the axis lies where the saved proposal has it. Each recording is several runs one after another; in a later run the table stands elsewhere and the axis lies off the vessels.

## Tests

- `web/src/recordingSidecar.test.ts` (10): the two angles with their sides, and the usual misreadings of the text; a text cut short or with more after it is not read; the field size; every frame gets its kind and the last reading, frames before the first reading get that one, and a recording without readings has none; quoted fields, a byte order mark and either line ending; a table that is not one row per frame, or names too many kinds, is refused.
- `web/src/replayOverlay.test.ts` (22): the saved view at the saved frame and wherever the screen showed the same; turned by the change of angles, past the back of the patient onto the other side from either direction, and sized by the change of field, also where the angles were never read; no view where the angles or field are beyond what a view can have; the axis at the saved frame where the saved proposal has it; placed views kept, a larger field at the same angles placed anew, and the oldest forgotten; the frame at a time and the time at a frame; the crop in a picture decoded at the admitted size or another; likeness 1 for the same picture brighter or with more contrast, low for another, 0 for a flat one.
- `web/src/replayLatency.test.ts` (5): median, 95th percentile and worst by nearest rank; frames presented between two drawn; cleared figures; a frame drawn before it was presented is refused.
- `web/src/RecordingReplay.test.tsx` (17): nothing replays before both files are open; the recording is checked against the saved frame, with its crop and redaction, and a wrong one refused; a recording already at the saved frame is checked without a seek, and the end of a seek to another frame, or one that comes while a seek is under way, is passed over; a picture that comes after the seek has ended is checked when it comes; a recording that does not reach the saved frame is taken there three times and then said so, and tried afresh with another plane or the recording opened again; the axis over the saved frame; the axis turned as the recording plays and left out when asked; the latency of the stretch played, saved as a file that names its plane and saved frame, and started again on the next play; a frame shown while paused left out of the figures, and one plane's figures forgotten when the other is chosen; the slider and the return to the saved frame; the figures shown again every 30 frames drawn and worked out only then; a table that does not fit refused, and a file too large to be one refused unread; a recording that cannot be played, a file without a picture, and a recording the browser does not start; the other plane checked again; controls held while the studio is busy and the recording let go on leaving.
- `web/src/projectionFrames.test.ts`, `web/src/ComparisonPanel.test.tsx`: a parsed plane keeps its source size, crop and redactions; each plane of a proposal is given to the replay with its own saved frame, view and place in its source picture; under a comparison the replay has the pose and the vessel axis, and is held while the studio is busy.

Ninety single-site changes made by hand to the six changed source files (the frame table, the turned view, frame and time, the crop, likeness, the latency figures, the check before play, what is timed, what is given to the replay, the kept place in the source picture) each fail a test. An independent read of the change found the check waiting on a seek that never ends where the recording already stood at the saved frame, the end of an older seek taken for the saved frame, one plane's figures kept under the other, and two sentences of the guide short of the reader's rule; all are fixed with tests. The review on the pull request added three, all taken up: the figures are worked out only when they are shown; a file too large to be a frame table is refused unread; the check before play ends in the picture checked or in the recording said not to reach the saved frame; the saved figures name their plane and saved frame; the guide says how frames are numbered.

## Checks

- Backend: ruff and format clean; 1,485 passed, 133 skipped.
- Frontend: TypeScript typecheck clean and the changed files formatted; the seven test files of the touched code, 285 of 285; production build; no high-severity advisory in the shipped dependencies.
- Real browser: the three recordings above, at `a532ebb`.
