# Ljubljana detector-size protocol

Protocol `ljubljana-detector-size-v1`. Committed before its one run on the held-back subjects.

## Question

When the field size is entered wrong and a fit is requested, does the search from several entered sizes (`sizeSearch.ts`) end nearer the reference pose than the fit from the entered size alone?

## Data

The ten Ljubljana subjects as prepared for `ljubljana-evidence-v1`: the Hugging Face copy, internal research evaluation only. Subjects 01 to 05 were used for development of this method. Subjects 06 to 10 are held back; they were read by three earlier protocols, so they are not unseen data.

## Runs

For every subject, the five perturbed starts of `ljubljana-evidence-v1`, each with three pairs of entered sizes and three arms:

| Entered size, frontal and lateral, as a multiple of the stored size | Arms                                     |
| ------------------------------------------------------------------- | ---------------------------------------- |
| 0.85 and 1.2 (the pair of `ljubljana-evidence-v1`)                  | two planes, frontal alone, lateral alone |
| 1.33 and 0.75                                                       | two planes, frontal alone, lateral alone |
| 1 and 1 (entered right, fit requested)                              | two planes, frontal alone, lateral alone |

Each run is made twice from the same start and the same entered sizes: once by the fitted search as it stands (`vessel_evidence_compass_v1` and its two-plane form), once by the size search. 45 runs per subject and method, 225 per group of five subjects.

## Measures

- Two planes: mean target error against the reference pose, in mm. One plane: in-plane error at the fitted view, in mm.
- Runs under 1 mm, the median error, and the count of runs that ended more than 0.5 mm nearer or farther with the size search than with the fit, of the runs with a proposal from both.
- Scale error: the size the proposal ended with against the stored size, as a fraction.
- Runs with no proposal are counted apart.
- Seconds per run.

## Primary result

Held-back subjects, two planes, sizes entered wrong (both pairs, 50 runs): runs under 1 mm with the size search against the fit.

## Conduct

One run with `LJUBLJANA_SUBJECTS=all` at the commit that holds this file and the harness `web/src/research/ljubljanaDetectorSize.eval.ts`. The results directory is named by that commit and is refused if it exists. Nothing is tuned on the held-back subjects afterwards. Only the search's own failure is recorded as no proposal; any other error stops the run.
