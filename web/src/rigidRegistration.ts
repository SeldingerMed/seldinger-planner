/** Automatic secondary-RAS→primary-RAS rigid registration proposal.
 *
 * Intensity-based: normalized mutual information over a three-level
 * block-averaged pyramid. A translation scan of the primary volume is
 * followed by bounded compass searches of the six rigid parameters from
 * several starting rotations, and the finest level chooses among the best
 * of them. The result is a proposal for the operator to review and confirm.
 * It carries no accuracy claim and has not been validated on acquired
 * angiography. */
import type { NVImage } from "@niivue/niivue";
import type { Vec3 } from "./obliqueSlice";
import { createNativeSampler } from "./nativeSampling";
import { validateRigid } from "./rigidFusion";

export const REGISTRATION_METHOD = "nmi_pyramid_compass_v1";
export const REGISTRATION_LIMITS = {
  /** Largest turn about each primary RAS axis searched away from the starting
   * matrix. The three combine, so the whole turn can reach about 36°. */
  rotation_deg: 20,
  /** Smallest share of secondary samples that must land inside the primary.
   * Mutual information has spurious optima where little of the secondary
   * overlaps, so those positions are not scored at all. A secondary that
   * extends well beyond the primary cannot be registered this way round. */
  min_overlap: 0.75,
  min_voxels_per_axis: 8,
  /** Positions visited by the translation scan, besides the starting one. */
  max_scan_positions: 6000,
  /** Most evaluations after the scan. Every search has its own share, so a
   * slow coarse one cannot starve the finer levels. */
  max_search_evaluations: 13000,
} as const;

export type RegistrationProposal = {
  method: typeof REGISTRATION_METHOD;
  /** Secondary RAS to primary RAS, in millimeters. */
  matrix: number[][];
  /** Normalized mutual information at the finest level, between 1 and 2.
   * Not an accuracy measure. */
  score: number;
  /** The same at the starting matrix. Zero where `start_overlap` is below
   * `min_overlap`: that position was not scored. */
  start_score: number;
  /** Share of secondary samples inside the primary at the starting matrix. */
  start_overlap: number;
  /** Share of secondary samples inside the primary at the proposal. */
  overlap: number;
  /** Longest edge of the block-averaged secondary samples at the finest
   * level. Detail smaller than this did not inform the proposal. */
  sample_mm: number;
  /** Displacement of the secondary volume center from the starting matrix. */
  translation_mm: number;
  /** Rotation away from the starting matrix. */
  rotation_deg: number;
  evaluations: number;
};

export type RegistrationJob = {
  /** Runs search steps until the proposal is complete or `expired()` returns
   * true. At least one step runs per call. The longest step is one pass over
   * a coarse grid, which is at most the size of the native volume. Returns
   * true once complete.
   * A failure is thrown again by every later call. */
  advance(expired: () => boolean): boolean;
  /** The finished proposal. Throws until `advance` has returned true. */
  result(): RegistrationProposal;
};

const BINS = 32,
  /** Share of voxels left out at each end of the intensity range. */
  TAIL = 0.001,
  TOP = 4,
  /** Native voxels averaged between two yields while a level is built. */
  STEP_VOXELS = 250000,
  /** Middle-level searches start unturned and turned this far (degrees)
   * either way about each axis: 27 starts from each of up to two positions. */
  TURNS = [0, -8, 8],
  /** Distinct middle-level results compared at the finest level. */
  KEEP = 3;
/** Target spacing (mm), secondary sample cap, histogram bins per image (a
 * power of two), parameters searched, compass steps (mm, degrees), the
 * translation step at which a search stops and the evaluations one search
 * may spend.
 * Coarse levels hold few samples, and mutual information estimated from few
 * samples in many bins rises as the overlap shrinks, so they use fewer bins.
 * The coarsest level moves translation only: block averages that large hold
 * too little detail to fix rotation, and a wrong turn there is hard to undo. */
const LEVELS = [
  {
    target: 6,
    cap: 4000,
    bins: 8,
    axes: 3,
    step: 8,
    turn: 0,
    stop: 2,
    evals: 300,
  },
  {
    target: 3,
    cap: 30000,
    bins: 16,
    axes: 6,
    step: 4,
    turn: 4,
    stop: 0.5,
    evals: 200,
  },
  {
    target: 1.5,
    cap: 600000,
    bins: 32,
    axes: 6,
    step: 1.5,
    turn: 2,
    stop: 0.05,
    evals: 800,
  },
] as const;

type Grid = {
  shape: Vec3;
  /** Histogram bin of every coarse voxel. */
  bins: Uint8Array;
  /** Row-major 3×4, coarse voxel to RAS. */
  affine: number[];
  /** Longest edge of one coarse voxel. */
  block_mm: number;
};
type Found = { p: number[]; s: number };
type Level = {
  fixed: Grid;
  /** Row-major 3×4, primary RAS to coarse primary voxel. */
  toVoxel: number[];
  /** RAS position and histogram bin of every coarse secondary voxel. */
  points: Float64Array;
  bins: Uint8Array;
  /** Histogram bins per image at this level. */
  count: number;
  block_mm: number;
};

/** `a ∘ b` for row-major 3×4 rigid or affine maps. */
function compose(a: number[], b: number[]): number[] {
  const out = new Array<number>(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++)
      out[4 * r + c] =
        a[4 * r] * b[c] + a[4 * r + 1] * b[4 + c] + a[4 * r + 2] * b[8 + c];
    out[4 * r + 3] =
      a[4 * r] * b[3] +
      a[4 * r + 1] * b[7] +
      a[4 * r + 2] * b[11] +
      a[4 * r + 3];
  }
  return out;
}
const apply = (m: number[], p: Vec3): Vec3 => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
  m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
  m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
];
function invert(m: number[]): number[] {
  const [a, b, c, , d, e, f, , g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12)
    throw new Error("Singular native affine");
  const r = [
    (e * i - f * h) / det,
    (c * h - b * i) / det,
    (b * f - c * e) / det,
    (f * g - d * i) / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    (d * h - e * g) / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ];
  const t = [m[3], m[7], m[11]];
  const out: number[] = [];
  for (let k = 0; k < 3; k++)
    out.push(
      r[3 * k],
      r[3 * k + 1],
      r[3 * k + 2],
      -(r[3 * k] * t[0] + r[3 * k + 1] * t[1] + r[3 * k + 2] * t[2]),
    );
  return out;
}
const flat = (m: number[][]) => [...m[0], ...m[1], ...m[2]];
const NONFINITE = "Nonfinite source sample; refusing registration";

/** Block-averaged copy of a validated native volume near `target` mm,
 * coarsened further until it holds at most `cap` voxels. Yields between
 * bounded pieces of work so a caller can keep its time slices short. */
function* coarsen(
  volume: NVImage,
  target: number,
  cap = Infinity,
): Generator<void, Grid> {
  const source = createNativeSampler(volume),
    native = flat(volume.getAffine()),
    [nx, ny] = source.shape;
  if (source.shape.some((n) => n < REGISTRATION_LIMITS.min_voxels_per_axis))
    throw new Error("Source is too small to register");
  const spacing = [0, 1, 2].map((j) =>
      Math.hypot(native[j], native[4 + j], native[8 + j]),
    ),
    most = source.shape.map((n) => Math.floor(n / 4));
  if (!spacing.every((mm) => mm > 0 && Number.isFinite(mm)))
    throw new Error("Singular native affine");
  let f: number[], shape: Vec3;
  // The block edge grows by half the smallest voxel at a time, so no block
  // size is skipped and the grid is the finest one that fits the cap.
  for (let mm = target; ; mm += Math.min(...spacing) / 2) {
    f = spacing.map((s, j) =>
      Math.max(1, Math.min(Math.round(mm / s), most[j])),
    );
    shape = source.shape.map((n, j) => Math.floor(n / f[j])) as Vec3;
    if (shape[0] * shape[1] * shape[2] <= cap) break;
    if (f.every((v, j) => v === most[j])) break;
  }
  const data = new Float32Array(shape[0] * shape[1] * shape[2]),
    raw = source.raw,
    weight = source.slope / (f[0] * f[1] * f[2]),
    slab = Math.max(1, Math.floor(STEP_VOXELS / (nx * ny * f[2])));
  let at = 0,
    least = Infinity,
    greatest = -Infinity;
  for (let z = 0; z < shape[2]; z++) {
    for (let y = 0; y < shape[1]; y++)
      for (let x = 0; x < shape[0]; x++) {
        let sum = 0;
        for (let k = z * f[2]; k < (z + 1) * f[2]; k++)
          for (let j = y * f[1]; j < (y + 1) * f[1]; j++) {
            const row = nx * (j + ny * k);
            for (let i = x * f[0]; i < (x + 1) * f[0]; i++) sum += raw[row + i];
          }
        const value = sum * weight + source.inter;
        if (value - value !== 0) throw new Error(NONFINITE);
        if (value < least) least = value;
        if (value > greatest) greatest = value;
        data[at++] = value;
      }
    if ((z + 1) % slab === 0) yield;
  }
  // Whole blocks leave up to f − 1 voxels an axis outside every average.
  // The search never reads them, but the fusion view draws them, so a
  // nonfinite one refuses the source like any other.
  const covered = shape.map((n, j) => n * f[j]);
  for (let k = 0, seen = 0; k < source.shape[2]; k++)
    for (let j = 0; j < ny; j++) {
      const row = nx * (j + ny * k),
        from = k < covered[2] && j < covered[1] ? covered[0] : 0;
      for (let i = from; i < nx; i++) {
        const value = raw[row + i] * source.slope + source.inter;
        if (value - value !== 0) throw new Error(NONFINITE);
      }
      if ((seen += nx - from) >= STEP_VOXELS) {
        seen = 0;
        yield;
      }
    }
  if (!(greatest > least))
    throw new Error("Source has no usable intensity variation");
  // Coarse voxel j covers native voxels f·j … f·j + f − 1.
  const affine = native.slice();
  for (let r = 0; r < 3; r++) {
    for (let j = 0; j < 3; j++) {
      affine[4 * r + 3] += (native[4 * r + j] * (f[j] - 1)) / 2;
      affine[4 * r + j] = native[4 * r + j] * f[j];
    }
  }
  // The intensity range leaves out the extreme 0.1% at each end, read from a
  // fine histogram: one pass, and exact to 1/4096 of the full range. A wider
  // cut would flatten what there is to register on when that is a small
  // share of the voxels: opacified vessels, or a body in a wide field of air.
  const FINE = 4096,
    counts = new Uint32Array(FINE),
    width = (greatest - least) / FINE;
  for (let n = 0; n < data.length; n++) {
    counts[Math.min(FINE - 1, Math.floor((data[n] - least) / width))]++;
    if (n % STEP_VOXELS === STEP_VOXELS - 1) yield;
  }
  yield;
  const edge = (rank: number) => {
    let k = 0;
    for (let seen = counts[0]; seen <= rank; seen += counts[++k]);
    return k;
  };
  const low = least + edge(Math.floor(TAIL * (data.length - 1))) * width,
    high =
      least + (edge(Math.ceil((1 - TAIL) * (data.length - 1))) + 1) * width,
    scale = BINS / (high - low),
    bins = new Uint8Array(data.length);
  for (let n = 0; n < data.length; n++) {
    const b = Math.floor((data[n] - low) * scale);
    bins[n] = b < 0 ? 0 : b >= BINS ? BINS - 1 : b;
    if (n % STEP_VOXELS === STEP_VOXELS - 1) yield;
  }
  yield;
  return {
    shape,
    bins,
    affine,
    block_mm: Math.max(...f.map((v, j) => v * spacing[j])),
  };
}

function* buildLevel(
  primary: NVImage,
  secondary: NVImage,
  { target, cap, bins: count }: (typeof LEVELS)[number],
): Generator<void, Level> {
  const fixed = yield* coarsen(primary, target),
    moving = yield* coarsen(secondary, target, cap),
    [mx, my, mz] = moving.shape,
    points = new Float64Array(3 * moving.bins.length);
  // Every block-averaged secondary voxel is a sample: averaging, not
  // skipping, is what keeps a capped level free of aliasing.
  for (let z = 0, at = 0; z < mz; z++)
    for (let y = 0; y < my; y++)
      for (let x = 0; x < mx; x++, at += 3)
        points.set(apply(moving.affine, [x, y, z]), at);
  const shift = Math.log2(BINS / count);
  if (shift)
    for (const bins of [fixed.bins, moving.bins])
      for (let n = 0; n < bins.length; n++) bins[n] >>= shift;
  yield;
  return {
    fixed,
    toVoxel: invert(fixed.affine),
    points,
    bins: moving.bins,
    count,
    block_mm: moving.block_mm,
  };
}

/** Normalized mutual information of the secondary samples against the
 * primary under `pose` (row-major 3×4, secondary RAS to primary RAS). */
function similarity(level: Level, pose: number[]) {
  const v = compose(level.toVoxel, pose),
    { shape } = level.fixed,
    data = level.fixed.bins,
    [sx, sy] = shape,
    mx = shape[0] - 1,
    my = shape[1] - 1,
    mz = shape[2] - 1,
    { points, bins } = level,
    total = bins.length,
    count = level.count,
    joint = new Float64Array(count * count);
  let inside = 0;
  for (let n = 0; n < total; n++) {
    const px = points[3 * n],
      py = points[3 * n + 1],
      pz = points[3 * n + 2],
      x = v[0] * px + v[1] * py + v[2] * pz + v[3],
      y = v[4] * px + v[5] * py + v[6] * pz + v[7],
      z = v[8] * px + v[9] * py + v[10] * pz + v[11];
    // Also false for a nonfinite coordinate.
    if (!(x >= 0 && y >= 0 && z >= 0 && x <= mx && y <= my && z <= mz))
      continue;
    const x0 = x >= mx ? mx - 1 : Math.floor(x),
      y0 = y >= my ? my - 1 : Math.floor(y),
      z0 = z >= mz ? mz - 1 : Math.floor(z),
      fx = x - x0,
      fy = y - y0,
      fz = z - z0,
      o = x0 + sx * (y0 + sy * z0),
      p = o + sx * sy;
    // Partial-volume interpolation: the eight surrounding primary voxels
    // share the sample by trilinear weight, so the score varies continuously
    // with the pose instead of jumping when an interpolated value changes bin.
    const row = bins[n] * count,
      gx = 1 - fx,
      gy = 1 - fy,
      gz = 1 - fz;
    joint[row + data[o]] += gx * gy * gz;
    joint[row + data[o + 1]] += fx * gy * gz;
    joint[row + data[o + sx]] += gx * fy * gz;
    joint[row + data[o + sx + 1]] += fx * fy * gz;
    joint[row + data[p]] += gx * gy * fz;
    joint[row + data[p + 1]] += fx * gy * fz;
    joint[row + data[p + sx]] += gx * fy * fz;
    joint[row + data[p + sx + 1]] += fx * fy * fz;
    inside++;
  }
  const overlap = inside / total;
  if (overlap < REGISTRATION_LIMITS.min_overlap) return { score: 0, overlap };
  const a = new Float64Array(count),
    b = new Float64Array(count);
  let hab = 0;
  for (let i = 0; i < count; i++)
    for (let j = 0; j < count; j++) {
      const c = joint[i * count + j];
      if (c === 0) continue;
      a[i] += c;
      b[j] += c;
      hab -= (c / inside) * Math.log(c / inside);
    }
  const entropy = (h: Float64Array) =>
    h.reduce(
      (s, c) => (c === 0 ? s : s - (c / inside) * Math.log(c / inside)),
      0,
    );
  // A constant overlap carries no information to align.
  return { score: hab > 1e-12 ? (entropy(a) + entropy(b)) / hab : 0, overlap };
}

/** Spacing (mm) and positions per axis of the translation scan over a box
 * of the given extent (mm): twice the coarsest block where that fits within
 * `REGISTRATION_LIMITS.max_scan_positions`, wider where it does not. */
export function scanGrid(extent: number[]): { step: number; counts: number[] } {
  // A nonfinite extent would never fit, and the widening below never end.
  if (!extent.every(Number.isFinite))
    throw new Error("Nonfinite primary extent; refusing registration");
  let step = Math.max(
    2 * LEVELS[0].target,
    Math.cbrt(
      (extent[0] * extent[1] * extent[2]) /
        REGISTRATION_LIMITS.max_scan_positions,
    ),
  );
  // Each axis rounds up to a whole position, so widen until the grid fits.
  for (; ; step *= 1.05) {
    const counts = extent.map((e) => Math.floor(e / step) + 1);
    if (
      counts[0] * counts[1] * counts[2] <=
      REGISTRATION_LIMITS.max_scan_positions
    )
      return { step, counts };
  }
}

/** `Rz·Ry·Rx` in degrees, row-major 3×3. */
function rotation(rx: number, ry: number, rz: number): number[] {
  const [a, b, c] = [rx, ry, rz].map((d) => (d * Math.PI) / 180),
    ca = Math.cos(a),
    sa = Math.sin(a),
    cb = Math.cos(b),
    sb = Math.sin(b),
    cc = Math.cos(c),
    sc = Math.sin(c);
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
/** The starting matrix turned about `center` (primary RAS) and then shifted.
 * `p` is three translations in mm followed by three rotations in degrees. */
function pose(base: number[], center: Vec3, p: number[]): number[] {
  const r = rotation(p[3], p[4], p[5]);
  const turn = [0, 1, 2].flatMap((k) => [
    r[3 * k],
    r[3 * k + 1],
    r[3 * k + 2],
    center[k] +
      p[k] -
      (r[3 * k] * center[0] +
        r[3 * k + 1] * center[1] +
        r[3 * k + 2] * center[2]),
  ]);
  return compose(turn, base);
}

/** Nearest rotation by Gram-Schmidt, rounded so the matrix is short to
 * read and still orthonormal well inside the 1e-6 contract. */
function finish(m: number[]): number[][] {
  const col = (j: number): Vec3 => [m[j], m[4 + j], m[8 + j]],
    dot = (u: Vec3, w: Vec3) => u[0] * w[0] + u[1] * w[1] + u[2] * w[2],
    unit = (u: Vec3): Vec3 => {
      const n = Math.hypot(...u);
      return [u[0] / n, u[1] / n, u[2] / n];
    };
  const x = unit(col(0)),
    y0 = col(1),
    d = dot(x, y0),
    y = unit([y0[0] - d * x[0], y0[1] - d * x[1], y0[2] - d * x[2]]),
    z: Vec3 = [
      x[1] * y[2] - x[2] * y[1],
      x[2] * y[0] - x[0] * y[2],
      x[0] * y[1] - x[1] * y[0],
    ];
  // A tiny negative entry rounds to −0, which does not compare equal to 0
  // when matrices are compared, so it is written as 0.
  const round = (value: number, digits: number) => {
    const rounded = Number(value.toFixed(digits));
    return rounded === 0 ? 0 : rounded;
  };
  return validateRigid([
    ...[0, 1, 2].map((k) => [
      round(x[k], 9),
      round(y[k], 9),
      round(z[k], 9),
      round(m[4 * k + 3], 4),
    ]),
    [0, 0, 0, 1],
  ]);
}

function* solve(
  primary: NVImage,
  secondary: NVImage,
  start: unknown,
): Generator<void, RegistrationProposal> {
  const base = flat(validateRigid(start));
  const levels: Level[] = [];
  for (const level of LEVELS) {
    levels.push(yield* buildLevel(primary, secondary, level));
    yield;
  }
  const corner = (volume: NVImage, at: (n: number, axis: number) => number) =>
    apply(
      flat(volume.getAffine()),
      createNativeSampler(volume).shape.map(at) as Vec3,
    );
  const center = apply(
    base,
    corner(secondary, (n) => (n - 1) / 2),
  );
  let evaluations = 0;
  const score = (level: Level, p: number[]) => {
    evaluations++;
    return similarity(level, pose(base, center, p)).score;
  };

  // Translation scan: the secondary center visits a grid over the primary's
  // RAS bounding box, rotation held at the starting matrix.
  const low = [Infinity, Infinity, Infinity],
    high = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c++)
    corner(primary, (n, axis) => ((c >> axis) & 1) * (n - 1)).forEach(
      (v, k) => {
        low[k] = Math.min(low[k], v);
        high[k] = Math.max(high[k], v);
      },
    );
  const extent = high.map((v, k) => v - low[k]),
    { step, counts } = scanGrid(extent);
  const first = extent.map((e, k) => low[k] + (e - (counts[k] - 1) * step) / 2);
  const candidates: number[][] = [[0, 0, 0, 0, 0, 0]];
  for (let k = 0; k < counts[2]; k++)
    for (let j = 0; j < counts[1]; j++)
      for (let i = 0; i < counts[0]; i++)
        candidates.push([
          first[0] + i * step - center[0],
          first[1] + j * step - center[1],
          first[2] + k * step - center[2],
          0,
          0,
          0,
        ]);
  const ranked: { p: number[]; s: number }[] = [];
  for (const p of candidates) {
    const s = score(levels[0], p);
    yield;
    if (s <= 0) continue;
    // Earlier candidates win ties, so the starting matrix is kept when equal.
    const at = ranked.findIndex((r) => s > r.s);
    ranked.splice(at < 0 ? ranked.length : at, 0, { p, s });
    ranked.length = Math.min(ranked.length, TOP);
  }
  const scanned = evaluations;
  if (!ranked.length)
    throw new Error(
      "No position puts enough of the secondary inside the primary to register",
    );

  function* descend(
    level: Level,
    from: number[],
    {
      axes,
      step,
      turn,
      stop,
      evals,
    }: {
      axes: number;
      step: number;
      turn: number;
      stop: number;
      evals: number;
    },
  ): Generator<void, Found> {
    const end = Math.min(
      evaluations + evals,
      scanned + REGISTRATION_LIMITS.max_search_evaluations,
    );
    let p = from,
      best = score(level, p);
    yield;
    while (step >= stop && evaluations < end) {
      let moved = false;
      for (let i = 0; i < axes; i++)
        for (const sign of [1, -1]) {
          if (evaluations >= end) break;
          const q = p.slice();
          q[i] += sign * (i < 3 ? step : turn);
          if (i >= 3 && Math.abs(q[i]) > REGISTRATION_LIMITS.rotation_deg)
            continue;
          const s = score(level, q);
          yield;
          if (s > best + 1e-12) {
            best = s;
            p = q;
            moved = true;
          }
        }
      if (!moved) {
        step /= 2;
        turn /= 2;
      }
    }
    return { p, s: best };
  }
  let best: Found = { p: ranked[0].p, s: -1 };
  for (const candidate of ranked) {
    const refined = yield* descend(levels[0], candidate.p, LEVELS[0]);
    if (refined.s > best.s) best = refined;
  }
  // A compass search stops at the nearest optimum, and anatomy that is close
  // to symmetric about an axis has several. So the middle level is searched
  // from a spread of rotations, at the scan's position and at the starting
  // matrix: the coarsest level can lose detail the scan depends on, and the
  // operator's start must not be discarded on its word. Middle-level scores
  // cannot rank near-equal results reliably, so the finest level compares
  // the best distinct few.
  const seeds = [best.p.slice(0, 3)];
  if (Math.hypot(...seeds[0]) >= 1) seeds.push([0, 0, 0]);
  const found: Found[] = [];
  for (const seed of seeds)
    for (const rx of TURNS)
      for (const ry of TURNS)
        for (const rz of TURNS)
          found.push(
            yield* descend(levels[1], [...seed, rx, ry, rz], LEVELS[1]),
          );
  // Stable: the unturned start comes first among equal scores.
  found.sort((a, b) => b.s - a.s);
  const apart = (a: Found, b: Found) =>
    Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]) >= 1 ||
    [3, 4, 5].some((i) => Math.abs(a.p[i] - b.p[i]) >= 1);
  const kept: Found[] = [];
  for (const one of found)
    if (kept.length < KEEP && kept.every((other) => apart(one, other)))
      kept.push(one);
  best = { p: kept[0].p, s: -1 };
  for (const { p } of kept) {
    const s = score(levels[2], p);
    yield;
    if (s > best.s) best = { p, s };
  }
  best = yield* descend(levels[2], best.p, LEVELS[2]);

  const fine = levels[2],
    matrix = finish(pose(base, center, best.p)),
    final = similarity(fine, flat(matrix)),
    begun = similarity(fine, base),
    moved = apply(
      flat(matrix),
      corner(secondary, (n) => (n - 1) / 2),
    ),
    turned = compose(flat(matrix), invert(base)),
    cosine = Math.max(
      -1,
      Math.min(1, (turned[0] + turned[5] + turned[10] - 1) / 2),
    );
  // The searches only move toward a higher score, but positions that pass
  // the overlap floor on a coarser level can all fall under it here, where
  // the samples reach nearer the edges. Such a result has no score to show.
  if (final.overlap < REGISTRATION_LIMITS.min_overlap)
    throw new Error(
      "The best position found leaves too little of the secondary inside the primary to register",
    );
  return {
    method: REGISTRATION_METHOD,
    matrix,
    score: final.score,
    start_score: begun.score,
    start_overlap: begun.overlap,
    overlap: final.overlap,
    sample_mm: fine.block_mm,
    translation_mm: Math.hypot(
      moved[0] - center[0],
      moved[1] - center[1],
      moved[2] - center[2],
    ),
    rotation_deg: (Math.acos(cosine) * 180) / Math.PI,
    evaluations,
  };
}

/** Resumable registration. `start` is the rigid matrix the search begins
 * from; the turn about each primary RAS axis stays within
 * `REGISTRATION_LIMITS.rotation_deg` of it, translation is searched across
 * the whole primary volume. */
export function createRegistrationJob(
  primary: NVImage,
  secondary: NVImage,
  start: unknown,
): RegistrationJob {
  const steps = solve(primary, secondary, start);
  let done: RegistrationProposal | null = null,
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
 * drive `createRegistrationJob` in short slices instead. */
export function proposeRigidRegistration(
  primary: NVImage,
  secondary: NVImage,
  start: unknown,
): RegistrationProposal {
  const job = createRegistrationJob(primary, secondary, start);
  job.advance(() => false);
  return job.result();
}
