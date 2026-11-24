/** The aorta and iliac model over an abdominal X-ray frame, lined up on the
 * bone: one proposal for the operator to confirm.
 *
 * The bone line-up engine (./boneLineup.ts) is used as it ran under its
 * held-back protocol and is not changed here. What this method adds is the
 * order in which it is asked and what is kept:
 *
 * 1. The frame nearer the patient's front is lined up alone. One frame does
 *    not place the scan along its own beam; that is said with the result.
 * 2. With a second frame far enough round, both are lined up together. That
 *    answer is kept only if each frame still holds its bone (its score at
 *    least `held_floor`) and the first frame's own score has not fallen
 *    below `first_kept` of its score alone. Otherwise the second frame is set
 *    aside with its reason and the single-frame answer stands: a second frame
 *    that does not show the bone must not move a good first answer.
 *
 * The model's centerlines are then drawn through the confirmed pose.
 * Nothing here is accepted without the operator. */
import {
  BONE_LINEUP,
  BONE_LINEUP_BIPLANE_METHOD,
  BONE_LINEUP_METHOD,
  BONE_NOT_IN_FRAME,
  createBoneLineupJob,
  type BoneFrameInput,
  type BoneLineupJob,
  type BoneLineupProposal,
  type BoneSamples,
} from "./boneLineup";
import { planeAngleDeg, planesFarEnough } from "./biplaneRegistration";
import {
  camera,
  project,
  validateView,
  type ViewNumbers,
} from "./carmGeometry";
import { detectorToPixel } from "./carmProjection";
import { validateRigid } from "./rigidFusion";

export const ABDOMINAL_LINEUP_METHOD = "bone_edge_compass_guarded_v3";
export const ABDOMINAL_LINEUP_VERSION = "step-d3-bone-lineup-registration-v1";

export const ABDOMINAL_LINEUP = {
  /** Least frame score at a two-frame answer for that frame to count as
   * holding its bone. Set on the C-ArmLSpine design cases (1 to 49 only):
   * with the case's own side frame the lowest side-frame score at the
   * two-frame answer was 0.250 (case 43), while a bone-smoothed side frame
   * or another patient's scored 0.02 to 0.31. 0.25 keeps every own frame
   * seen and sets aside most of the wrong ones; it does not separate them
   * all, and the held-back cases are spent, so this floor has no held-out
   * measurement. Measured: docs/research/
   * step-d-overlay-correction-heart-motion-results.md. */
  held_floor: 0.25,
  /** Least share of its own single-frame score the first frame keeps at a
   * two-frame answer. */
  first_kept: 0.8,
} as const;

export type SecondView =
  | { status: "not_given" }
  | {
      status: "set_aside";
      /** Index into the frames as given. */
      frame: number;
      reason: "bone_not_held" | "moved_first_frame" | "too_close";
    };

export type AbdominalLineupProposal = {
  method: typeof ABDOMINAL_LINEUP_METHOD;
  engine_method: typeof BONE_LINEUP_METHOD | typeof BONE_LINEUP_BIPLANE_METHOD;
  matrix: number[][];
  /** Indices into the frames as given, in the order a then b. */
  used: number[];
  frame_scores: number[];
  /** Mean score over the frames used, at the start. */
  start_score: number;
  depth: "not_determined_single_view" | "two_views";
  second_view: SecondView;
  single: BoneLineupProposal;
  both: BoneLineupProposal | null;
};

export type AbdominalLineupJob = {
  advance(expired: () => boolean): boolean;
  result(): AbdominalLineupProposal;
};

const rad = Math.PI / 180;
/** The engine's refusal of a frame with no contrast at all. */
const FRAME_SHOWS_NOTHING = "Frame shows nothing to line up on";

/** Angle of each frame's beam from the scan's front-to-back axis at `start`,
 * as the engine reads it. */
export function fromFrontDeg(
  frame: Pick<BoneFrameInput, "view" | "isocenter">,
  start: number[][],
): number {
  const { d } = camera(validateView(frame.view), frame.isocenter),
    along = d[0] * start[0][1] + d[1] * start[1][1] + d[2] * start[2][1];
  return Math.acos(Math.min(1, Math.abs(along))) / rad;
}

/** A lone frame places the bone only while its beam stays within the
 * engine's angle of the front at the pose found, as well as at the start:
 * the search may turn the scan, and the server checks the saved pose. */
export function loneFrameHolds(
  frame: Pick<BoneFrameInput, "view" | "isocenter">,
  matrix: number[][],
): boolean {
  return fromFrontDeg(frame, matrix) <= BONE_LINEUP.lone_frame_from_front_deg;
}

export function createAbdominalLineupJob(input: {
  samples: BoneSamples;
  frames: BoneFrameInput[];
  start: number[][];
}): AbdominalLineupJob {
  const frames = input.frames;
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > 2)
    throw new Error("One or two frames are required");
  const start = validateRigid(input.start) as number[][];
  const angles = frames.map((frame) => fromFrontDeg(frame, start));
  const first = frames.length === 2 && angles[1] < angles[0] ? 1 : 0,
    second = frames.length === 2 ? 1 - first : -1;
  if (angles[first] > BONE_LINEUP.lone_frame_from_front_deg)
    throw new Error(
      "No frame is within 60 degrees of the front: add a frame from the front",
    );
  const tooClose =
    second >= 0 &&
    !planesFarEnough(
      planeAngleDeg(validateView(frames[0].view), validateView(frames[1].view)),
    );
  let single: BoneLineupProposal | null = null,
    both: BoneLineupProposal | null = null,
    bothFailed = false,
    done: AbdominalLineupProposal | null = null,
    failure: unknown = null;
  const singleJob: BoneLineupJob = createBoneLineupJob({
    samples: input.samples,
    frames: [frames[first]],
    start,
  });
  let bothJob: BoneLineupJob | null = null;

  const finish = (): AbdominalLineupProposal => {
    const alone = single as BoneLineupProposal;
    const keepSingle = (second_view: SecondView): AbdominalLineupProposal => {
      if (!loneFrameHolds(frames[first], alone.matrix))
        throw new Error(
          "Lined up alone, the frame turns past 60 degrees from the front: add a frame from the front",
        );
      return {
        method: ABDOMINAL_LINEUP_METHOD,
        engine_method: BONE_LINEUP_METHOD,
        matrix: alone.matrix,
        used: [first],
        frame_scores: [alone.score],
        start_score: alone.start_score,
        depth: "not_determined_single_view",
        second_view,
        single: alone,
        both,
      };
    };
    if (second < 0) return keepSingle({ status: "not_given" });
    if (tooClose)
      return keepSingle({
        status: "set_aside",
        frame: second,
        reason: "too_close",
      });
    if (!both || bothFailed)
      return keepSingle({
        status: "set_aside",
        frame: second,
        reason: "bone_not_held",
      });
    // frame_scores are in the order the frames were given.
    if (Math.min(...both.frame_scores) < ABDOMINAL_LINEUP.held_floor)
      return keepSingle({
        status: "set_aside",
        frame: second,
        reason: "bone_not_held",
      });
    if (both.frame_scores[first] < ABDOMINAL_LINEUP.first_kept * alone.score)
      return keepSingle({
        status: "set_aside",
        frame: second,
        reason: "moved_first_frame",
      });
    return {
      method: ABDOMINAL_LINEUP_METHOD,
      engine_method: BONE_LINEUP_BIPLANE_METHOD,
      matrix: both.matrix,
      used: [0, 1],
      frame_scores: both.frame_scores,
      start_score: both.start_score,
      depth: "two_views",
      second_view: { status: "not_given" },
      single: alone,
      both,
    };
  };

  return {
    advance(expired) {
      if (failure) throw failure;
      try {
        if (!single) {
          if (!singleJob.advance(expired)) return false;
          single = singleJob.result();
          if (second >= 0 && !tooClose)
            try {
              bothJob = createBoneLineupJob({
                samples: input.samples,
                frames: [...frames],
                start,
              });
            } catch {
              bothFailed = true;
            }
          if (expired()) return false;
        }
        if (bothJob && !both && !bothFailed) {
          try {
            if (!bothJob.advance(expired)) return false;
            both = bothJob.result();
          } catch (error) {
            // The first frame has already been lined up alone, so a frame
            // that shows nothing, or no bone at the start, is the second one:
            // it is set aside. Anything else fails the whole line-up.
            if (
              error instanceof Error &&
              (error.message === BONE_NOT_IN_FRAME ||
                error.message === FRAME_SHOWS_NOTHING)
            )
              bothFailed = true;
            else throw error;
          }
        }
        if (!done) done = finish();
        return true;
      } catch (error) {
        failure = error ?? new Error("Line-up failed");
        throw failure;
      }
    },
    result() {
      if (!done) throw new Error("Line-up is not complete");
      return done;
    },
  };
}

export function proposeAbdominalLineup(
  input: Parameters<typeof createAbdominalLineupJob>[0],
): AbdominalLineupProposal {
  const job = createAbdominalLineupJob(input);
  job.advance(() => false);
  return job.result();
}

export type ModelBranch = {
  name: "aorta" | "right_iliac" | "left_iliac";
  path_ras: number[][];
  radius_mm: number[];
};

/** Each branch's centerline in frame pixels (x right, y down), through the
 * volume-to-C-arm `matrix`, with each point's radius in pixels at its
 * depth. Points behind the source or beyond the detector are dropped. */
export function projectBranches(
  branches: readonly ModelBranch[],
  matrix: number[][],
  view: ViewNumbers,
  isocenter: readonly number[],
  size: { width: number; height: number },
): { name: ModelBranch["name"]; points: [number, number, number][] }[] {
  const m = validateRigid(matrix) as number[][],
    cam = camera(view, isocenter),
    pitch = view.detector_width_mm / size.width;
  return branches.map((branch) => ({
    name: branch.name,
    points: branch.path_ras.flatMap((p, i): [number, number, number][] => {
      const q = [0, 1, 2].map(
        (r) => m[r][0] * p[0] + m[r][1] * p[1] + m[r][2] * p[2] + m[r][3],
      );
      try {
        const [x, y, depth] = project(cam, q);
        const [px, py] = detectorToPixel(view, size, x, y);
        const radius =
          ((branch.radius_mm[i] ?? 0) * cam.source_detector_mm) / depth / pitch;
        return [[px, py, radius]];
      } catch {
        return [];
      }
    }),
  }));
}
