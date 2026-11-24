/** A synthetic coronary cine with a known answer: three dark branches on a
 * textured background, squeezed and turned with each beat about a centre,
 * moved slowly by breathing, with contrast coming in and washing out. Not
 * anatomy; the truth of every point at every frame is known. */
import type { CineFrame, TreeBranch } from "../coronaryMotion";

export const CINE = {
  size: 256,
  frames: 48,
  frame_ms: 1000 / 15,
  period_ms: 800,
  centre: [128, 128],
} as const;

/** The branches at rest, as the operator would draw them. */
export const DRAWN: TreeBranch[] = [
  {
    id: "lad",
    points: Array.from({ length: 30 }, (_, i) => [
      70 + 4 * i,
      60 + 2.2 * i + 10 * Math.sin(i / 5),
    ]),
  },
  {
    id: "lcx",
    points: Array.from({ length: 24 }, (_, i) => [
      70 + 1.5 * i + 6 * Math.sin(i / 4),
      60 + 5 * i,
    ]),
  },
  {
    id: "diagonal",
    points: Array.from({ length: 16 }, (_, i) => [130 + 3 * i, 92 + 4 * i]),
  },
];

/** Where a drawn point lies at time `t`. */
export function moveAt(t_ms: number, p: readonly number[]): number[] {
  const beat = (1 - Math.cos((2 * Math.PI * t_ms) / CINE.period_ms)) / 2,
    squeeze = 1 - 0.12 * beat,
    turn = ((6 * Math.PI) / 180) * beat,
    breath = 5 * Math.sin((2 * Math.PI * t_ms) / 4000);
  const [cx, cy] = CINE.centre,
    dx = p[0] - cx,
    dy = p[1] - cy;
  return [
    cx + squeeze * (Math.cos(turn) * dx - Math.sin(turn) * dy),
    cy + squeeze * (Math.sin(turn) * dx + Math.cos(turn) * dy) + breath,
  ];
}

/** Contrast of the vessels in frame `k`, 0 to 1. */
export function contrastAt(k: number, washout: number[] = []): number {
  return washout.includes(k) ? 0 : 1;
}

export function renderCine(options: { washout?: number[] } = {}): {
  frames: CineFrame[];
  truth: TreeBranch[][];
} {
  const { size } = CINE;
  // Fixed texture: soft blobs that do not move, as bone and lung shading.
  let seed = 11;
  const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const blobs = Array.from({ length: 40 }, () => [
    random() * size,
    random() * size,
    8 + random() * 30,
    (random() - 0.5) * 40,
  ]);
  const background = new Float64Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let v = 160;
      for (const [bx, by, r, a] of blobs)
        v += a * Math.exp(-((x - bx) ** 2 + (y - by) ** 2) / (2 * r * r));
      background[y * size + x] = v;
    }
  const frames: CineFrame[] = [],
    truth: TreeBranch[][] = [];
  for (let k = 0; k < CINE.frames; k++) {
    const t = k * CINE.frame_ms;
    const moved = DRAWN.map((b) => ({
      id: b.id,
      points: b.points.map((p) => moveAt(t, p)),
    }));
    truth.push(moved);
    const pixels = new Float64Array(background);
    const depth = 70 * contrastAt(k, options.washout);
    if (depth > 0)
      for (const branch of moved) {
        // Densely along each branch, a dark disc of radius 2.5 pixels.
        const pts = branch.points;
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
                const v = depth * Math.max(0, Math.min(1, 3 - d));
                const at = py * size + px;
                // Darkest of the overlapping samples.
                pixels[at] = Math.min(pixels[at], background[at] - v);
              }
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
  return { frames, truth };
}
