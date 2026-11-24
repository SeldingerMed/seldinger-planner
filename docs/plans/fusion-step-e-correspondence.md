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
| 1 | Known-truth tracer: a 3D tree with known heart motion projected through a known C-arm into a cine with frame times; the engine recovers the phase frames, names each branch's 2D course and follows it, with errors against truth printed | Synthetic, gated | `coronaryCorrespondence.test.ts`; studio run and `research/coronaryCorrespondence.eval.ts` (results sections 1 and 2) | met: studio median 0.47 px against 5.12 px held still; held-out real-anatomy cines 0.33 px against 5.27 px |
| 2 | Refusals: foreign pair, source mismatch, stale pair, missing CT phase, missing or display-rate-only frame times, missing or moving projection geometry, period not read (missing phase), no vessels on the frames at the CT's phase (contrast not yet in), a tree the frame holds no better than its mirror image | Synthetic, gated | engine and server tests, each asserting its own message | met |
| 3 | Branch faults: a CT branch absent from the cine is reported not found, two branches drawn to one vessel are reported in conflict, a branch with two equally good courses is reported ambiguous; none is forced | Synthetic, gated | engine tests | met |
| 4 | Truth is never an input: the engine's inputs carry no truth field; the evaluation scores against truth after the run | Code review, test | type and test (`takes no truth or other extra input`) | met |
| 5 | Studio path end to end on the synthetic tracer: tree from the server, bundle opened, pair saved, proposal, replay, confirm, saved and reloaded | Synthetic, through the UI | `CoronaryCorrespondencePanel.test.tsx`; browser run on a production build (results section 1) | met |
| 6 | Heart period coverage on real cines from frame times and image evidence, not forced: design cases then one run on unspent studies under a protocol committed first | Real cine, no truth | `research/cardiacPeriod.eval.ts`, results section 3 | measured: 74 of 87 held-out cines against the tracker's 15; correctness not established (no ECG) |
| 7 | Refused-but-available native formats decoded where safe (Siemens JPEG Lossless) | Real cine | converter test, results section 5 | met |
| 8 | Real paired CT and cine of the same patient | Real paired | results section 6 | open: no open source; ICADD paired CCTA and ICA needs a data request to its authors |
| 9 | Real data as far as allowed: real cine geometry and timing through the converter and the engine; another patient's CT tree against a real cine is refused, and the fit gate's behaviour is measured as a foreign-pair check, not as registration accuracy | Real cine, unpaired CT | results sections 2 and 4 | met: 0 of 8 forced foreign pairs proposed on real cines; 29 of 30 foreign trees refused on held-out real-anatomy cines (one failure reported) |

Measured correspondence on CT and cine of the same patient is reported apart from tracking figures. Where there is none, the results page says so in its first lines.

## Decisions log

- 2026-11-24. Training HD has 27.7 GiB free, under the 40 GiB floor set for this task. Nothing is written to it. Real inputs are read into memory only; every evaluation prints to standard output.
- 2026-11-24. Design header survey (first 15 studies of each CardioSYNTAX holdout, already read by PR #27): no heart-rate tag, no ECG waveform, no R-wave pointer in any of 309 files. Philips files carry a frame time vector, Siemens a frame time. Every file carries the C-arm angles and source-to-detector distance; 4 Siemens files lack source-to-patient distance and pixel spacing. 64 Siemens files are JPEG Lossless (process 14). So on this set the period can come only from frame times plus image evidence.
- 2026-11-24. Split fixed before any new run: design is the first 15 studies (name order) of each holdout, as in PR #27. Unspent for the one held-out run: Philips studies 16 to 97 and Siemens studies 16 to 20. No unspent file is opened before the protocol is committed.
- 2026-11-24. The CT phase is matched from image evidence only for a diastolic CT phase (60 to 85 percent of the R-R interval): each beat's quietest frames. Any other CT phase needs ECG timing, which these files do not hold, and is refused rather than guessed.
- 2026-11-24. Engine in the browser, as the line-up and the tracker are. The rigid fit reuses `vessel_evidence_compass_v1` on the phase frame. Motion reuses `coronary_tree_tracking_v1`, seeded with the matched CT tree.
- 2026-11-24. Foreign trees were proposed on cines rendered from real ImageCAS-X anatomy (design cases). Added the mirror-image margin (`min_mirror_margin` 0.25, refusal `tree_not_distinct`), set on the design cases, then tested once on ten unspent cases under `docs/research/step-e-correspondence-heldout-protocol.md`.
- 2026-11-24, review of PR #28. A cine whose beat reads but whose frames at the CT's phase hold no vessels now ends in its own refusal (`no_vessels_at_phase`) instead of an error; the heart period read runs in slices inside the job; the engine's tree limits match the server record (32 branches, 2000 points); the tree byte bound admits the largest tree the schema allows. Further review fixes: a period read outside 333 to 1500 ms is refused (`period_out_of_range`) rather than proposed for a record that cannot hold it; settling branches that contest one vessel runs in slices; the cine converter writes a C-arm view only where the browser's limits admit it. Design replays of both evaluations after these changes gave the same output as before them (heart period, 30 design studies; correspondence, 5 design cases; every field but run time).
