/** Bounded pure native-volume CPR and parallel-transport frame core. */
import type { NVImage } from "@niivue/niivue";
import type { Vec3 } from "./obliqueSlice";
import { createNativeSampler } from "./nativeSampling";

export interface PathFrame {
  point: Vec3;
  tangent: Vec3;
  u: Vec3;
  v: Vec3;
  s_mm: number;
}

const finite = (v: number) => Number.isFinite(v);
const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalized = (a: Vec3, what: string): Vec3 => {
  const n = norm(a);
  if (!finite(n) || n < 1e-12) throw new Error(`Degenerate ${what}`);
  return [a[0] / n, a[1] / n, a[2] / n];
};

function validatePath(path: Vec3[]) {
  if (
    !Array.isArray(path) ||
    path.length < 2 ||
    path.length > 128 ||
    path.some((p) => !Array.isArray(p) || p.length !== 3 || !p.every(finite))
  )
    throw new Error("Path must be 2..128 finite RAS points");
  for (let i = 1; i < path.length; i++) {
    const d: Vec3 = [
      path[i][0] - path[i - 1][0],
      path[i][1] - path[i - 1][1],
      path[i][2] - path[i - 1][2],
    ];
    if (norm(d) <= 1e-8)
      throw new Error("Path has consecutive duplicate points");
  }
  let length = 0;
  for (let i = 1; i < path.length; i++)
    length += norm([
      path[i][0] - path[i - 1][0],
      path[i][1] - path[i - 1][1],
      path[i][2] - path[i - 1][2],
    ]);
  if (!finite(length) || length > 10000)
    throw new Error("Path length must be finite and <= 10000mm");
  return length;
}

function validateStations(stations: number) {
  if (!Number.isInteger(stations) || stations < 2 || stations > 256)
    throw new Error("stations must be an integer in 2..256");
}

function validateRoll(rollDegrees: number) {
  if (!finite(rollDegrees) || Math.abs(rollDegrees) > 180)
    throw new Error("rollDegrees must be finite and within ±180");
}

interface Segments {
  cum: number[]; // cumulative length at each vertex
  dirs: Vec3[]; // normalized segment directions
  total: number;
}

function segments(path: Vec3[]): Segments {
  const cum = [0];
  const dirs: Vec3[] = [];
  for (let i = 1; i < path.length; i++) {
    const d: Vec3 = [
      path[i][0] - path[i - 1][0],
      path[i][1] - path[i - 1][1],
      path[i][2] - path[i - 1][2],
    ];
    cum.push(cum[i - 1] + norm(d));
    dirs.push(normalized(d, "path segment"));
  }
  return { cum, dirs, total: cum[cum.length - 1] };
}

function atArc(
  path: Vec3[],
  seg: Segments,
  s: number,
): { point: Vec3; tangent: Vec3; index: number } {
  // Polygonal arc-length interpolation; locate the containing segment.
  let lo = 0,
    hi = seg.dirs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (seg.cum[mid + 1] < s) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.min(lo, seg.dirs.length - 1);
  const t = s - seg.cum[i];
  return {
    point: [
      path[i][0] + seg.dirs[i][0] * t,
      path[i][1] + seg.dirs[i][1] * t,
      path[i][2] + seg.dirs[i][2] * t,
    ],
    tangent: seg.dirs[i],
    index: i,
  };
}

/** Rotate u by the exact rigid rotation taking ta to tb (parallel transport step). */
function transport(u: Vec3, ta: Vec3, tb: Vec3): Vec3 {
  const d = Math.max(-1, Math.min(1, dot(ta, tb)));
  if (d > 1 - 1e-12) return u; // same tangent
  const axis = cross(ta, tb);
  const sinA = norm(axis);
  if (sinA < 1e-12)
    throw new Error("Unresolved tangent reversal in path; refusing frames");
  const k = 1 / sinA;
  const a: Vec3 = [axis[0] * k, axis[1] * k, axis[2] * k];
  const theta = Math.acos(d);
  const cosT = Math.cos(theta),
    sinT = Math.sin(theta);
  const aDotU = dot(a, u);
  return normalized(
    [
      u[0] * cosT + cross(a, u)[0] * sinT + a[0] * aDotU * (1 - cosT),
      u[1] * cosT + cross(a, u)[1] * sinT + a[1] * aDotU * (1 - cosT),
      u[2] * cosT + cross(a, u)[2] * sinT + a[2] * aDotU * (1 - cosT),
    ],
    "transported frame vector",
  );
}

function initialU(t: Vec3): Vec3 {
  // Deterministic: reference axis least parallel to the tangent.
  const axes: Vec3[] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  let best = axes[0],
    bestAbs = Infinity;
  for (const e of axes) {
    const abs = Math.abs(dot(e, t));
    if (abs < bestAbs - 1e-15) {
      bestAbs = abs;
      best = e;
    }
  }
  return normalized(
    [
      best[0] - dot(best, t) * t[0],
      best[1] - dot(best, t) * t[1],
      best[2] - dot(best, t) * t[2],
    ],
    "initial frame vector",
  );
}

function rollFrame(t: Vec3, u: Vec3, rollDegrees: number): Vec3 {
  if (rollDegrees === 0) return u;
  const a = (rollDegrees * Math.PI) / 180;
  const cosT = Math.cos(a),
    sinT = Math.sin(a);
  return [
    u[0] * cosT + cross(t, u)[0] * sinT,
    u[1] * cosT + cross(t, u)[1] * sinT,
    u[2] * cosT + cross(t, u)[2] * sinT,
  ];
}

/**
 * Parallel-transport chain across EVERY original segment, from the anchored
 * initial frame at s=0. Built once and shared by buildPathFrames and
 * pointAlongPath so arbitrary stations and raster frames use the identical
 * chain; applying it to every segment also rejects reversals hidden between
 * coarse stations. Roll is applied afterwards, exactly once per output frame.
 */
function transportChain(seg: Segments): Vec3[] {
  const us: Vec3[] = [initialU(seg.dirs[0])];
  for (let i = 1; i < seg.dirs.length; i++)
    us.push(transport(us[i - 1], seg.dirs[i - 1], seg.dirs[i]));
  return us;
}

function frameAt(
  path: Vec3[],
  seg: Segments,
  chain: Vec3[],
  s: number,
  rollDegrees: number,
): PathFrame {
  const { point, tangent, index } = atArc(path, seg, s);
  const u = rollFrame(tangent, chain[index], rollDegrees);
  const v = cross(tangent, u);
  return { point, tangent, u, v: normalized(v, "frame v"), s_mm: s };
}

export function buildPathFrames(
  path: Vec3[],
  stations = 128,
  rollDegrees = 0,
): { frames: PathFrame[]; length_mm: number } {
  const length_mm = validatePath(path);
  validateStations(stations);
  validateRoll(rollDegrees);
  const seg = segments(path);
  const chain = transportChain(seg);
  const frames: PathFrame[] = [];
  for (let i = 0; i < stations; i++) {
    const s = ((i + 0.5) / stations) * length_mm;
    frames.push(frameAt(path, seg, chain, s, rollDegrees));
  }
  return { frames, length_mm };
}

export function pointAlongPath(
  path: Vec3[],
  s_mm: number,
  rollDegrees = 0,
): PathFrame {
  const length_mm = validatePath(path);
  validateRoll(rollDegrees);
  if (!finite(s_mm) || s_mm < -1e-9 || s_mm > length_mm + 1e-9)
    throw new Error("s_mm outside path arc-length extent");
  const seg = segments(path);
  const chain = transportChain(seg);
  return frameAt(
    path,
    seg,
    chain,
    Math.max(0, Math.min(length_mm, s_mm)),
    rollDegrees,
  );
}

export interface CprOptions {
  mode: "stretched" | "straightened";
  width_px: number;
  height_px: number;
  span_mm: number;
  roll_degrees: number;
  window: [number, number];
}

export function sampleCPR(
  volume: NVImage,
  path: Vec3[],
  options: CprOptions,
): {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  outside: number;
  length_mm: number;
} {
  const {
    mode,
    width_px: width,
    height_px: height,
    span_mm: span,
    roll_degrees: roll,
    window,
  } = options;
  if (mode !== "stretched" && mode !== "straightened")
    throw new Error("mode must be 'stretched' or 'straightened'");
  if (!Number.isInteger(width) || width < 2 || width > 256)
    throw new Error("width_px must be an integer in 2..256");
  if (!Number.isInteger(height) || height < 2 || height > 128)
    throw new Error("height_px must be an integer in 2..128");
  if (!finite(span) || span <= 0 || span > 200)
    throw new Error("span_mm must be > 0 and <= 200");
  validateRoll(roll);
  if (
    !Array.isArray(window) ||
    window.length !== 2 ||
    !window.every(finite) ||
    window[0] >= window[1]
  )
    throw new Error("window must be two finite numbers with lo < hi");
  const { frames, length_mm } = buildPathFrames(path, width, roll);
  const sampler = createNativeSampler(volume);
  // Stretched = ruled CPR along the fixed initial (rolled) transverse direction.
  const fixedU = pointAlongPath(path, 0, roll).u;
  const rgba = new Uint8ClampedArray(4 * width * height);
  const [lo, hi] = window;
  const scale = 255 / (hi - lo);
  let outside = 0;
  for (let j = 0; j < height; j++) {
    const off = ((j + 0.5) / height - 0.5) * span;
    for (let i = 0; i < width; i++) {
      const f = frames[i];
      const u = mode === "straightened" ? f.u : fixedU;
      const p: Vec3 = [
        f.point[0] + off * u[0],
        f.point[1] + off * u[1],
        f.point[2] + off * u[2],
      ];
      const value = sampler.sample(p);
      const k = (j * width + i) * 4;
      if (value === null) {
        outside++;
        continue; // alpha stays 0: transparent, no fabricated samples
      }
      const g = Math.max(0, Math.min(255, (value - lo) * scale));
      rgba[k] = g;
      rgba[k + 1] = g;
      rgba[k + 2] = g;
      rgba[k + 3] = 255;
    }
  }
  return { width, height, rgba, outside, length_mm };
}
