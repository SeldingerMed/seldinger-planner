/** 2D-to-3D rigid registration proposal: a vessel point set from the volume
 * against vessel centerlines found in one angiographic frame.
 *
 * The camera is the Step A pinhole model under its declared angle
 * convention. The search moves the volume rigidly in the C-arm frame so that
 * its projected medial points fall on 2D centerlines, scoring both
 * directions with a truncated distance so that vessels present on only one
 * side cost a bounded amount.
 *
 * The result is a proposal for an operator to review. The score measures
 * agreement between two automatically extracted line sets, not registration
 * accuracy. One plane does not determine depth, which stays near the start,
 * and determines a turn about an in-plane axis only weakly. */
import { camera, validateView, type ViewNumbers } from "./carmGeometry";
import { detectorToPixel } from "./carmProjection";
import type { Vec3 } from "./obliqueSlice";
import { validateRigid } from "./rigidFusion";
import { VESSEL_TARGET_LIMITS, type VesselTarget } from "./vesselness2d";

export const PROJECTION_REGISTRATION_METHOD = "centerline_distance_compass_v1";
export const PROJECTION_REGISTRATION_LIMITS = {
  min_points: 30,
  /** Points scored in the final refinement. */
  max_points: 4000,
  /** Search range about the starting pose, in the camera's own axes. */
  in_plane_mm: 60,
  depth_mm: 60,
  rotation_deg: 15,
  /** Distances are capped here, in millimeters at the isocenter plane of the
   * entered geometry. The cap is held as a fixed number of working pixels,
   * so a fitted field size cannot buy a lower score by changing it. */
  truncation_mm: 8,
  /** A point this close to a 2D centerline counts as matched. */
  match_mm: 2,
  /** A pose that leaves fewer points than this in the frame is not scored. */
  min_in_field: 0.5,
  /** Range of the fitted detector scale for an uncalibrated plane. */
  detector_scale: [0.7, 1.45],
  max_evaluations: 30_000,
  /** Cost added when depth reaches the edge of its range, and when one
   * out-of-plane turn does. The matching cost itself runs from 0 to 1.5. */
  depth_prior: 0.2,
  out_of_plane_prior: 0.01,
} as const;

export type RegistrationScore = {
  /** Mean capped distance from projected 3D points to 2D centerlines,
   * in millimeters at the isocenter plane. Points outside the frame count
   * at the cap. */
  mean_distance_mm: number;
  /** Share of 3D points within `match_mm` of a 2D centerline. */
  matched_fraction: number;
  /** Share of 3D points that project inside the frame. */
  in_field_fraction: number;
  /** Share of 2D centerline samples with no projected 3D point nearby. */
  uncovered_fraction: number;
};
export type ProjectionRegistrationProposal = {
  method: typeof PROJECTION_REGISTRATION_METHOD;
  /** Rigid volume-RAS to C-arm-RAS matrix. */
  matrix: number[][];
  /** The view the proposal was scored in. Its detector size carries the
   * fitted scale when one was fitted. */
  view: ViewNumbers;
  detector_scale: number;
  score: RegistrationScore;
  start_score: RegistrationScore;
  /** How far the proposal moved the point-set centroid from the start, and
   * the angle it turned from the start. Both describe the search's change,
   * not `matrix` as a whole. */
  translation_mm: number;
  rotation_deg: number;
  point_count: number;
  evaluations: number;
};
export type ProjectionRegistrationInput = {
  /** Medial vessel points, x y z triples in volume RAS millimeters. */
  points: Float32Array;
  view: ViewNumbers;
  isocenter: Vec3;
  frame: { width: number; height: number };
  target: VesselTarget;
  /** Rigid volume-RAS to C-arm-RAS matrix the search starts from. */
  start: unknown;
  /** Fit one detector scale instead of depth, for an uncalibrated plane. */
  fit_detector_scale: boolean;
};
export type ProjectionRegistrationJob = {
  /** Runs until the search is complete or `expired()` returns true. Returns
   * true once complete. A failure is thrown again by every later call. */
  advance(expired: () => boolean): boolean;
  result(): ProjectionRegistrationProposal;
};

const rad = Math.PI / 180;

/** Rotation by `rx`, `ry`, `rz` degrees about fixed axes x, y, z, row-major. */
function rotation(rx: number, ry: number, rz: number): number[] {
  const ca = Math.cos(rx * rad),
    sa = Math.sin(rx * rad),
    cb = Math.cos(ry * rad),
    sb = Math.sin(ry * rad),
    cc = Math.cos(rz * rad),
    sc = Math.sin(rz * rad);
  return [
    cc * cb,
    cc * sb * sa - sc * ca,
    cc * sb * ca + sc * sa,
    sc * cb,
    sc * sb * sa + cc * ca,
    sc * sb * ca - cc * sa,
    -sb,
    cb * sa,
    cb * ca,
  ];
}

function finiteView(
  view: ViewNumbers,
  size: { width: number; height: number },
) {
  const valid = validateView(view);
  if (
    !Number.isInteger(size.width) ||
    !Number.isInteger(size.height) ||
    size.width < 1 ||
    size.height < 1
  )
    throw new Error("Invalid frame size");
  return valid;
}

/** Frame pixel coordinates (x right, y down) of volume points under a
 * registration. A point that cannot be projected (behind the source or
 * beyond the detector) yields NaN in both coordinates. */
export function projectRegistered(
  view: ViewNumbers,
  isocenter: Vec3,
  matrix: number[][],
  points: Float32Array,
  size: { width: number; height: number },
): Float32Array {
  const valid = finiteView(view, size),
    cam = camera(valid, isocenter),
    m = validateRigid(matrix),
    count = Math.floor(points.length / 3),
    out = new Float32Array(2 * count);
  for (let k = 0; k < count; k++) {
    const x = points[3 * k],
      y = points[3 * k + 1],
      z = points[3 * k + 2];
    const rel = [0, 1, 2].map(
      (i) => m[i][0] * x + m[i][1] * y + m[i][2] * z + m[i][3] - cam.source[i],
    );
    const depth = rel[0] * cam.d[0] + rel[1] * cam.d[1] + rel[2] * cam.d[2];
    if (!(depth >= 1) || depth > cam.source_detector_mm) {
      out[2 * k] = out[2 * k + 1] = NaN;
      continue;
    }
    const scale = cam.source_detector_mm / depth;
    const [px, py] = detectorToPixel(
      valid,
      size,
      (rel[0] * cam.u[0] + rel[1] * cam.u[1] + rel[2] * cam.u[2]) * scale,
      (rel[0] * cam.v[0] + rel[1] * cam.v[1] + rel[2] * cam.v[2]) * scale,
    );
    out[2 * k] = px;
    out[2 * k + 1] = py;
  }
  return out;
}

type Subset = { cam: Float32Array; count: number };
type Found = { p: number[]; cost: number };

function* solve(
  input: ProjectionRegistrationInput,
): Generator<void, ProjectionRegistrationProposal> {
  const L = PROJECTION_REGISTRATION_LIMITS;
  const { points, target, frame } = input;
  const view = finiteView(input.view, frame),
    start = validateRigid(input.start),
    isocenter = input.isocenter;
  if (isocenter.length !== 3 || !isocenter.every(Number.isFinite))
    throw new Error("Invalid isocenter");
  if (
    !(points instanceof Float32Array) ||
    points.length % 3 !== 0 ||
    points.length / 3 < L.min_points
  )
    throw new Error("Too few vessel points to register");
  for (let i = 0; i < points.length; i++)
    if (!Number.isFinite(points[i])) throw new Error("Nonfinite vessel point");
  if (
    target.distance.length !== target.width * target.height ||
    target.width * target.scale > frame.width ||
    target.height * target.scale > frame.height ||
    (target.width + 1) * target.scale <= frame.width ||
    (target.height + 1) * target.scale <= frame.height
  )
    throw new Error("Vessel target does not belong to this frame");
  const total = points.length / 3,
    cam = camera(view, isocenter),
    sid = view.source_detector_mm,
    sod = view.source_isocenter_mm;
  // Points in camera axes about the pivot: the centroid at the start pose.
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
  const axes = [cam.u, cam.v, cam.d];
  const offset = axes.map(
    (axis) =>
      axis[0] * (pivot[0] - isocenter[0]) +
      axis[1] * (pivot[1] - isocenter[1]) +
      axis[2] * (pivot[2] - isocenter[2]),
  );
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
    return { cam: out, count };
  };
  const coarse = subset(500),
    middle = subset(1500),
    fine = subset(L.max_points);

  // Working-grid geometry. One working pixel is `mm_per_px` at the isocenter.
  const { width: w, height: h, distance } = target;
  const pitch = view.detector_width_mm / frame.width;
  if (Math.abs(view.detector_height_mm / frame.height / pitch - 1) > 0.02)
    throw new Error("Detector pixels must be square");
  const mm_per_px = (pitch * target.scale * sod) / sid;
  // The 2D distance map is only known out to its own limit. A field so small
  // that the millimeter cap lies beyond it cannot be scored in millimeters.
  const cap = L.truncation_mm / mm_per_px;
  if (cap > VESSEL_TARGET_LIMITS.max_distance_px)
    throw new Error("Field too small for this frame");
  // The working grid starts at the frame origin and may stop short of its
  // far edges, so pixel coordinates use the frame's own extent.
  const fw = frame.width / target.scale,
    fh = frame.height / target.scale;
  // 2D centerline samples and the coarse grid that tests their coverage.
  const cell = Math.max(1, Math.round(cap / 3)),
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
  let stamp = 0,
    evaluations = 0;

  const measure = (set: Subset, p: number[]) => {
    const r = rotation(p[3], p[4], p[5]),
      scale = Math.exp(p[6]);
    const kx = (sid / (view.detector_width_mm * scale)) * fw,
      ky = (sid / (view.detector_height_mm * scale)) * fh;
    if (++stamp >= 0xffffffff) {
      grid.fill(0);
      stamp = 1;
    }
    let sum = 0,
      inside = 0,
      matched = 0;
    // Millimeters per working pixel follow the field size being tried.
    const near = L.match_mm / (mm_per_px * scale);
    for (let k = 0; k < set.count; k++) {
      const x = set.cam[3 * k],
        y = set.cam[3 * k + 1],
        z = set.cam[3 * k + 2];
      const depth = sod + r[6] * x + r[7] * y + r[8] * z + p[2] + offset[2];
      if (!(depth >= 1) || depth > sid) {
        sum += cap;
        continue;
      }
      const px =
          ((r[0] * x + r[1] * y + r[2] * z + p[0] + offset[0]) / depth) * kx +
          fw / 2 -
          0.5,
        py =
          fh / 2 -
          ((r[3] * x + r[4] * y + r[5] * z + p[1] + offset[1]) / depth) * ky -
          0.5;
      // Inside means inside the frame itself, edge to edge. The distance map
      // is sampled at the nearest place it is defined, which differs only in
      // the half pixel at each edge and in a trailing partial block.
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
      // Stamp the 3 x 3 block of coverage cells around the point.
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
  const cost = (set: Subset, p: number[]) => {
    evaluations++;
    const m = measure(set, p);
    if (m.inside < L.min_in_field) return 2;
    // One plane sees depth only as a small change of magnification, and a
    // turn about an in-plane axis mostly as foreshortening. Left free, the
    // two trade against each other and against vessels that have no
    // partner in the frame. A weak pull toward the start settles them.
    return (
      m.forward +
      0.5 * m.uncovered +
      L.depth_prior * (p[2] / L.depth_mm) ** 2 +
      L.out_of_plane_prior *
        ((p[3] / L.rotation_deg) ** 2 + (p[4] / L.rotation_deg) ** 2)
    );
  };
  const report = (p: number[]): RegistrationScore => {
    const m = measure(fine, p);
    return {
      mean_distance_mm: m.forward * cap * mm_per_px * Math.exp(p[6]),
      matched_fraction: m.matched,
      in_field_fraction: m.inside,
      uncovered_fraction: m.uncovered,
    };
  };
  const fit = input.fit_detector_scale;
  const logScale = L.detector_scale.map(Math.log);
  const within = (p: number[]) =>
    Math.abs(p[0]) <= L.in_plane_mm &&
    Math.abs(p[1]) <= L.in_plane_mm &&
    Math.abs(p[2]) <= L.depth_mm &&
    Math.abs(p[3]) <= L.rotation_deg &&
    Math.abs(p[4]) <= L.rotation_deg &&
    Math.abs(p[5]) <= L.rotation_deg &&
    p[6] >= logScale[0] &&
    p[6] <= logScale[1];
  // Per-parameter unit steps: millimeters in plane, a coarser step in
  // depth (which a single plane sees only as magnification), degrees, and
  // 1% of detector scale. Depth and scale are alternatives.
  const unit = [1, 1, fit ? 0 : 4, 1, 1, 1, fit ? 0.01 : 0];

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
      for (let i = 0; i < 7; i++) {
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

  const zero = [0, 0, 0, 0, 0, 0, 0];
  const start_score = report(zero);
  yield;
  // In-plane scan at the starting rotation, with a few detector scales
  // when the scale is being fitted.
  const scan: Found[] = [];
  const stepMm = L.truncation_mm,
    reach = Math.floor(L.in_plane_mm / stepMm);
  const scales = fit ? [-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3] : [0];
  for (const s of scales)
    for (let j = -reach; j <= reach; j++) {
      for (let i = -reach; i <= reach; i++) {
        const p = [i * stepMm, j * stepMm, 0, 0, 0, 0, s];
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
          Math.hypot(seed.p[0] - candidate.p[0], seed.p[1] - candidate.p[1]) >
            1.5 * stepMm || Math.abs(seed.p[6] - candidate.p[6]) > 0.05,
      )
    )
      seeds.push(candidate);
  }
  seeds.push({ p: zero, cost: 0 });
  // In-plane rotation changes the picture most, so each seed is also
  // searched from a turn either way about the viewing axis.
  const found: Found[] = [];
  for (const seed of seeds)
    for (const turn of [0, -7, 7]) {
      const from = seed.p.slice();
      from[5] = turn;
      found.push(yield* descend(middle, from, 4, 0.5, 500));
    }
  found.sort((a, b) => a.cost - b.cost);
  let best: Found | null = null;
  const refined: number[][] = [];
  for (const candidate of found) {
    if (refined.length === 3) break;
    if (
      refined.some(
        (p) =>
          Math.hypot(p[0] - candidate.p[0], p[1] - candidate.p[1]) < 2 &&
          Math.hypot(
            p[3] - candidate.p[3],
            p[4] - candidate.p[4],
            p[5] - candidate.p[5],
          ) < 2 &&
          Math.abs(p[6] - candidate.p[6]) < 0.02,
      )
    )
      continue;
    refined.push(candidate.p);
    const result = yield* descend(fine, candidate.p, 1, 0.03, 1500);
    if (!best || result.cost < best.cost) best = result;
  }
  if (!best || best.cost >= 2)
    throw new Error(
      "No pose in the search range keeps the vessel points inside the frame",
    );
  const p = best.p,
    r = rotation(p[3], p[4], p[5]),
    scale = Math.exp(p[6]);
  // World rotation B R B^T and the pivot's shift B t, composed onto the start.
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
  return {
    method: PROJECTION_REGISTRATION_METHOD,
    matrix: orthonormal(raw),
    view: {
      ...view,
      detector_width_mm: view.detector_width_mm * scale,
      detector_height_mm: view.detector_height_mm * scale,
    },
    detector_scale: scale,
    score: report(p),
    start_score,
    translation_mm: Math.hypot(p[0], p[1], p[2]),
    rotation_deg: Math.acos(cosine) / rad,
    point_count: total,
    evaluations,
  };
}

/** Nearest rotation by Gram-Schmidt, rounded to nine digits. */
function orthonormal(rows: number[][]): number[][] {
  const col = (j: number) => [rows[0][j], rows[1][j], rows[2][j]],
    dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    unit = (a: number[]) => {
      const n = Math.hypot(...a);
      return a.map((value) => value / n);
    };
  const x = unit(col(0)),
    y0 = col(1),
    d = dot(x, y0),
    y = unit(y0.map((value, i) => value - d * x[i])),
    z = [
      x[1] * y[2] - x[2] * y[1],
      x[2] * y[0] - x[0] * y[2],
      x[0] * y[1] - x[1] * y[0],
    ];
  const round = (value: number, digits: number) => {
    const rounded = Number(value.toFixed(digits));
    return rounded === 0 ? 0 : rounded;
  };
  return validateRigid([
    ...[0, 1, 2].map((k) => [
      round(x[k], 9),
      round(y[k], 9),
      round(z[k], 9),
      round(rows[k][3], 6),
    ]),
    [0, 0, 0, 1],
  ]);
}

/** Resumable proposal search. */
export function createProjectionRegistrationJob(
  input: ProjectionRegistrationInput,
): ProjectionRegistrationJob {
  const steps = solve(input);
  let done: ProjectionRegistrationProposal | null = null,
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
 * drive `createProjectionRegistrationJob` in short slices instead. */
export function proposeProjectionRegistration(
  input: ProjectionRegistrationInput,
): ProjectionRegistrationProposal {
  const job = createProjectionRegistrationJob(input);
  job.advance(() => false);
  return job.result();
}
