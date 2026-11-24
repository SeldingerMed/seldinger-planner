/** What a bone line-up does not carry, as one proposal for the operator to
 * confirm: an iliac artery straightened by a stiff wire, and the vessels
 * above the pelvis moved along the body's long axis by breathing.
 *
 * Both are fitted to what the operator marks on the frame, over a confirmed
 * line-up, and nothing else:
 * - wire marks: points along a wire seen in an iliac artery. The branch's
 *   centerline is pulled toward the straight line between its two ends by a
 *   share `straighten` (0 none, 1 straight) that brings it nearest the marks.
 * - landmarks: a point in the scan (set at the cursor) and where the same
 *   point lies on the frame. Breathing moves each scan point along the long
 *   axis by `shift_mm`, scaled from nothing at `anchor_s` to the whole shift
 *   at `full_s` (both in scan millimeters, superior positive).
 *
 * A parameter is fitted only from at least two marks of its own kind, and
 * the correction is proposed only when it brings the marks nearer than the
 * rigid line-up does by `CORRECTION.min_gain` of their distance. Otherwise
 * the rigid line-up stands and the reason is given. */
import {
  camera,
  project,
  validateView,
  type ViewNumbers,
} from "./carmGeometry";
import { detectorToPixel } from "./carmProjection";
import { validateRigid } from "./rigidFusion";

export const CORRECTION_METHOD = "wire_breathing_correction_v1";
export const CORRECTION = {
  /** Least share by which the marks' root mean square distance must fall. */
  min_gain: 0.2,
  /** And by at least this many pixels of the frame. */
  min_gain_px: 1,
  min_marks: 2,
  max_shift_mm: 40,
} as const;

export type Branch = {
  name: "aorta" | "right_iliac" | "left_iliac";
  path_ras: number[][];
};
export type WireMark = {
  branch: "right_iliac" | "left_iliac";
  pixel: number[];
};
export type Landmark = { ras: number[]; pixel: number[] };
export type Breathing = { anchor_s: number; full_s: number };
export type CorrectionParams = {
  straighten: { right_iliac: number; left_iliac: number };
  shift_mm: number;
};
export type CorrectionProposal = {
  method: typeof CORRECTION_METHOD;
  status: "proposed" | "rigid_stands";
  reason: null | "too_few_marks" | "no_gain";
  params: CorrectionParams;
  /** Root mean square distance of the marks from the model, in frame pixels. */
  rigid_rms_px: number;
  corrected_rms_px: number;
  marks: { wire: number; landmarks: number };
};

const NONE: CorrectionParams = {
  straighten: { right_iliac: 0, left_iliac: 0 },
  shift_mm: 0,
};

/** The path pulled toward the line between its two ends by `share`. */
export function straighten(path: number[][], share: number): number[][] {
  if (!(share >= 0 && share <= 1)) throw new Error("Invalid straightening");
  if (path.length < 2 || share === 0) return path.map((p) => [...p]);
  const a = path[0],
    b = path[path.length - 1],
    ab = [0, 1, 2].map((i) => b[i] - a[i]),
    length2 = ab.reduce((s, v) => s + v * v, 0);
  if (!(length2 > 0)) return path.map((p) => [...p]);
  return path.map((p) => {
    const t =
      [0, 1, 2].reduce((s, i) => s + (p[i] - a[i]) * ab[i], 0) / length2;
    return [0, 1, 2].map((i) => p[i] + share * (a[i] + t * ab[i] - p[i]));
  });
}

/** The scan point moved along the long axis by breathing. */
export function breathe(
  point: readonly number[],
  shift_mm: number,
  breathing: Breathing,
): number[] {
  const span = breathing.full_s - breathing.anchor_s;
  if (!Number.isFinite(span) || span === 0)
    throw new Error("Invalid breathing span");
  const w = Math.min(1, Math.max(0, (point[2] - breathing.anchor_s) / span));
  return [point[0], point[1], point[2] + shift_mm * w];
}

/** The corrected branches, in scan millimeters. */
export function correctBranches(
  branches: readonly Branch[],
  params: CorrectionParams,
  breathing: Breathing,
): Branch[] {
  return branches.map((branch) => {
    const share = branch.name === "aorta" ? 0 : params.straighten[branch.name];
    return {
      name: branch.name,
      path_ras: straighten(branch.path_ras, share).map((p) =>
        breathe(p, params.shift_mm, breathing),
      ),
    };
  });
}

type Projector = (point: readonly number[]) => [number, number] | null;

export function projector(
  matrix: number[][],
  view: ViewNumbers,
  isocenter: readonly number[],
  size: { width: number; height: number },
): Projector {
  const m = validateRigid(matrix) as number[][],
    v = validateView(view),
    cam = camera(v, isocenter);
  return (p) => {
    const q = [0, 1, 2].map(
      (r) => m[r][0] * p[0] + m[r][1] * p[1] + m[r][2] * p[2] + m[r][3],
    );
    try {
      const [x, y] = project(cam, q);
      const [px, py] = detectorToPixel(v, size, x, y);
      return Number.isFinite(px) && Number.isFinite(py) ? [px, py] : null;
    } catch {
      return null;
    }
  };
}

function toSegment(p: readonly number[], a: number[], b: number[]): number {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    l2 = dx * dx + dy * dy,
    t =
      l2 > 0
        ? Math.min(
            1,
            Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2),
          )
        : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Distance of each mark from the corrected model, in frame pixels; a mark
 * the model cannot reach counts as `far`. */
export function markDistances(
  branches: readonly Branch[],
  wire: readonly WireMark[],
  landmarks: readonly Landmark[],
  params: CorrectionParams,
  breathing: Breathing,
  to: Projector,
  far = 1e4,
): number[] {
  const corrected = correctBranches(branches, params, breathing);
  const drawn = new Map(
    corrected.map((branch) => [
      branch.name,
      branch.path_ras.map(to).filter((p): p is [number, number] => p !== null),
    ]),
  );
  const out: number[] = [];
  for (const mark of wire) {
    const line = drawn.get(mark.branch) ?? [];
    let best = far;
    for (let i = 1; i < line.length; i++)
      best = Math.min(best, toSegment(mark.pixel, line[i - 1], line[i]));
    out.push(best);
  }
  for (const mark of landmarks) {
    const at = to(breathe(mark.ras, params.shift_mm, breathing));
    out.push(
      at ? Math.hypot(at[0] - mark.pixel[0], at[1] - mark.pixel[1]) : far,
    );
  }
  return out;
}

const rms = (values: number[]) =>
  values.length
    ? Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length)
    : 0;

/** The correction that brings the marks nearest, searched over the
 * parameters the marks can fix, or the rigid line-up with its reason. */
export function proposeCorrection(input: {
  branches: readonly Branch[];
  wire: readonly WireMark[];
  landmarks: readonly Landmark[];
  breathing: Breathing;
  matrix: number[][];
  view: ViewNumbers;
  isocenter: readonly number[];
  size: { width: number; height: number };
}): CorrectionProposal {
  const to = projector(input.matrix, input.view, input.isocenter, input.size);
  const { wire, landmarks, branches, breathing } = input;
  const cost = (p: CorrectionParams) =>
    rms(markDistances(branches, wire, landmarks, p, breathing, to));
  const rigid = cost(NONE);
  const free: ("right_iliac" | "left_iliac" | "shift")[] = [];
  for (const side of ["right_iliac", "left_iliac"] as const)
    if (wire.filter((m) => m.branch === side).length >= CORRECTION.min_marks)
      free.push(side);
  if (landmarks.length >= CORRECTION.min_marks) free.push("shift");
  const marks = { wire: wire.length, landmarks: landmarks.length };
  const stands = (
    reason: CorrectionProposal["reason"],
    corrected = rigid,
  ): CorrectionProposal => ({
    method: CORRECTION_METHOD,
    status: "rigid_stands",
    reason,
    params: NONE,
    rigid_rms_px: rigid,
    corrected_rms_px: corrected,
    marks,
  });
  if (!free.length) return stands("too_few_marks");

  // Each parameter on its own scale: a straightening share and millimeters.
  const get = (p: CorrectionParams, k: (typeof free)[number]) =>
    k === "shift" ? p.shift_mm : p.straighten[k];
  const put = (p: CorrectionParams, k: (typeof free)[number], v: number) =>
    k === "shift"
      ? {
          ...p,
          shift_mm: Math.max(
            -CORRECTION.max_shift_mm,
            Math.min(CORRECTION.max_shift_mm, v),
          ),
        }
      : {
          ...p,
          straighten: { ...p.straighten, [k]: Math.max(0, Math.min(1, v)) },
        };
  const scale = (k: (typeof free)[number]) => (k === "shift" ? 8 : 0.2);

  // A coarse look along each parameter, then a compass search together.
  let best = NONE,
    bestCost = rigid;
  for (const k of free) {
    const values =
      k === "shift"
        ? Array.from({ length: 21 }, (_, i) => -CORRECTION.max_shift_mm + 4 * i)
        : Array.from({ length: 11 }, (_, i) => i / 10);
    for (const v of values) {
      const p = put(best, k, v),
        c = cost(p);
      if (c < bestCost) {
        best = p;
        bestCost = c;
      }
    }
  }
  for (let step = 1; step > 1e-3;) {
    let moved = false;
    for (const k of free)
      for (const sign of [1, -1]) {
        const p = put(best, k, get(best, k) + sign * step * scale(k)),
          c = cost(p);
        if (c < bestCost - 1e-9) {
          best = p;
          bestCost = c;
          moved = true;
        }
      }
    if (!moved) step /= 2;
  }
  if (
    rigid - bestCost < CORRECTION.min_gain * rigid ||
    rigid - bestCost < CORRECTION.min_gain_px
  )
    return stands("no_gain", bestCost);
  return {
    method: CORRECTION_METHOD,
    status: "proposed",
    reason: null,
    params: best,
    rigid_rms_px: rigid,
    corrected_rms_px: bestCost,
    marks,
  };
}
