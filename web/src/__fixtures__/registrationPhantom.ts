/** Synthetic registration phantom: one analytic scene sampled on two grids
 * related by a known rigid transform. No patient data. */
import type { NVImage } from "@niivue/niivue";
import type { Vec3 } from "../obliqueSlice";

const segments: [Vec3, Vec3][] = [
  [
    [-20, -10, -15],
    [15, 20, 10],
  ],
  [
    [15, 20, 10],
    [30, -5, 25],
  ],
  [
    [-5, 5, 0],
    [-25, 25, 20],
  ],
];
function tubeDistance(p: Vec3, [a, b]: [Vec3, Vec3]) {
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
/** CT-like scene in primary RAS: air, a bright shell, soft tissue, three
 * enhanced tubes and one soft blob. Deliberately asymmetric. */
export function scene(p: Vec3): number {
  const r = Math.hypot(p[0] / 46, p[1] / 50, p[2] / 44);
  if (r >= 1) return -1000;
  if (r > 0.9) return 900;
  if (segments.some((s) => tubeDistance(p, s) < 2.5)) return 350;
  return (
    40 +
    200 *
      Math.exp(-((p[0] - 10) ** 2 + (p[1] + 20) ** 2 + (p[2] + 10) ** 2) / 128)
  );
}

export function makeVolume(
  n: number,
  affine: number[][],
  value: (ras: Vec3, index: number) => number,
): NVImage {
  const img = new Float32Array(n ** 3);
  for (let z = 0, at = 0; z < n; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++, at++)
        img[at] = value(
          affine
            .slice(0, 3)
            .map((r) => r[0] * x + r[1] * y + r[2] * z + r[3]) as Vec3,
          at,
        );
  return {
    hdr: {
      dims: [3, n, n, n, 1, 1, 1, 1],
      datatypeCode: 16,
      xyzt_units: 2,
      scl_slope: 1,
      scl_inter: 0,
    },
    getAffine: () => affine,
    img,
  } as unknown as NVImage;
}
const grid = (mm: number, origin: Vec3) => [
  [mm, 0, 0, origin[0]],
  [0, mm, 0, origin[1]],
  [0, 0, mm, origin[2]],
  [0, 0, 0, 1],
];

/** Rodrigues rotation about `axis` by `degrees`, turning about `pivot` and
 * landing the pivot on `target`: a 4×4 rigid matrix. */
export function rigidAbout(
  axis: Vec3,
  degrees: number,
  pivot: Vec3,
  target: Vec3,
): number[][] {
  const n = Math.hypot(...axis),
    [x, y, z] = axis.map((v) => v / n),
    c = Math.cos((degrees * Math.PI) / 180),
    s = Math.sin((degrees * Math.PI) / 180),
    r = [
      [c + x * x * (1 - c), x * y * (1 - c) - z * s, x * z * (1 - c) + y * s],
      [y * x * (1 - c) + z * s, c + y * y * (1 - c), y * z * (1 - c) - x * s],
      [z * x * (1 - c) - y * s, z * y * (1 - c) + x * s, c + z * z * (1 - c)],
    ];
  return [
    ...r.map((row, k) => [
      ...row,
      target[k] - (row[0] * pivot[0] + row[1] * pivot[1] + row[2] * pivot[2]),
    ]),
    [0, 0, 0, 1],
  ];
}
export const transform = (m: number[][], p: Vec3) =>
  m
    .slice(0, 3)
    .map((r) => r[0] * p[0] + r[1] * p[1] + r[2] * p[2] + r[3]) as Vec3;

/** Primary: 72³ at 1.5 mm. Secondary: 56³ at 1.2 mm in its own frame, with a
 * different contrast (inverted, nonlinear) and deterministic noise.
 * `truth` maps secondary RAS to primary RAS by construction. */
export function phantomPair(truth?: number[][]) {
  const secondaryAffine = grid(1.2, [-100, 50, 20]),
    center: Vec3 = [-67, 83, 53];
  const map = truth ?? rigidAbout([1, 2, -1], 14, center, [5, 4, 6]);
  let seed = 12345;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed / 2147483648 - 0.5) * 30;
  };
  return {
    truth: map,
    center,
    primary: makeVolume(72, grid(1.5, [-53.25, -53.25, -53.25]), scene),
    secondary: makeVolume(56, secondaryAffine, (q) => {
      const v = scene(transform(map, q));
      return 2000 - 0.9 * v + 60 * Math.sin(v / 90) + noise();
    }),
    /** The eight corners of the secondary volume, in secondary RAS. */
    corners: Array.from({ length: 8 }, (_, c) =>
      transform(secondaryAffine, [
        (c & 1) * 55,
        ((c >> 1) & 1) * 55,
        ((c >> 2) & 1) * 55,
      ]),
    ),
  };
}
