/** One resumable run from a vessel mask, a saved pose and the frames of its
 * planes to the comparison of the two: vessel diameters from the mask and
 * from each frame, the narrowest place of each run, and where along a
 * plane's run of frames contrast reaches each segment. Pure computation; it
 * fetches and stores nothing. */
import { axisDiameterSteps } from "./axisDiameter";
import type { ViewNumbers } from "./carmGeometry";
import {
  CONTRAST_ARRIVAL_LIMITS,
  contrastArrival,
  type SegmentArrival,
} from "./contrastArrival";
import {
  compareDiameters,
  type DiameterComparison,
} from "./diameterComparison";
import { frameDiameters } from "./frameDiameter";
import { placedSamples, type PlacedSamples } from "./framePlacement";
import type { Vec3 } from "./obliqueSlice";
import { stepped } from "./projectionOverlayJob";
import type { Polarity } from "./vesselness2d";
import { vesselSegmentSteps, type VesselSegments } from "./vesselSegments";

export type ComparisonJobInput = {
  /** Nonzero inside the vessel, x fastest, on the source grid. */
  mask: Uint8Array;
  shape: readonly [number, number, number];
  affine: number[][];
  /** The pose and isocenter of the confirmed registration. */
  matrix: number[][];
  isocenter: Vec3;
  /** One entry per plane of that registration, in its order. */
  planes: {
    /** The frame the registration was confirmed on. */
    frame: { gray: Uint8Array; width: number; height: number };
    view: ViewNumbers;
    polarity: Polarity;
    /** Every admitted frame of the plane, in the order they were taken. */
    run: { index: number; gray: Uint8Array }[];
  }[];
};
export type PlaneComparison = {
  placed: PlacedSamples;
  /** Diameter in the frame at each axis sample; NaN where not measured. */
  frame_mm: Float32Array;
  diameters: DiameterComparison;
  /** Null for a plane with too few frames to read an arrival from. */
  arrival: SegmentArrival[] | null;
};
export type ComparisonResult = {
  segments: VesselSegments;
  /** Diameter of the mask at each axis sample. */
  mask_mm: Float32Array;
  planes: PlaneComparison[];
};
export type ComparisonJob = {
  /** Runs until complete or `expired()` is true. Returns true once complete.
   * A failure is thrown again by every later call. */
  advance(expired: () => boolean): boolean;
  result(): ComparisonResult;
};

function* run(input: ComparisonJobInput): Generator<void, ComparisonResult> {
  const segments = yield* vesselSegmentSteps(
      input.mask,
      input.shape,
      input.affine,
    ),
    cuts = yield* axisDiameterSteps(
      input.mask,
      input.shape,
      input.affine,
      segments,
    ),
    planes: PlaneComparison[] = [];
  for (const plane of input.planes) {
    const { width, height, gray } = plane.frame,
      placed = placedSamples(
        plane.view,
        input.isocenter,
        input.matrix,
        segments.points,
        { width, height },
      );
    yield;
    const frame_mm = frameDiameters(
      { width, height, gray, polarity: plane.polarity },
      placed,
      segments,
      {
        ...cuts,
        pixels: placedSamples(
          plane.view,
          input.isocenter,
          input.matrix,
          cuts.centers,
          { width, height },
        ).pixels,
      },
    );
    yield;
    planes.push({
      placed,
      frame_mm,
      diameters: compareDiameters(segments, cuts.mm, frame_mm),
      arrival:
        plane.run.length >= CONTRAST_ARRIVAL_LIMITS.min_frames
          ? contrastArrival({
              segments,
              pixels: placed.pixels,
              width,
              height,
              polarity: plane.polarity,
              frames: plane.run,
            })
          : null,
    });
    yield;
  }
  return { segments, mask_mm: cuts.mm, planes };
}

export function createComparisonJob(input: ComparisonJobInput): ComparisonJob {
  return stepped(() => run(input));
}
