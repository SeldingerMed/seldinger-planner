# Fusion Step C4, part 4 verification: view proposals in the studio

Step C4, part 4, is a small general network that reads one frame's vessel evidence and proposes up to five views for it. The first pull request (#15, merged as `19b6961`) held the research code, the synthetic gate and the run on public subjects with a reference pose. This one brings the weights into the planner under a fixed size and hash, offers the proposals in the overlay studio as a start for the unchanged search, and reads five public clinical cases with them. The behavior is described in [Angiogram overlay and 2D-to-3D registration proposal](../angiogram-overlay.md#proposed-views), the design in [the plan](../plans/fusion-step-c4.md), and the weights in [their record](../research/view-network-v1.md). This note records what was checked and what each check does and does not show.

Evidence classes used below: unit evidence on synthetic data, mutation checks of the new guards, and one reading of five public clinical cases under a rule fixed beforehand. Nothing here is a validation study. No registration accuracy on patient data is claimed.

The headline is the same as for part 1. The software path is sound: the weights are served and used only when their size and hash are the fixed ones, a picked view turns the model as stated, the search and every saved record are as they were, and a proposal started from a picked view cannot be saved. On the five clinical cases the reading shows no gain from the proposed views. In no search did the projected tree as a whole follow the filled arteries, the scores are about those of the part 1 reading, and in one case of the five one frame looks nearer than its part 1 proposal. The control stays in the studio as a research aid whose wording says what it is. No record version was added for it.

## Delivered surface

- `planner/model_assets.py`: `VIEW_NETWORK`, the size and SHA-256 of the one weights file, and the commit that trained it.
- `planner/view_network_server.py`: `GET /api/view-network`. No parameters. The file is verified on every read. 404 when nothing is installed, 503 when what is there is not the fixed file or is a link, never cached.
- `web/src/viewNetworkFile.ts`: the same size and hash, checked in the browser before the bytes are parsed.
- `web/src/viewProposals.ts`: the network fetched once per page under a 30-second deadline, by a fetch no single caller can stop, with a failed or late fetch not kept, and the views of one frame at one polarity.
- `web/src/poseInitializer.ts`: `startFromProposedView`, the turn of the model, about a fixed point, that makes a plane at its entered angles see the model as a proposed view says.
- `web/src/projectionOverlayJob.ts`: an optional start view for the one-plane and the two-plane job. Without one the start is the volume's own position, as before. Each result states the start it used.
- `web/src/ViewProposalPicker.tsx` and `web/src/ProjectionOverlayStudio.tsx`: the control, the pick, the sentence that states the start, and a proposal from a picked view that can be reviewed and discarded only.
- `docs/research/view-network-v1.md`: how the file was made, from what, and under which terms.

`planner/projection_registration.py` is not changed. No record version is added or altered.

## Acceptance criteria and where each is checked

Criteria 1 to 6 and 9 were met in the first pull request. This one covers 7, 8 and 10.

| Criterion                                                              | Where it is checked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7. TAIR, five fixed cases, one reading under a rule written beforehand | [Five public clinical cases](#five-public-clinical-cases) below. The rule was committed as `f172858` before a view was proposed for a TAIR frame.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 8. One file whose size and SHA-256 are fixed in code                   | `tests/test_view_network_server.py`: the fixed identity, the browser's copy of it read from the TypeScript source and held equal, the verified file served whole, bytes one off in content or length refused, a link refused, a link to nothing refused, absent weights answered as not installed, a file that goes while it is being read answered the same, a read error answered as a fault, the record of the weights naming the same size, hash and training commit, a request unable to name a file or a hash, and the planner itself serving the route. `web/src/viewNetworkFile.test.ts`: the browser's own check. |
| 8. The record of how it was made                                       | `docs/research/view-network-v1.md`, read from the training record, the generation records and the manifest of sources on external storage.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 10. Saved records replay; anything a record gains is a new version     | Nothing is gained: a proposal started from a picked view is not saved. `ProjectionOverlayStudio.test.tsx` holds that no save request is sent for one, for one plane and for two. The record module and its tests are untouched, and in the reading below each of the five Step C3 records stayed at revision 1 with its vessel presence report still agreeing with a fresh computation.                                                                                                                                                                                                                                    |

Unit evidence for the new parts, all on synthetic data:

- `poseInitializer.test.ts`: the start from a proposed view is a rigid turn that leaves the pivot in place, makes the entered plane see the model as the proposed view says, in-plane turn included, and agrees with the start the Ljubljana evaluation used for a volume in patient axes.
- `projectionOverlayJob.test.ts`: a search started from a proposed view near the truth ends on it where the same search from the volume's own position does not, for one plane and for two, with the second plane keeping its entered angle to the first. Without a start view the start is the identity.
- `viewProposals.test.ts`: the views are those of the evaluation path for the same frame, the polarity is used, the network is fetched once, a failed fetch is tried again, a caller that gives up does not take the fetch from the next one, and a fetch that does not arrive in 30 seconds is given up, said to be late and tried again when asked.
- `ViewProposalPicker.test.tsx`: a share too small to round to one percent is not shown as none, a start picked for the other plane's frame is shown as the choice in force, a running request is stopped when another frame or polarity is shown, and an angle that rounds to nothing is written as 0.
- `ProjectionOverlayStudio.test.tsx`: nothing is proposed or picked until the operator asks. A pick is the start of the next search and is stated before and after it. It holds for the frame and polarity it was proposed for and for no other, and is not carried to another source. For two planes one pick serves both. Going back to the volume's own position drops a proposal made from a picked view. A network that is not installed is said so, and the search is as it was.

## Mutation checks

Single-site mutants of the new guards were applied one at a time and the relevant test files run: 8 on the server side and 43 in the browser. First pass: 51 mutants, 38 killed, 13 survived.

Tests added because of survivors:

- "a link to nothing is a fault and not an absence": a dangling link in place of the file was answered as not installed.
- "a picked view is no start for another frame of its plane": only a change of polarity was tested.
- "for two planes a picked view is for its frame and polarity, and a proposal belongs to its start": the two-plane path had neither check, and changing the start did not have to drop a two-plane proposal.
- The first studio test now checks which choice is shown as picked, the polarity test that views proposed at the other polarity can be picked in their turn, and the not-installed test that the message goes with the frame as it was read.

After those: 51 mutants, 46 killed, 5 survived. The survivors are guards behind another guard, kept as a second line:

- The browser's length check: bytes of another length also have another hash.
- The browser's refusal of a failed response: the body of one fails the length and hash check.
- The save handler's early return for a proposal started from a picked view: the save controls are not offered for one.
- The control's own disabled state, on its button and on its list: both sit inside the part of the studio that is disabled as a whole while a computation runs.

The first pass on the server side had to be repeated. A compiled copy of a mutated module was reused by the next run, so two results could not be trusted. With compiled copies switched off the eight server mutants gave the results counted above.

## Five public clinical cases

This is one reading of five cases. It shows what the network proposes for real biplane frames and what the search does from those starts today. It is not accuracy evidence. TAIR has no reference pose. The overlays were looked at by the agent that built this step. No clinician reviewed them.

Source: TAIR clinical data, version 1.0 (Kitware), CC BY 4.0. Nothing from the dataset, and nothing derived from it, is in the repository: frames, masks, overlays and per-case files are on external storage.

### The rule, fixed before a view was proposed for a TAIR frame

The rule is in [the plan](../plans/fusion-step-c4.md) and was committed as `f172858` before the first proposal. In short: the five cases, bundles, frames, accepted vessel masks and entered geometry of the proposals the [Step C3 note](step-c3-vessel-presence.md) saved, with nothing chosen again. Per case, views proposed once for each plane's frame, dark vessels. Per case two searches and no more: vessel evidence, two planes, the field-size fit on for both, one from the first proposal of plane A's frame and one from the first proposal of plane B's frame. Lower-ranked proposals are not tried. Nothing is saved. No retries, and no pass criterion.

It ran in the studio against the running server, on a shadow copy of the Step C3 runtime with this branch's server code (the tree that was committed as `8f83484`), so the Step C3 image and its records are as they were.

### What was checked against the rule

- Each case was loaded by redrawing its saved Step C3 record, which sets the bundle, both frames, the mask, the isocenter and the entered geometry from the record. Read back before each search and compared with the Step C3 setup the part 1 reading used: the bundle, the frame of each plane, the isocenter, the entered angles and the field width agree for both planes of all five cases, with dark vessels and the field-size fit on.
- Ten view requests and ten searches, two of each per case. Every search ended in a proposal. No alert was shown.
- No search offered a save. The server log holds 435 requests, all of them reads. The weights were requested ten times and served, verified, each time.
- Through both searches of every case the studio showed the saved Step C3 proposal at revision 1 and reported that its saved vessel presence report agrees with a fresh computation. The Step C3 image file still has its modification time of 15 November.

### Departures and what they were

- The workstation's job governor pauses the newest research process when the machine's research jobs are over their memory budget, and it counted the planner server as one. It paused the server four times during the reading: after 00164, while 00132 was being opened, as the first search of 00132 ended, and as the first search of 00146 began. The first two times the server was started again, before the cause was known. After that it was left paused until the governor resumed it. No search was cut short: the views and the search are computed in the browser once the frames and the mask are loaded. Cases 00132 and 00146 were opened again, by the same steps, for their plane B half.
- No completed view request or search was repeated. Driver calls that failed did so on a step ahead of the view request or the search: a helper name that was not exported, a case that had not finished opening, a control that was disabled while the server was paused. Their error text was not kept, so this rests on the driver's code and on the files each completed step wrote.
- The working tree changed twice while a case was waiting on the paused server, and the development server reloads changed modules. Between the two halves of 00132 the tree was stashed and restored once for a formatting check, the change was committed as `8f83484`, and the first mutation pass ran in the tree and was stopped and reverted. Between the two halves of 00146 a test was added and ten mutants were applied and reverted. Each time the tree was back at its commit, and the case was opened again, before the next view request. The first three searches ran on the tree before it was committed, with the content of `8f83484`.
- 00164 was driven one step at a time while the procedure was being set up, and the others by the same steps as one script.
- A search took a few seconds. The time was not measured to any precision.

### What the network proposed

Each cell is primary angle, secondary angle, in-plane turn and the network's share. The entered angles are the operator's estimate the Step C3 note used. They are not a reference.

| Case  | Plane | Entered  | View 1                | View 2                | View 3                | View 4                | View 5                |
| ----- | ----- | -------- | --------------------- | --------------------- | --------------------- | --------------------- | --------------------- |
| 00164 | A     | 0°, 0°   | 19°, 28°, -7° (4%)    | 13°, 48°, -3° (2%)    | 10°, 9°, -3° (2%)     | -3°, -40°, -7° (2%)   | -49°, 12°, 8° (1%)    |
| 00164 | B     | -90°, 0° | 99°, -13°, 18° (8%)   | 90°, 7°, 16° (7%)     | -60°, 13°, 2° (2%)    | 74°, -7°, 9° (0%)     | 112°, 7°, 15° (0%)    |
| 00132 | A     | 0°, 0°   | -68°, -10°, -20° (3%) | -20°, -18°, -1° (3%)  | -50°, -20°, -11° (2%) | -108°, 11°, -11° (1%) | -40°, -47°, -10° (1%) |
| 00132 | B     | -90°, 1° | 91°, -12°, 3° (6%)    | -67°, -9°, -18° (5%)  | 112°, 0°, -3° (3%)    | 70°, -9°, -1° (3%)    | -110°, 9°, -12° (2%)  |
| 00151 | A     | -7°, 0°  | -20°, -11°, -1° (16%) | -16°, 9°, 9° (0%)     | -26°, -31°, 0° (0%)   | 3°, -8°, 4° (0%)      | 119°, 39°, 10° (0%)   |
| 00151 | B     | -90°, 0° | 102°, 11°, 11° (3%)   | 40°, -50°, 6° (3%)    | -9°, 0°, 7° (3%)      | 119°, 28°, 10° (2%)   | 47°, -30°, 9° (2%)    |
| 00161 | A     | 10°, 36° | 29°, -49°, -3° (6%)   | 82°, 51°, 9° (6%)     | 69°, -54°, -4° (2%)   | 106°, -53°, 5° (1%)   | -9°, -40°, -4° (1%)   |
| 00161 | B     | -81°, 7° | -78°, -19°, -8° (9%)  | -108°, 10°, -7° (4%)  | -96°, -10°, -10° (2%) | 48°, -18°, -12° (1%)  | 121°, 19°, -7° (1%)   |
| 00146 | A     | -8°, 0°  | -22°, -29°, 3° (27%)  | -41°, -49°, -13° (0%) | 2°, -20°, 2° (0%)     | 4°, -45°, 10° (0%)    | -126°, 44°, -16° (0%) |
| 00146 | B     | -90°, 1° | 32°, -9°, -3° (11%)   | -109°, -12°, -5° (1%) | -89°, -11°, -3° (1%)  | 53°, -8°, -12° (1%)   | 10°, -8°, -7° (0%)    |

Against the entered angles, with the caution that those are an estimate:

- The first proposal is within 15° of the entered direction in none of the ten frames. The nearest is 17° (00151, plane A). One of the five is within 15° in three frames (00164 A, 00151 A, 00146 B).
- For three of the five lateral frames (00164, 00132, 00151) the first proposal is a lateral view from the other side of the head, 164° to 169° from the entered direction. A lateral frame and its mirror image are views from opposite sides, and the network has only the vessel pattern to tell them apart.
- The shares are low. The first proposal has under 10% in seven of the ten frames.

### What the searches did

Scores as the studio reported them. They are the mean vessel evidence under the projected 3D points, from 0 to 1, and are not a registration accuracy. Movement is from the start the picked view gave, not from the volume's own position.

| Case  | Started from view 1 of | Moved from that start | Plane A: evidence at the start, at the result | Plane B: evidence at the start, at the result | Fit of the field size |
| ----- | ---------------------- | --------------------- | --------------------------------------------- | --------------------------------------------- | --------------------- |
| 00164 | A: 19°, 28°, -7°       | 35.0 mm, 17.3°        | 0.04, 0.08                                    | 0.05, 0.10                                    | dropped               |
| 00164 | B: 99°, -13°, 18°      | 35.6 mm, 17.1°        | 0.03, 0.10                                    | 0.06, 0.11                                    | dropped               |
| 00132 | A: -68°, -10°, -20°    | 35.3 mm, 15.1°        | 0.09, 0.24                                    | 0.13, 0.20                                    | kept (0.84, 0.78)     |
| 00132 | B: 91°, -12°, 3°       | 48.6 mm, 10.2°        | 0.09, 0.22                                    | 0.13, 0.23                                    | dropped               |
| 00151 | A: -20°, -11°, -1°     | 30.5 mm, 9.6°         | 0.09, 0.11                                    | 0.09, 0.15                                    | dropped               |
| 00151 | B: 102°, 11°, 11°      | 25.2 mm, 18.1°        | 0.09, 0.12                                    | 0.08, 0.14                                    | dropped               |
| 00161 | A: 29°, -49°, -3°      | 17.1 mm, 16.1°        | 0.11, 0.14                                    | 0.13, 0.17                                    | dropped               |
| 00161 | B: -78°, -19°, -8°     | 6.2 mm, 18.6°         | 0.12, 0.15                                    | 0.14, 0.17                                    | dropped               |
| 00146 | A: -22°, -29°, 3°      | 63.1 mm, 20.3°        | 0.06, 0.12                                    | 0.09, 0.16                                    | dropped               |
| 00146 | B: 32°, -9°, -3°       | 66.7 mm, 6.1°         | 0.08, 0.17                                    | 0.09, 0.18                                    | dropped               |

In every search at least 94% of the projected points were inside both frames, and between 50% and 82% of the strong line-like structure in a frame had no projected point near it. The result scores run from 0.08 to 0.24. Each is within 0.04 of the part 1 score for the same frame from the volume's own position: lower in 12 of the 20, equal in 4 and higher in 4.

Looking at the overlays beside those of the part 1 reading: in none of the ten searches does the projected tree as a whole follow the filled arteries. In 00151, 00161 and 00146 a projected trunk lies on or beside a filled trunk over part of its length, as one did in the part 1 proposals of 00151 and 00161. A trunk of a whole-head model and a filled trunk are both long, near-vertical lines, so one lying along the other is weak evidence of a pose. In no case could a branch of the model be matched to a filled branch by eye.

- 00164: one filled carotid with faint branches, a catheter, and the dark shadow at the siphon the Step C3 note described as a device. From either start the projected tree is centred near the top of the filled carotid in the frontal frame and above or beside the siphon in the lateral one, with a trunk running beside the filled vessel and not on it. It sits in a different place from each start. No clear difference from the part 1 proposal.
- 00132: one hemisphere of the frontal frame and nearly all of the lateral frame are densely filled, so points fall on vessels wherever the tree is put. From plane A's view, with the fit kept, the tree is spread across the filled hemisphere and scattered over the lateral frame. From plane B's view it is bunched in the middle of the lateral frame. Again the highest scores of the five cases, and they do not show a fit.
- 00151: one carotid is filled. From plane A's view a projected trunk lies on the filled carotid over two stretches of the frontal frame. The filled branches at its top have no projected vessel on them, and the rest of the tree spreads to one side. From plane B's view, which looks from the other side of the head, the tree spreads to the other side of the carotid, again with a strand on its upper part. In the lateral frame the tree lies over the siphon from both starts, and from plane A's view part of it is again on the tube with markers. The three results score about the same (0.11 to 0.15), so the score does not say which side is right.
- 00161: a posterior injection. From plane A's view a projected trunk and the strands that leave its top lie close to the filled basilar artery and its top branches in the frontal frame, as a trunk did in the part 1 proposal. That picked view is 87° from the entered one. The rest of the tree, which this injection does not fill, is spread across both frames. From plane B's view the tree is spread across both frames and nothing is matched.
- 00146: the filled arteries are at the top of both frames, and a faintly filled carotid runs down from them. From either start the branches sit over the filled region and the trunks run down beside the carotid in the lateral frame, not on it. That is nearer than the part 1 proposal, whose trunks crossed empty background there. In the frontal frame the trunks pass near the carotid from plane A's view and cross it from plane B's. The scores from plane A's view are lower than the part 1 scores (0.12 and 0.16 against 0.16 and 0.18).

### What this says about the network

- The reading gives no reason to prefer a proposed view to the volume's own position on frames like these. One case of five looks nearer in one frame, by eye, and its score is no higher. That agrees with the run on subjects with a reference pose, where starting from the first proposal did worse than the default views.
- These cases cannot show the gain the network was built for. Their entered views are standard frontal and lateral views and the volume's own position is already near them, as on the reference-pose subjects. A frame taken far from a standard view, with its true view known, is what would test it, and no public set at hand has one.
- The misfit on these frames is not mainly a matter of the start. From three different starts per case the search ends in three different places with about the same score, and in 00151 two of them are mirror placements. A selective injection fills part of the tree, and the mask holds all of it.
- The lateral mirror is a concrete fault to carry to the next network. For three of the five lateral frames the first proposal looks from the other side of the head. A term or an input that tells left from right, or proposals that come as mirror pairs, would address it.

Whatever a reading shows, the rule left the network as it is. The decision the rule reserved for after the reading is the record version for a proposal started from a picked view. It is not built: nothing here supports saving such a proposal.

### What the cases found in the software

Nothing. No fault was found, so no case was run again.

## Review of the pull request

The automated review of the first head raised four findings, all in the studio and none in the server path, the start from a picked view or the save block. Each was fixed with a test written first.

- With two planes, the list for one plane's frame showed the volume's own position as chosen while the start in force was a view picked for the other plane's frame. The status line was right and the list was not. The list now shows that pick as the choice in force.
- The fetch of the weights had no deadline. The reading above shows that a server can stop answering on this workstation. The fetch now has the studio's 30 seconds and says so when they run out.
- The one fetch was tied to the first caller, so asking again for another frame while it ran failed the second request with the first one's abort. The fetch now belongs to the page.
- A share under half a percent was shown as 0%. It is now shown as under 1%.

The review of the second head raised two more, in the control, fixed the same way.

- A request for views kept running after its frame or polarity was no longer the one shown, for a result that could not be listed. It is now stopped when another frame or polarity is shown.
- An angle between -0.5 and 0 degrees was written as -0°. It is now written as 0°.

The review of the third head raised one, in the studio.

- A picked view was kept when the studio was given another source, where the same frames could make it a start. It is now dropped with the isocenter and the entered geometry.

The review of the fourth head raised one, in the server.

- Absence was decided by a look before the read, so a file that went in between was answered as a fault. It is now decided where the read fails. A link in place of the file, to something or to nothing, is still a fault.

The review of the fifth head raised two, in the server.

- A read error on the file, which lives on an external volume, was not caught and would have been answered as a server error. It is now answered as a fault of the weights, with no bytes served.
- The commit of the training code was fixed in the code and read by nothing. A test now holds it, the size and the hash equal to the record of the weights, and a comment says no record is stamped with it.

The review of the sixth head raised two, and the frontend job in CI failed once on that head.

- Deciding whether the weights are absent looks at the same volume the read failed on, and that look could itself fail. A path that cannot be looked at is now a fault.
- A failure to propose views was shown again when its frame came back on screen. It now goes when another frame or polarity is shown.
- The CI failure was in a studio test added for the first review, which asked for views before the studio had finished drawing the other plane's frame, so the click did nothing. The studio was behaving as designed. The studio tests now wait until the control takes input before they ask.

The review of the seventh head raised one.

- The 30-second deadline of the weights fetch was a second literal beside the studio's own. Both now take one value from `web/src/requestDeadline.ts`, and a studio test holds them equal.

The review of the eighth head raised one.

- Any failure that surfaced after the deadline was reported as lateness, so bytes that arrived in time and failed their check just after it would have been called late. What the check itself finds is now reported as that.

The review of the ninth head raised two, in the studio. Neither changed the code.

- That the list would, with two planes, name the pick as another plane's while its own plane's frame was being drawn again. It does not: the control draws no list while no frame is on screen. A test now holds that.
- That a pick stands when a frame with the same bytes, admitted under the same plane, is opened again in the same volume. This is intended, since a frame is known by its bytes and the views depend on nothing else, and the status line names the start in force. It is now written in the user documentation and held by a test.

The reviews of the tenth and eleventh heads raised one each.

- A test of the server failed the look at every path, not only at the weights. It now fails the look at its own path alone.
- That a view picked with one plane on screen would be lost when both planes are then fitted, because its frame would carry the label of a one-plane bundle. It is not lost: the frames of a two-plane bundle are plane A's and plane B's whether or not both are fitted, and a one-plane bundle cannot be fitted as two. A test now holds that the pick stands. No code changed.

The review of the twelfth head raised one.

- What is reported after the deadline was decided by the wording of the failure. It is now decided by what happened: only an abort, once the deadline has passed, is lateness, and anything else is reported as what it is. Six single-site changes of that rule were each caught.

The review of the thirteenth head raised three.

- The documentation said a pick stands for the same frame and left out that it must be admitted under the same plane, which the code requires. The user documentation and this record now say so.
- A share of 99.5% or more was written as 100%. It is now written as over 99%.
- The browser's loader takes the expected size and hash as an argument, which only the tests give. Its comment now says so.

The mutation counts above are of the first head. The new guards were checked the same way: twenty-two single-site changes (the list's choice in force in the control and in the studio, the share's wording, the deadline's abort, message and timer, the fetch's own signal, a caller's abort, a failed fetch not being kept, the stop on another frame or polarity, the wording of a small negative angle, the drop on another source, three of the server's decision between absent and faulty, the answer to a read error, the training commit, two of the answer to a path that cannot be looked at, the failure going with its frame, and two of what is reported after the deadline), all twenty-two caught.

## Final local checks

On the head of this pull request: backend 1473 passed and 133 skipped, Python lint and format checks clean, TypeScript typecheck clean. The full frontend suite on the head is the frontend job in CI, which has to pass before the merge. The local frontend runs were made on a workstation shared with other research jobs, whose job governor pauses test workers when more than three heavy jobs are running. Full local runs on earlier heads: 1325 of 1325 on the first; later 1329 of 1331 and 1332 of 1333, the three failures being timeouts or a single failure in files this pull request does not touch, each of which passed when its file was run again. On the last heads the governor held the full run behind three other jobs, so the test files of the studio, the control, the proposals and the weights file were run on their own on the final head: 85 of 85 in the four files. The production build and the dependency audit (zero vulnerabilities) were clean on the earlier heads, and no dependency is changed by this pull request. Every file this pull request changes passes Prettier. The native ingestion and physics suites were not run again here; nothing they cover is changed.

## Limits

- The network was trained on synthetic frames from TOF-MRA vessel masks that their owners release for academic research use only. The weights are for internal research, are not distributed and are not cleared for commercial use.
- No accuracy of a proposed view is claimed on patient frames. On the ten public subjects with a reference pose the first proposal was within 15° in four of ten held-back frames, and on the five clinical cases the reading shows no gain from a proposed start.
- The start from a proposed view assumes a volume in patient axes, which a CTA or MRA volume is. It is not checked.
- The reading was made by the agent that built the step, once, on five cases.
- A proposal started from a picked view cannot be saved, so nothing downstream (vessel presence, the brief) can be based on one.
