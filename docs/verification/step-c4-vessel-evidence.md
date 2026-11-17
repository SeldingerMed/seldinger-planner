# Fusion Step C4, part 1 verification: vessel evidence in the studio

Step C4, part 1, adds a second pair of 2D-to-3D proposal methods that match the projected 3D vessels to a continuous map of line-like structure in the frame, with no threshold and no extracted line set. The first pull request (#13, merged as `bc3a825`) held the two methods and their evaluation on public subjects with a reference pose. This one offers them in the overlay studio, gives them their own saved record, and reads five public clinical cases with them. The behavior is described in [Angiogram overlay and 2D-to-3D registration proposal](../angiogram-overlay.md#vessel-evidence). This note records what was checked and what each check does and does not show.

Evidence classes used below: unit evidence on synthetic data, records the studio itself sent on a phantom, mutation checks of the new guards, a completed run of a small fixed protocol on public data that is not unseen, and one reading of five public clinical cases under a rule fixed beforehand. Nothing here is a validation study. No registration accuracy on patient data is claimed.

The headline result is mixed. The software path is sound: the studio proposes, saves, reloads and redraws a vessel evidence record, the server and the browser refuse a record of one kind dressed as the other, and records of the Step C1 and C2 methods behave as before. On public subjects with a reference pose the new two-plane method ended under 1 mm far more often than the older one. On the five clinical cases with selective injections it did not help: no proposal visibly lay on the filled arteries, two read worse than the older method's proposal of the same frames, and the scores did not show it. The score rework fixed the failure it was designed for, which was a poor score at a correct pose. It did not fix registration on selective injections, where most of the 3D mask has no partner in the frame.

## Delivered surface

- `planner/projection_registration.py`: record versions `step-c4-evidence-registration-v3` and `step-c4-evidence-biplane-registration-v4`, with their own score, no sensitivity and a stored fit outcome.
- `planner/vessel_presence.py`: a report bound to a vessel evidence record is refused. `planner/fusion_brief.py`: the brief reads the number of planes from the record, not from its version.
- `web/src/projectionFrames.ts`: the closed parser for the two new record shapes and for the server's summary of them.
- `web/src/projectionOverlayJob.ts`: the two job runners take a method.
- `web/src/ProjectionOverlayStudio.tsx`: the method choice, the proposal and saved wording, the save payloads and the redraw.
- `web/src/VesselPresencePanel.tsx`: no report action on a vessel evidence record, and the reason.
- `web/src/__fixtures__/evidence-registration-records.json`: five records the studio sent on the phantom, each beside the server's summary of it.

Not changed in this pull request: `web/src/evidenceRegistration.ts` and `web/src/vesselEvidence2d.ts`, which stay as they were run under protocol `ljubljana-evidence-v1`, the centerline distance engines, and the Step C1, C2 and C3 record contracts.

## Acceptance criteria and where each is checked

| Criterion | Check |
| --- | --- |
| A saved record of a Step C1 or C2 method validates, summarizes and reads back as before | The earlier tests in `tests/test_projection_registration_server.py` and `web/src/projectionFrames.test.ts` pass with no assertion of theirs changed or removed (one gained two more malformed rows to refuse), and the Step C3 records of five real cases were redrawn by this code (below) |
| A vessel evidence record has its own version, its own score, no sensitivity and a fit outcome | `tests/test_projection_registration_server.py`, section "Vessel evidence methods (Step C4)", and `web/src/evidenceRecords.test.ts` |
| A record of one kind is never accepted as the other, on either side | The rejection tables in the same two files: a sensitivity on an evidence record, an evidence method under an older version, a centerline distance score under an evidence method, an accuracy field in the score |
| The fit outcome cannot contradict the request, and a dropped fit cannot change a size | Same two files, both sides |
| The server and the browser agree on the record | `test_the_studio_s_own_vessel_evidence_records_are_accepted_as_sent` and `web/src/evidenceRecords.test.ts` read the same fixture |
| The studio offers the method, shows no sensitivity for it, asks for the same attestation for two planes, and drops an unsaved proposal when the method changes | `web/src/ProjectionOverlayStudio.test.tsx`, ten tests named for vessel evidence, the method choice or a fit |
| A kept fit is stored as the size the search found, per plane | "saves a kept fit of the field size as the size the search found" and "a two-plane fit is recorded plane by plane" |
| A saved record is redrawn as stored, with nothing searched or rescored | "redraws a saved vessel evidence record without searching, and says what became of a fit", and the reload of five real cases below |
| A vessel evidence record carries no vessel presence report | `test_a_vessel_evidence_registration_carries_no_report`, the panel tests, and the five real cases below |
| The brief reads a vessel evidence record | `test_the_brief_reads_a_two_plane_vessel_evidence_registration` |
| Five public TAIR cases read under a rule fixed beforehand, labelled as one reading and not accuracy evidence | below |

## The record, tested from both sides

The fixture holds what the studio sent when driven through its own controls on the phantom: one plane with no fit, one plane with a fit that was dropped, one plane with a fit that was kept (entered 205 mm against a true 180 mm, stored at 0.895 times the entered width), two planes with no fit, and two planes with a fit kept on plane B alone. The Python test requires the server to accept each exactly as sent and to give the stored summary. The browser test requires the parser to accept each with that summary. A field name, a version or a fit rule cannot change on one side without one of the two failing.

## Mutation checks

Single-site mutants of the new guards were applied one at a time to a throwaway copy and the relevant test files run: 11 on the server side and 32 in the browser. First pass: 43 mutants, 36 killed, 7 survived.

Tests added because of survivors:

- "an unknown fit outcome on a requested fit": the list of allowed outcomes was only reached when another rule had already refused the record.
- "reads bright vessels when the frame is declared bright": both job runners passed with the polarity ignored, because every frame in the tests had dark vessels.
- "changing the method drops a one-plane proposal made by the other one": only the two-plane case was tested.
- The two-plane save test now checks that each plane's result score and starting score are stored in that order.

After those: 43 mutants, 41 killed, 2 survived. The two survivors are guards behind another guard, kept as a second line:

- `T11`: the panel's compute handler returns early on a vessel evidence record, and the action that calls it is not offered for one.
- `T21`: the save handler requires the same-position attestation for a two-plane vessel evidence proposal, and the button that calls it is disabled without it. The mutant that stops asking for the attestation (`T20`) is killed, and the server refuses such a record on its own (`P10`).

In one rerun a mutant of the one-plane job also failed a presence panel test that does not depend on it, while other test runs were using the machine. The mutant was run again alone and was killed by the test written for it only. The panel test turned out to be a Step C3 test with a race of its own, described under the final checks.

## Public subjects with a reference pose

Reported with the first pull request and unchanged by this one. Protocol `ljubljana-evidence-v1` was committed before any run on the five held-back subjects and was run once, at `c0e2ee1`: 480 registrations, none failed. The two method files in this pull request are those of that commit except for comments.

| Two planes, runs ending under 1 mm | Vessel evidence | Centerline distance |
| --- | --- | --- |
| Held-back subjects 06 to 10, entered geometry right | 18 of 25 | 5 of 25 |
| Development subjects 01 to 05, entered geometry right | 25 of 25 | 7 of 25 |
| Held-back subjects, entered field size wrong, fit on | 10 of 25 | 0 of 25 |
| Development subjects, entered field size wrong, fit on | 23 of 25 | 0 of 25 |

One held-back subject failed in every arm, including when started on the reference pose. It was not opened for diagnosis, which would have made it development data. The development figures overstate the method, since it was designed on those subjects. The data is a public copy under CC BY-NC-ND 4.0, used for internal research evaluation only. The full aggregates and the limits of the run are in [the results note](../research/ljubljana-evidence-results.md).

## Five public clinical cases

This is one reading of five cases. It shows that the path from a real biplane run to a saved, reloaded vessel evidence record runs, and what such a proposal looks like today. It is not accuracy evidence. The overlays were looked at by the agent that built this step. No clinician reviewed them.

Source: TAIR clinical data, version 1.0 (Kitware), CC BY 4.0. Nothing from the dataset, and nothing derived from it, is in the repository: frames, masks, overlays and per-case files are on external storage.

### The rule, fixed before the method was run on a TAIR frame

The rule is in [the plan](../plans/fusion-step-c4.md) and was committed as `52fe264` before the first proposal. In short: the five cases, bundles, frames, accepted vessel masks and entered geometry of the proposals the [Step C3 note](step-c3-vessel-presence.md) saved, with nothing chosen again. Vessel evidence, two planes, from the on-screen angles, dark vessels, the field-size fit on for both planes. One proposal per case, saved as proposed with the same attestation, then reloaded and redrawn once. No retries with other settings, and no pass criterion.

It ran in the studio against the running server, on a shadow copy of the Step C3 runtime with this branch's server code, so the Step C3 image and its records are as they were.

### What was checked against the rule

- Each saved record was compared with the Step C3 record of the same case: the same frame bundle, frame of each plane and frame hash, the same vessel mask, the same isocenter, polarity, geometry source and fit request, and the same entered angles and field size. All five agree.
- The server log shows one save per case, five in all. Each case holds the Step C3 record at revision 1, untouched, and the vessel evidence record at revision 2.
- No alert was shown in any case, before or after the save.

### Departures and what they were

- 00164 was driven one step at a time while the procedure was being set up, and the other four by the same steps as one script. The steps and their order were the same.
- A proposal took a few seconds. The time was not measured to any precision.

### What the proposals looked like

Scores as the studio reported them. They are the mean vessel evidence under the projected 3D points, from 0 to 1, and are not a registration accuracy.

| Case | Rays apart | Moved from the start | Step C3 proposal moved | Plane A: evidence at the start, at the result | Plane B: evidence at the start, at the result | Fit of the field size |
| --- | --- | --- | --- | --- | --- | --- |
| 00164 | 90° | 32.2 mm, 16.3° | 24.3 mm, 16.5° | 0.05, 0.11 | 0.05, 0.11 | dropped |
| 00132 | 90° | 50.2 mm, 17.7° | 49.2 mm, 12.9° | 0.09, 0.25 | 0.14, 0.22 | dropped |
| 00151 | 83° | 24.6 mm, 17.5° | 63.7 mm, 15.5° | 0.10, 0.12 | 0.09, 0.13 | dropped |
| 00161 | 87° | 23.1 mm, 15.9° | 18.4 mm, 19.5° | 0.12, 0.15 | 0.14, 0.18 | dropped |
| 00146 | 82° | 40.4 mm, 8.1° | 67.9 mm, 21.2° | 0.09, 0.16 | 0.09, 0.18 | dropped |

In every case at least 98% of the projected points were inside both frames, and between 58% and 79% of the strong line-like structure in a frame had no projected point near it.

Looking at the overlays, in none of the five cases do the projected vessels visibly lie on the filled arteries. That is what the Step C3 note said of the centerline distance proposals of the same frames.

- 00164: few filled arteries, a catheter and a dark device shadow, as the Step C3 note described. The projected tree sits around them and follows nothing. No clear difference from the Step C3 proposal.
- 00132: the proposal is close to the Step C3 one (50.2 mm against 49.2 mm from the start). The projected tree lies among the filled arteries of one hemisphere without tracing them, and in the lateral frame it is bunched in one part of a tree that fills the frame. This is again the case with the highest scores, and the scores do not show the misfit.
- 00151: worse than the Step C3 proposal. In the frontal frame one strand lies near the top of the filled carotid and the rest spreads to one side of it. In the lateral frame the tree has moved off the filled carotid, and part of it lies on a tube with markers that is not a vessel.
- 00161: the projected tree is spread wider across the frontal frame than in the Step C3 proposal and reaches below the filled arteries in the lateral one. It does not trace them. No clear difference in fit.
- 00146: worse than the Step C3 proposal in the lateral frame, where the tree has moved away from the filled arteries at the top of the frame. In the frontal frame the two are alike, and the projected trunks run down the neck where nothing is filled.

### What this says about the method

- The scores did not separate these proposals from good ones. The results here run from 0.11 to 0.25. The median result of the two-plane runs on the held-back subjects with a reference pose was 0.19, and most of those ended within 1 mm. A reader cannot tell a pose that is right from one that is wrong by this number.
- The method counts any line-like structure. In 00151 the search took a tube for a vessel. The design accepted this as a known property of the target, and this is the first case where it decided a result.
- The fit of the field size was dropped in all five cases, so every proposal is at the entered size, which the Step C3 note estimated to understate the field by about 7%. The centerline distance method had fitted between 0.96 and 1.32 times the entered width on the same frames. Neither is known to be right.
- The injections are selective and the masks are whole-head. Most of each mask has no partner in the frame at any pose. The cost was redesigned so that unmatched 3D points stop pulling the pose, and on these frames that was not enough: the search still has no way to know which part was injected.

The methods stay at version 1, as the rule fixed. These findings are inputs to the next version and are listed in the plan.

### The read-back on real data

All five records were saved, the page was reloaded, and each was read back and shown as "Showing the saved operator-confirmed two-plane proposal. It is not a validated registration." In each case the two redrawn overlays were the same images, byte for byte, as the ones shown when the proposal was made.

Before any proposal, the Step C3 record of each case was redrawn by this branch's code and shown under the same words. These are records of the centerline distance method written by the Step C3 code.

After each save the presence panel said: "A report was confirmed for an earlier proposal or an earlier revision of this case. It is not shown or reused." and "The saved proposal was made by vessel evidence. A vessel presence report reads the 2D centerlines of a centerline distance proposal, and is not available for this one." No report action was offered. The Step C3 reports themselves are still stored.

### What the cases found in the software

Nothing. No fault was found, so no case was run again.

## Final local checks

On the head of this pull request: backend 1417 passed and 127 skipped, Python lint and format checks clean; frontend 1219 passed in 99 files, TypeScript typecheck, production build and dependency audit clean (zero vulnerabilities). Every TypeScript file this pull request changes passes Prettier. Against the Step C3 baseline that is 54 more backend tests and 123 more frontend tests over the two pull requests of part 1. The native ingestion and physics suites were not run again here; nothing they cover is changed, and CI runs them.

Three existing tests were found to depend on timing and were corrected, each after reproducing the failure:

- `aneurysm-integration.test.tsx`, "requires explicit saved-state reload after a revision conflict", failed once in CI on the first pull request. The test typed and clicked while the worksheet was still locked during the reload. It now waits for the reload to finish, as an operator has to. With every read delayed by 40 ms the old test fails and the new one passes.
- `VesselPresencePanel.test.tsx`, "computes, shows and saves exactly the report the operator reviewed", failed once in a full local run. The panel reports the end of a computation or a request to its host one step after the result is on screen, and the test read that report in the same step. With the machine heavily loaded the first such place failed within 12 runs of the file, and once it was corrected a second failed in 2 of 80. The three places that read it that way now wait for it, and 80 further runs under the same load passed. The panel is unchanged.

Under that artificial load three older registration tests (two in `rigidRegistration.test.ts`, one in `biplaneRegistration.test.ts`) passed the 5 second default limit, and were at first left as they were. One of them, "holds the same gate on poses drawn after the method was fixed", then timed out in CI on this pull request at 5.8 s; it takes 2.5 s on the workstation. The searches in these files are bounded by their limits, not by the clock, so `rigidRegistration.test.ts`, `biplaneRegistration.test.ts` and `projectionRegistration.test.ts` now each state a limit of 30 s for their tests. No assertion in them is changed.

## Independent review

One independent Hermes reviewer read the whole change against eight stated requirements: older records unchanged, the two kinds of record kept apart on both sides, the server and the browser in agreement, the save payloads taken from the proposal on screen, a method change dropping an unsaved proposal, no vessel presence report on a vessel evidence record, the wording, and the tests. It reported all eight as met, with file and line, and ran the two server test files and three browser test files. It reached its step limit before it had seen the studio test file finish, so that file was reviewed by reading only; it passes in the checks above.

It raised one finding: that the panel's sentence "The saved proposal was made by vessel evidence" would also show for a proposal that is stale or absent. That is not so. The panel renders nothing unless the saved proposal is current, the sentence sits below that return, and "nothing is offered for a registration that is not current" holds it. Nothing was changed.

The reviewer was told not to review the two method files, which were reviewed before the protocol run.

The repository's automated review raised two points of wording, both in the studio and neither in a method. The words for a saved record said only that a fit was kept; they now name each field the fit moved, or say that none did, as the words for an unsaved proposal already did. The sentence for an unsaved one-plane proposal lacked a verb. Its further suggestion, to name the vessel polarity in that sentence, was not taken: the polarity is on the control beside it, and the sentence for the centerline distance method does not name it either. The five clinical cases were read before this change, and it does not alter what was shown for them: all five were two-plane proposals whose fit was dropped.

A second round raised two points of upkeep, both applied with no change in behavior. A two-plane centerline distance save no longer has a fallback sensitivity of zero: a proposal with no stated sensitivity is not saved. No path produces one today. And what a vessel evidence proposal belongs to no longer includes the sensitivity, which that method does not read.

A third round found a fault in the server. The method of a stored record picks its model and its version, and a stored row whose method had been rewritten to a list or an object raised a type error in that lookup, where every other malformed row is an invalid record. The registration route already answered 503 for it; the reading function itself now refuses it as invalid, for any caller. Test: `test_a_method_that_is_not_a_name_is_refused_as_invalid`, which fails without the change, and two more stored rows in `test_a_stored_row_that_is_not_a_record_fails_closed`. It also noted that this record and the pull request text gave different frontend counts, one written before the last tests were added; both now give the count of the final run.

A fourth round noted that a kept fit which moved a field by less than half a percent was named as moved and written as 1.00. Its suggestion, to call such a field unmoved, was not taken, because the stored size did move. The number now gets the digits that show the move (1.004), in the words for a saved record and for an unsaved proposal alike. The test of the saved words covers it; no proposal on the test phantom moves a field that little, so the unsaved sentence is covered only for its ordinary case.

## Limits

- On the five clinical cases reviewed, proposals by vessel evidence did not hold, and two were worse than the centerline distance proposals. Vessel evidence is not a better default on selective injections, and the studio's default stays centerline distance.
- The score is not an accuracy, and on these cases it did not even rank a visibly poor proposal below good ones on other data.
- The fit of the field size is not solved. It was dropped in all five clinical cases, and on the held-back subjects with a reference pose 10 of 25 runs with a wrong entered size ended under 1 mm.
- A vessel evidence record carries no vessel presence report, so the Step C3 report is only available for the older methods.
- The reference-pose figures come from ten public subjects, five of them used for development, on a public copy of the data whose license does not allow commercial use. They are development evidence.
- Five clinical cases, one frame pair each, one reader who is not a clinician, assumed geometry, and frames from screen captures. None of the numbers in that section is a performance figure.
- Not for live guidance, diagnosis or treatment decisions.
