# Ljubljana evaluation of the learned view initializer: protocol

Protocol `ljubljana-view-initializer-v1`. Written and committed on 2026-11-18, before the network was run on subjects 06 to 10. A change after that run is a new protocol, not a correction.

## Purpose

To report, on real frames with a known pose, how far the views proposed by the learned view initializer of Step C4 part 4 lie from the stored views, and how the part 1 registrations fare when started from a proposed view against the same registrations started from the studio's default views. This is criterion 6 of the part: reported, not gated. It is research evidence on ten subjects, not a validation study.

## Data and its use

The Hugging Face copy of the Ljubljana set, prepared as for the earlier evaluations. Used for internal research evaluation only, under CC BY-NC-ND 4.0. No frame or volume of it was used to train the network or to choose its checkpoint.

- **Subjects 01 to 05: development.** They were looked at freely. They showed that the volumes are not stored in patient axes (below), and they gave the development numbers in the decisions log of `docs/plans/fusion-step-c4.md`.
- **Subjects 06 to 10: held back.** Nothing in this part has opened them. This protocol allows one run on them. Nothing is tuned on that run, and no held-back subject is opened to explain a number. They were used once before, in the one run of `ljubljana-evidence-v1` for part 1, whose results did not shape this part.

## The network

One file, fixed before this protocol: 7,097,120 bytes, SHA-256 `1c76811cc68707e9a55c8ad99b75e13eeaf9b292c1fb10db75c0e7872a2b8b56`. Trained once (seed 1) on synthetic frames of public artery masks, checkpoint chosen on synthetic validation frames, synthetic gate passed (88.4% and 63.1% against 80% and 50%). The run records the hash of the file it read.

## Axes

The files of this set give their world axes as patient axes, but the front of the head lies toward -y in them. This was read off the lateral frames of subjects 01 to 05 without the network (the face is on the side of the picture where the -y end of the 3D mask lands, in all five). Up is unchanged, so every volume of the set is taken to be in patient axes turned half round about the vertical (`volume_axes: half_turn_about_vertical`). Stored views are compared, and starts are made, in patient axes. The same reading is applied to subjects 06 to 10 without looking at them. If a held-back subject is stored differently its numbers will show it, and they are reported as they come. Left and right cannot be checked on this set.

## What is run

For each subject and each of its two frames the network reads the vessel evidence of the frame (dark vessels, the same windowed 8-bit frame as in part 1) and proposes up to five ranked views.

Registrations use `vessel_evidence_compass_v1` and `vessel_evidence_compass_biplane_v1` at their version 1 settings, with no detector-size fit, from a start that makes the plane see the patient as a given view says, with the centre of the vessel points on the central ray at the isocenter. Nine arms:

| Arm                                                     | Planes        | Start                                    |
| ------------------------------------------------------- | ------------- | ---------------------------------------- |
| `frontal_default`, `lateral_default`, `biplane_default` | one, one, two | the studio's default views, 0/0 and 90/0 |
| `frontal_first`, `lateral_first`, `biplane_first`       | one, one, two | the network's first proposal             |
| `frontal_best`, `lateral_best`, `biplane_best`          | one, one, two | the proposal nearest the stored view     |

The two-plane arms take their start from the frontal frame. The `best` arms use the stored view to pick the proposal. They show what an operator who picks well could get, and are not something the network does alone.

## What is reported

Separately for subjects 01 to 05, for 06 to 10 and for all ten:

- per plane and together: how many frames have the first proposal within 15 degrees of the stored view, how many have any of the five within 15 degrees, and how many have the default view within 15 degrees; the median of each angle; the rank of the nearest proposal;
- per arm: the turn between the start and the reference; target error over the stored 3D points (median, mean, 90th percentile, maximum, share under 1, 2 and 5 mm); in-plane error; runs that gave no proposal.

15 degrees is the measure because it is the reach of the search.

## How the results will be read

- The frames of this set were taken near standard views, so the default views start near the reference. The set can show whether the proposals contain a near view on real frames and how they are ranked. It cannot show that the network helps from a far start.
- Ten subjects: counts are reported as counts, with no significance claims.
- The development numbers were seen before this protocol was written. Only the held-back numbers are unseen.
- Whatever the held-back numbers are, the network, the proposals and the methods stay as they are for this protocol.

## How the harness is checked

`web/src/research/ljubljanaViewInitializer.test.ts` runs the whole evaluation on a phantom prepared the same way: a start made from the stored view reproduces the reference rotation in either reading of the axes, a view read against the wrong axes starts half a turn away, and a phantom a few degrees from the default views registers under 1 mm.

## Commands

```
LJUBLJANA_PREPARED=<prepared> VIEW_NETWORK=<view-network.bin> VIEW_RESULTS=<results> LJUBLJANA_SUBJECTS=protocol \
  npx vitest run --config vitest.research.config.ts src/research/ljubljanaViewInitializer.eval.ts
```

Per-frame detail stays on external storage. Only aggregates go into the results page.
