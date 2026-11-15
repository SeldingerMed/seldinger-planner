/** One resumable run from a vessel mask, a saved pose and the frames it was
 * confirmed on to a vessel-presence result: the mask's segments, the
 * centerlines of each frame, and each segment's class in each plane. Pure
 * computation; it fetches and stores nothing. */
import type { ViewNumbers } from "./carmGeometry";
import type { Vec3 } from "./obliqueSlice";
import { stepped } from "./projectionOverlayJob";
import {
  vesselTargetSteps,
  type Polarity,
  type VesselTarget,
} from "./vesselness2d";
import { vesselPresence, type VesselPresence } from "./vesselPresence";
import { vesselSegmentSteps, type VesselSegments } from "./vesselSegments";

export type PresenceJobInput = {
  /** Nonzero inside the vessel, x fastest, on the source grid. */
  mask: Uint8Array;
  shape: readonly [number, number, number];
  affine: number[][];
  /** The pose and isocenter of the registration the report is for. */
  matrix: number[][];
  isocenter: Vec3;
  /** One entry per plane of that registration, in its order, each with the
   * view, polarity and sensitivity the registration was confirmed with. */
  planes: {
    frame: { gray: Uint8Array; width: number; height: number };
    view: ViewNumbers;
    polarity: Polarity;
    sensitivity: number;
  }[];
};
export type PresenceJobResult = {
  segments: VesselSegments;
  targets: VesselTarget[];
  presence: VesselPresence;
};
export type PresenceJob = {
  /** Runs until complete or `expired()` is true. Returns true once complete.
   * A failure is thrown again by every later call. */
  advance(expired: () => boolean): boolean;
  result(): PresenceJobResult;
};

function* run(input: PresenceJobInput): Generator<void, PresenceJobResult> {
  const segments = yield* vesselSegmentSteps(
      input.mask,
      input.shape,
      input.affine,
    ),
    targets: VesselTarget[] = [];
  for (const plane of input.planes)
    targets.push(
      yield* vesselTargetSteps(
        plane.frame.gray,
        plane.frame.width,
        plane.frame.height,
        plane.polarity,
        plane.sensitivity,
      ),
    );
  return {
    segments,
    targets,
    presence: vesselPresence({
      segments,
      isocenter: input.isocenter,
      matrix: input.matrix,
      planes: input.planes.map((plane, k) => ({
        view: plane.view,
        frame: { width: plane.frame.width, height: plane.frame.height },
        target: targets[k],
      })),
    }),
  };
}

export function createPresenceJob(input: PresenceJobInput): PresenceJob {
  return stepped(() => run(input));
}
