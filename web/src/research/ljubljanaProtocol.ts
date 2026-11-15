/** The fixed parts of the Ljubljana known-pose evaluation: which starts are
 * tried, which arms are run and how runs are summarized. The written
 * protocol is docs/research/ljubljana-known-pose-protocol.md; a change here
 * after results exist is a new protocol, not a correction. */
import type { Vec3 } from "../obliqueSlice";
import { orthonormal, rotation } from "../projectionRegistration";

export const LJUBLJANA_PROTOCOL = {
  id: "ljubljana-known-pose-v1",
  subjects: 10,
  /** Perturbed starts per subject, shared by every arm. */
  starts_per_subject: 5,
  seed: 20261114,
  /** Each start is off the reference by a turn about each C-arm axis and a
   * shift along each, drawn evenly from this range in tenths. */
  perturbation_deg: 10,
  perturbation_mm: 10,
  /** In the uncalibrated arms the frontal and lateral detector sizes are
   * entered wrong by these factors and fitted. */
  entered_detector_factor: [0.85, 1.2],
  polarity: "dark",
  success_mm: [1, 2, 5],
} as const;

export type Perturbation = { degrees: Vec3; shift_mm: Vec3 };

/** Every start of the protocol, in subject order then start order. */
export function protocolStarts(): Perturbation[][] {
  const P = LJUBLJANA_PROTOCOL;
  let state: number = P.seed;
  const draw = (range: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.round((state / 2 ** 32) * 20 * range - 10 * range) / 10;
  };
  return Array.from({ length: P.subjects }, () =>
    Array.from({ length: P.starts_per_subject }, () => ({
      degrees: [
        draw(P.perturbation_deg),
        draw(P.perturbation_deg),
        draw(P.perturbation_deg),
      ] as Vec3,
      shift_mm: [
        draw(P.perturbation_mm),
        draw(P.perturbation_mm),
        draw(P.perturbation_mm),
      ] as Vec3,
    })),
  );
}

/** `reference` moved by a perturbation: turned about `pivot`, then shifted. */
export function perturbed(
  reference: number[][],
  pivot: Vec3,
  by: Perturbation,
): number[][] {
  const r = rotation(by.degrees[0], by.degrees[1], by.degrees[2]);
  return orthonormal(
    [0, 1, 2].map((i) => {
      const row = [0, 1, 2].map(
        (j) =>
          r[3 * i] * reference[0][j] +
          r[3 * i + 1] * reference[1][j] +
          r[3 * i + 2] * reference[2][j],
      );
      const moved =
        r[3 * i] * (reference[0][3] - pivot[0]) +
        r[3 * i + 1] * (reference[1][3] - pivot[1]) +
        r[3 * i + 2] * (reference[2][3] - pivot[2]);
      return [...row, moved + pivot[i] + by.shift_mm[i]];
    }),
  );
}

export type Summary = {
  runs: number;
  /** Runs in which the engine returned no proposal. They count against
   * every success rate and are left out of the error statistics. */
  no_proposal: number;
  median: number | null;
  mean: number | null;
  p90: number | null;
  max: number | null;
  /** Share of all runs with error under each `success_mm` threshold. */
  success: number[];
};

/** Quantile by linear interpolation between order statistics. */
export function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const at = (sorted.length - 1) * q,
    low = Math.floor(at),
    high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}

/** Summary of one error per run; `null` marks a run with no proposal. */
export function summarize(errors: (number | null)[]): Summary {
  const found = errors
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  const round = (value: number | null) =>
    value === null ? null : Math.round(value * 1000) / 1000;
  return {
    runs: errors.length,
    no_proposal: errors.length - found.length,
    median: round(quantile(found, 0.5)),
    mean: round(
      found.length ? found.reduce((a, b) => a + b, 0) / found.length : null,
    ),
    p90: round(quantile(found, 0.9)),
    max: round(found.length ? found[found.length - 1] : null),
    success: LJUBLJANA_PROTOCOL.success_mm.map((limit) =>
      errors.length
        ? Math.round(
            (found.filter((value) => value < limit).length / errors.length) *
              1000,
          ) / 1000
        : 0,
    ),
  };
}
