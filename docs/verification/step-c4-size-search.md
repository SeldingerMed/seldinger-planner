# Step C4 part 2: the search of the field size

Verification record for part 2 (2026-11-21).

## What was built

| Piece                                                                                                           | Where                                                                                                 |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| The search of the field size from several sizes around the entered one, keeping the result with the lowest cost | `web/src/sizeSearch.ts`                                                                               |
| The best-start search ends with it when a fit is requested                                                      | `web/src/bestStart.ts`                                                                                |
| The overlay jobs send a vessel evidence proposal with a requested fit that way, for one plane and for two       | `web/src/projectionOverlayJob.ts`                                                                     |
| Methods `vessel_evidence_size_search_v1` and `vessel_evidence_size_search_biplane_v1`, record versions 7 and 8  | `planner/projection_registration.py`, `web/src/projectionFrames.ts`                                   |
| The studio's words for the fit and for a proposal made this way                                                 | `web/src/ProjectionOverlayStudio.tsx`                                                                 |
| Ljubljana harness and protocol                                                                                  | `web/src/research/ljubljanaDetectorSize.eval.ts`, `docs/research/ljubljana-detector-size-protocol.md` |

The studio has no new control: with vessel evidence chosen and the fit on, the size is searched.

## Results

Protocol `ljubljana-detector-size-v1`, run once at `cb8a241` ([results](../research/ljubljana-detector-size-results.md)). Runs under 1 mm of the reference pose:

| Two planes, sizes entered wrong                      | Fit from the entered size | Search of the size |
| ---------------------------------------------------- | ------------------------- | ------------------ |
| Held-back subjects 06 to 10 (the protocol's measure) | 25 of 50                  | 37 of 50           |
| Development subjects 01 to 05                        | 44 of 50                  | 50 of 50           |
| All ten subjects                                     | 69 of 100                 | 87 of 100          |
| All ten, runs that ended nearer / farther            |                           | 26 / 0 of 100      |

| Held back, sizes entered 0.85 and 1.2 times the stored ones | Fit from the entered size | Search of the size |
| ----------------------------------------------------------- | ------------------------- | ------------------ |
| Two planes, under 1 mm                                      | 10 of 25                  | 20 of 25           |
| Two planes, median                                          | 7.44 mm                   | 0.43 mm            |
| Two planes, median size error                               | 6.6%                      | 0.3%               |
| Lateral frame, under 1 mm                                   | 10 of 25                  | 16 of 25           |
| Frontal frame, under 1 mm                                   | 14 of 25                  | 17 of 25           |

With the sizes entered right and the fit requested, all 150 runs ended where the fit ended. Of the 13 held-back two-plane runs over 1 mm, 10 are subject 06, which fails in every arm of every protocol. One-plane runs: 60 of 300 ended nearer and 9 farther over all ten subjects. A two-plane proposal took a median of 7.7 to 8.1 seconds, against 1.2 to 1.3.

## Tests

- `web/src/sizeSearch.test.ts`: an input with no size to fit is refused; with the entered size within the fit's reach the result is the fit's, under the size-search name; a size the fit cannot reach from the entered one is found and described against the entered size; each fitted plane is run alone along the ladder and the fit from its two best sizes, and the fit from the entered sizes is not run twice; two planes entered wrong in opposite senses each get their own size; a plane with no fit requested stays at its entered size; a result handed in is not searched for again and its evaluations are counted; another size is kept only when it lowers the cost by the fit's margin, measured from the cost at the entered sizes; a size above or below what the view model or the record accepts is passed over; a search that finds no pose is passed over and any other error stops the run; on a rendered frame a size entered a third too small is recovered, yielding between slices.
- `web/src/bestStart.test.ts`: with a requested fit and no other start the result is the size search's from the own position; with other starts the size is searched from the kept start, that start's result is handed over, and the result is described from the own position; with no fit requested the best-start name and numbers stay.
- `web/src/projectionOverlayJob.test.ts`: one plane's size is searched with or without proposed views; of two planes, the size of the one that asks for it.
- `web/src/ProjectionOverlayStudio.test.tsx`: the fit's help text under vessel evidence, the status of a proposal made this way, and the inputs it is saved with.
- `web/src/evidenceRecords.test.ts`, `tests/test_projection_registration_server.py`: records of versions 7 and 8 round-trip under their own names; a size-search record with no requested fit, under another kind's version, or with another kind's fields is refused.

Forty-two single-site changes of the new code were made by hand (the limits, the ladder and its order, the two best sizes, the margin and what it is measured from, the kept scale and start scores, the gain, the count of evaluations, the failure handling, the method names, the hand-over from the best start, the routing in both overlay jobs, the version tables and the rule that a size-search record has a requested fit, in the browser and the server). Thirty-eight were caught by the tests as first written. Tests were added for the other four, and each of the forty-two is now caught.

## Checks

On the head of this pull request:

- Backend: 1481 passed and 133 skipped; Python lint and format checks clean.
- Frontend: TypeScript typecheck clean; the seven test files of the touched code, 352 of 352; production build and dependency audit clean. The full frontend suite is the frontend job in CI.
