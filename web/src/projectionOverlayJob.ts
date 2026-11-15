/** One resumable run from a vessel mask and one admitted frame, or one frame
 * from each plane of a pair, to an overlay: medial 3D points, then either a
 * registration proposal against the extracted centerlines, or nothing
 * further when a saved pose is only being redrawn. Pure computation; it
 * fetches and stores nothing. */
import {
  createBiplaneRegistrationJob,
  type BiplaneRegistrationProposal,
} from "./biplaneRegistration";
import type { ViewNumbers } from "./carmGeometry";
import { centroid, medialPointSteps } from "./maskPoints";
import type { Vec3 } from "./obliqueSlice";
import {
  createProjectionRegistrationJob,
  type ProjectionRegistrationProposal,
} from "./projectionRegistration";
import {
  vesselTargetSteps,
  type Polarity,
  type VesselTarget,
} from "./vesselness2d";

export const IDENTITY_MATRIX = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

export type OverlayJobInput = {
  /** Nonzero inside the vessel, x fastest, on the source grid. */
  mask: Uint8Array;
  shape: readonly [number, number, number];
  affine: number[][];
  frame: { gray: Uint8Array; width: number; height: number };
  view: ViewNumbers;
  /** Null places the isocenter at the centroid of the vessel points. */
  isocenter: Vec3 | null;
  /** Null redraws without searching: no target is extracted. */
  search: {
    polarity: Polarity;
    sensitivity: number;
    fit_detector_scale: boolean;
  } | null;
};
export type OverlayJobResult = {
  points: Float32Array;
  isocenter: Vec3;
  /** Grid voxels per measured cell; above 1 the mask was coarsened. */
  pooling: number;
  target: VesselTarget | null;
  proposal: ProjectionRegistrationProposal | null;
};
export type OverlayJob = {
  /** Runs until complete or `expired()` is true. Returns true once complete.
   * A failure is thrown again by every later call. */
  advance(expired: () => boolean): boolean;
  result(): OverlayJobResult;
};

function* run(
  input: OverlayJobInput,
  clock: { expired: () => boolean },
): Generator<void, OverlayJobResult> {
  const medial = yield* medialPointSteps(input.mask, input.shape, input.affine),
    isocenter = input.isocenter ?? centroid(medial.points),
    base = { points: medial.points, isocenter, pooling: medial.pooling };
  if (!input.search) return { ...base, target: null, proposal: null };
  const { gray, width, height } = input.frame,
    target = yield* vesselTargetSteps(
      gray,
      width,
      height,
      input.search.polarity,
      input.search.sensitivity,
    ),
    job = createProjectionRegistrationJob({
      points: medial.points,
      view: input.view,
      isocenter,
      frame: { width, height },
      target,
      start: IDENTITY_MATRIX,
      fit_detector_scale: input.search.fit_detector_scale,
    });
  while (!job.advance(() => clock.expired())) yield;
  return { ...base, target, proposal: job.result() };
}

/** Wraps a stepping computation so it can be advanced in time slices. */
export function stepped<T>(
  make: (clock: { expired: () => boolean }) => Generator<void, T>,
) {
  const clock = { expired: () => false },
    steps = make(clock);
  let done: { value: T } | null = null,
    failure: unknown = null;
  return {
    advance(expired: () => boolean) {
      if (failure) throw failure;
      clock.expired = expired;
      try {
        while (!done) {
          const next = steps.next();
          if (next.done) {
            done = { value: next.value };
            break;
          }
          if (expired()) return false;
        }
      } catch (error) {
        failure = error ?? new Error("Overlay computation failed");
        throw failure;
      }
      return true;
    },
    result() {
      if (!done) throw new Error("Overlay computation is not complete");
      return done.value;
    },
  };
}

export function createOverlayJob(input: OverlayJobInput): OverlayJob {
  return stepped((clock) => run(input, clock));
}

export type BiplaneOverlayPlane = {
  frame: { gray: Uint8Array; width: number; height: number };
  view: ViewNumbers;
  polarity: Polarity;
  sensitivity: number;
  fit_detector_scale: boolean;
};
export type BiplaneOverlayJobInput = {
  mask: Uint8Array;
  shape: readonly [number, number, number];
  affine: number[][];
  /** Plane A, then plane B. */
  planes: [BiplaneOverlayPlane, BiplaneOverlayPlane];
  /** One point shared by both central rays. Null places it at the centroid
   * of the vessel points. */
  isocenter: Vec3 | null;
  /** False redraws without searching: no target is extracted. */
  search: boolean;
};
export type BiplaneOverlayJobResult = {
  points: Float32Array;
  isocenter: Vec3;
  pooling: number;
  targets: [VesselTarget, VesselTarget] | null;
  proposal: BiplaneRegistrationProposal | null;
};
export type BiplaneOverlayJob = {
  advance(expired: () => boolean): boolean;
  result(): BiplaneOverlayJobResult;
};

function* runPair(
  input: BiplaneOverlayJobInput,
  clock: { expired: () => boolean },
): Generator<void, BiplaneOverlayJobResult> {
  const medial = yield* medialPointSteps(input.mask, input.shape, input.affine),
    isocenter = input.isocenter ?? centroid(medial.points),
    base = { points: medial.points, isocenter, pooling: medial.pooling };
  if (!input.search) return { ...base, targets: null, proposal: null };
  const targets: VesselTarget[] = [];
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
  const [a, b] = input.planes.map((plane, k) => ({
    view: plane.view,
    isocenter,
    frame: { width: plane.frame.width, height: plane.frame.height },
    target: targets[k],
    fit_detector_scale: plane.fit_detector_scale,
  }));
  const job = createBiplaneRegistrationJob({
    points: medial.points,
    planes: [a, b],
    start: IDENTITY_MATRIX,
  });
  while (!job.advance(() => clock.expired())) yield;
  return {
    ...base,
    targets: [targets[0], targets[1]],
    proposal: job.result(),
  };
}

export function createBiplaneOverlayJob(
  input: BiplaneOverlayJobInput,
): BiplaneOverlayJob {
  return stepped((clock) => runPair(input, clock));
}
