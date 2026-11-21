# Ljubljana evaluation of the best-start search: results

Protocol [`ljubljana-best-start-v1`](ljubljana-best-start-protocol.md), run once on 2026-11-21 at commit `917e38c`. View network SHA-256 `1c76811cc68707e9a55c8ad99b75e13eeaf9b292c1fb10db75c0e7872a2b8b56`. Target error is the mean distance over the stored 3D points between the found pose and the reference pose.

## The measure

Two planes on held-back subjects 06 to 10, runs under 1 mm: **4 of 5** from the best of several starts, 4 of 5 from the single start.

## Subjects 06 to 10 (held back)

| Arm                         | Start           | Median  | Under 1 mm | Under 2 mm | Under 5 mm | No proposal |
| --------------------------- | --------------- | ------- | ---------- | ---------- | ---------- | ----------- |
| Two planes                  | single          | 0.27 mm | 4 of 5     | 4 of 5     | 4 of 5     | 0           |
| Two planes                  | best of several | 0.23 mm | 4 of 5     | 4 of 5     | 4 of 5     | 0           |
| Frontal frame               | single          | 5.3 mm  | 1 of 5     | 1 of 5     | 2 of 5     | 0           |
| Frontal frame               | best of several | 4.8 mm  | 1 of 5     | 1 of 5     | 3 of 5     | 0           |
| Lateral frame               | single          | 25.5 mm | 0 of 5     | 0 of 5     | 0 of 5     | 0           |
| Lateral frame               | best of several | 25.5 mm | 0 of 5     | 0 of 5     | 0 of 5     | 0           |
| Lateral frame, view unknown | single          | 48.1 mm | 0 of 5     | 0 of 5     | 0 of 5     | 0           |
| Lateral frame, view unknown | best of several | 28.9 mm | 0 of 5     | 0 of 5     | 0 of 5     | 0           |

| Arm                         | First start kept | Ended nearer | Ended farther |
| --------------------------- | ---------------- | ------------ | ------------- |
| Two planes                  | 2 of 5           | 2 of 5       | 0 of 5        |
| Frontal frame               | 2 of 5           | 2 of 5       | 1 of 5        |
| Lateral frame               | 3 of 5           | 1 of 5       | 1 of 5        |
| Lateral frame, view unknown | 2 of 5           | 3 of 5       | 0 of 5        |

## Subjects 01 to 05 (development)

| Arm                         | Start           | Median  | Under 1 mm | Under 2 mm | Under 5 mm | No proposal |
| --------------------------- | --------------- | ------- | ---------- | ---------- | ---------- | ----------- |
| Two planes                  | single          | 0.40 mm | 3 of 5     | 3 of 5     | 5 of 5     | 0           |
| Two planes                  | best of several | 0.40 mm | 4 of 5     | 4 of 5     | 5 of 5     | 0           |
| Frontal frame               | single          | 6.8 mm  | 1 of 5     | 1 of 5     | 2 of 5     | 0           |
| Frontal frame               | best of several | 6.1 mm  | 1 of 5     | 1 of 5     | 2 of 5     | 0           |
| Lateral frame               | single          | 23.1 mm | 0 of 5     | 0 of 5     | 0 of 5     | 0           |
| Lateral frame               | best of several | 22.1 mm | 0 of 5     | 0 of 5     | 0 of 5     | 0           |
| Lateral frame, view unknown | single          | 45.4 mm | 0 of 5     | 0 of 5     | 0 of 5     | 0           |
| Lateral frame, view unknown | best of several | 22.1 mm | 0 of 5     | 0 of 5     | 0 of 5     | 0           |

| Arm                         | First start kept | Ended nearer | Ended farther |
| --------------------------- | ---------------- | ------------ | ------------- |
| Two planes                  | 2 of 5           | 1 of 5       | 0 of 5        |
| Frontal frame               | 2 of 5           | 2 of 5       | 0 of 5        |
| Lateral frame               | 2 of 5           | 3 of 5       | 0 of 5        |
| Lateral frame, view unknown | 0 of 5           | 5 of 5       | 0 of 5        |

## All ten subjects

| Arm                         | Start           | Median  | Under 1 mm | Under 2 mm | Under 5 mm | No proposal |
| --------------------------- | --------------- | ------- | ---------- | ---------- | ---------- | ----------- |
| Two planes                  | single          | 0.40 mm | 7 of 10    | 7 of 10    | 9 of 10    | 0           |
| Two planes                  | best of several | 0.38 mm | 8 of 10    | 8 of 10    | 9 of 10    | 0           |
| Frontal frame               | single          | 6.1 mm  | 2 of 10    | 2 of 10    | 4 of 10    | 0           |
| Frontal frame               | best of several | 5.4 mm  | 2 of 10    | 2 of 10    | 5 of 10    | 0           |
| Lateral frame               | single          | 25.4 mm | 0 of 10    | 0 of 10    | 0 of 10    | 0           |
| Lateral frame               | best of several | 24.7 mm | 0 of 10    | 0 of 10    | 0 of 10    | 0           |
| Lateral frame, view unknown | single          | 45.6 mm | 0 of 10    | 0 of 10    | 0 of 10    | 0           |
| Lateral frame, view unknown | best of several | 28.5 mm | 0 of 10    | 0 of 10    | 0 of 10    | 0           |

| Arm                         | First start kept | Ended nearer | Ended farther |
| --------------------------- | ---------------- | ------------ | ------------- |
| Two planes                  | 4 of 10          | 3 of 10      | 0 of 10       |
| Frontal frame               | 4 of 10          | 4 of 10      | 1 of 10       |
| Lateral frame               | 5 of 10          | 4 of 10      | 1 of 10       |
| Lateral frame, view unknown | 2 of 10          | 8 of 10      | 0 of 10       |

"Ended nearer" and "ended farther" compare the best of several starts with the single start on the same input, by more than 0.05 mm.

## The run

All 40 runs finished and were written. The machine's job queue held the run for about four and a half hours, so the test runner reported its one-hour limit after the results were on disk. Per-run detail is on the external volume under `fusion-c4/best-start/917e38c/`.
