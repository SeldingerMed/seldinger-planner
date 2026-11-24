/** A synthetic coronary CT tree and the cine of the same synthetic heart,
 * with a known answer for the CT-to-cine correspondence.
 *
 * The tree is in CT millimeters (RAS) at the CT's own cardiac phase. Over
 * the cine the heart squeezes toward its centre and twists about its long
 * axis on a beat with a fast systole, rapid filling, a quiet diastasis and
 * an atrial kick; breathing moves it slowly. The tree is carried into the
 * C-arm's axes by a table offset the engine is not told, projected through
 * a pinhole C-arm, and drawn dark on a textured background.
 *
 * Not anatomy and not an X-ray simulation: a tracer with known truth for
 * every branch point in every frame. */
import { camera, project, type ViewNumbers } from "../carmGeometry";
import { detectorToPixel } from "../carmProjection";
import type { CineFrame } from "../coronaryMotion";
import type { Vec3 } from "../obliqueSlice";

export const CT_CINE = {
  size: 256,
  frames: 64,
  frame_ms: 1000 / 15,
  period_ms: 860,
  /** Phase of the first frame, share of the beat after the R wave. */
  start_phase: 0.1,
  /** Phase the CT was reconstructed at, percent of the R-R interval. */
  ct_phase_percent: 75,
  view: {
    primary_deg: 30,
    secondary_deg: 20,
    source_detector_mm: 1000,
    source_isocenter_mm: 750,
    detector_width_mm: 204.8,
    detector_height_mm: 204.8,
  } as ViewNumbers,
  pixel_spacing_mm: 0.8,
  /** CT RAS to C-arm RAS: a turn (degrees about x, y, z) and a shift. */
  table: { turn_deg: [3, -2, 4], shift_mm: [8, -6, 10] },
} as const;

export type CtBranch = {
  id: string;
  label: string;
  parent: string | null;
  path_ras: number[][];
};

const smooth = (n: number, f: (s: number) => number[]) =>
  Array.from({ length: n }, (_, i) => f(i / (n - 1)));

/** The tree at the CT's phase, CT RAS millimeters, its centre near 0. */
export function ctTree(): CtBranch[] {
  const lm = smooth(8, (s) => [-20 + 10 * s, 10 + 4 * s, 30 - 2 * s]);
  const lmEnd = lm[lm.length - 1];
  const lad = smooth(40, (s) => [
    lmEnd[0] + 25 * s + 6 * Math.sin(3 * s),
    lmEnd[1] + 12 * s,
    lmEnd[2] - 75 * s,
  ]);
  const lcx = smooth(30, (s) => [
    lmEnd[0] + 4 * s,
    lmEnd[1] - 35 * s,
    lmEnd[2] - 10 * s - 25 * s * s,
  ]);
  const ladAt = lad[14];
  const d1 = smooth(20, (s) => [
    ladAt[0] + 22 * s,
    ladAt[1] - 6 * s,
    ladAt[2] - 30 * s,
  ]);
  const lcxAt = lcx[16];
  const om1 = smooth(18, (s) => [
    lcxAt[0] + 18 * s,
    lcxAt[1] - 8 * s,
    lcxAt[2] - 26 * s,
  ]);
  return [
    { id: "lm", label: "left main", parent: null, path_ras: lm },
    { id: "lad", label: "LAD", parent: "lm", path_ras: lad },
    { id: "lcx", label: "circumflex", parent: "lm", path_ras: lcx },
    { id: "d1", label: "first diagonal", parent: "lad", path_ras: d1 },
    { id: "om1", label: "first obtuse marginal", parent: "lcx", path_ras: om1 },
  ];
}

/** Contraction over the beat, 0 at end-diastole (the R wave) and 1 at
 * end-systole: a fast systole, rapid filling, a quiet diastasis from about
 * 55 to 85 percent, and the atrial kick. */
export function squeezeAt(phase: number): number {
  const p = ((phase % 1) + 1) % 1;
  if (p < 0.35) return Math.sin((Math.PI / 2) * (p / 0.35)) ** 2;
  if (p < 0.55) {
    const s = (p - 0.35) / 0.2;
    return 1 - 0.9 * (0.5 - 0.5 * Math.cos(Math.PI * s));
  }
  if (p < 0.85) return 0.1 - 0.02 * ((p - 0.55) / 0.3);
  const s = (p - 0.85) / 0.15;
  // The atrial kick, then back to end-diastole.
  return 0.08 * (1 - s) + 0.06 * Math.sin(Math.PI * s);
}

export const phaseAt = (t_ms: number) =>
  CT_CINE.start_phase + t_ms / CT_CINE.period_ms;

const rotate = (p: number[], deg: readonly number[]): number[] => {
  const [a, b, c] = deg.map((d) => (d * Math.PI) / 180);
  let [x, y, z] = p;
  [y, z] = [Math.cos(a) * y - Math.sin(a) * z, Math.sin(a) * y + Math.cos(a) * z];
  [x, z] = [Math.cos(b) * x + Math.sin(b) * z, -Math.sin(b) * x + Math.cos(b) * z];
  [x, y] = [Math.cos(c) * x - Math.sin(c) * y, Math.sin(c) * x + Math.cos(c) * y];
  return [x, y, z];
};

/** Where a CT point lies at time `t`, still in CT axes: squeezed toward the
 * heart's centre and twisted about its long axis by the beat, relative to
 * the CT's phase, and moved by breathing. */
export function heartAt(t_ms: number, p: readonly number[]): number[] {
  const ct = squeezeAt(CT_CINE.ct_phase_percent / 100),
    now = squeezeAt(phaseAt(t_ms)),
    s = now - ct;
  const centre = [0, 0, -10],
    k = 1 - 0.14 * s,
    twist = ((9 * Math.PI) / 180) * s;
  const d = [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]];
  const x = Math.cos(twist) * d[0] - Math.sin(twist) * d[1],
    y = Math.sin(twist) * d[0] + Math.cos(twist) * d[1];
  const breath = 6 * Math.sin((2 * Math.PI * t_ms) / 4200);
  return [centre[0] + k * x, centre[1] + k * y, centre[2] + k * d[2] + breath];
}

/** CT RAS to C-arm RAS, the table offset the engine does not know. */
export function toCarm(p: readonly number[]): number[] {
  const q = rotate([...p], CT_CINE.table.turn_deg);
  return q.map((v, i) => v + CT_CINE.table.shift_mm[i]);
}

const CAMERA = camera(CT_CINE.view, [0, 0, 0]);

/** A C-arm point in frame pixels, x right, y down. */
export function toPixel(p: readonly number[]): number[] {
  const [x, y] = project(CAMERA, p as Vec3);
  return detectorToPixel(
    CT_CINE.view,
    { width: CT_CINE.size, height: CT_CINE.size },
    x,
    y,
  );
}

/** A small hash-based generator (mulberry32). A plain linear congruence
 * repeats its high bits at power-of-two strides, which would make the
 * noise of every frame alike and lend the cine a false rhythm. */
export function noise(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

export type CineOptions = {
  /** Branches left out of the cine (not filled, or not this patient's). */
  omit?: string[];
  /** Branches drawn shifted in the frame by this many pixels. */
  shift?: Record<string, [number, number]>;
  /** Extra vessels drawn like a branch, shifted by this many pixels. */
  decoys?: { like: string; offset_px: [number, number] }[];
  /** Frames with no contrast. */
  washout?: number[];
  /** Frames with every vessel held still at the first frame's place. */
  still?: boolean;
  frames?: number;
  /** Another tree in place of `ctTree()`. */
  tree?: CtBranch[];
};

export function renderCtCine(options: CineOptions = {}): {
  frames: CineFrame[];
  /** Per frame, per branch id, the true pixel place of every CT point. */
  truth: Record<string, number[][]>[];
  /** Per frame, its phase in the beat, 0 to 1 after the R wave. */
  phases: number[];
} {
  const { size } = CT_CINE,
    count = options.frames ?? CT_CINE.frames;
  const random = noise(7);
  const blobs = Array.from({ length: 40 }, () => [
    random() * size,
    random() * size,
    8 + random() * 30,
    (random() - 0.5) * 40,
  ]);
  const background = new Float64Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let v = 165;
      for (const [bx, by, r, a] of blobs)
        v += a * Math.exp(-((x - bx) ** 2 + (y - by) ** 2) / (2 * r * r));
      background[y * size + x] = v;
    }
  const tree = options.tree ?? ctTree();
  const frames: CineFrame[] = [],
    truth: Record<string, number[][]>[] = [],
    phases: number[] = [];
  for (let k = 0; k < count; k++) {
    const t = k * CT_CINE.frame_ms,
      at = options.still ? 0 : t;
    phases.push(((phaseAt(t) % 1) + 1) % 1);
    const placed: Record<string, number[][]> = {};
    for (const b of tree)
      placed[b.id] = b.path_ras.map((p) => toPixel(toCarm(heartAt(at, p))));
    truth.push(placed);
    const drawn: number[][][] = [];
    for (const b of tree) {
      if (options.omit?.includes(b.id)) continue;
      const [dx, dy] = options.shift?.[b.id] ?? [0, 0];
      drawn.push(placed[b.id].map(([x, y]) => [x + dx, y + dy]));
    }
    for (const decoy of options.decoys ?? []) {
      const [dx, dy] = decoy.offset_px;
      drawn.push(placed[decoy.like].map(([x, y]) => [x + dx, y + dy]));
    }
    const pixels = new Float64Array(background);
    const depth = options.washout?.includes(k) ? 0 : 70;
    if (depth > 0)
      for (const pts of drawn)
        for (let i = 1; i < pts.length; i++)
          for (let s = 0; s <= 1; s += 0.1) {
            const x = pts[i - 1][0] + s * (pts[i][0] - pts[i - 1][0]),
              y = pts[i - 1][1] + s * (pts[i][1] - pts[i - 1][1]);
            for (let j = -4; j <= 4; j++)
              for (let q = -4; q <= 4; q++) {
                const px = Math.round(x) + q,
                  py = Math.round(y) + j;
                if (px < 0 || py < 0 || px >= size || py >= size) continue;
                const d = Math.hypot(px - x, py - y);
                const v = depth * Math.max(0, Math.min(1, 2.5 - d));
                const idx = py * size + px;
                pixels[idx] = Math.min(pixels[idx], background[idx] - v);
              }
          }
    const out = new Uint8Array(size * size);
    for (let i = 0; i < out.length; i++)
      out[i] = Math.max(
        0,
        Math.min(255, Math.round(pixels[i] + (random() - 0.5) * 6)),
      );
    frames.push({ pixels: out, width: size, height: size, time_ms: t });
  }
  return { frames, truth, phases };
}
