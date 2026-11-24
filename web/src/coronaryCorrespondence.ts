/** A patient's CT coronary tree matched to the same patient's cine, branch
 * by branch, and followed over the cine's heartbeats: one proposal for the
 * operator to confirm.
 *
 * Inputs are the tree as the CT gives it (named branches, millimeters, the
 * CT's own cardiac phase), the cine as its DICOM header gives it (frames,
 * recorded frame times, C-arm angles and distances), and the pair the
 * operator stated, bound to both by their digests. Nothing is taken from
 * names: the pair is the operator's statement, and each branch is matched
 * by where its course lies in the frame, never by what it is called.
 *
 * The steps:
 * - the pair, the frame times, the C-arm geometry and the CT's phase are
 *   checked, and the proposal is refused where any is missing or does not
 *   hold (a pair for another tree or cine; times that are only a display
 *   rate; no geometry or a C-arm that moved; a CT phase not stated, or one
 *   outside diastasis, which only an ECG could find in the cine);
 * - the heart's period and each beat's quiet frames are read from the cine
 *   (`cine_heart_period_v2`); of those, the frame with the most vessel
 *   evidence is the phase frame, where the CT's diastolic tree holds;
 * - the tree is lined up on the phase frame: a rigid CT-to-C-arm pose
 *   (6 degrees of freedom), searched coarse to fine over the frame's vessel
 *   evidence and projected through the cine's own C-arm geometry. A tree
 *   the frame does not hold is refused (another patient's tree, or the
 *   wrong cine);
 * - each CT branch is then looked for near where the pose puts it. It is
 *   matched where one course clearly holds it; not found where none does;
 *   ambiguous where two courses, apart and each with a valley between,
 *   hold it about equally; in conflict where it and another branch, apart
 *   in the CT, are drawn onto the same vessel. Only matched branches go on;
 * - the matched tree is followed over the cine from the phase frame
 *   (`coronary_tree_tracking_v1`), each point keeping its CT point.
 *
 * Every number here is a proposal and the image's own evidence; it is not a
 * validated registration and claims no clinical accuracy. */
import { validateView, viewFrame, type ViewNumbers } from "./carmGeometry";
import {
  CARDIAC_PERIOD_METHOD,
  cardiacPeriod,
  type CardiacPeriod,
} from "./cardiacPeriod";
import {
  CORONARY_MOTION,
  CORONARY_MOTION_METHOD,
  createCoronaryMotionJob,
  type CineFrame,
  type CoronaryMotionJob,
} from "./coronaryMotion";
import { vesselEvidenceSteps, type VesselEvidence } from "./vesselEvidence2d";

export const CORRESPONDENCE_METHOD = "ct_tree_cine_correspondence_v1";
export const CORRESPONDENCE = {
  /** CT phases, percent of the R-R interval, matched to the cine's quiet
   * frames. Any other needs an ECG the cine does not carry. */
  diastolic_ct_phase_percent: [60, 85] as [number, number],
  /** CT points are kept at least this far apart, millimeters. */
  min_spacing_mm: 1,
  max_points: CORONARY_MOTION.max_points,
  max_branches: 40,
  max_path_points: 4000,
  /** The coarse search for where the tree lies, millimeters and degrees. */
  shift_range_mm: 80,
  shift_step_mm: 5,
  turn_range_deg: [-12, -6, 0, 6, 12],
  starts: 6,
  max_depth_mm: 60,
  max_turn_deg: 20,
  /** Evidence level the fit is scored on (blur 2 working pixels). */
  score_level: 3,
  /** Least mean evidence along the lined-up tree to call it found. */
  min_fit: 0.5,
  /** Least share of branches matched for the tree to be found. */
  min_matched_share: 0.5,
  /** A branch is looked for this far from where the pose puts it. */
  branch_search_px: 12,
  min_branch: 0.4,
  /** A second course this close in score, and apart, makes a branch
   * ambiguous; the valley between must fall below this share of it. */
  ambiguous_share: 0.85,
  ambiguous_apart_px: 5,
  valley_share: 0.75,
  /** Cost of a course's distance from the pose, evidence per square
   * pixel: 0.09 at 13 pixels. */
  distance_cost: 0.0005,
  /** Of two branches on one vessel, one keeps it only where it is nearer
   * by this many pixels and this many times; the pose of the rest of the
   * tree is good to about 2 pixels on the tracer. */
  nearer_px: 5,
  nearer_ratio: 3,
  /** Two branches whose courses lie within this of each other for over
   * half their points share one vessel. */
  overlap_px: 2.5,
  overlap_share: 0.5,
  /** Apart in the CT: under this share of overlap before the search. */
  apart_share: 0.2,
} as const;

export type CtTreeBranch = {
  id: string;
  label: string;
  parent: string | null;
  path_ras: number[][];
};
export type CorrespondenceInput = {
  tree: {
    tree_sha256: string;
    /** The CT's reconstruction phase, percent of the R-R interval. */
    ct_phase_percent: number | null;
    branches: CtTreeBranch[];
  };
  cine: {
    source_sha256: string;
    bundle_sha256: string;
    frames: CineFrame[];
    /** Where the frame times came from. A display rate is not a time. */
    timing: "frame_time_vector" | "frame_time" | "cine_rate" | null;
    view: ViewNumbers | null;
    /** Whether the file declares the C-arm static over the cine. */
    geometry: "fixed" | "moving" | "unknown";
  };
  /** The operator's statement that the cine is this patient's. */
  pair: {
    record_id: string;
    tree_sha256: string;
    cine_source_sha256: string;
  } | null;
};

export type RefusalReason =
  | "not_paired"
  | "pair_mismatch"
  | "no_frame_times"
  | "no_geometry"
  | "moving_geometry"
  | "geometry_not_declared"
  | "ct_phase_missing"
  | "ct_phase_needs_ecg"
  | "period_not_read"
  | "tree_not_found";

export const REFUSAL_TEXT: Record<RefusalReason, string> = {
  not_paired: "This cine is not paired with this patient's CT. State the pair first.",
  pair_mismatch: "The stated pair names another tree or another cine.",
  no_frame_times: "The cine has no recorded frame times; a display rate is not a time.",
  no_geometry: "The cine has no C-arm angles and distances.",
  moving_geometry: "The C-arm moved during this cine.",
  geometry_not_declared: "The cine does not say whether the C-arm stood still.",
  ct_phase_missing: "The CT tree does not state its cardiac phase.",
  ct_phase_needs_ecg:
    "The CT phase is outside diastasis; finding it in the cine needs an ECG this cine does not carry.",
  period_not_read: "The heart's period could not be read from this cine.",
  tree_not_found: "The CT tree is not found in this cine.",
};

export type BranchStatus = "matched" | "not_found" | "ambiguous" | "conflict";
export type BranchMatch = {
  id: string;
  label: string;
  parent: string | null;
  status: BranchStatus;
  /** Mean vessel evidence along the branch at its best course, 0 to 1. */
  score: number;
  /** The second course's evidence, where there is one apart. */
  runner_up: number | null;
  /** Where the best course lies from where the pose put the branch. */
  shift_px: [number, number];
  /** The branch's kept CT points, by index into its `path_ras`. */
  ct_index: number[];
  /** Their places in the phase frame, pixels, x right and y down. */
  points_px: number[][];
};
export type MotionFrame =
  | {
      status: "phase" | "followed";
      match: number;
      branches: { id: string; points_px: number[][] }[];
    }
  | { status: "refused"; reason: "low_match" | "torn" };

export type CorrespondenceProposal = {
  method: typeof CORRESPONDENCE_METHOD;
  status: "proposed";
  operator_confirmation_required: true;
  clinical_validation: false;
  tree_sha256: string;
  cine_source_sha256: string;
  bundle_sha256: string;
  pair_record_id: string;
  phase: {
    method: typeof CARDIAC_PERIOD_METHOD;
    ct_phase_percent: number;
    period_ms: number;
    quiet_frames: number[];
    frame: number;
  };
  fit: {
    /** CT RAS to C-arm RAS, millimeters, rigid. */
    ct_to_carm_ras: number[][];
    score: number;
    start_score: number;
  };
  branches: BranchMatch[];
  motion: {
    method: typeof CORONARY_MOTION_METHOD;
    frames: MotionFrame[];
    followed: number;
    refused: number;
  };
};
export type CorrespondenceResult =
  | CorrespondenceProposal
  | {
      method: typeof CORRESPONDENCE_METHOD;
      status: "refused";
      reason: RefusalReason;
      /** What was read before the refusal. */
      period?: CardiacPeriod;
      fit_score?: number;
      matched_share?: number;
    };

export type CorrespondenceJob = {
  advance(expired: () => boolean): boolean;
  result(): CorrespondenceResult;
};

const SHA = /^[a-f0-9]{64}$/,
  ID = /^[a-z0-9][a-z0-9_]{0,31}$/;

function exactKeys(value: unknown, keys: string[], what: string) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${what}`);
  const have = Object.keys(value);
  for (const k of have)
    if (!keys.includes(k)) throw new Error(`Unexpected input: ${what}.${k}`);
  for (const k of keys) if (!have.includes(k)) throw new Error(`Missing ${what}.${k}`);
}

function validate(input: CorrespondenceInput) {
  exactKeys(input, ["tree", "cine", "pair"], "input");
  exactKeys(input.tree, ["tree_sha256", "ct_phase_percent", "branches"], "tree");
  exactKeys(
    input.cine,
    ["source_sha256", "bundle_sha256", "frames", "timing", "view", "geometry"],
    "cine",
  );
  if (input.pair !== null)
    exactKeys(input.pair, ["record_id", "tree_sha256", "cine_source_sha256"], "pair");
  const { tree, cine } = input;
  if (!SHA.test(tree.tree_sha256) || !SHA.test(cine.source_sha256) || !SHA.test(cine.bundle_sha256))
    throw new Error("Invalid digest");
  const p = tree.ct_phase_percent;
  if (p !== null && !(Number.isFinite(p) && p >= 0 && p < 100))
    throw new Error("Invalid CT phase");
  const L = CORRESPONDENCE;
  if (
    !Array.isArray(tree.branches) ||
    tree.branches.length < 1 ||
    tree.branches.length > L.max_branches
  )
    throw new Error("A tree of 1 to 40 branches is required");
  const ids = new Set<string>();
  for (const b of tree.branches) {
    exactKeys(b, ["id", "label", "parent", "path_ras"], "branch");
    if (!ID.test(b.id) || ids.has(b.id)) throw new Error("Branch ids must be distinct");
    ids.add(b.id);
    if (typeof b.label !== "string" || b.label.length > 80)
      throw new Error("Invalid branch label");
    if (
      !Array.isArray(b.path_ras) ||
      b.path_ras.length < 2 ||
      b.path_ras.length > L.max_path_points ||
      !b.path_ras.every(
        (q) =>
          Array.isArray(q) &&
          q.length === 3 &&
          q.every((v) => Number.isFinite(v) && Math.abs(v) < 1e5),
      )
    )
      throw new Error("Invalid branch path");
  }
  for (const b of tree.branches)
    if (b.parent !== null && (!ids.has(b.parent) || b.parent === b.id))
      throw new Error("A branch's parent must be another branch of the tree");
  if (!["frame_time_vector", "frame_time", "cine_rate", null].includes(cine.timing))
    throw new Error("Invalid timing");
  if (!["fixed", "moving", "unknown"].includes(cine.geometry))
    throw new Error("Invalid geometry");
}

/** Each branch's CT points, kept at an even spacing so the whole tree
 * stays within the point budget. */
function sample(branches: readonly CtTreeBranch[]): number[][] {
  const L = CORRESPONDENCE;
  let length = 0;
  for (const b of branches)
    for (let i = 1; i < b.path_ras.length; i++)
      length += Math.hypot(
        ...b.path_ras[i].map((v, k) => v - b.path_ras[i - 1][k]),
      );
  const spacing = Math.max(L.min_spacing_mm, length / (L.max_points - 2 * branches.length));
  return branches.map((b) => {
    const kept = [0];
    let since = 0;
    for (let i = 1; i < b.path_ras.length; i++) {
      since += Math.hypot(...b.path_ras[i].map((v, k) => v - b.path_ras[i - 1][k]));
      if (since >= spacing) {
        kept.push(i);
        since = 0;
      }
    }
    if (kept[kept.length - 1] !== b.path_ras.length - 1)
      kept.push(b.path_ras.length - 1);
    return kept;
  });
}

type Pose = [number, number, number, number, number, number];

function rotation(rx: number, ry: number, rz: number, axes: number[][]): number[][] {
  // Turns about the C-arm's own axes (u, v, then the beam d), degrees.
  const turn = (axis: number[], deg: number) => {
    const a = (deg * Math.PI) / 180,
      c = Math.cos(a),
      s = Math.sin(a),
      [x, y, z] = axis;
    return [
      [c + x * x * (1 - c), x * y * (1 - c) - z * s, x * z * (1 - c) + y * s],
      [y * x * (1 - c) + z * s, c + y * y * (1 - c), y * z * (1 - c) - x * s],
      [z * x * (1 - c) - y * s, z * y * (1 - c) + x * s, c + z * z * (1 - c)],
    ];
  };
  const mul = (a: number[][], b: number[][]) =>
    a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
  return mul(turn(axes[2], rz), mul(turn(axes[1], ry), turn(axes[0], rx)));
}

type Geometry = {
  view: ViewNumbers;
  u: number[];
  v: number[];
  d: number[];
  source: number[];
  width: number;
  height: number;
};

function geometryOf(view: ViewNumbers, width: number, height: number): Geometry {
  const checked = validateView(view);
  const { u, v, d } = viewFrame(checked.primary_deg, checked.secondary_deg);
  return {
    view: checked,
    u,
    v,
    d,
    source: d.map((x) => -x * checked.source_isocenter_mm),
    width,
    height,
  };
}

/** The pose as a CT-to-C-arm matrix: the tree's centre to the isocenter,
 * turned, then moved. */
function matrixOf(pose: Pose, centre: number[], g: Geometry): number[][] {
  const R = rotation(pose[3], pose[4], pose[5], [g.u, g.v, g.d]);
  const t = [0, 1, 2].map(
    (i) => pose[0] * g.u[i] + pose[1] * g.v[i] + pose[2] * g.d[i],
  );
  const out = R.map((row, i) => [
    ...row,
    t[i] - (row[0] * centre[0] + row[1] * centre[1] + row[2] * centre[2]),
  ]);
  out.push([0, 0, 0, 1]);
  return out;
}

/** CT points to frame pixels under a matrix; NaN where behind the source
 * or past the detector. */
function projectAll(points: number[][], m: number[][], g: Geometry): number[][] {
  const sdd = g.view.source_detector_mm;
  return points.map((p) => {
    const q = [0, 1, 2].map(
      (i) => m[i][0] * p[0] + m[i][1] * p[1] + m[i][2] * p[2] + m[i][3] - g.source[i],
    );
    const depth = q[0] * g.d[0] + q[1] * g.d[1] + q[2] * g.d[2];
    if (!(depth > 1 && depth < sdd)) return [NaN, NaN];
    const s = sdd / depth,
      x = (q[0] * g.u[0] + q[1] * g.u[1] + q[2] * g.u[2]) * s,
      y = (q[0] * g.v[0] + q[1] * g.v[1] + q[2] * g.v[2]) * s;
    return [
      (x / g.view.detector_width_mm + 0.5) * g.width,
      (0.5 - y / g.view.detector_height_mm) * g.height,
    ];
  });
}

/** Mean evidence at frame pixels on one level; a point off the frame
 * counts as no evidence. */
function scoreOn(
  ev: VesselEvidence,
  level: number,
  pts: readonly number[][],
  dx = 0,
  dy = 0,
): number {
  if (!pts.length) return 0;
  const map = ev.levels[level],
    w = ev.width,
    h = ev.height;
  let s = 0;
  for (const p of pts) {
    const x = (p[0] + dx + 0.5) / ev.scale - 0.5,
      y = (p[1] + dy + 0.5) / ev.scale - 0.5;
    if (!(x >= 0 && y >= 0 && x <= w - 1 && y <= h - 1)) continue;
    const x0 = Math.min(w - 2, Math.floor(x)),
      y0 = Math.min(h - 2, Math.floor(y)),
      fx = x - x0,
      fy = y - y0,
      i = y0 * w + x0;
    s +=
      (1 - fy) * ((1 - fx) * map[i] + fx * map[i + 1]) +
      fy * ((1 - fx) * map[i + w] + fx * map[i + w + 1]);
  }
  return s / pts.length;
}

function overlapShare(a: number[][], b: number[][], within: number): number {
  if (!a.length) return 0;
  let n = 0;
  for (const p of a)
    if (b.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= within)) n++;
  return n / a.length;
}

type Candidate = { dx: number; dy: number; score: number; rank: number };

/** The courses a branch could lie on near where the pose put it: the peaks
 * of its evidence over shifts, best first. A peak counts only where a
 * valley parts it from every better peak. Courses are ranked by their
 * evidence less a small cost for their distance from the pose, so of two
 * equal courses the nearer is first. */
function candidates(ev: VesselEvidence, pts: number[][]): Candidate[] {
  const L = CORRESPONDENCE,
    R = L.branch_search_px,
    side = 2 * R + 1,
    grid = new Float64Array(side * side);
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++)
      grid[(dy + R) * side + dx + R] = scoreOn(ev, L.score_level, pts, dx, dy);
  const peaks: Candidate[] = [];
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const v = grid[y * side + x];
      if (v < L.min_branch * 0.5) continue;
      let peak = true;
      for (let j = -1; j <= 1 && peak; j++)
        for (let q = -1; q <= 1; q++) {
          const yy = y + j,
            xx = x + q;
          if ((j || q) && yy >= 0 && xx >= 0 && yy < side && xx < side && grid[yy * side + xx] > v)
            peak = false;
        }
      if (peak)
        peaks.push({
          dx: x - R,
          dy: y - R,
          score: v,
          rank: v - L.distance_cost * ((x - R) ** 2 + (y - R) ** 2),
        });
    }
  peaks.sort((a, b) => b.rank - a.rank);
  const valleyBetween = (a: Candidate, b: Candidate) => {
    const n = Math.ceil(Math.hypot(a.dx - b.dx, a.dy - b.dy));
    let low = Infinity;
    for (let t = 1; t < n; t++) {
      const x = Math.round(a.dx + ((b.dx - a.dx) * t) / n) + R,
        y = Math.round(a.dy + ((b.dy - a.dy) * t) / n) + R;
      low = Math.min(low, grid[y * side + x]);
    }
    return low < L.valley_share * Math.min(a.score, b.score);
  };
  const out: Candidate[] = [];
  for (const p of peaks)
    if (
      out.every(
        (q) =>
          Math.hypot(p.dx - q.dx, p.dy - q.dy) >= L.ambiguous_apart_px &&
          valleyBetween(p, q),
      )
    )
      out.push(p);
  return out;
}

type Assigned = {
  status: BranchStatus;
  best: Candidate | null;
  runner: Candidate | null;
};

/** Each branch's course. Where two branches apart in the CT come to lie on
 * one vessel, the one nearer it keeps it and the other looks again
 * elsewhere; where neither is clearly nearer, both are in conflict.
 * Nearness is taken under the pose fitted without either branch, so that
 * neither has pulled the pose onto the vessel.
 * A branch's second course counts against it (ambiguous) only where no
 * other branch lies on it. */
function assign(
  placed: number[][][],
  options: Candidate[][],
  shifted: (i: number, c: Candidate) => number[][],
  apartFrom: (i: number, j: number, ci: number[][], cj: number[][]) => [number, number],
): Assigned[] {
  const L = CORRESPONDENCE,
    n = placed.length;
  const pool = options.map((o) => o.filter((c) => c.score >= L.min_branch));
  const conflict = new Set<number>();
  const apart = (i: number, j: number) =>
    Math.max(
      overlapShare(placed[i], placed[j], L.overlap_px),
      overlapShare(placed[j], placed[i], L.overlap_px),
    ) < L.apart_share;
  const together = (a: number[][], b: number[][]) =>
    Math.max(overlapShare(a, b, L.overlap_px), overlapShare(b, a, L.overlap_px)) >
    L.overlap_share;
  for (let round = 0; round < 4 * n; round++) {
    let changed = false;
    for (let i = 0; i < n && !changed; i++)
      for (let j = i + 1; j < n && !changed; j++) {
        if (conflict.has(i) || conflict.has(j)) continue;
        const a = pool[i][0],
          b = pool[j][0];
        if (!a || !b || !apart(i, j)) continue;
        const pa = shifted(i, a),
          pb = shifted(j, b);
        if (!together(pa, pb)) continue;
        const [da, db] = apartFrom(i, j, pa, pb);
        const clearly = (near: number, far: number) =>
          near + L.nearer_px <= far && L.nearer_ratio * near <= far;
        if (clearly(da, db))
          pool[j] = pool[j].filter((c) => !together(shifted(j, c), pa));
        else if (clearly(db, da))
          pool[i] = pool[i].filter((c) => !together(shifted(i, c), pb));
        else {
          conflict.add(i);
          conflict.add(j);
        }
        changed = true;
      }
    if (!changed) break;
  }
  const bests = pool.map((p) => p[0] ?? null);
  return pool.map((p, i) => {
    const best = bests[i];
    if (!best) return { status: "not_found", best: null, runner: null };
    if (conflict.has(i)) return { status: "conflict", best, runner: p[1] ?? null };
    const others = bests
      .map((c, j) => (c && j !== i ? shifted(j, c) : null))
      .filter((x): x is number[][] => x !== null);
    const runner =
      p.slice(1).find((c) => others.every((o) => !together(shifted(i, c), o))) ?? null;
    const status: BranchStatus =
      runner && runner.score >= L.ambiguous_share * best.score ? "ambiguous" : "matched";
    return { status, best, runner };
  });
}

function* steps(
  input: CorrespondenceInput,
  slice: { motion: CoronaryMotionJob | null },
): Generator<void, CorrespondenceResult, void> {
  validate(input);
  const L = CORRESPONDENCE,
    { tree, cine, pair } = input;
  const refuse = (
    reason: RefusalReason,
    extra: Partial<Record<"period" | "fit_score" | "matched_share", unknown>> = {},
  ): CorrespondenceResult =>
    ({ method: CORRESPONDENCE_METHOD, status: "refused", reason, ...extra }) as CorrespondenceResult;
  if (!pair) return refuse("not_paired");
  if (pair.tree_sha256 !== tree.tree_sha256 || pair.cine_source_sha256 !== cine.source_sha256)
    return refuse("pair_mismatch");
  if (cine.timing !== "frame_time_vector" && cine.timing !== "frame_time")
    return refuse("no_frame_times");
  if (!cine.view) return refuse("no_geometry");
  if (cine.geometry === "moving") return refuse("moving_geometry");
  if (cine.geometry !== "fixed") return refuse("geometry_not_declared");
  const ct_phase = tree.ct_phase_percent;
  if (ct_phase === null) return refuse("ct_phase_missing");
  if (ct_phase < L.diastolic_ct_phase_percent[0] || ct_phase > L.diastolic_ct_phase_percent[1])
    return refuse("ct_phase_needs_ecg");
  const frames = cine.frames;
  const period = cardiacPeriod(frames);
  if (period.status !== "read") return refuse("period_not_read", { period });
  yield;

  const { width, height } = frames[0];
  const g = geometryOf(cine.view, width, height);
  // Evidence on each quiet frame; the phase frame holds the most.
  let ev: VesselEvidence | null = null,
    frame = period.quiet_frames[0];
  for (const k of period.quiet_frames) {
    const it = vesselEvidenceSteps(frames[k].pixels, width, height, "dark");
    let next = it.next();
    while (!next.done) {
      yield;
      next = it.next();
    }
    if (!ev || next.value.strong.length > ev.strong.length) {
      ev = next.value;
      frame = k;
    }
  }
  if (!ev) return refuse("period_not_read", { period });

  const kept = sample(tree.branches);
  const ctPoints = tree.branches.map((b, i) => kept[i].map((j) => b.path_ras[j]));
  const all = ctPoints.flat();
  const centre = [0, 1, 2].map((k) => all.reduce((s, p) => s + p[k], 0) / all.length);
  const coarse = all.filter((_, i) => i % 2 === 0);
  const at = (pose: Pose, pts: number[][], level: number) =>
    scoreOn(ev!, level, projectAll(pts, matrixOf(pose, centre, g), g));

  // Coarse: where in the frame, and how turned in its plane.
  const found: { pose: Pose; score: number }[] = [];
  for (const rz of L.turn_range_deg) {
    for (let a = -L.shift_range_mm; a <= L.shift_range_mm; a += L.shift_step_mm)
      for (let b = -L.shift_range_mm; b <= L.shift_range_mm; b += L.shift_step_mm) {
        const pose: Pose = [a, b, 0, 0, 0, rz];
        found.push({ pose, score: at(pose, coarse, 0) });
      }
    yield;
  }
  found.sort((p, q) => q.score - p.score);
  const starts: Pose[] = [];
  for (const f of found) {
    if (
      starts.every(
        (s) => Math.hypot(s[0] - f.pose[0], s[1] - f.pose[1]) >= 2 * L.shift_step_mm,
      )
    )
      starts.push(f.pose);
    if (starts.length >= L.starts) break;
  }
  // Fine: all six, level by level, by a pattern search.
  const limits = [L.shift_range_mm + 10, L.shift_range_mm + 10, L.max_depth_mm, L.max_turn_deg, L.max_turn_deg, L.max_turn_deg];
  const refineLevel = (start: Pose, pts: number[][], level: number): Pose => {
    let pose = [...start] as Pose;
    const scaleMm = 8 / 2 ** level;
    const step = [scaleMm, scaleMm, 4 * scaleMm, scaleMm, scaleMm, scaleMm];
    let score = at(pose, pts, level);
    for (let round = 0; round < 6; round++) {
      let moved = false;
      for (let i = 0; i < 6; i++)
        for (const sign of [1, -1]) {
          const trial = [...pose] as Pose;
          trial[i] += sign * step[i];
          if (Math.abs(trial[i]) > limits[i]) continue;
          const s = at(trial, pts, level);
          if (s > score + 1e-9) {
            pose = trial;
            score = s;
            moved = true;
          }
        }
      if (!moved) for (let i = 0; i < 6; i++) step[i] /= 2;
    }
    return pose;
  };
  let best: { pose: Pose; score: number } | null = null;
  for (const start of starts) {
    let pose = [...start] as Pose;
    for (let level = 1; level < ev.levels.length; level++) {
      pose = refineLevel(pose, all, level);
      yield;
    }
    const score = at(pose, all, L.score_level);
    if (!best || score > best.score) best = { pose, score };
  }
  const pose = best!.pose,
    matrix = matrixOf(pose, centre, g),
    fitScore = best!.score;
  if (fitScore < L.min_fit) return refuse("tree_not_found", { period, fit_score: fitScore });

  // Each branch near where the pose put it.
  const placed = ctPoints.map((pts) => projectAll(pts, matrix, g));
  const options = placed.map((pts) =>
    candidates(ev!, pts.filter((p) => Number.isFinite(p[0]))),
  );
  const shifted = (i: number, c: Candidate) =>
    placed[i]
      .filter((p) => Number.isFinite(p[0]))
      .map((p) => [p[0] + c.dx, p[1] + c.dy]);
  // Where two branches contest one course, how far each lies from it
  // under the pose fitted to the rest of the tree, which neither pulled.
  const apartFrom = (i: number, j: number, ci: number[][], cj: number[][]) => {
    const rest = ctPoints.filter((_, k) => k !== i && k !== j).flat();
    let p = pose;
    if (rest.length >= 3)
      for (let level = 1; level < ev!.levels.length; level++) p = refineLevel(p, rest, level);
    const m = matrixOf(p, centre, g);
    const away = (k: number, course: number[][]) => {
      const now = projectAll(ctPoints[k], m, g).filter((q) => Number.isFinite(q[0]));
      const n = Math.min(now.length, course.length);
      let x = 0,
        y = 0;
      for (let t = 0; t < n; t++) {
        x += course[t][0] - now[t][0];
        y += course[t][1] - now[t][1];
      }
      return n ? Math.hypot(x / n, y / n) : Infinity;
    };
    return [away(i, ci), away(j, cj)] as [number, number];
  };
  const assigned = assign(placed, options, shifted, apartFrom);
  const branches: BranchMatch[] = tree.branches.map((b, i) => {
    const { status, best, runner } = assigned[i];
    const tx = best?.dx ?? 0,
      ty = best?.dy ?? 0;
    const keep = placed[i]
      .map((p, k) => [p, kept[i][k]] as const)
      .filter(
        ([p]) =>
          Number.isFinite(p[0]) &&
          p[0] + tx >= 0 &&
          p[1] + ty >= 0 &&
          p[0] + tx <= width - 1 &&
          p[1] + ty <= height - 1,
      );
    return {
      id: b.id,
      label: b.label,
      parent: b.parent,
      status,
      score: best?.score ?? 0,
      runner_up: runner?.score ?? null,
      shift_px: [tx, ty] as [number, number],
      ct_index: keep.map(([, j]) => j),
      points_px: keep.map(([p]) => [p[0] + tx, p[1] + ty]),
    };
  });
  const matched = branches.filter((b) => b.status === "matched");
  const share = matched.length / branches.length;
  if (share < L.min_matched_share || matched.reduce((s, b) => s + b.points_px.length, 0) < 3)
    return refuse("tree_not_found", { period, fit_score: fitScore, matched_share: share });
  yield;

  // Followed over the cine from the phase frame.
  const job = createCoronaryMotionJob({
    frames,
    reference: frame,
    branches: matched.map((b) => ({ id: b.id, points: b.points_px })),
  });
  slice.motion = job;
  while (!job.advance(() => true)) yield;
  slice.motion = null;
  const tracked = job.result();
  const motionFrames: MotionFrame[] = tracked.frames.map((f) =>
    f.status === "refused"
      ? { status: "refused", reason: f.reason }
      : {
          status: f.status === "reference" ? "phase" : "followed",
          match: f.match,
          branches: f.branches.map((b, i) => ({ id: matched[i].id, points_px: b.points })),
        },
  );
  return {
    method: CORRESPONDENCE_METHOD,
    status: "proposed",
    operator_confirmation_required: true,
    clinical_validation: false,
    tree_sha256: tree.tree_sha256,
    cine_source_sha256: cine.source_sha256,
    bundle_sha256: cine.bundle_sha256,
    pair_record_id: pair.record_id,
    phase: {
      method: CARDIAC_PERIOD_METHOD,
      ct_phase_percent: ct_phase,
      period_ms: period.period_ms,
      quiet_frames: period.quiet_frames,
      frame,
    },
    fit: {
      ct_to_carm_ras: matrix,
      score: fitScore,
      start_score: at([0, 0, 0, 0, 0, 0], all, L.score_level),
    },
    branches,
    motion: {
      method: CORONARY_MOTION_METHOD,
      frames: motionFrames,
      followed: motionFrames.filter((f) => f.status === "followed").length,
      refused: motionFrames.filter((f) => f.status === "refused").length,
    },
  };
}

/** A job the caller advances in short slices, so a page stays live. */
export function createCorrespondenceJob(input: CorrespondenceInput): CorrespondenceJob {
  const slice = { motion: null as CoronaryMotionJob | null };
  const it = steps(input, slice);
  let done: CorrespondenceResult | null = null;
  return {
    advance(expired) {
      while (!done) {
        const next = it.next();
        if (next.done) done = next.value;
        else if (expired()) return false;
      }
      return true;
    },
    result() {
      if (!done) throw new Error("Correspondence is not complete");
      return done;
    },
  };
}

export function proposeCorrespondence(input: CorrespondenceInput): CorrespondenceResult {
  const job = createCorrespondenceJob(input);
  job.advance(() => false);
  return job.result();
}
