# Ljubljana known-pose evaluation of the vessel evidence methods: protocol

Protocol `ljubljana-evidence-v1`. Fixed on 2026-11-16 and committed before the vessel evidence methods were run on subjects 06 to 10. The results are recorded separately in [ljubljana-evidence-results.md](ljubljana-evidence-results.md). Anything done differently from this page is listed there as a deviation.

It repeats [ljubljana-known-pose-v1](ljubljana-known-pose-protocol.md) with the new methods. Data, handling, licence terms, reference pose, error measures and starts are the ones written there and are not repeated here. This page records what differs.

## Purpose

The first run showed that the older methods' score did not mark the reference pose as a good pose. A diagnostic on subjects 01 to 05 ([results](ljubljana-reference-diagnostics-results.md)) found the cause in the 2D line set and the cost, and Step C4 part 1 replaced both. This run measures the replacement on the same ten subjects from the same starts.

It reports numbers and sets no pass mark. It is not a validation study.

## What the two groups of subjects are

- **Subjects 01 to 05: development.** The diagnostic looked at them at the reference pose. The new methods were then built against them: every arm of this protocol was run on these five several times while the cost, the search and the detector-fit rule were being settled. Their numbers describe how well the method was fitted to them. They are not a test.
- **Subjects 06 to 10: held back.** No diagnostic and no development run opened them, and the evaluation code refused them until this protocol was committed. They were part of the first run with the older methods, whose aggregate results over all ten were read, so they are not unseen data. No choice in the new methods was made from them.

The held-back group is the more informative one. It is five subjects from the same center and the same examination type as the development group. Agreement between the groups says the method was not fitted to five particular subjects. It does not say how the method does at another center, with another 3D modality, or on a selective injection.

## Method settings

Both methods run as committed at the commit named on the results page, with every setting at its default: `vessel_evidence_compass_v1` for one plane and `vessel_evidence_compass_biplane_v1` for two. Their settings were chosen on the synthetic phantom and on subjects 01 to 05. No setting may be changed in response to the held-back results; a later change is a new method version and needs a new protocol.

## Inputs

As in the first protocol, except the 2D target:

- **Vessel mask, 3D points, frames, frame window, frame pixels, views**: unchanged.
- **2D target**: `vesselEvidence` with dark vessels, on the same windowed 8-bit frame.

## Arms

The nine arms of the first protocol, with the same five starts per subject, and three more.

| Arm                                                                          | Planes   | Entered detector sizes             | Fit requested | Start              | Runs per group |
| ---------------------------------------------------------------------------- | -------- | ---------------------------------- | ------------- | ------------------ | -------------- |
| `biplane`                                                                    | both     | as stored                          | no            | perturbed          | 25             |
| `frontal`, `lateral`                                                         | one      | as stored                          | no            | perturbed          | 25 each        |
| `biplane_uncalibrated`                                                       | both     | 0.85 and 1.2 times the stored size | yes           | perturbed          | 25             |
| `frontal_uncalibrated`, `lateral_uncalibrated`                               | one      | 0.85 or 1.2 times the stored size  | yes           | perturbed          | 25 each        |
| `biplane_fit_right_size`, `frontal_fit_right_size`, `lateral_fit_right_size` | as above | as stored                          | yes           | perturbed          | 25 each        |
| `biplane_from_reference`, `frontal_from_reference`, `lateral_from_reference` | as above | as stored                          | no            | the reference pose | 5 each         |

The `fit_right_size` arms are new. A fit that is requested when the entered size is already right should change nothing. They measure whether it does.

## What is reported

Every number is reported for the held-back group and the development group separately, and for all ten so that it can be set beside the first run.

For each arm:

- Target error: median, mean, 90th percentile and maximum.
- Runs with target error under 1, 2 and 5 mm. A run with no proposal counts as a failure at every threshold; such runs are counted.
- Subjects with every run under each threshold.
- In-plane error per plane, as in the first protocol. It is the fair measure for the single-plane arms.
- Start error, for scale.
- For the arms that request a fit: how many fits were kept, and the absolute error of the detector scale the proposal ended with.
- For the calibrated perturbed arms: in how many runs the method's score at the reference pose was higher than at the perturbed start. This is the property the older score lacked.
- The method's mean evidence at the start and at the result.
- Median run time, and the text of any failure.

Beside these, the first run's results for `centerline_distance_compass_v1` and `centerline_distance_compass_biplane_v1` are regrouped by the same two groups from its saved per-run detail. That is a regrouping of an existing run. The older methods are not run again.

All of this is reported, not gated. The synthetic gates in the test suite are the only gates.

## How the results will be read

Written before the run, so that the reading is not fitted to the outcome.

- The comparison that matters is the held-back group under the new methods against the same five subjects under the older methods.
- If the held-back group is clearly worse than the development group, the method was fitted to the development subjects, and that is what the results page will say.
- The single-plane arms are read by in-plane error. One plane does not determine depth, and their target error is expected to stay several millimeters.
- A good result here does not carry to a CTA or MRA from another day or to a selective injection. Both are harder, and the TAIR review of part 1 is where the second is looked at.

## How the harness is checked

`ljubljanaEvidenceEvaluation.test.ts` writes two phantom subjects in the prepared layout and runs every arm on them. The two-plane arm has to come back under 1 mm, the score has to rank the reference pose above every start, a fit from wrong entered sizes has to be kept and land within 5%, and a fit from right entered sizes has to be dropped and leave the result unchanged.

## Commands

```
cd web && LJUBLJANA_PREPARED=<prepared> LJUBLJANA_RESULTS=<results> \
  LJUBLJANA_SUBJECTS=protocol \
  npx vitest run --config vitest.research.config.ts \
  src/research/ljubljanaEvidence.eval.ts
```

One run, with a clean working tree, at the commit named on the results page. Between this page and that commit the two methods may change only for reasons that do not come from subjects 06 to 10: findings of code review, the synthetic gates and the development subjects. Any such change is listed on the results page. If the run stops on a defect in the harness, the defect is fixed, the run is repeated in full, and both are recorded as a deviation.
