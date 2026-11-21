/** Vessel diameters from the 3D mask and from a frame, side by side: per
 * segment, and the narrowest place of each unbranched run.
 *
 * Both sides are given per axis sample (`axisDiameters`, `frameDiameters`).
 * Nothing here says why the two differ: the mask may be thick or thin, the
 * vessel may be foreshortened or lie under another, or the registration may
 * be off. */
import type { VesselSegments } from "./vesselSegments";

export const DIAMETER_COMPARISON_LIMITS = {
  /** A segment with fewer measured samples has no diameter. */
  min_samples: 3,
  /** Samples a diameter is smoothed over along a run, by their median. */
  smooth: 5,
  /** A run with fewer smoothed samples has no narrowest place. */
  min_run_samples: 10,
} as const;

export type SegmentDiameters = {
  /** Median over the segment's samples, in millimeters. */
  mask_mm: number | null;
  frame_mm: number | null;
  /** Samples of the segment measured in the frame. */
  frame_samples: number;
};
export type Narrowest = {
  /** The axis sample at the narrowest place. */
  sample: number;
  narrowest_mm: number;
  /** The median along the run. */
  reference_mm: number;
  /** How much narrower than the reference, in percent of it. */
  percent: number;
};
export type RunDiameters = {
  run: number;
  samples: number;
  mask: Narrowest | null;
  frame: Narrowest | null;
};
export type DiameterComparison = {
  segments: SegmentDiameters[];
  runs: RunDiameters[];
};

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b),
    mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function narrowest(values: Float32Array, samples: number[]): Narrowest | null {
  const L = DIAMETER_COMPARISON_LIMITS,
    reach = L.smooth >> 1,
    smoothed: { sample: number; mm: number }[] = [];
  for (let i = 0; i < samples.length; i++) {
    const near: number[] = [];
    for (
      let j = Math.max(0, i - reach);
      j <= Math.min(samples.length - 1, i + reach);
      j++
    )
      if (Number.isFinite(values[samples[j]])) near.push(values[samples[j]]);
    // More than half of the window must have been measured.
    if (near.length > reach)
      smoothed.push({ sample: samples[i], mm: median(near) });
  }
  if (smoothed.length < L.min_run_samples) return null;
  const reference_mm = median(smoothed.map((one) => one.mm));
  // Of two places as narrow, the first along the run.
  let least = smoothed[0];
  for (const one of smoothed) if (one.mm < least.mm) least = one;
  if (!(reference_mm > 0)) return null;
  return {
    sample: least.sample,
    narrowest_mm: least.mm,
    reference_mm,
    percent: 100 * (1 - least.mm / reference_mm),
  };
}

export function compareDiameters(
  segments: VesselSegments,
  mask_mm: Float32Array,
  frame_mm: Float32Array,
): DiameterComparison {
  const L = DIAMETER_COMPARISON_LIMITS,
    { labels } = segments,
    count = labels.length;
  if (mask_mm.length !== count || frame_mm.length !== count)
    throw new Error("Diameters do not match the vessel segments");
  const of = segments.segments.map(() => ({
      mask: [] as number[],
      frame: [] as number[],
    })),
    runs = new Map<number, number[]>();
  for (let k = 0; k < count; k++) {
    if (Number.isFinite(mask_mm[k])) of[labels[k]].mask.push(mask_mm[k]);
    if (Number.isFinite(frame_mm[k])) of[labels[k]].frame.push(frame_mm[k]);
    const run = segments.segments[labels[k]].run;
    if (!runs.has(run)) runs.set(run, []);
    // Samples of a run follow one another along the vessel.
    runs.get(run)!.push(k);
  }
  return {
    segments: of.map((one) => ({
      mask_mm: one.mask.length >= L.min_samples ? median(one.mask) : null,
      frame_mm: one.frame.length >= L.min_samples ? median(one.frame) : null,
      frame_samples: one.frame.length,
    })),
    runs: [...runs.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([run, samples]) => ({
        run,
        samples: samples.length,
        mask: narrowest(mask_mm, samples),
        frame: narrowest(frame_mm, samples),
      })),
  };
}
