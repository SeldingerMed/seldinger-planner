# Ljubljana evaluation of the field-size search: results

Protocol [`ljubljana-detector-size-v1`](ljubljana-detector-size-protocol.md), run once on 2026-11-21 at commit `cb8a241`. Target error is the mean distance over the stored 3D points between the found pose and the reference pose for two planes, and the in-plane error at the fitted view for one. Entered sizes are multiples of the stored field size, frontal then lateral. Size error is the size the proposal ended with against the stored size.

## The measure

Two planes on held-back subjects 06 to 10, sizes entered wrong, runs under 1 mm: **37 of 50** from the size search, 25 of 50 from the fit.

## Subjects 06 to 10 (held back)

| Entered sizes | Arm           | Method      | Median  | Under 1 mm | Under 2 mm | Under 5 mm | Median size error | No proposal |
| ------------- | ------------- | ----------- | ------- | ---------- | ---------- | ---------- | ----------------- | ----------- |
| 0.85 and 1.2  | Two planes    | fit         | 7.44 mm | 10 of 25   | 10 of 25   | 10 of 25   | 6.6%              | 0           |
| 0.85 and 1.2  | Two planes    | size search | 0.43 mm | 20 of 25   | 20 of 25   | 20 of 25   | 0.3%              | 0           |
| 0.85 and 1.2  | Frontal frame | fit         | 0.51 mm | 14 of 25   | 14 of 25   | 14 of 25   | 1.5%              | 0           |
| 0.85 and 1.2  | Frontal frame | size search | 0.34 mm | 17 of 25   | 18 of 25   | 19 of 25   | 1.2%              | 0           |
| 0.85 and 1.2  | Lateral frame | fit         | 7.85 mm | 10 of 25   | 10 of 25   | 10 of 25   | 13.5%             | 0           |
| 0.85 and 1.2  | Lateral frame | size search | 0.57 mm | 16 of 25   | 16 of 25   | 19 of 25   | 1.8%              | 0           |
| 1.33 and 0.75 | Two planes    | fit         | 0.48 mm | 15 of 25   | 17 of 25   | 19 of 25   | 0.4%              | 0           |
| 1.33 and 0.75 | Two planes    | size search | 0.46 mm | 17 of 25   | 20 of 25   | 20 of 25   | 0.4%              | 0           |
| 1.33 and 0.75 | Frontal frame | fit         | 0.58 mm | 16 of 25   | 16 of 25   | 18 of 25   | 1.6%              | 0           |
| 1.33 and 0.75 | Frontal frame | size search | 0.31 mm | 20 of 25   | 20 of 25   | 20 of 25   | 1.5%              | 0           |
| 1.33 and 0.75 | Lateral frame | fit         | 0.42 mm | 14 of 25   | 14 of 25   | 15 of 25   | 1.3%              | 0           |
| 1.33 and 0.75 | Lateral frame | size search | 0.42 mm | 15 of 25   | 15 of 25   | 15 of 25   | 1.2%              | 0           |
| 1 and 1       | Two planes    | fit         | 0.46 mm | 18 of 25   | 20 of 25   | 20 of 25   | 0.0%              | 0           |
| 1 and 1       | Two planes    | size search | 0.46 mm | 18 of 25   | 20 of 25   | 20 of 25   | 0.0%              | 0           |
| 1 and 1       | Frontal frame | fit         | 0.34 mm | 20 of 25   | 20 of 25   | 20 of 25   | 0.0%              | 0           |
| 1 and 1       | Frontal frame | size search | 0.34 mm | 20 of 25   | 20 of 25   | 20 of 25   | 0.0%              | 0           |
| 1 and 1       | Lateral frame | fit         | 0.30 mm | 19 of 25   | 20 of 25   | 21 of 25   | 0.0%              | 0           |
| 1 and 1       | Lateral frame | size search | 0.30 mm | 19 of 25   | 20 of 25   | 21 of 25   | 0.0%              | 0           |

| Entered sizes | Arm           | Size search ended nearer | Size search ended farther | Seconds, fit | Seconds, size search |
| ------------- | ------------- | ------------------------ | ------------------------- | ------------ | -------------------- |
| 0.85 and 1.2  | Two planes    | 14 of 25                 | 0 of 25                   | 1.2 s        | 7.8 s                |
| 0.85 and 1.2  | Frontal frame | 6 of 25                  | 1 of 25                   | 0.3 s        | 1.7 s                |
| 0.85 and 1.2  | Lateral frame | 14 of 25                 | 1 of 25                   | 0.3 s        | 1.6 s                |
| 1.33 and 0.75 | Two planes    | 6 of 25                  | 0 of 25                   | 1.1 s        | 7.6 s                |
| 1.33 and 0.75 | Frontal frame | 4 of 25                  | 0 of 25                   | 0.3 s        | 1.5 s                |
| 1.33 and 0.75 | Lateral frame | 4 of 25                  | 1 of 25                   | 0.3 s        | 1.6 s                |
| 1 and 1       | Two planes    | 0 of 25                  | 0 of 25                   | 1.2 s        | 6.8 s                |
| 1 and 1       | Frontal frame | 0 of 25                  | 0 of 25                   | 0.3 s        | 1.5 s                |
| 1 and 1       | Lateral frame | 0 of 25                  | 0 of 25                   | 0.3 s        | 1.4 s                |

## Subjects 01 to 05 (development)

| Entered sizes | Arm           | Method      | Median  | Under 1 mm | Under 2 mm | Under 5 mm | Median size error | No proposal |
| ------------- | ------------- | ----------- | ------- | ---------- | ---------- | ---------- | ----------------- | ----------- |
| 0.85 and 1.2  | Two planes    | fit         | 0.42 mm | 23 of 25   | 23 of 25   | 23 of 25   | 0.4%              | 0           |
| 0.85 and 1.2  | Two planes    | size search | 0.40 mm | 25 of 25   | 25 of 25   | 25 of 25   | 0.4%              | 0           |
| 0.85 and 1.2  | Frontal frame | fit         | 0.34 mm | 25 of 25   | 25 of 25   | 25 of 25   | 0.7%              | 0           |
| 0.85 and 1.2  | Frontal frame | size search | 0.34 mm | 25 of 25   | 25 of 25   | 25 of 25   | 0.6%              | 0           |
| 0.85 and 1.2  | Lateral frame | fit         | 0.45 mm | 15 of 25   | 16 of 25   | 20 of 25   | 1.1%              | 0           |
| 0.85 and 1.2  | Lateral frame | size search | 0.28 mm | 21 of 25   | 21 of 25   | 22 of 25   | 0.6%              | 0           |
| 1.33 and 0.75 | Two planes    | fit         | 0.41 mm | 21 of 25   | 21 of 25   | 23 of 25   | 0.4%              | 0           |
| 1.33 and 0.75 | Two planes    | size search | 0.39 mm | 25 of 25   | 25 of 25   | 25 of 25   | 0.4%              | 0           |
| 1.33 and 0.75 | Frontal frame | fit         | 0.35 mm | 25 of 25   | 25 of 25   | 25 of 25   | 0.5%              | 0           |
| 1.33 and 0.75 | Frontal frame | size search | 0.32 mm | 25 of 25   | 25 of 25   | 25 of 25   | 0.5%              | 0           |
| 1.33 and 0.75 | Lateral frame | fit         | 0.23 mm | 21 of 25   | 21 of 25   | 24 of 25   | 0.7%              | 0           |
| 1.33 and 0.75 | Lateral frame | size search | 0.24 mm | 22 of 25   | 22 of 25   | 22 of 25   | 0.6%              | 0           |
| 1 and 1       | Two planes    | fit         | 0.39 mm | 25 of 25   | 25 of 25   | 25 of 25   | 0.0%              | 0           |
| 1 and 1       | Two planes    | size search | 0.39 mm | 25 of 25   | 25 of 25   | 25 of 25   | 0.0%              | 0           |
| 1 and 1       | Frontal frame | fit         | 0.36 mm | 25 of 25   | 25 of 25   | 25 of 25   | 0.0%              | 0           |
| 1 and 1       | Frontal frame | size search | 0.36 mm | 25 of 25   | 25 of 25   | 25 of 25   | 0.0%              | 0           |
| 1 and 1       | Lateral frame | fit         | 0.29 mm | 22 of 25   | 22 of 25   | 24 of 25   | 0.0%              | 0           |
| 1 and 1       | Lateral frame | size search | 0.29 mm | 22 of 25   | 22 of 25   | 24 of 25   | 0.0%              | 0           |

| Entered sizes | Arm           | Size search ended nearer | Size search ended farther | Seconds, fit | Seconds, size search |
| ------------- | ------------- | ------------------------ | ------------------------- | ------------ | -------------------- |
| 0.85 and 1.2  | Two planes    | 2 of 25                  | 0 of 25                   | 1.3 s        | 8.1 s                |
| 0.85 and 1.2  | Frontal frame | 0 of 25                  | 0 of 25                   | 0.3 s        | 1.7 s                |
| 0.85 and 1.2  | Lateral frame | 7 of 25                  | 3 of 25                   | 0.3 s        | 1.6 s                |
| 1.33 and 0.75 | Two planes    | 4 of 25                  | 0 of 25                   | 1.2 s        | 7.8 s                |
| 1.33 and 0.75 | Frontal frame | 0 of 25                  | 0 of 25                   | 0.3 s        | 1.5 s                |
| 1.33 and 0.75 | Lateral frame | 1 of 25                  | 2 of 25                   | 0.3 s        | 1.6 s                |
| 1 and 1       | Two planes    | 0 of 25                  | 0 of 25                   | 1.3 s        | 6.7 s                |
| 1 and 1       | Frontal frame | 0 of 25                  | 0 of 25                   | 0.3 s        | 1.4 s                |
| 1 and 1       | Lateral frame | 0 of 25                  | 0 of 25                   | 0.3 s        | 1.3 s                |

## All ten subjects

| Entered sizes | Arm           | Method      | Median  | Under 1 mm | Under 2 mm | Under 5 mm | Median size error | No proposal |
| ------------- | ------------- | ----------- | ------- | ---------- | ---------- | ---------- | ----------------- | ----------- |
| 0.85 and 1.2  | Two planes    | fit         | 0.44 mm | 33 of 50   | 33 of 50   | 33 of 50   | 0.5%              | 0           |
| 0.85 and 1.2  | Two planes    | size search | 0.40 mm | 45 of 50   | 45 of 50   | 45 of 50   | 0.4%              | 0           |
| 0.85 and 1.2  | Frontal frame | fit         | 0.36 mm | 39 of 50   | 39 of 50   | 39 of 50   | 1.0%              | 0           |
| 0.85 and 1.2  | Frontal frame | size search | 0.34 mm | 42 of 50   | 43 of 50   | 44 of 50   | 0.9%              | 0           |
| 0.85 and 1.2  | Lateral frame | fit         | 0.87 mm | 25 of 50   | 26 of 50   | 30 of 50   | 2.3%              | 0           |
| 0.85 and 1.2  | Lateral frame | size search | 0.35 mm | 37 of 50   | 37 of 50   | 41 of 50   | 1.0%              | 0           |
| 1.33 and 0.75 | Two planes    | fit         | 0.44 mm | 36 of 50   | 38 of 50   | 42 of 50   | 0.4%              | 0           |
| 1.33 and 0.75 | Two planes    | size search | 0.41 mm | 42 of 50   | 45 of 50   | 45 of 50   | 0.4%              | 0           |
| 1.33 and 0.75 | Frontal frame | fit         | 0.39 mm | 41 of 50   | 41 of 50   | 43 of 50   | 1.0%              | 0           |
| 1.33 and 0.75 | Frontal frame | size search | 0.32 mm | 45 of 50   | 45 of 50   | 45 of 50   | 0.9%              | 0           |
| 1.33 and 0.75 | Lateral frame | fit         | 0.29 mm | 35 of 50   | 35 of 50   | 39 of 50   | 0.9%              | 0           |
| 1.33 and 0.75 | Lateral frame | size search | 0.31 mm | 37 of 50   | 37 of 50   | 37 of 50   | 0.9%              | 0           |
| 1 and 1       | Two planes    | fit         | 0.39 mm | 43 of 50   | 45 of 50   | 45 of 50   | 0.0%              | 0           |
| 1 and 1       | Two planes    | size search | 0.39 mm | 43 of 50   | 45 of 50   | 45 of 50   | 0.0%              | 0           |
| 1 and 1       | Frontal frame | fit         | 0.35 mm | 45 of 50   | 45 of 50   | 45 of 50   | 0.0%              | 0           |
| 1 and 1       | Frontal frame | size search | 0.35 mm | 45 of 50   | 45 of 50   | 45 of 50   | 0.0%              | 0           |
| 1 and 1       | Lateral frame | fit         | 0.30 mm | 41 of 50   | 42 of 50   | 45 of 50   | 0.0%              | 0           |
| 1 and 1       | Lateral frame | size search | 0.30 mm | 41 of 50   | 42 of 50   | 45 of 50   | 0.0%              | 0           |

| Entered sizes | Arm           | Size search ended nearer | Size search ended farther | Seconds, fit | Seconds, size search |
| ------------- | ------------- | ------------------------ | ------------------------- | ------------ | -------------------- |
| 0.85 and 1.2  | Two planes    | 16 of 50                 | 0 of 50                   | 1.3 s        | 8.1 s                |
| 0.85 and 1.2  | Frontal frame | 6 of 50                  | 1 of 50                   | 0.3 s        | 1.7 s                |
| 0.85 and 1.2  | Lateral frame | 21 of 50                 | 4 of 50                   | 0.3 s        | 1.6 s                |
| 1.33 and 0.75 | Two planes    | 10 of 50                 | 0 of 50                   | 1.2 s        | 7.7 s                |
| 1.33 and 0.75 | Frontal frame | 4 of 50                  | 0 of 50                   | 0.3 s        | 1.5 s                |
| 1.33 and 0.75 | Lateral frame | 5 of 50                  | 3 of 50                   | 0.3 s        | 1.6 s                |
| 1 and 1       | Two planes    | 0 of 50                  | 0 of 50                   | 1.3 s        | 6.8 s                |
| 1 and 1       | Frontal frame | 0 of 50                  | 0 of 50                   | 0.3 s        | 1.4 s                |
| 1 and 1       | Lateral frame | 0 of 50                  | 0 of 50                   | 0.3 s        | 1.3 s                |

"Ended nearer" and "ended farther" compare the size search with the fit on the same start and the same entered sizes, by more than 0.5 mm.

## The run

All 450 runs of each method finished and were written. Per-run detail is on the external volume under `fusion-c4/detector-size/cb8a241/`.
