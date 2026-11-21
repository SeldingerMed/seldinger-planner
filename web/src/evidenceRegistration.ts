/** 2D-to-3D rigid registration proposal against vessel evidence: a vessel
 * point set from the volume against the line-likeness of one angiographic
 * frame, or of two frames that share one patient pose.
 *
 * The older methods (projectionRegistration.ts, biplaneRegistration.ts)
 * score the distance between projected 3D points and a thresholded 2D line
 * set. On real frames that line set held the large trunks and little else,
 * and the many 3D points left without a partner decided the pose. Here each
 * plane's cost is one minus the mean evidence under the projected points
 * (vesselEvidence2d.ts), so a point with no vessel under it costs the same
 * wherever it lands, plus a bounded term for strong 2D evidence that no
 * projected point is near.
 *
 * The camera is the Step A pinhole model under its declared angle
 * convention. With two planes the frames must show the same anatomy in the
 * same position; nothing here can check that. With one plane, depth and
 * out-of-plane turns stay near the start, because one plane does not
 * determine them.
 *
 * The result is a proposal for an operator to review. Its score says how
 * much of the projected model lies on line-like structure in the frame. It
 * is not registration accuracy. */
import { planeAngleDeg, planesFarEnough } from "./biplaneRegistration";
import {
  camera,
  VIEW_LIMITS,
  viewFrame,
  type ViewNumbers,
} from "./carmGeometry";
import type { Vec3 } from "./obliqueSlice";
import { finiteView, orthonormal, rotation } from "./projectionRegistration";
import { validateRigid } from "./rigidFusion";
import {
  VESSEL_EVIDENCE_LIMITS as EVIDENCE,
  type VesselEvidence,
} from "./vesselEvidence2d";

export const EVIDENCE_REGISTRATION_METHOD = "vessel_evidence_compass_v1";
export const EVIDENCE_BIPLANE_REGISTRATION_METHOD =
  "vessel_evidence_compass_biplane_v1";
/** The same search run from several starts, the result with the most vessel
 * evidence kept (bestStart.ts). */
export const EVIDENCE_BEST_START_METHOD = "vessel_evidence_best_start_v1";
export const EVIDENCE_BEST_START_BIPLANE_METHOD =
  "vessel_evidence_best_start_biplane_v1";
export const EVIDENCE_REGISTRATION_LIMITS = {
  min_points: 30,
  /** Points scored in the refinement. */
  max_points: 4000,
  /** Search range about the starting pose along each of the first plane's
   * camera axes, and about each of them. */
  translation_mm: 60,
  rotation_deg: 15,
  /** A pose that leaves fewer points than this in a frame is not scored. */
  min_in_field: 0.5,
  /** Range of the fitted detector scale for an uncalibrated plane. It is
   * narrowed for a plane whose fitted detector would otherwise leave the
   * sizes the view model accepts. */
  detector_scale: [0.7, 1.45],
  /** A fitted detector scale is kept only when it lowers the cost by at
   * least this much against the same search at the entered size. When no
   * pose at the entered size can be scored there is nothing to compare
   * with, and the fit is kept. */
  min_fit_gain: 0.02,
  /** Spacing of the translation scan that opens the search. */
  scan_step_mm: 8,
  /** Weight of the share of strong 2D evidence with no projected point
   * nearby, and the side of the cells that decide "nearby", in working
   * pixels. A point covers its own cell and the eight around it. */
  coverage_weight: 0.5,
  coverage_cell_px: 4,
  /** One evaluation scores every plane, or stops at the first plane that
   * leaves too few points inside its frame. */
  max_evaluations: 120_000,
  /** One plane only: cost added when depth reaches the edge of its range,
   * and when one out-of-plane turn does. */
  depth_prior: 1,
  out_of_plane_prior: 0.01,
} as const;

/** The search's own failure: from this start, no pose in range could be
 * scored. Any other error is a fault in the input. */
export const EVIDENCE_NO_POSE =
  "No pose in the search range keeps the vessel points inside every frame";
export type EvidenceScore = {
  /** Mean evidence under the projected 3D points at the narrowest blur,
   * from 0 to 1. Points outside the frame count as zero. */
  mean_evidence: number;
  /** Share of 3D points that project inside the frame. */
  in_field_fraction: number;
  /** Share of strong 2D evidence samples with no projected 3D point
   * nearby. */
  uncovered_fraction: number;
};
export type EvidencePlaneInput = {
  view: ViewNumbers;
  /** A point on this plane's central ray, in C-arm RAS millimeters. */
  isocenter: Vec3;
  frame: { width: number; height: number };
  evidence: VesselEvidence;
  /** Fit this plane's detector scale, for an uncalibrated plane. With one
   * plane the scale is fitted instead of depth. */
  fit_detector_scale: boolean;
};
export type EvidenceRegistrationInput = {
  /** Medial vessel points, x y z triples in volume RAS millimeters. */
  points: Float32Array;
  /** One plane, or two that share one patient pose. */
  planes: EvidencePlaneInput[];
  /** Rigid volume-RAS to C-arm-RAS matrix the search starts from. */
  start: unknown;
};
export type EvidencePlaneProposal = {
  /** The view this plane was scored in. Its detector size carries the
   * fitted scale when one was fitted. */
  view: ViewNumbers;
  detector_scale: number;
  score: EvidenceScore;
  start_score: EvidenceScore;
};
export type EvidenceRegistrationProposal = {
  method:
    | typeof EVIDENCE_REGISTRATION_METHOD
    | typeof EVIDENCE_BIPLANE_REGISTRATION_METHOD
    | typeof EVIDENCE_BEST_START_METHOD
    | typeof EVIDENCE_BEST_START_BIPLANE_METHOD;
  /** Rigid volume-RAS to C-arm-RAS matrix, one for every plane. */
  matrix: number[][];
  planes: EvidencePlaneProposal[];
  /** Angle between the two central rays, 0 to 90 degrees; null for one
   * plane. */
  plane_angle_deg: number | null;
  /** What became of a requested detector-scale fit. A fit is `kept` when it
   * lowered the cost by at least `min_fit_gain` against the entered size,
   * or when no pose at the entered size could be scored. Otherwise it is
   * `dropped`: every plane then keeps its entered size.
   *
   * `kept` says the result of the fitted search was kept. It does not say
   * the size moved: that search also refines the pose, and the gain can
   * come from the pose alone. Each plane's `detector_scale` says what
   * became of its size. */
  detector_fit: "not_requested" | "kept" | "dropped";
  /** Cost of the search at the entered size less cost of the search with
   * the scale free, whatever that search moved. Null when no
   * fit was requested, or when no pose at the entered size could be
   * scored. */
  fit_gain: number | null;
  /** How far the proposal moved the point-set centroid from the start, and
   * the angle it turned from the start. */
  translation_mm: number;
  rotation_deg: number;
  point_count: number;
  evaluations: number;
};
export type EvidenceRegistrationJob = {
  /** Runs until the search is complete or `expired()` returns true. Returns
   * true once complete. A failure is thrown again by every later call. */
  advance(expired: () => boolean): boolean;
  result(): EvidenceRegistrationProposal;
};

const rad = Math.PI / 180;
const dot = (a: readonly number[], b: readonly number[]) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

type Subset = { points: Float32Array; count: number };
type Measure = { evidence: number; inside: number; uncovered: number };
type Found = { p: number[]; cost: number };

/** Scores one plane. Points are in the first plane's camera axes about the
 * pivot; `measure` turns them by `r`, shifts them by `p` and takes them to
 * this plane's own axes. */
function planeScorer(
  input: EvidencePlaneInput,
  axesA: readonly Vec3[],
  pivot: readonly number[],
) {
  const { evidence, frame } = input,
    view = finiteView(input.view, frame),
    isocenter = input.isocenter;
  if (
    !Array.isArray(isocenter) ||
    isocenter.length !== 3 ||
    !isocenter.every(Number.isFinite)
  )
    throw new Error("Invalid isocenter");
  const { width: w, height: h } = evidence;
  if (
    !Array.isArray(evidence.levels) ||
    evidence.levels.length !== EVIDENCE.blur_px.length ||
    evidence.levels.some((level) => level.length !== w * h) ||
    w * evidence.scale > frame.width ||
    h * evidence.scale > frame.height ||
    (w + 1) * evidence.scale <= frame.width ||
    (h + 1) * evidence.scale <= frame.height
  )
    throw new Error("Vessel evidence does not belong to this frame");
  const pitch = view.detector_width_mm / frame.width;
  if (Math.abs(view.detector_height_mm / frame.height / pitch - 1) > 0.02)
    throw new Error("Detector pixels must be square");
  const cam = camera(view, isocenter),
    axes = [cam.u, cam.v, cam.d],
    sid = view.source_detector_mm,
    sod = view.source_isocenter_mm;
  const m = axes.flatMap((axis) => axesA.map((a) => dot(axis, a)));
  const offset = axes.map((axis) =>
    dot(axis, [
      pivot[0] - isocenter[0],
      pivot[1] - isocenter[1],
      pivot[2] - isocenter[2],
    ]),
  );
  // The working grid starts at the frame origin and may stop short of its
  // far edges, so pixel coordinates use the frame's own extent.
  const fw = frame.width / evidence.scale,
    fh = frame.height / evidence.scale;
  const cell = EVIDENCE_REGISTRATION_LIMITS.coverage_cell_px,
    gw = Math.ceil(w / cell),
    gh = Math.ceil(h / cell),
    grid = new Uint32Array(gw * gh),
    strongCell = Int32Array.from(evidence.strong, (at) => {
      const x = at % w;
      return Math.floor((at - x) / w / cell) * gw + Math.floor(x / cell);
    });
  let stamp = 0;

  const measure = (
    set: Subset,
    r: number[],
    p: number[],
    logScale: number,
    level: number,
  ): Measure => {
    const scale = Math.exp(logScale),
      kx = (sid / (view.detector_width_mm * scale)) * fw,
      ky = (sid / (view.detector_height_mm * scale)) * fh,
      map = evidence.levels[level];
    if (++stamp >= 0xffffffff) {
      grid.fill(0);
      stamp = 1;
    }
    let sum = 0,
      inside = 0;
    for (let k = 0; k < set.count; k++) {
      const x = set.points[3 * k],
        y = set.points[3 * k + 1],
        z = set.points[3 * k + 2];
      const ax = r[0] * x + r[1] * y + r[2] * z + p[0],
        ay = r[3] * x + r[4] * y + r[5] * z + p[1],
        az = r[6] * x + r[7] * y + r[8] * z + p[2];
      const depth = sod + m[6] * ax + m[7] * ay + m[8] * az + offset[2];
      if (!(depth >= 1) || depth > sid) continue;
      const px =
          ((m[0] * ax + m[1] * ay + m[2] * az + offset[0]) / depth) * kx +
          fw / 2 -
          0.5,
        py =
          fh / 2 -
          ((m[3] * ax + m[4] * ay + m[5] * az + offset[1]) / depth) * ky -
          0.5;
      // Inside means inside the frame itself, edge to edge. The map is
      // sampled at the nearest place it is defined, which differs only in
      // the half pixel at each edge and in a trailing partial block.
      if (!(px >= -0.5 && py >= -0.5 && px <= fw - 0.5 && py <= fh - 0.5))
        continue;
      inside++;
      const sx = px < 0 ? 0 : px > w - 1 ? w - 1 : px,
        sy = py < 0 ? 0 : py > h - 1 ? h - 1 : py,
        x0 = Math.min(w - 2, Math.floor(sx)),
        y0 = Math.min(h - 2, Math.floor(sy)),
        fx = sx - x0,
        fy = sy - y0,
        at = y0 * w + x0;
      sum +=
        map[at] * (1 - fx) * (1 - fy) +
        map[at + 1] * fx * (1 - fy) +
        map[at + w] * (1 - fx) * fy +
        map[at + w + 1] * fx * fy;
      const cx = Math.floor((sx + 0.5) / cell),
        cy = Math.floor((sy + 0.5) / cell);
      for (let j = cy > 0 ? cy - 1 : 0; j <= cy + 1 && j < gh; j++)
        for (let i = cx > 0 ? cx - 1 : 0; i <= cx + 1 && i < gw; i++)
          grid[j * gw + i] = stamp;
    }
    let uncovered = 0;
    for (let k = 0; k < strongCell.length; k++)
      if (grid[strongCell[k]] !== stamp) uncovered++;
    return {
      evidence: sum / set.count,
      inside: inside / set.count,
      uncovered: strongCell.length ? uncovered / strongCell.length : 0,
    };
  };
  return {
    view,
    measure,
    fit: input.fit_detector_scale,
    /** Millimeters at the isocenter per working pixel, as entered. */
    mm_per_px: (pitch * evidence.scale * sod) / sid,
  };
}

function* solve(
  input: EvidenceRegistrationInput,
): Generator<void, EvidenceRegistrationProposal> {
  const L = EVIDENCE_REGISTRATION_LIMITS;
  const { points } = input;
  if (
    !Array.isArray(input.planes) ||
    input.planes.length < 1 ||
    input.planes.length > 2
  )
    throw new Error("One or two planes are required");
  const two = input.planes.length === 2;
  const start = validateRigid(input.start);
  if (
    !(points instanceof Float32Array) ||
    points.length % 3 !== 0 ||
    points.length / 3 < L.min_points
  )
    throw new Error("Too few vessel points to register");
  for (let i = 0; i < points.length; i++)
    if (!Number.isFinite(points[i])) throw new Error("Nonfinite vessel point");
  const views = input.planes.map((plane) =>
    finiteView(plane.view, plane.frame),
  );
  const plane_angle_deg = two ? planeAngleDeg(views[0], views[1]) : null;
  if (plane_angle_deg !== null && !planesFarEnough(plane_angle_deg))
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
  // The search moves along and about the first plane's camera axes.
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
    fine = subset(L.max_points);
  const scorers = input.planes.map((plane) => planeScorer(plane, axes, pivot));
  const requested = [scorers[0].fit, two && scorers[1].fit];
  const levels = EVIDENCE.blur_px.length,
    narrowest = levels - 1;
  let evaluations = 0;

  // p = shift along A's axes (3), turn about them (3), log scale of A and B.
  const cost = (set: Subset, p: number[], level: number) => {
    evaluations++;
    const r = rotation(p[3], p[4], p[5]);
    let sum = 0;
    for (let k = 0; k < scorers.length; k++) {
      const m = scorers[k].measure(set, r, p, p[6 + k], level);
      // Known limit of version 1: for two planes no scored pose reaches 2,
      // but for one plane a pose at the far end of the depth range with no
      // evidence under it can cost up to about 2.5, and is then treated as
      // not scored. The methods are frozen as run under
      // ljubljana-evidence-v1, so this stands until the next version.
      if (m.inside < L.min_in_field) return 2;
      sum += 1 - m.evidence + L.coverage_weight * m.uncovered;
    }
    sum /= scorers.length;
    // One plane sees depth only as a small change of magnification, and a
    // turn about an in-plane axis mostly as foreshortening. A weak pull
    // toward the start settles them.
    if (!two)
      sum +=
        L.depth_prior * (p[2] / L.translation_mm) ** 2 +
        L.out_of_plane_prior *
          ((p[3] / L.rotation_deg) ** 2 + (p[4] / L.rotation_deg) ** 2);
    return sum;
  };
  // Not counted in `evaluations`: it runs once before the search and once
  // after, outside every budget.
  const report = (p: number[]): EvidenceScore[] => {
    const r = rotation(p[3], p[4], p[5]);
    return scorers.map((scorer, k) => {
      const m = scorer.measure(fine, r, p, p[6 + k], narrowest);
      return {
        mean_evidence: m.evidence,
        in_field_fraction: m.inside,
        uncovered_fraction: m.uncovered,
      };
    });
  };
  // The scale range of each plane, kept inside what the view model accepts.
  const logScale = [0, 1].map((k) => {
    const view = scorers[k]?.view;
    if (!view) return [0, 0];
    const sides = [view.detector_width_mm, view.detector_height_mm],
      limits = [VIEW_LIMITS.detector_width_mm, VIEW_LIMITS.detector_height_mm];
    return [
      Math.log(
        Math.max(L.detector_scale[0], ...sides.map((s, i) => limits[i][0] / s)),
      ),
      Math.log(
        Math.min(L.detector_scale[1], ...sides.map((s, i) => limits[i][1] / s)),
      ),
    ];
  });
  const within = (p: number[]) =>
    Math.abs(p[0]) <= L.translation_mm &&
    Math.abs(p[1]) <= L.translation_mm &&
    Math.abs(p[2]) <= L.translation_mm &&
    Math.abs(p[3]) <= L.rotation_deg &&
    Math.abs(p[4]) <= L.rotation_deg &&
    Math.abs(p[5]) <= L.rotation_deg &&
    p[6] >= logScale[0][0] &&
    p[6] <= logScale[0][1] &&
    p[7] >= logScale[1][0] &&
    p[7] <= logScale[1][1];
  // Per-parameter unit steps: millimeters, degrees, and 1% of a fitted
  // detector scale. One plane sees depth and detector scale as the same
  // freedom, so it searches one of them, depth in coarser steps.
  let fit = requested,
    unit: number[] = [];
  const freedoms = (fitted: boolean[]) => {
    fit = fitted;
    unit = [
      1,
      1,
      two ? 1 : fit[0] ? 0 : 4,
      1,
      1,
      1,
      fit[0] ? 0.01 : 0,
      fit[1] ? 0.01 : 0,
    ];
  };

  function* descend(
    set: Subset,
    from: number[],
    level: number,
    step: number,
    stop: number,
    budget: number,
  ): Generator<void, Found> {
    const end = Math.min(evaluations + budget, L.max_evaluations);
    let p = from,
      best = cost(set, p, level);
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
          const c = cost(set, q, level);
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
  const mm = scorers[0].mm_per_px;

  /** The whole search with the given planes' detector scales free. `also`
   * is a pose to refine besides the ones the search finds itself. */
  function* search(
    fitted: boolean[],
    also: Found | null = null,
  ): Generator<void, Found | null> {
    freedoms(fitted);
    // Translation scan at the starting rotation and the widest blur, with a
    // few detector scales common to the fitted planes. One plane does not
    // scan depth. The grid is fixed by two limits and is not stopped by the
    // evaluation budget, which it stays well under.
    const scan: Found[] = [];
    const reach = Math.floor(L.translation_mm / L.scan_step_mm),
      deep = two ? reach : 0;
    const scales = fit[0] || fit[1] ? [-0.3, -0.15, 0, 0.15, 0.3] : [0];
    for (const s of scales)
      for (let k = -deep; k <= deep; k++)
        for (let j = -reach; j <= reach; j++) {
          for (let i = -reach; i <= reach; i++) {
            const p = [
              i * L.scan_step_mm,
              j * L.scan_step_mm,
              k * L.scan_step_mm,
              0,
              0,
              0,
              fit[0] ? s : 0,
              fit[1] ? s : 0,
            ];
            if (within(p)) scan.push({ p, cost: cost(coarse, p, 0) });
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
              1.5 * L.scan_step_mm ||
            Math.abs(seed.p[6] - candidate.p[6]) > 0.05 ||
            Math.abs(seed.p[7] - candidate.p[7]) > 0.05,
        )
      )
        seeds.push(candidate);
    }
    seeds.push({ p: zero, cost: 0 });
    const found: Found[] = [];
    for (const seed of seeds)
      found.push(yield* descend(coarse, seed.p.slice(), 0, 4, 1, 300));
    found.sort((a, b) => a.cost - b.cost);
    // The best few, each taken through the narrower blurs in turn. The step
    // at each level starts at that level's blur width in millimeters.
    let best: Found | null = null;
    const refine = function* (from: Found, first: number) {
      let result = from;
      for (let level = first; level < levels; level++) {
        const width = EVIDENCE.blur_px[level] * mm;
        result = yield* descend(fine, result.p, level, width, width / 8, 1500);
      }
      if (!best || result.cost < best.cost) best = result;
    };
    // The pose handed in is already refined. Taken through the narrowest
    // blur alone it cannot end worse than it came, so the search it joins
    // never costs more than the one that found it. It is also taken through
    // every blur like the rest, which can move it further.
    if (also) {
      yield* refine(also, narrowest);
      yield* refine(also, 1);
    }
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
      yield* refine(candidate, 1);
    }
    const result = best as Found | null;
    return result && result.cost < 2 ? result : null;
  }

  let best: Found | null,
    detector_fit: EvidenceRegistrationProposal["detector_fit"] =
      "not_requested",
    fit_gain: number | null = null;
  if (!requested[0] && !requested[1]) best = yield* search(requested);
  else {
    // First the search at the entered sizes, then the search with the
    // scales free, which also refines the pose the first one found. A
    // scale that is free can always find a slightly lower cost, so the fit
    // has to earn its place.
    const entered = yield* search([false, false]);
    best = yield* search(requested, entered);
    if (best && entered) fit_gain = entered.cost - best.cost;
    if (best && (fit_gain === null || fit_gain >= L.min_fit_gain))
      detector_fit = "kept";
    else {
      best = entered;
      detector_fit = "dropped";
    }
  }
  if (!best) throw new Error(EVIDENCE_NO_POSE);
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
  return {
    method: two
      ? EVIDENCE_BIPLANE_REGISTRATION_METHOD
      : EVIDENCE_REGISTRATION_METHOD,
    matrix: orthonormal(raw),
    planes: scorers.map((scorer, k) => {
      const scale = Math.exp(p[6 + k]);
      return {
        view: {
          ...scorer.view,
          detector_width_mm: scorer.view.detector_width_mm * scale,
          detector_height_mm: scorer.view.detector_height_mm * scale,
        },
        detector_scale: scale,
        score: score[k],
        start_score: start_score[k],
      };
    }),
    plane_angle_deg,
    detector_fit,
    fit_gain,
    translation_mm: Math.hypot(p[0], p[1], p[2]),
    rotation_deg: Math.acos(cosine) / rad,
    point_count: total,
    evaluations,
  };
}

/** Resumable proposal search. */
export function createEvidenceRegistrationJob(
  input: EvidenceRegistrationInput,
): EvidenceRegistrationJob {
  const steps = solve(input);
  let done: EvidenceRegistrationProposal | null = null,
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

/** One-shot proposal. Blocks until complete; interactive callers should
 * drive `createEvidenceRegistrationJob` in short slices instead. */
export function proposeEvidenceRegistration(
  input: EvidenceRegistrationInput,
): EvidenceRegistrationProposal {
  const job = createEvidenceRegistrationJob(input);
  job.advance(() => false);
  return job.result();
}
