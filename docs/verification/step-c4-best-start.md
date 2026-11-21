# Step C4 part 4: the best of several starts

Verification record for the third pull request of part 4 (2026-11-21). It replaces the view picker of the second pull request with one automatic search.

## What was built

| Piece                                                                                                        | Where                                                                                           |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| The search from several starts, keeping the result with the most vessel evidence                             | `web/src/bestStart.ts`                                                                          |
| The overlay jobs take a view proposer and run that search for one plane and for two                          | `web/src/projectionOverlayJob.ts`                                                               |
| The studio fetches the view network on Propose overlay and hands it to the job                               | `web/src/ProjectionOverlayStudio.tsx`, `web/src/viewProposals.ts`                               |
| Methods `vessel_evidence_best_start_v1` and `vessel_evidence_best_start_biplane_v1`, record versions 5 and 6 | `planner/projection_registration.py`, `web/src/projectionFrames.ts`                             |
| Ljubljana harness and protocol                                                                               | `web/src/research/ljubljanaBestStart.eval.ts`, `docs/research/ljubljana-best-start-protocol.md` |

Removed: `web/src/ViewProposalPicker.tsx`, its tests, its styles, the picked start in the studio and in the overlay jobs, and the picker's verification record. The weights route, the browser's check of the file and the page-owned fetch are as merged.

## Results

Development subjects 01 to 05, run with the shipped rule and the shipped code path:

| Arm                                         | Single start | Best start |
| ------------------------------------------- | ------------ | ---------- |
| Two planes, runs under 1 mm                 | 3 of 5       | 4 of 5     |
| Two planes, median                          | 0.40 mm      | 0.40 mm    |
| Lateral frame with its view unknown, median | 45.4 mm      | 22.1 mm    |
| Frontal frame, median                       | 6.8 mm       | 6.1 mm     |
| Lateral frame, median                       | 23.1 mm      | 22.1 mm    |
| Runs that ended farther from the reference  |              | 0 of 20    |

Held-back subjects 06 to 10, one protocol run: [results](../research/ljubljana-best-start-results.md).

## Tests

- `web/src/bestStart.test.ts`: with no other start the numbers are the single search's; the start that finds the frame is kept wherever it stands in the list; the own position is kept when no other start is better; a start that fails is passed over and the first failure is reported when all fail; the result is described against the first start.
- `web/src/projectionOverlayJob.test.ts`: one plane's pose is found where the entered angles are 40 degrees off; one pose for two planes is found from a view proposed for either frame; no views are asked for another method or a redraw.
- `web/src/ProjectionOverlayStudio.test.tsx`: with the network a one-plane and a two-plane proposal are made and saved under the best-start methods; the network is fetched when the vessel evidence method is chosen and not for the centerline distance method; the wait for it runs beside the mask read; without the network the search runs from the volume's own position.
- `web/src/evidenceRecords.test.ts`, `tests/test_projection_registration_server.py`: records of versions 5 and 6 round-trip under their own names, and a record under another kind's version or with another kind's fields is refused.

Thirty-five single-site changes of the new code were made by hand (the comparison, the kept start, the failure handling, the method names, the description against the first start, the wiring of the proposer in the jobs and the studio, the wait for the weights, the slice boundaries, the version table). Each was caught by a test.

## Checks

On the head of this pull request:

- Backend: 1477 passed and 133 skipped; Python lint and format checks clean.
- Frontend: TypeScript typecheck clean; the nine test files of the touched code, 400 of 400; production build and dependency audit clean. The full frontend suite is the frontend job in CI.
