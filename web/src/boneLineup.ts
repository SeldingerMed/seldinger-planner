/** Bone line-up: where a CT sits in the C-arm's frame, read from one or two
 * X-ray frames that show bone and no contrast.
 *
 * The scan's bone is reduced to weighted points. A pose is scored by
 * dropping those points on the detector as a soft picture of the bone and
 * asking how much of that picture's edges lie on frame edges that run the
 * same way. The frame's edge strength is pressed flat and its direction
 * kept, so skin and soft-tissue outlines, which are strong in a side view,
 * count no more than a vertebra's. The score is the agreement divided by
 * the picture's total edge strength, not by its root mean square: against
 * a flattened frame the root mean square rewards any pose that smears the
 * picture's edges, a turn out of the plane or a move toward the source.
 *
 * The search is a compass search from the starting pose, coarse picture
 * first. With two frames the first is lined up alone, then depth along its
 * beam is scanned with both frames, then both are searched together: a
 * search with both from the start stops on a wrong depth for a large share
 * of starts.
 *
 * Every result is a proposal for the operator to confirm. */
import { planeAngleDeg, planesFarEnough } from "./biplaneRegistration";
import { camera, validateView, type ViewNumbers } from "./carmGeometry";
import type { Vec3 } from "./obliqueSlice";
import { orthonormal } from "./projectionRegistration";
import { validateRigid } from "./rigidFusion";

export const BONE_LINEUP_METHOD = "bone_edge_compass_v1";
export const BONE_LINEUP_BIPLANE_METHOD = "bone_edge_compass_biplane_v1";

export const BONE_LINEUP = {
  /** Scan values above this count as bone. */
  threshold_hu: 250,
  /** Spacing of the bone points taken from the scan. */
  grid_mm: 2,
  min_points: 200,
  max_points: 400_000,
  /** Longer side of the working picture. */
  working_px: 128,
  /** Working picture divisors, coarse to fine: for the first frame alone,
   * then for both frames. Both frames are scanned along the first beam and
   * searched at the finest level only: at a coarser one a lateral spine
   * scores as well a vertebral body's depth off as in place. */
  first_levels: [4, 2, 1],
  both_levels: [1],
  blur_px: 1.5,
  /** Least strength an edge is pressed flat against, as a share of the
   * frame's strong edges (its 95th percentile). */
  flat_floor: 0.1,
  /** Opening steps at divisor 2: across, up and along the first beam in
   * millimeters, then turns about those axes in degrees. */
  step: [4, 4, 12, 2, 2, 2],
  /** A level ends when its largest step is this small. */
  stop: 0.05,
  /** A look across the first frame for other places to start from: how far
   * each way, in what steps, and how many separate places are then
   * searched beside the one looked around. */
  opening_scan_mm: 48,
  opening_step_mm: 8,
  opening_candidates: 3,
  opening_apart_mm: 16,
  /** The same look around the first answer, at these levels, at most this
   * many times. */
  second_looks: 2,
  second_look_levels: [2, 1],
  depth_scan_mm: 60,
  depth_step_mm: 2,
  depth_candidates: 3,
  depth_apart_mm: 8,
  /** How far a proposal may move from the start. */
  translation_mm: 80,
  rotation_deg: 20,
  /** A pose is scored only while each frame holds at least this share of
   * the bone it held at the start. A scan is often far longer than a frame
   * shows, so the share of the whole scan says nothing. */
  keep_in_field: 0.5,
  max_evaluations: 60_000,
  slice_evaluations: 40,
} as const;

export const BONE_NOT_IN_FRAME =
  "The bone is not in the frame at the starting pose";

export type BoneVolume = {
  /** Scan values in Hounsfield units, first index fastest. */
  data: Int16Array | Float32Array;
  shape: readonly number[];
  /** Voxel index to RAS millimeters. */
  affine: number[][];
  /** Nonzero where bone moves against the rest between the scan and the
   * procedure, a femur at the hip. It is left out of the line-up. */
  moving?: Uint8Array;
};
export type BoneSamples = {
  /** x y z triples in volume RAS millimeters. */
  points: Float64Array;
  /** Scan value above the bone threshold at each point. */
  weights: Float64Array;
};
export type BoneFrameInput = {
  view: ViewNumbers;
  /** A point on this frame's central ray, in C-arm RAS millimeters. */
  isocenter: Vec3;
  /** Gray values as a detector reads them, bone dark, rows from the top.
   * Frame ingest already turns the other polarity around. */
  pixels: ArrayLike<number>;
  width: number;
  height: number;
};
export type BoneLineupInput = {
  samples: BoneSamples;
  /** One frame, or two that share one patient pose. */
  frames: BoneFrameInput[];
  /** Rigid volume-RAS to C-arm-RAS matrix the search starts from. */
  start: unknown;
};
export type BoneLineupProposal = {
  method: typeof BONE_LINEUP_METHOD | typeof BONE_LINEUP_BIPLANE_METHOD;
  /** Rigid volume-RAS to C-arm-RAS matrix. */
  matrix: number[][];
  /** Share of the bone picture's edges that lie on frame edges running the
   * same way, at the finest level, mean over frames. Below 1 by design. */
  score: number;
  frame_scores: number[];
  start_score: number;
  /** Depths along the first beam that were searched with both frames. */
  depth_candidates_mm: number[];
  translation_mm: number;
  rotation_deg: number;
  point_count: number;
  evaluations: number;
};
export type BoneLineupJob = {
  /** Runs until done or `expired` says stop. True when done. */
  advance(expired: () => boolean): boolean;
  result(): BoneLineupProposal;
};

const rad = Math.PI / 180;

export function boneSamples(volume: BoneVolume): BoneSamples {
  const L = BONE_LINEUP,
    { data, shape, affine, moving } = volume;
  if (
    !Array.isArray(shape) ||
    shape.length !== 3 ||
    !shape.every((n) => Number.isInteger(n) && n > 0) ||
    !(data instanceof Int16Array || data instanceof Float32Array) ||
    data.length !== shape[0] * shape[1] * shape[2]
  )
    throw new Error("Scan does not match its shape");
  if (
    moving !== undefined &&
    !(moving instanceof Uint8Array && moving.length === data.length)
  )
    throw new Error("Marked bone does not match the scan");
  if (
    !Array.isArray(affine) ||
    affine.length !== 4 ||
    !affine.every(
      (row) =>
        Array.isArray(row) && row.length === 4 && row.every(Number.isFinite),
    )
  )
    throw new Error("Invalid scan geometry");
  const spacing = [0, 1, 2].map((j) =>
    Math.hypot(affine[0][j], affine[1][j], affine[2][j]),
  );
  if (!spacing.every((s) => s > 1e-3)) throw new Error("Invalid scan geometry");
  const [nx, ny, nz] = shape;
  for (let grid: number = L.grid_mm; ; grid *= 1.5) {
    const stride = spacing.map((s) => Math.max(1, Math.round(grid / s)));
    const points: number[] = [],
      weights: number[] = [];
    for (let k = 0; k < nz; k += stride[2])
      for (let j = 0; j < ny; j += stride[1])
        for (let i = 0; i < nx; i += stride[0]) {
          const at = i + nx * (j + ny * k),
            hu = data[at];
          if (!(hu > L.threshold_hu) || moving?.[at]) continue;
          for (let a = 0; a < 3; a++)
            points.push(
              affine[a][0] * i +
                affine[a][1] * j +
                affine[a][2] * k +
                affine[a][3],
            );
          weights.push(hu - L.threshold_hu);
        }
    if (weights.length < L.min_points)
      throw new Error("Too little bone in the scan");
    if (weights.length <= L.max_points)
      return {
        points: Float64Array.from(points),
        weights: Float64Array.from(weights),
      };
  }
}

/** Gaussian blur, rows then columns. Outside the picture counts as the
 * nearest edge value (`clamp`) or as nothing. */
function blur(
  src: Float32Array,
  w: number,
  h: number,
  sigma: number,
  clamp: boolean,
  out: Float32Array,
  scratch: Float32Array,
) {
  const radius = Math.ceil(3 * sigma),
    kernel = new Float32Array(2 * radius + 1);
  let total = 0;
  for (let i = -radius; i <= radius; i++)
    total += kernel[i + radius] = Math.exp((-i * i) / (2 * sigma * sigma));
  for (let i = 0; i < kernel.length; i++) kernel[i] /= total;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let i = -radius; i <= radius; i++) {
        let at = x + i;
        if (at < 0 || at >= w) {
          if (!clamp) continue;
          at = at < 0 ? 0 : w - 1;
        }
        sum += kernel[i + radius] * src[y * w + at];
      }
      scratch[y * w + x] = sum;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let i = -radius; i <= radius; i++) {
        let at = y + i;
        if (at < 0 || at >= h) {
          if (!clamp) continue;
          at = at < 0 ? 0 : h - 1;
        }
        sum += kernel[i + radius] * scratch[at * w + x];
      }
      out[y * w + x] = sum;
    }
}

type Level = {
  w: number;
  h: number;
  /** The frame's edge direction, strength pressed flat. */
  fx: Float32Array;
  fy: Float32Array;
  drr: Float32Array;
  soft: Float32Array;
  scratch: Float32Array;
};
type Prepared = {
  levels: Map<number, Level>;
  /** Rows: image right, image up and beam, in the search's own axes. */
  m: number[];
  o: number[];
  sid: number;
  width_mm: number;
  height_mm: number;
};

function prepareFrame(frame: BoneFrameInput, divisors: number[]) {
  const L = BONE_LINEUP,
    { pixels, width, height } = frame;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 16 ||
    height < 16 ||
    pixels?.length !== width * height
  )
    throw new Error("Frame does not match its size");
  let low = Infinity,
    high = -Infinity;
  for (let i = 0; i < pixels.length; i++) {
    const value = pixels[i];
    if (!Number.isFinite(value) || value < 0) throw new Error("Invalid frame");
    if (value < low) low = value;
    if (value > high) high = value;
  }
  if (!(high > low)) throw new Error("Frame shows nothing to line up on");
  // The working picture: each of its pixels is the mean of the source
  // pixels it covers, part pixels by their share, so the picture stays
  // where the frame is. Sides are a multiple of the coarsest divisor.
  const coarsest = Math.max(...divisors),
    shrink = Math.min(1, L.working_px / Math.max(width, height)),
    side = (n: number) =>
      Math.max(2 * coarsest, coarsest * Math.floor((n * shrink) / coarsest)),
    w = side(width),
    h = side(height);
  /** For each working pixel, the source pixels it covers and their shares. */
  const spans = (from: number, to: number) =>
    Array.from({ length: to }, (_, k) => {
      const a = (k * from) / to,
        b = ((k + 1) * from) / to,
        first = Math.floor(a),
        last = Math.min(from, Math.ceil(b)),
        share = new Float64Array(last - first);
      for (let i = first; i < last; i++)
        share[i - first] = (Math.min(i + 1, b) - Math.max(i, a)) / (b - a);
      return { first, share };
    });
  const across = spans(width, w),
    down = spans(height, h);
  const floor = high / 256,
    full = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const rows = down[y];
    for (let x = 0; x < w; x++) {
      const columns = across[x];
      let sum = 0;
      for (let j = 0; j < rows.share.length; j++) {
        const at = (rows.first + j) * width + columns.first;
        let line = 0;
        for (let i = 0; i < columns.share.length; i++)
          line += columns.share[i] * pixels[at + i];
        sum += rows.share[j] * line;
      }
      // What the beam lost on the way: bright where a detector reads dark.
      full[y * w + x] = -Math.log((sum + floor) / (high + floor));
    }
  }
  const levels = new Map<number, Level>();
  for (const divisor of divisors) {
    const lw = w / divisor,
      lh = h / divisor,
      small = new Float32Array(lw * lh);
    for (let y = 0; y < lh; y++)
      for (let x = 0; x < lw; x++) {
        let sum = 0;
        for (let j = 0; j < divisor; j++)
          for (let i = 0; i < divisor; i++)
            sum += full[(y * divisor + j) * w + x * divisor + i];
        small[y * lw + x] = sum / (divisor * divisor);
      }
    const soft = new Float32Array(lw * lh),
      tmp = new Float32Array(lw * lh);
    blur(small, lw, lh, L.blur_px, true, soft, tmp);
    const fx = new Float32Array(lw * lh),
      fy = new Float32Array(lw * lh),
      strength: number[] = [];
    for (let y = 1; y < lh - 1; y++)
      for (let x = 1; x < lw - 1; x++) {
        const at = y * lw + x;
        fx[at] = (soft[at + 1] - soft[at - 1]) / 2;
        fy[at] = (soft[at + lw] - soft[at - lw]) / 2;
        strength.push(Math.hypot(fx[at], fy[at]));
      }
    strength.sort((a, b) => a - b);
    // Half the frame's edges are weaker than `typical`. A frame that is
    // mostly flat has a typical strength near nothing, and its shading
    // would then count as much as bone, so the strong edges set a floor.
    const typical = Math.max(
      strength[strength.length >> 1],
      L.flat_floor * strength[Math.floor(strength.length * 0.95)],
    );
    if (!(typical > 0)) throw new Error("Frame shows nothing to line up on");
    for (let at = 0; at < fx.length; at++) {
      const flat = Math.hypot(fx[at], fy[at]) + typical;
      fx[at] /= flat;
      fy[at] /= flat;
    }
    levels.set(divisor, {
      w: lw,
      h: lh,
      fx,
      fy,
      drr: new Float32Array(lw * lh),
      soft: new Float32Array(lw * lh),
      scratch: new Float32Array(lw * lh),
    });
  }
  return levels;
}

/** Turn about x, then y, then z, in degrees; row-major. */
function rotation(rx: number, ry: number, rz: number): number[] {
  const cx = Math.cos(rx * rad),
    sx = Math.sin(rx * rad),
    cy = Math.cos(ry * rad),
    sy = Math.sin(ry * rad),
    cz = Math.cos(rz * rad),
    sz = Math.sin(rz * rad);
  return [
    cz * cy,
    cz * sy * sx - sz * cx,
    cz * sy * cx + sz * sx,
    sz * cy,
    sz * sy * sx + cz * cx,
    sz * sy * cx - cz * sx,
    -sy,
    cy * sx,
    cy * cx,
  ];
}

function* solve(input: BoneLineupInput): Generator<void, BoneLineupProposal> {
  const L = BONE_LINEUP;
  if (
    !Array.isArray(input.frames) ||
    input.frames.length < 1 ||
    input.frames.length > 2
  )
    throw new Error("One or two frames are required");
  const two = input.frames.length === 2;
  const start = validateRigid(input.start);
  const { points, weights } = input.samples ?? {};
  if (
    !(points instanceof Float64Array) ||
    !(weights instanceof Float64Array) ||
    points.length !== 3 * weights.length ||
    weights.length < L.min_points
  )
    throw new Error("Too little bone in the scan");
  const count = weights.length;
  for (let i = 0; i < count; i++)
    if (
      !(weights[i] > 0) ||
      !Number.isFinite(weights[i]) ||
      !Number.isFinite(points[3 * i]) ||
      !Number.isFinite(points[3 * i + 1]) ||
      !Number.isFinite(points[3 * i + 2])
    )
      throw new Error("Invalid bone points");
  const views = input.frames.map((frame) => validateView(frame.view));
  if (two && !planesFarEnough(planeAngleDeg(views[0], views[1])))
    throw new Error("The two frames are too close to parallel");
  const divisors: number[] = [
    ...new Set([...L.first_levels, ...L.both_levels]),
  ];
  const cameras = input.frames.map((frame, k) =>
    camera(views[k], frame.isocenter),
  );

  // Points at the starting pose and their weighted middle, the pivot of
  // every turn; then the same points in the first frame's axes about it.
  const world = new Float64Array(points.length),
    pivot = [0, 0, 0];
  let weight = 0;
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < 3; a++) {
      const value =
        start[a][0] * points[3 * i] +
        start[a][1] * points[3 * i + 1] +
        start[a][2] * points[3 * i + 2] +
        start[a][3];
      world[3 * i + a] = value;
      pivot[a] += weights[i] * value;
    }
    weight += weights[i];
  }
  for (let a = 0; a < 3; a++) pivot[a] /= weight;
  const axes = [cameras[0].u, cameras[0].v, cameras[0].d];
  const local = new Float64Array(points.length);
  for (let i = 0; i < count; i++)
    for (let a = 0; a < 3; a++)
      local[3 * i + a] =
        axes[a][0] * (world[3 * i] - pivot[0]) +
        axes[a][1] * (world[3 * i + 1] - pivot[1]) +
        axes[a][2] * (world[3 * i + 2] - pivot[2]);

  const prepared: Prepared[] = input.frames.map((frame, k) => {
    const cam = cameras[k],
      rows = [cam.u, cam.v, cam.d];
    return {
      levels: prepareFrame(frame, divisors),
      m: rows.flatMap((row) =>
        axes.map(
          (axis) => row[0] * axis[0] + row[1] * axis[1] + row[2] * axis[2],
        ),
      ),
      o: rows.map(
        (row) =>
          row[0] * (pivot[0] - cam.source[0]) +
          row[1] * (pivot[1] - cam.source[1]) +
          row[2] * (pivot[2] - cam.source[2]),
      ),
      sid: cam.source_detector_mm,
      width_mm: 2 * cam.half_width_mm,
      height_mm: 2 * cam.half_height_mm,
    };
  });

  let evaluations = 0;
  /** Drops the bone on one frame's working picture at one pose. Returns
   * the weight and the number of points that fell in the frame. p = shift
   * along the first frame's axes, turns about them. */
  const drop = (k: number, divisor: number, p: number[]) => {
    const frame = prepared[k],
      level = frame.levels.get(divisor) as Level,
      { w, h, drr } = level,
      { m, o } = frame,
      r = rotation(p[3], p[4], p[5]);
    // Fewer points carry a coarser picture.
    const stride = Math.max(1, Math.min(divisor, Math.floor(count / 2000)));
    drr.fill(0);
    let inside = 0,
      seen = 0;
    for (let i = 0; i < count; i += stride) {
      const x = local[3 * i],
        y = local[3 * i + 1],
        z = local[3 * i + 2];
      const lx = r[0] * x + r[1] * y + r[2] * z + p[0],
        ly = r[3] * x + r[4] * y + r[5] * z + p[1],
        lz = r[6] * x + r[7] * y + r[8] * z + p[2];
      const depth = m[6] * lx + m[7] * ly + m[8] * lz + o[2];
      // Points spread over more of the detector the nearer they are to the
      // source. Weighting by depth squared keeps a point's share of the
      // picture what its share of the beam's path is.
      const value = weights[i] * (depth / frame.sid) ** 2;
      if (!(depth >= 1)) continue;
      const scale = frame.sid / depth;
      const px =
          (((m[0] * lx + m[1] * ly + m[2] * lz + o[0]) * scale) /
            frame.width_mm +
            0.5) *
            w -
          0.5,
        py =
          (0.5 -
            ((m[3] * lx + m[4] * ly + m[5] * lz + o[1]) * scale) /
              frame.height_mm) *
            h -
          0.5;
      const x0 = Math.floor(px),
        y0 = Math.floor(py);
      if (!(x0 >= 0 && y0 >= 0 && x0 < w - 1 && y0 < h - 1)) continue;
      const ax = px - x0,
        ay = py - y0,
        at = y0 * w + x0;
      drr[at] += value * (1 - ax) * (1 - ay);
      drr[at + 1] += value * ax * (1 - ay);
      drr[at + w] += value * (1 - ax) * ay;
      drr[at + w + 1] += value * ax * ay;
      inside += value;
      seen += stride;
    }
    return { inside, seen };
  };
  const zero = [0, 0, 0, 0, 0, 0];
  // What each frame holds at the start, at each level.
  const floors = prepared.map((_, k) => {
    if (drop(k, 1, zero).seen < L.min_points)
      throw new Error(BONE_NOT_IN_FRAME);
    return new Map(
      divisors.map((divisor) => [
        divisor,
        L.keep_in_field * drop(k, divisor, zero).inside,
      ]),
    );
  });
  /** Edge agreement of one frame at one pose; -1 when the bone has left
   * the frame. */
  const measure = (k: number, divisor: number, p: number[]) => {
    const level = prepared[k].levels.get(divisor) as Level,
      { w, h, drr, soft, scratch, fx, fy } = level;
    if (drop(k, divisor, p).inside < (floors[k].get(divisor) as number))
      return -1;
    blur(drr, w, h, L.blur_px, false, soft, scratch);
    let agree = 0,
      own = 0;
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const at = y * w + x,
          dx = (soft[at + 1] - soft[at - 1]) / 2,
          dy = (soft[at + w] - soft[at - w]) / 2;
        agree += dx * fx[at] + dy * fy[at];
        own += Math.hypot(dx, dy);
      }
    return own > 0 ? agree / own : -1;
  };
  const score = (which: number[], divisor: number, p: number[]) => {
    evaluations++;
    let sum = 0;
    for (const k of which) {
      const one = measure(k, divisor, p);
      if (one <= -1) return -1;
      sum += one;
    }
    return sum / which.length;
  };
  const within = (p: number[]) =>
    Math.hypot(p[0], p[1], p[2]) <= L.translation_mm &&
    Math.abs(p[3]) <= L.rotation_deg &&
    Math.abs(p[4]) <= L.rotation_deg &&
    Math.abs(p[5]) <= L.rotation_deg;

  type Found = { p: number[]; score: number };
  function* descend(
    which: number[],
    divisor: number,
    from: number[],
    opening: readonly number[] = L.step,
  ): Generator<void, Found> {
    let p = from.slice(),
      best = score(which, divisor, p);
    const step = opening.map((value) => (value * divisor) / 2);
    let since = 0;
    while (Math.max(...step) > L.stop && evaluations < L.max_evaluations) {
      let improved = false;
      for (let i = 0; i < 6; i++)
        for (const direction of [1, -1]) {
          const next = p.slice();
          next[i] += direction * step[i];
          if (!within(next)) continue;
          const value = score(which, divisor, next);
          if (++since >= L.slice_evaluations) {
            since = 0;
            yield;
          }
          if (value > best + 1e-6) {
            p = next;
            best = value;
            improved = true;
            break;
          }
        }
      if (!improved) for (let i = 0; i < 6; i++) step[i] /= 2;
    }
    return { p, score: best };
  }

  /** The best `count` entries of a scan that are `apart` from each other. */
  const separate = (
    scan: [number, number[]][],
    count: number,
    apart: number,
    kept: number[][] = [],
  ) => {
    scan.sort((a, b) => b[0] - a[0]);
    const picked: number[][] = [];
    for (const [, at] of scan) {
      if (picked.length === count) break;
      if (
        [...kept, ...picked].every(
          (other) =>
            Math.hypot(...other.map((value, i) => value - at[i])) >= apart,
        )
      )
        picked.push(at);
    }
    return picked;
  };

  // The first frame alone. A spine repeats itself every vertebra, and a
  // start a level off descends onto the wrong one, so the search looks
  // across the frame for other places to start from: coarsely around the
  // start before the first descent, and more finely around its answer
  // after it. The finest level tells the places apart.
  const look = (around: number[], divisor: number) => {
    const scan: [number, number[]][] = [];
    for (
      let u = -L.opening_scan_mm;
      u <= L.opening_scan_mm;
      u += L.opening_step_mm
    )
      for (
        let v = -L.opening_scan_mm;
        v <= L.opening_scan_mm;
        v += L.opening_step_mm
      ) {
        if (u === 0 && v === 0) continue;
        const p = around.slice();
        p[0] += u;
        p[1] += v;
        if (within(p)) scan.push([score([0], divisor, p), p]);
      }
    return separate(scan, L.opening_candidates, L.opening_apart_mm, [around]);
  };
  const from = function* (p: number[], levels: readonly number[]) {
    let next: Found = { p, score: 0 };
    for (const divisor of levels) next = yield* descend([0], divisor, next.p);
    return next;
  };
  let found = yield* from(zero, L.first_levels);
  for (const p of look(zero, L.first_levels[0])) {
    const next = yield* from(p, L.first_levels);
    if (next.score > found.score) found = next;
  }
  for (let round = 0; round < L.second_looks; round++) {
    let better: Found | null = null;
    for (const p of look(found.p, L.second_look_levels[0])) {
      const next = yield* from(p, L.second_look_levels);
      if (next.score > (better ?? found).score + 1e-6) better = next;
    }
    if (!better) break;
    found = better;
  }

  const depth_candidates_mm: number[] = [];
  if (two) {
    // Depth along the first beam is what one frame cannot see and the other
    // sees as a plain shift.
    // The second frame sees depth as plainly as the first sees a shift
    // across, so depth is stepped like one.
    const opening = [
      L.step[0],
      L.step[1],
      L.step[0],
      L.step[3],
      L.step[4],
      L.step[5],
    ];
    const both = [0, 1],
      first: Found = found,
      scan: [number, number[]][] = [];
    for (
      let depth = -L.depth_scan_mm;
      depth <= L.depth_scan_mm;
      depth += L.depth_step_mm
    ) {
      const p = first.p.slice();
      p[2] += depth;
      if (within(p)) scan.push([score(both, L.both_levels[0], p), [depth]]);
    }
    yield;
    for (const [depth] of separate(scan, L.depth_candidates, L.depth_apart_mm))
      depth_candidates_mm.push(depth);
    let best: Found | null = null;
    for (const depth of depth_candidates_mm) {
      let next: Found = { p: first.p.slice(), score: 0 };
      next.p[2] += depth;
      for (const divisor of L.both_levels)
        next = yield* descend(both, divisor, next.p, opening);
      if (!best || next.score > best.score) best = next;
    }
    if (best) found = best;
  }

  const which = prepared.map((_, k) => k),
    p = found.p,
    r = rotation(p[3], p[4], p[5]);
  const frame_scores = which.map((k) => measure(k, 1, p)),
    start_scores = which.map((k) => measure(k, 1, zero));
  const mean = (values: number[]) =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  // The turn and the shift in C-arm axes, composed onto the start.
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
    method: two ? BONE_LINEUP_BIPLANE_METHOD : BONE_LINEUP_METHOD,
    matrix: orthonormal([...raw, [0, 0, 0, 1]]),
    score: mean(frame_scores),
    frame_scores,
    start_score: mean(start_scores),
    depth_candidates_mm,
    translation_mm: Math.hypot(p[0], p[1], p[2]),
    rotation_deg: Math.acos(cosine) / rad,
    point_count: count,
    evaluations,
  };
}

/** Resumable line-up search. */
export function createBoneLineupJob(input: BoneLineupInput): BoneLineupJob {
  const steps = solve(input);
  let done: BoneLineupProposal | null = null,
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
        failure = error ?? new Error("Line-up failed");
        throw failure;
      }
      return true;
    },
    result() {
      if (!done) throw new Error("Line-up is not complete");
      return done;
    },
  };
}

/** One-shot line-up. Blocks until complete; interactive callers should
 * drive `createBoneLineupJob` in short slices instead. */
export function proposeBoneLineup(input: BoneLineupInput): BoneLineupProposal {
  const job = createBoneLineupJob(input);
  job.advance(() => false);
  return job.result();
}
