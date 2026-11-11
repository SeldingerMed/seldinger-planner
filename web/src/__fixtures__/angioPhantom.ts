/** Synthetic angiography phantom: an analytic vessel tree, its binary mask on
 * a millimeter grid, and a frame rendered from the tree at a known pose.
 * No patient data.
 *
 * The frame is drawn by splatting points sampled inside the analytic tubes
 * through the Step A reference `camera` and `project`, so it shares no code
 * with the registration search it is used to test. */
import { camera, project, type ViewNumbers } from "../carmGeometry";
import { detectorToPixel } from "../carmProjection";
import type { Vec3 } from "../obliqueSlice";

export type Tube = { path: Vec3[]; radius: number };
export const TREE: Tube[] = [
  {
    path: [
      [0, -5, -35],
      [2, 0, -10],
      [-4, 8, 0],
      [0, 2, 10],
    ],
    radius: 2.5,
  },
  {
    path: [
      [0, 2, 10],
      [20, 6, 14],
      [34, 0, 22],
    ],
    radius: 1.8,
  },
  {
    path: [
      [0, 2, 10],
      [-6, 14, 22],
      [-4, 26, 30],
    ],
    radius: 1.5,
  },
  {
    path: [
      [20, 6, 14],
      [26, 18, 8],
    ],
    radius: 1.2,
  },
];

function segmentDistance(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
    ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]],
    t = Math.max(
      0,
      Math.min(
        1,
        (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) /
          (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2),
      ),
    );
  return Math.hypot(ap[0] - t * ab[0], ap[1] - t * ab[1], ap[2] - t * ab[2]);
}
export function insideTree(p: Vec3, tree: Tube[] = TREE): boolean {
  return tree.some(({ path, radius }) =>
    path.slice(1).some((b, i) => segmentDistance(p, path[i], b) < radius),
  );
}

/** Binary mask of the tree on an axis-aligned grid with `spacing` mm voxels. */
export function treeMask(spacing = 1, tree: Tube[] = TREE) {
  const origin: Vec3 = [-32, -28, -45],
    shape: [number, number, number] = [
      Math.round(84 / spacing),
      Math.round(72 / spacing),
      Math.round(92 / spacing),
    ];
  const affine = [
    [spacing, 0, 0, origin[0]],
    [0, spacing, 0, origin[1]],
    [0, 0, spacing, origin[2]],
    [0, 0, 0, 1],
  ];
  const mask = new Uint8Array(shape[0] * shape[1] * shape[2]);
  for (let z = 0, at = 0; z < shape[2]; z++)
    for (let y = 0; y < shape[1]; y++)
      for (let x = 0; x < shape[0]; x++, at++)
        if (
          insideTree(
            [
              origin[0] + spacing * x,
              origin[1] + spacing * y,
              origin[2] + spacing * z,
            ],
            tree,
          )
        )
          mask[at] = 1;
  return { mask, shape, affine };
}

/** Rigid matrix: rotate by fixed-axis x, y, z degrees about `pivot`, then
 * translate. */
export function rigid(
  degrees: Vec3,
  translation: Vec3,
  pivot: Vec3 = [0, 0, 0],
): number[][] {
  const [a, b, c] = degrees.map((value) => (value * Math.PI) / 180),
    ca = Math.cos(a),
    sa = Math.sin(a),
    cb = Math.cos(b),
    sb = Math.sin(b),
    cc = Math.cos(c),
    sc = Math.sin(c);
  const r = [
    [cc * cb, cc * sb * sa - sc * ca, cc * sb * ca + sc * sa],
    [sc * cb, sc * sb * sa + cc * ca, sc * sb * ca - cc * sa],
    [-sb, cb * sa, cb * ca],
  ];
  return [
    ...r.map((row, i) => [
      ...row,
      pivot[i] +
        translation[i] -
        (row[0] * pivot[0] + row[1] * pivot[1] + row[2] * pivot[2]),
    ]),
    [0, 0, 0, 1],
  ];
}
export const applyRigid = (m: number[][], p: Vec3): Vec3 =>
  [0, 1, 2].map(
    (i) => m[i][0] * p[0] + m[i][1] * p[1] + m[i][2] * p[2] + m[i][3],
  ) as Vec3;

/** Deterministic noise in [0, 1). */
function lcg(seed: number) {
  let state = seed >>> 0;
  return () =>
    (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

export type FrameOptions = {
  width: number;
  height: number;
  /** "dark": vessels darker than the background, as in a subtracted run
   * displayed white-on-black inverted; "bright": the opposite. */
  polarity: "dark" | "bright";
  noise: number;
  seed: number;
  tree?: Tube[];
};

/** 8-bit frame of the tree placed by `pose` (volume RAS to C-arm RAS). */
export function renderFrame(
  view: ViewNumbers,
  isocenter: Vec3,
  pose: number[][],
  options: FrameOptions,
): Uint8Array {
  const { width, height } = options,
    cam = camera(view, isocenter),
    sums = new Float32Array(width * height);
  const step = 0.3;
  for (const { path, radius } of options.tree ?? TREE)
    for (let s = 1; s < path.length; s++) {
      const a = path[s - 1],
        b = path[s],
        axis = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
        length = Math.hypot(...axis),
        t = axis.map((value) => value / length);
      // Two unit vectors orthogonal to the segment.
      const seedAxis = Math.abs(t[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0],
        e1raw = [
          t[1] * seedAxis[2] - t[2] * seedAxis[1],
          t[2] * seedAxis[0] - t[0] * seedAxis[2],
          t[0] * seedAxis[1] - t[1] * seedAxis[0],
        ],
        n1 = Math.hypot(...e1raw),
        e1 = e1raw.map((value) => value / n1),
        e2 = [
          t[1] * e1[2] - t[2] * e1[1],
          t[2] * e1[0] - t[0] * e1[2],
          t[0] * e1[1] - t[1] * e1[0],
        ];
      for (let along = 0; along <= length; along += step)
        for (let i = -radius; i <= radius; i += step)
          for (let j = -radius; j <= radius; j += step) {
            if (i * i + j * j > radius * radius) continue;
            const p = applyRigid(pose, [
              a[0] + t[0] * along + e1[0] * i + e2[0] * j,
              a[1] + t[1] * along + e1[1] * i + e2[1] * j,
              a[2] + t[2] * along + e1[2] * i + e2[2] * j,
            ]);
            const [x, y] = project(cam, p),
              [px, py] = detectorToPixel(view, { width, height }, x, y),
              col = Math.floor(px),
              row = Math.floor(py);
            if (col >= 0 && row >= 0 && col < width && row < height)
              sums[row * width + col] += 1;
          }
    }
  const random = lcg(options.seed),
    out = new Uint8Array(width * height);
  let peak = 0;
  for (const value of sums) if (value > peak) peak = value;
  for (let row = 0, at = 0; row < height; row++)
    for (let col = 0; col < width; col++, at++) {
      // Smooth background ramp, contrast proportional to path length.
      const background = 150 + 30 * (col / width) + 20 * (row / height),
        contrast = (110 * sums[at]) / (peak || 1),
        noise = options.noise * (random() - 0.5),
        dark = background - contrast + noise,
        value = options.polarity === "dark" ? dark : 255 - dark;
      out[at] = Math.max(0, Math.min(255, Math.round(value)));
    }
  return out;
}
