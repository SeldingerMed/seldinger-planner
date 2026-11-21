# Ljubljana evaluation of the best-start search: protocol

Protocol `ljubljana-best-start-v1`. Written and committed on 2026-11-21, before the best-start search was run on subjects 06 to 10. A change after that run is a new protocol.

## Purpose

To measure, on real frames with a known pose, what the vessel evidence search gains when it is run from several starts and the result with the most vessel evidence is kept (`web/src/bestStart.ts`), against the same search run from one start.

## Data and its use

The Hugging Face copy of the Ljubljana set, prepared as for the earlier evaluations. Internal research evaluation only, under CC BY-NC-ND 4.0. No frame or volume of it was used to train the view network.

- **Subjects 01 to 05: development.** The rule below was chosen on them.
- **Subjects 06 to 10: held back.** This protocol allows one run on them. Nothing is tuned on that run.

## The rule

Fixed before the run, and the rule the planner ships:

1. The first start is the one the search would have had alone.
2. The other starts are the views the view network proposes for each frame searched (up to five per frame), each made into a start by turning the model about the centre of its vessel points.
3. The unchanged search (`vessel_evidence_compass_v1`, `vessel_evidence_compass_biplane_v1`, no detector-size fit) is run from every start.
4. The result with the highest mean vessel evidence under the projected points, averaged over the planes, is kept. A later start has to be better than the first to replace it.

The view network is the one fixed file of `docs/research/view-network-v1.md` (SHA-256 `1c76811cc68707e9a55c8ad99b75e13eeaf9b292c1fb10db75c0e7872a2b8b56`). Volume axes are handled as in `ljubljana-view-initializer-v1`.

## What is run

Four arms per subject. In each, the single start and the best start are run on the same input.

| Arm               | Planes  | First start                                   |
| ----------------- | ------- | --------------------------------------------- |
| `frontal`         | frontal | the default frontal view, 0/0                 |
| `lateral`         | lateral | the default lateral view, 90/0                |
| `biplane`         | both    | the default frontal view, 0/0                 |
| `lateral_unknown` | lateral | the default frontal view: the view is unknown |

## What is reported

Separately for subjects 01 to 05, for 06 to 10 and for all ten, per arm, for the single start and for the best start: the median target error over the stored 3D points, the number of runs under 1, 2 and 5 mm, and runs with no proposal. Also how often the first start was kept, and how often the best start ended nearer to or farther from the reference than the single start by more than 0.05 mm.

The measure of the method is the `biplane` arm on subjects 06 to 10: runs under 1 mm, best start against single start. One plane fixes depth only weakly, so the one-plane arms are reported for the direction of the change.

## The run

`runs: 1`. From a clean tree at the commit that holds this protocol and the code:

```
LJUBLJANA_PREPARED=<dir> VIEW_NETWORK=<view-network.bin> \
BEST_START_RESULTS=<results>/<commit> LJUBLJANA_SUBJECTS=protocol \
  npx vitest run --config vitest.research.config.ts \
  src/research/ljubljanaBestStart.eval.ts
```

The results directory is named by the commit and an existing one is refused. Per-run detail stays on the external volume. Aggregates go to `docs/research/ljubljana-best-start-results.md`.
