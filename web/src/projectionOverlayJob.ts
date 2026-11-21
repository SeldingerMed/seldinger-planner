/** One resumable run from a vessel mask and one admitted frame, or one frame
 * from each plane of a pair, to an overlay: medial 3D points, then either a
 * registration proposal, or nothing further when a saved pose is only being
 * redrawn. The proposal is made against the extracted centerlines or, by
 * the vessel evidence methods, against the frame's vessel evidence. Pure
 * computation; it fetches and stores nothing. */
import {
  createBiplaneRegistrationJob,
  type BiplaneRegistrationProposal,
} from "./biplaneRegistration";
import { bestStartSteps } from "./bestStart";
import type { ViewNumbers } from "./carmGeometry";
import {
  createEvidenceRegistrationJob,
  type EvidenceRegistrationProposal,
} from "./evidenceRegistration";
import { startFromProposedView, type StartView } from "./poseInitializer";
import { centroid, medialPointSteps } from "./maskPoints";
import type { Vec3 } from "./obliqueSlice";
import {
  createProjectionRegistrationJob,
  type ProjectionRegistrationProposal,
} from "./projectionRegistration";
import { vesselEvidenceSteps, type VesselEvidence } from "./vesselEvidence2d";
import {
  vesselTargetSteps,
  type Polarity,
  type VesselTarget,
} from "./vesselness2d";

/** Which pair of methods proposes: the centerline distance methods, which
 * match to a thresholded line set, or the vessel evidence methods, which
 * read a map with no threshold and ignore the sensitivity. */
export type OverlayMethod = "centerline_distance" | "vessel_evidence";

export const IDENTITY_MATRIX = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

/** Views of the volume proposed for a frame from its vessel evidence. */
export type ProposeViews = (evidence: VesselEvidence) => StartView[];

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
    /** Centerline distance when absent. */
    method?: OverlayMethod;
    polarity: Polarity;
    sensitivity: number;
    fit_detector_scale: boolean;
  } | null;
  /** With this, the vessel evidence search is also run from each view
   * proposed for the frame, and the result with the most evidence is kept. */
  propose_views?: ProposeViews | null;
};
export type OverlayJobResult = {
  points: Float32Array;
  isocenter: Vec3;
  /** Grid voxels per measured cell; above 1 the mask was coarsened. */
  pooling: number;
  /** The extracted line set. Null for a vessel evidence proposal, which
   * has none. */
  target: VesselTarget | null;
  /** By centerline distance, or null. */
  proposal: ProjectionRegistrationProposal | null;
  /** By vessel evidence, or null. At most one of the two is set. */
  evidence: EvidenceRegistrationProposal | null;
};
export type OverlayJob = {
  /** Runs until complete or `expired()` is true. Returns true once complete.
   * A failure is thrown again by every later call. */
  advance(expired: () => boolean): boolean;
  result(): OverlayJobResult;
};

/** A start for each view proposed for each plane's frame. The network's pass
 * over a frame is not sliced, so each one begins at a slice boundary. */
function* proposedStarts(
  planes: { view: ViewNumbers; evidence: VesselEvidence }[],
  propose: ProposeViews,
  pivot: Vec3,
): Generator<void, number[][][]> {
  const starts: number[][][] = [];
  for (const plane of planes) {
    yield;
    for (const seen of propose(plane.evidence))
      starts.push(startFromProposedView(plane.view, seen, pivot));
  }
  return starts;
}

function* run(
  input: OverlayJobInput,
  clock: { expired: () => boolean },
): Generator<void, OverlayJobResult> {
  const medial = yield* medialPointSteps(input.mask, input.shape, input.affine),
    isocenter = input.isocenter ?? centroid(medial.points),
    base = { points: medial.points, isocenter, pooling: medial.pooling };
  if (!input.search)
    return { ...base, target: null, proposal: null, evidence: null };
  const { gray, width, height } = input.frame;
  if (input.search.method === "vessel_evidence") {
    const evidence = yield* vesselEvidenceSteps(
        gray,
        width,
        height,
        input.search.polarity,
      ),
      search = {
        points: medial.points,
        planes: [
          {
            view: input.view,
            isocenter,
            frame: { width, height },
            evidence,
            fit_detector_scale: input.search.fit_detector_scale,
          },
        ],
        start: IDENTITY_MATRIX,
      };
    if (input.propose_views) {
      const pivot = centroid(medial.points),
        best = yield* bestStartSteps(
          search,
          yield* proposedStarts(search.planes, input.propose_views, pivot),
          clock,
        );
      return { ...base, target: null, proposal: null, evidence: best.proposal };
    }
    const job = createEvidenceRegistrationJob(search);
    while (!job.advance(() => clock.expired())) yield;
    return { ...base, target: null, proposal: null, evidence: job.result() };
  }
  const target = yield* vesselTargetSteps(
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
  return { ...base, target, proposal: job.result(), evidence: null };
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
  /** Centerline distance when absent. */
  method?: OverlayMethod;
  /** With this, the vessel evidence search is also run from each view
   * proposed for either frame, and the result with the most evidence is
   * kept. One turn of the model serves both planes. */
  propose_views?: ProposeViews | null;
};
export type BiplaneOverlayJobResult = {
  points: Float32Array;
  isocenter: Vec3;
  pooling: number;
  /** The extracted line sets. Null for a vessel evidence proposal. */
  targets: [VesselTarget, VesselTarget] | null;
  /** By centerline distance, or null. */
  proposal: BiplaneRegistrationProposal | null;
  /** By vessel evidence, or null. At most one of the two is set. */
  evidence: EvidenceRegistrationProposal | null;
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
  if (!input.search)
    return { ...base, targets: null, proposal: null, evidence: null };
  if (input.method === "vessel_evidence") {
    const planes = [];
    for (const plane of input.planes)
      planes.push({
        view: plane.view,
        isocenter,
        frame: { width: plane.frame.width, height: plane.frame.height },
        evidence: yield* vesselEvidenceSteps(
          plane.frame.gray,
          plane.frame.width,
          plane.frame.height,
          plane.polarity,
        ),
        fit_detector_scale: plane.fit_detector_scale,
      });
    const search = { points: medial.points, planes, start: IDENTITY_MATRIX };
    if (input.propose_views) {
      const pivot = centroid(medial.points),
        best = yield* bestStartSteps(
          search,
          yield* proposedStarts(planes, input.propose_views, pivot),
          clock,
        );
      return {
        ...base,
        targets: null,
        proposal: null,
        evidence: best.proposal,
      };
    }
    const job = createEvidenceRegistrationJob(search);
    while (!job.advance(() => clock.expired())) yield;
    return { ...base, targets: null, proposal: null, evidence: job.result() };
  }
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
    evidence: null,
  };
}

export function createBiplaneOverlayJob(
  input: BiplaneOverlayJobInput,
): BiplaneOverlayJob {
  return stepped((clock) => runPair(input, clock));
}
