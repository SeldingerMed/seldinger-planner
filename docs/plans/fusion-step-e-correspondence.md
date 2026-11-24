# Step E part 2: the CT coronary tree matched to the same patient's cine

Branch `feat/fusion-e-cta-correspondence`, cut from `60b1b18` (PR #27). Kanban task `t_cd198c59`.

PR #27 follows an axis seeded on one frame through the cine (`coronary_tree_tracking_v1`). That is tracking, not CT-to-cine correspondence. This part adds the correspondence itself and the product path that carries it.

## What the operator does

1. The case's CT coronary tree is admitted on the server, bound to the scan by its SHA-256, with each branch named and the CT's cardiac phase stated.
2. The operator opens a cine bundle made locally from a DICOM XA cine. It is read in the browser and sent nowhere. Its frame times and C-arm geometry come from the DICOM header.
3. The operator states the pair: this cine is of this patient. The server records the pair by the tree's digest and the cine's SHA-256. Nothing is inferred from names or identifiers inside the files.
4. One proposal: the heart period and the frames at the CT's phase, the tree lined up on the best of those frames, each named CT branch matched to its course in the frame (or reported not found, ambiguous, or in conflict with another branch), and the matched tree followed over the cine.
5. The operator replays the cine under the proposal and confirms it. The confirmed record names the pair, the tree, the cine and every branch match.

## Acceptance criteria and evidence ledger

| # | Criterion | Kind | Evidence | State |
|---|---|---|---|---|
| 1 | Known-truth tracer: a 3D tree with known heart motion projected through a known C-arm into a cine with frame times; the engine recovers the phase frames, names each branch's 2D course and follows it, with errors against truth printed | Synthetic, gated | `coronaryCorrespondence.test.ts`, `research/coronaryCorrespondenceSynthetic.eval.ts` | open |
| 2 | Refusals: foreign pair, source mismatch, stale pair, missing CT phase, missing or display-rate-only frame times, missing or moving projection geometry, period not read (missing phase) | Synthetic, gated | engine and server tests, each asserting its own message | open |
| 3 | Branch faults: a CT branch absent from the cine is reported not found, two branches drawn to one vessel are reported in conflict, a branch with two equally good courses is reported ambiguous; none is forced | Synthetic, gated | engine tests | open |
| 4 | Truth is never an input: the engine's inputs carry no truth field; the evaluation scores against truth after the run | Code review, test | type and test | open |
| 5 | Studio path end to end on the synthetic tracer: tree from the server, bundle opened, pair saved, proposal, replay, confirm, saved and reloaded | Synthetic, through the UI | `CoronaryFusionPanel.test.tsx`, a browser run on the Studio | open |
| 6 | Heart period coverage on real cines from frame times and image evidence, not forced: design cases (the 30 cines of PR #27, now including the 7 JPEG Lossless ones) then one run on unspent studies under a protocol committed first | Real cine, no truth | `research/cardiacPeriod.eval.ts`, protocol and results pages | open |
| 7 | Refused-but-available native formats decoded where safe (Siemens JPEG Lossless) | Real cine | converter test, coverage table | open |
| 8 | Real paired CT and cine of the same patient | Real paired | source scout; if none is open, the exact missing artifact and its gate | open |
| 9 | Real data as far as allowed: real cine geometry and timing through the converter and the engine; another patient's CT tree against a real cine is refused without a pair, and with a forced pair the fit gate's behaviour is measured and reported as a foreign-pair check, not as registration accuracy | Real cine, unpaired CT | evaluation | open |

Measured correspondence on CT and cine of the same patient is reported apart from tracking figures. Where there is none, the results page says so in its first lines.

## Decisions log

- 2026-11-24. Training HD has 27.7 GiB free, under the 40 GiB floor set for this task. Nothing is written to it. Real inputs are read into memory only; every evaluation prints to standard output.
- 2026-11-24. Design header survey (first 15 studies of each CardioSYNTAX holdout, already read by PR #27): no heart-rate tag, no ECG waveform, no R-wave pointer in any of 309 files. Philips files carry a frame time vector, Siemens a frame time. Every file carries the C-arm angles and source-to-detector distance; 4 Siemens files lack source-to-patient distance and pixel spacing. 64 Siemens files are JPEG Lossless (process 14). So on this set the period can come only from frame times plus image evidence.
- 2026-11-24. Split fixed before any new run: design is the first 15 studies (name order) of each holdout, as in PR #27. Unspent for the one held-out run: Philips studies 16 to 97 and Siemens studies 16 to 20. No unspent file is opened before the protocol is committed.
- 2026-11-24. The CT phase is matched from image evidence only for a diastolic CT phase (60 to 85 percent of the R-R interval): each beat's quietest frames. Any other CT phase needs ECG timing, which these files do not hold, and is refused rather than guessed.
- 2026-11-24. Engine in the browser, as the line-up and the tracker are. The rigid fit reuses `vessel_evidence_compass_v1` on the phase frame. Motion reuses `coronary_tree_tracking_v1`, seeded with the matched CT tree.
