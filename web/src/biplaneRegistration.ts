/** Joint 2D-to-3D rigid registration proposal against two angiographic
 * planes that share one patient pose.
 *
 * One plane leaves depth and out-of-plane turns weakly determined (see
 * projectionRegistration.ts). A second plane far enough from the first sees
 * the first plane's depth as an in-plane shift, so one rigid pose scored
 * against both frames at once is determined in all six freedoms. Each plane
 * is scored the way the single-plane method scores it; the joint cost is the
 * mean of the two, with no pull toward the start.
 *
 * The two frames must show the same anatomy in the same position: acquired
 * together, or with no patient or table movement between them. Nothing here
 * can check that. The result is a proposal for an operator to review, and
 * its scores measure agreement between automatically extracted line sets,
 * not registration accuracy.
 *
 * The single-plane method is left as it is, and this module repeats its
 * per-plane scoring, because a saved `centerline_distance_compass_v1` record
 * can be replayed to the same numbers only while that arithmetic is fixed. */
import { camera, viewFrame, type ViewNumbers } from "./carmGeometry";
import type { Vec3 } from "./obliqueSlice";
import {
  finiteView,
  orthonormal,
  PROJECTION_REGISTRATION_LIMITS as PLANE,
  rotation,
  type RegistrationScore,
} from "./projectionRegistration";
import { validateRigid } from "./rigidFusion";
import { VESSEL_TARGET_LIMITS, type VesselTarget } from "./vesselness2d";

export const BIPLANE_REGISTRATION_METHOD =
  "centerline_distance_compass_biplane_v1";
export const BIPLANE_REGISTRATION_LIMITS = {
  /** Search range about the starting pose along each of plane A's camera
   * axes, and about each of them. */
  translation_mm: 60,
  rotation_deg: 15,
  /** Smallest angle between the two central rays. Below it the second plane
   * adds too little to determine depth. */
  min_plane_angle_deg: 30,
  /** Distance cap of the last refinement, in millimeters at the isocenter
   * plane. Earlier stages use the single-plane method's wider cap. */
  final_truncation_mm: 2,
  /** One evaluation scores both planes, or stops at the first plane that
   * leaves too few points inside its frame. */
  max_evaluations: 60_000,
} as const;

export type BiplanePlaneInput = {
  view: ViewNumbers;
  /** A point on this plane's central ray, in C-arm RAS millimeters. Two
   * planes of one system share it; it is given per plane so that central
   * rays that do not meet can still be described. */
  isocenter: Vec3;
  frame: { width: number; height: number };
  target: VesselTarget;
  /** Fit this plane's detector scale, for an uncalibrated plane. */
  fit_detector_scale: boolean;
};
export type BiplaneRegistrationInput = {
  /** Medial vessel points, x y z triples in volume RAS millimeters. */
  points: Float32Array;
  planes: [BiplanePlaneInput, BiplanePlaneInput];
  /** Rigid volume-RAS to C-arm-RAS matrix the search starts from. */
  start: unknown;
};
export type BiplanePlaneProposal = {
  /** The view this plane was scored in. Its detector size carries the
   * fitted scale when one was fitted. */
  view: ViewNumbers;
  detector_scale: number;
  score: RegistrationScore;
  start_score: RegistrationScore;
};
export type BiplaneRegistrationProposal = {
  method: typeof BIPLANE_REGISTRATION_METHOD;
  /** Rigid volume-RAS to C-arm-RAS matrix, one for both planes. */
  matrix: number[][];
  planes: [BiplanePlaneProposal, BiplanePlaneProposal];
  /** Angle between the two central rays, 0 to 90 degrees. */
  plane_angle_deg: number;
  /** How far the proposal moved the point-set centroid from the start, and
   * the angle it turned from the start. */
  translation_mm: number;
  rotation_deg: number;
  point_count: number;
  evaluations: number;
};
export type BiplaneRegistrationJob = {
  /** Runs until the search is complete or `expired()` returns true. Returns
   * true once complete. A failure is thrown again by every later call. */
  advance(expired: () => boolean): boolean;
  result(): BiplaneRegistrationProposal;
};

const rad = Math.PI / 180;
const dot = (a: readonly number[], b: readonly number[]) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Whether two central rays this many degrees apart can be fitted together.
 * The margin absorbs rounding, so that planes entered exactly at the limit
 * pass here, in the saved-record parser and on the server alike. */
export const planesFarEnough = (plane_angle_deg: number) =>
  plane_angle_deg >= BIPLANE_REGISTRATION_LIMITS.min_plane_angle_deg - 1e-9;

/** Angle between the central rays of two views, 0 to 90 degrees. */
export function planeAngleDeg(a: ViewNumbers, b: ViewNumbers): number {
  const cosine = Math.abs(
    dot(
      viewFrame(a.primary_deg, a.secondary_deg).d,
      viewFrame(b.primary_deg, b.secondary_deg).d,
    ),
  );
  return Math.acos(Math.min(1, cosine)) / rad;
}

type Subset = { points: Float32Array; count: number };
type Measure = {
  forward: number;
  inside: number;
  matched: number;
  uncovered: number;
};
type Found = { p: number[]; cost: number };

/** Scores one plane. Points are in plane A's camera axes about the pivot;
 * `measure` turns them by `r`, shifts them by `p` and takes them to this
 * plane's own axes. `cap` is the distance cap in working pixels. */
function planeScorer(
  input: BiplanePlaneInput,
  axesA: readonly Vec3[],
  pivot: readonly number[],
) {
  const { target, frame } = input,
    view = finiteView(input.view, frame),
    isocenter = input.isocenter;
  if (
    !Array.isArray(isocenter) ||
    isocenter.length !== 3 ||
    !isocenter.every(Number.isFinite)
  )
    throw new Error("Invalid isocenter");
  if (
    target.distance.length !== target.width * target.height ||
    target.width * target.scale > frame.width ||
    target.height * target.scale > frame.height ||
    (target.width + 1) * target.scale <= frame.width ||
    (target.height + 1) * target.scale <= frame.height
  )
    throw new Error("Vessel target does not belong to this frame");
  const cam = camera(view, isocenter),
    axes = [cam.u, cam.v, cam.d],
    sid = view.source_detector_mm,
    sod = view.source_isocenter_mm;
  const toPlane = axes.flatMap((axis) => axesA.map((a) => dot(axis, a)));
  const offset = axes.map((axis) =>
    dot(axis, [
      pivot[0] - isocenter[0],
      pivot[1] - isocenter[1],
      pivot[2] - isocenter[2],
    ]),
  );
  // Working-grid geometry. One working pixel is `mm_per_px` at the isocenter.
  const { width: w, height: h, distance } = target;
  const pitch = view.detector_width_mm / frame.width;
  if (Math.abs(view.detector_height_mm / frame.height / pitch - 1) > 0.02)
    throw new Error("Detector pixels must be square");
  const mm_per_px = (pitch * target.scale * sod) / sid;
  const fullCap = PLANE.truncation_mm / mm_per_px;
  if (fullCap > VESSEL_TARGET_LIMITS.max_distance_px)
    throw new Error("Field too small for this frame");
  const fw = frame.width / target.scale,
    fh = frame.height / target.scale;
  const cell = Math.max(1, Math.round(fullCap / 3)),
    gw = Math.ceil(w / cell),
    gh = Math.ceil(h / cell),
    grid = new Uint32Array(gw * gh);
  const sampleStride = Math.ceil(target.centerline.length / 2500),
    sampleCount = Math.ceil(target.centerline.length / sampleStride),
    sampleCell = new Int32Array(sampleCount);
  for (let k = 0; k < sampleCount; k++) {
    const at = target.centerline[k * sampleStride],
      x = at % w,
      y = (at - x) / w;
    sampleCell[k] = Math.floor(y / cell) * gw + Math.floor(x / cell);
  }
  let stamp = 0;

  const measure = (
    set: Subset,
    r: number[],
    p: number[],
    logScale: number,
    cap: number,
  ): Measure => {
    const scale = Math.exp(logScale);
    const kx = (sid / (view.detector_width_mm * scale)) * fw,
      ky = (sid / (view.detector_height_mm * scale)) * fh;
    if (++stamp >= 0xffffffff) {
      grid.fill(0);
      stamp = 1;
    }
    let sum = 0,
      inside = 0,
      matched = 0;
    const near = PLANE.match_mm / (mm_per_px * scale);
    const m = toPlane;
    for (let k = 0; k < set.count; k++) {
      const x = set.points[3 * k],
        y = set.points[3 * k + 1],
        z = set.points[3 * k + 2];
      const ax = r[0] * x + r[1] * y + r[2] * z + p[0],
        ay = r[3] * x + r[4] * y + r[5] * z + p[1],
        az = r[6] * x + r[7] * y + r[8] * z + p[2];
      const depth = sod + m[6] * ax + m[7] * ay + m[8] * az + offset[2];
      if (!(depth >= 1) || depth > sid) {
        sum += cap;
        continue;
      }
      const px =
          ((m[0] * ax + m[1] * ay + m[2] * az + offset[0]) / depth) * kx +
          fw / 2 -
          0.5,
        py =
          fh / 2 -
          ((m[3] * ax + m[4] * ay + m[5] * az + offset[1]) / depth) * ky -
          0.5;
      if (!(px >= -0.5 && py >= -0.5 && px <= fw - 0.5 && py <= fh - 0.5)) {
        sum += cap;
        continue;
      }
      inside++;
      const sx = px < 0 ? 0 : px > w - 1 ? w - 1 : px,
        sy = py < 0 ? 0 : py > h - 1 ? h - 1 : py,
        x0 = Math.min(w - 2, Math.floor(sx)),
        y0 = Math.min(h - 2, Math.floor(sy)),
        fx = sx - x0,
        fy = sy - y0,
        at = y0 * w + x0;
      const d =
        distance[at] * (1 - fx) * (1 - fy) +
        distance[at + 1] * fx * (1 - fy) +
        distance[at + w] * (1 - fx) * fy +
        distance[at + w + 1] * fx * fy;
      sum += d < cap ? d : cap;
      if (d <= near) matched++;
      // The same coarse reverse-coverage heuristic as the single-plane
      // method: a search term, not a vessel-presence measurement.
      const cx = Math.floor((sx + 0.5) / cell),
        cy = Math.floor((sy + 0.5) / cell);
      for (let j = cy > 0 ? cy - 1 : 0; j <= cy + 1 && j < gh; j++)
        for (let i = cx > 0 ? cx - 1 : 0; i <= cx + 1 && i < gw; i++)
          grid[j * gw + i] = stamp;
    }
    let uncovered = 0;
    for (let k = 0; k < sampleCount; k++)
      if (grid[sampleCell[k]] !== stamp) uncovered++;
    return {
      forward: sum / (set.count * cap),
      inside: inside / set.count,
      matched: matched / set.count,
      uncovered: uncovered / sampleCount,
    };
  };
  const score = (m: Measure, logScale: number): RegistrationScore => ({
    mean_distance_mm: m.forward * fullCap * mm_per_px * Math.exp(logScale),
    matched_fraction: m.matched,
    in_field_fraction: m.inside,
    uncovered_fraction: m.uncovered,
  });
  return { view, measure, score, fullCap, fit: input.fit_detector_scale };
}

function* solve(
  input: BiplaneRegistrationInput,
): Generator<void, BiplaneRegistrationProposal> {
  const L = BIPLANE_REGISTRATION_LIMITS;
  const { points } = input;
  if (!Array.isArray(input.planes) || input.planes.length !== 2)
    throw new Error("Two planes are required");
  const start = validateRigid(input.start);
  if (
    !(points instanceof Float32Array) ||
    points.length % 3 !== 0 ||
    points.length / 3 < PLANE.min_points
  )
    throw new Error("Too few vessel points to register");
  for (let i = 0; i < points.length; i++)
    if (!Number.isFinite(points[i])) throw new Error("Nonfinite vessel point");
  const views = input.planes.map((plane) =>
    finiteView(plane.view, plane.frame),
  );
  const plane_angle_deg = planeAngleDeg(views[0], views[1]);
  if (!planesFarEnough(plane_angle_deg))
    throw new Error("The two planes are too close to parallel");
  const total = points.length / 3;
  // Points at the start pose, and their centroid: the pivot of the search.
  const pivot = [0, 0, 0];
  const world = new Float64Array(points.length);
  for (let k = 0; k < total; k++)
    for (let i = 0; i < 3; i++) {
      const value =
        start[i][0] * points[3 * k] +
        start[i][1] * points[3 * k + 1] +
        start[i][2] * points[3 * k + 2] +
        start[i][3];
      world[3 * k + i] = value;
      pivot[i] += value / total;
    }
  // The search moves along and about plane A's camera axes.
  const frameA = viewFrame(views[0].primary_deg, views[0].secondary_deg),
    axes: Vec3[] = [frameA.u, frameA.v, frameA.d];
  const subset = (limit: number): Subset => {
    const stride = Math.ceil(total / limit),
      count = Math.ceil(total / stride),
      out = new Float32Array(3 * count);
    for (let k = 0; k < count; k++)
      for (let i = 0; i < 3; i++) {
        const at = 3 * k * stride;
        out[3 * k + i] =
          axes[i][0] * (world[at] - pivot[0]) +
          axes[i][1] * (world[at + 1] - pivot[1]) +
          axes[i][2] * (world[at + 2] - pivot[2]);
      }
    return { points: out, count };
  };
  const coarse = subset(500),
    fine = subset(PLANE.max_points);
  const scorers = input.planes.map((plane) => planeScorer(plane, axes, pivot));
  let evaluations = 0;

  // p = shift along A's axes (3), turn about them (3), log scale of A and B.
  // Share of each plane's distance cap in force: 1 except in the last stage.
  let trim = 1;
  const cost = (set: Subset, p: number[]) => {
    evaluations++;
    const r = rotation(p[3], p[4], p[5]);
    let sum = 0;
    for (let k = 0; k < 2; k++) {
      const m = scorers[k].measure(
        set,
        r,
        p,
        p[6 + k],
        scorers[k].fullCap * trim,
      );
      if (m.inside < PLANE.min_in_field) return 2;
      sum += m.forward + 0.5 * m.uncovered;
    }
    return sum / 2;
  };
  const report = (p: number[]): RegistrationScore[] => {
    const r = rotation(p[3], p[4], p[5]);
    return scorers.map((scorer, k) =>
      scorer.score(
        scorer.measure(fine, r, p, p[6 + k], scorer.fullCap),
        p[6 + k],
      ),
    );
  };
  const logScale = PLANE.detector_scale.map(Math.log);
  const within = (p: number[]) =>
    Math.abs(p[0]) <= L.translation_mm &&
    Math.abs(p[1]) <= L.translation_mm &&
    Math.abs(p[2]) <= L.translation_mm &&
    Math.abs(p[3]) <= L.rotation_deg &&
    Math.abs(p[4]) <= L.rotation_deg &&
    Math.abs(p[5]) <= L.rotation_deg &&
    p[6] >= logScale[0] &&
    p[6] <= logScale[1] &&
    p[7] >= logScale[0] &&
    p[7] <= logScale[1];
  // Per-parameter unit steps: millimeters, degrees, and 1% of a fitted
  // detector scale.
  const fit = scorers.map((scorer) => scorer.fit);
  const unit = [1, 1, 1, 1, 1, 1, fit[0] ? 0.01 : 0, fit[1] ? 0.01 : 0];

  function* descend(
    set: Subset,
    from: number[],
    step: number,
    stop: number,
    budget: number,
  ): Generator<void, Found> {
    const end = Math.min(evaluations + budget, L.max_evaluations);
    let p = from,
      best = cost(set, p);
    yield;
    while (step >= stop && evaluations < end) {
      let moved = false;
      for (let i = 0; i < 8; i++) {
        if (unit[i] === 0) continue;
        for (const sign of [1, -1]) {
          if (evaluations >= end) break;
          const q = p.slice();
          q[i] += sign * step * unit[i];
          if (!within(q)) continue;
          const c = cost(set, q);
          yield;
          if (c < best - 1e-12) {
            best = c;
            p = q;
            moved = true;
          }
        }
      }
      if (!moved) step /= 2;
    }
    return { p, cost: best };
  }

  const zero = [0, 0, 0, 0, 0, 0, 0, 0];
  const start_score = report(zero);
  yield;
  // Translation scan at the starting rotation, with a few detector scales
  // common to the fitted planes.
  const scan: Found[] = [];
  const stepMm = PLANE.truncation_mm,
    reach = Math.floor(L.translation_mm / stepMm);
  const scales = fit[0] || fit[1] ? [-0.3, -0.15, 0, 0.15, 0.3] : [0];
  for (const s of scales)
    for (let k = -reach; k <= reach; k++)
      for (let j = -reach; j <= reach; j++) {
        for (let i = -reach; i <= reach; i++) {
          const p = [
            i * stepMm,
            j * stepMm,
            k * stepMm,
            0,
            0,
            0,
            fit[0] ? s : 0,
            fit[1] ? s : 0,
          ];
          if (within(p)) scan.push({ p, cost: cost(coarse, p) });
        }
        yield;
      }
  scan.sort((a, b) => a.cost - b.cost);
  const seeds: Found[] = [];
  for (const candidate of scan) {
    if (seeds.length === 4) break;
    if (
      seeds.every(
        (seed) =>
          Math.hypot(
            seed.p[0] - candidate.p[0],
            seed.p[1] - candidate.p[1],
            seed.p[2] - candidate.p[2],
          ) >
            1.5 * stepMm ||
          Math.abs(seed.p[6] - candidate.p[6]) > 0.05 ||
          Math.abs(seed.p[7] - candidate.p[7]) > 0.05,
      )
    )
      seeds.push(candidate);
  }
  seeds.push({ p: zero, cost: 0 });
  // With two planes every turn changes one of the pictures, so each seed is
  // also searched from a turn either way about each axis.
  const turns = [
    [0, 0, 0],
    [7, 0, 0],
    [-7, 0, 0],
    [0, 7, 0],
    [0, -7, 0],
    [0, 0, 7],
    [0, 0, -7],
  ];
  const found: Found[] = [];
  for (const seed of seeds)
    for (const turn of turns) {
      const from = seed.p.slice();
      for (let i = 0; i < 3; i++) from[3 + i] = turn[i];
      found.push(yield* descend(coarse, from, 4, 0.5, 400));
    }
  found.sort((a, b) => a.cost - b.cost);
  let best: Found | null = null;
  const refined: number[][] = [];
  for (const candidate of found) {
    if (refined.length === 3) break;
    if (
      refined.some(
        (p) =>
          Math.hypot(
            p[0] - candidate.p[0],
            p[1] - candidate.p[1],
            p[2] - candidate.p[2],
          ) < 2 &&
          Math.hypot(
            p[3] - candidate.p[3],
            p[4] - candidate.p[4],
            p[5] - candidate.p[5],
          ) < 2 &&
          Math.abs(p[6] - candidate.p[6]) < 0.02 &&
          Math.abs(p[7] - candidate.p[7]) < 0.02,
      )
    )
      continue;
    refined.push(candidate.p);
    const result = yield* descend(fine, candidate.p, 1, 0.03, 2000);
    if (!best || result.cost < best.cost) best = result;
  }
  if (best && best.cost < 2) {
    // Last, the same descent with distances capped much closer in. A point
    // with no partner then costs the same wherever it lands, so vessels
    // seen on one side only, and branches that overlap in one plane, stop
    // pulling the pose toward the nearest unrelated line.
    trim = L.final_truncation_mm / PLANE.truncation_mm;
    best = yield* descend(fine, best.p, 0.5, 0.03, 2000);
    trim = 1;
  }
  if (!best || best.cost >= 2)
    throw new Error(
      "No pose in the search range keeps the vessel points inside both frames",
    );
  const p = best.p,
    r = rotation(p[3], p[4], p[5]);
  // World rotation B^T R B and the pivot's shift B^T t, composed onto the start.
  const turn = [0, 1, 2].map((i) =>
    [0, 1, 2].map((j) => {
      let sum = 0;
      for (let a = 0; a < 3; a++)
        for (let b = 0; b < 3; b++)
          sum += axes[a][i] * r[3 * a + b] * axes[b][j];
      return sum;
    }),
  );
  const shift = [0, 1, 2].map(
    (i) => axes[0][i] * p[0] + axes[1][i] * p[1] + axes[2][i] * p[2],
  );
  const raw = [0, 1, 2].map((i) => {
    const row = [0, 1, 2].map(
      (j) =>
        turn[i][0] * start[0][j] +
        turn[i][1] * start[1][j] +
        turn[i][2] * start[2][j],
    );
    const moved =
      turn[i][0] * (start[0][3] - pivot[0]) +
      turn[i][1] * (start[1][3] - pivot[1]) +
      turn[i][2] * (start[2][3] - pivot[2]);
    return [...row, pivot[i] + shift[i] + moved];
  });
  const cosine = Math.max(-1, Math.min(1, (r[0] + r[4] + r[8] - 1) / 2));
  const score = report(p);
  const plane = (k: number): BiplanePlaneProposal => {
    const scale = Math.exp(p[6 + k]);
    return {
      view: {
        ...views[k],
        detector_width_mm: views[k].detector_width_mm * scale,
        detector_height_mm: views[k].detector_height_mm * scale,
      },
      detector_scale: scale,
      score: score[k],
      start_score: start_score[k],
    };
  };
  return {
    method: BIPLANE_REGISTRATION_METHOD,
    matrix: orthonormal(raw),
    planes: [plane(0), plane(1)],
    plane_angle_deg,
    translation_mm: Math.hypot(p[0], p[1], p[2]),
    rotation_deg: Math.acos(cosine) / rad,
    point_count: total,
    evaluations,
  };
}

/** Resumable joint proposal search. */
export function createBiplaneRegistrationJob(
  input: BiplaneRegistrationInput,
): BiplaneRegistrationJob {
  const steps = solve(input);
  let done: BiplaneRegistrationProposal | null = null,
    failure: unknown = null;
  return {
    advance(expired) {
      if (failure) throw failure;
      try {
        while (!done) {
          const next = steps.next();
          if (next.done) {
            done = next.value;
            break;
          }
          if (expired()) return false;
        }
      } catch (error) {
        failure = error ?? new Error("Registration failed");
        throw failure;
      }
      return true;
    },
    result() {
      if (!done) throw new Error("Registration is not complete");
      return done;
    },
  };
}

/** One-shot joint proposal. Blocks until complete; interactive callers
 * should drive `createBiplaneRegistrationJob` in short slices instead. */
export function proposeBiplaneRegistration(
  input: BiplaneRegistrationInput,
): BiplaneRegistrationProposal {
  const job = createBiplaneRegistrationJob(input);
  job.advance(() => false);
  return job.result();
}
