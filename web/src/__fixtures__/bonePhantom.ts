/** A bone phantom and a frame renderer made apart from the bone line-up
 * engine, for tests of what is built on it. Same construction as the
 * engine's own tests in ../boneLineup.test.ts. Synthetic only. */
import type { BoneFrameInput, BoneVolume } from "../boneLineup";
import { camera, project, type ViewNumbers } from "../carmGeometry";

const N = 48,
  MM = 2;
const AFFINE = [
  [MM, 0, 0, (-(N - 1) * MM) / 2],
  [0, MM, 0, (-(N - 1) * MM) / 2],
  [0, 0, MM, (-(N - 1) * MM) / 2],
  [0, 0, 0, 1],
];

/** Three stacked blocks, each with a pedicle bar, a spinous bar reaching
 * back and a transverse bar reaching to one side, so no mirror or turn maps
 * the shape onto itself and every turn moves something a frame can see;
 * soft tissue around them. */
export function phantom(): BoneVolume {
  const data = new Int16Array(N * N * N);
  const set = (
    x: [number, number],
    y: [number, number],
    z: [number, number],
    hu: number,
  ) => {
    for (let k = z[0]; k < z[1]; k++)
      for (let j = y[0]; j < y[1]; j++)
        for (let i = x[0]; i < x[1]; i++) data[i + N * (j + N * k)] = hu;
  };
  set([6, 42], [8, 40], [4, 44], 40);
  for (const [at, wide] of [
    [6, 9],
    [19, 8],
    [31, 10],
  ]) {
    set([24 - wide, 24 + wide], [22, 34], [at, at + 9], 700);
    set([24 - wide, 24 - wide + 4], [14, 22], [at + 2, at + 6], 900);
    set([22, 25], [9, 22], [at + 1, at + 4], 900);
    set([24 + wide, 24 + wide + 8], [25, 28], [at + 5, at + 8], 800);
  }
  return { data, shape: [N, N, N], affine: AFFINE };
}

export const view = (primary_deg: number): ViewNumbers => ({
  primary_deg,
  secondary_deg: 0,
  source_detector_mm: 1140,
  source_isocenter_mm: 745,
  detector_width_mm: 306,
  detector_height_mm: 306,
});

const rad = Math.PI / 180;
/** Volume RAS to C-arm RAS: turns about z then x, then a shift. */
export function rigid(
  z_deg: number,
  x_deg: number,
  shift: number[],
): number[][] {
  const cz = Math.cos(z_deg * rad),
    sz = Math.sin(z_deg * rad),
    cx = Math.cos(x_deg * rad),
    sx = Math.sin(x_deg * rad);
  const rz = [
      [cz, -sz, 0],
      [sz, cz, 0],
      [0, 0, 1],
    ],
    rx = [
      [1, 0, 0],
      [0, cx, -sx],
      [0, sx, cx],
    ];
  const r = rx.map((row) =>
    [0, 1, 2].map(
      (j) => row[0] * rz[0][j] + row[1] * rz[1][j] + row[2] * rz[2][j],
    ),
  );
  return [...r.map((row, i) => [...row, shift[i]]), [0, 0, 0, 1]];
}
export const move = (m: number[][], p: number[]) =>
  [0, 1, 2].map(
    (i) => m[i][0] * p[0] + m[i][1] * p[1] + m[i][2] * p[2] + m[i][3],
  );

/** A frame made apart from the engine: every voxel above air, soft tissue
 * included, dropped on the nearest pixel and weighted so that a pixel holds
 * the beam's path through the scan, then turned into what a detector
 * reads. */
export function render(
  volume: BoneVolume,
  pose: number[][],
  v: ViewNumbers,
  side = 256,
): BoneFrameInput {
  const [nx, ny, nz] = volume.shape,
    cam = camera(v, [0, 0, 0]),
    sum = new Float64Array(side * side);
  // Each voxel is spread over 27 points, so the picture has no grid in it.
  const parts = [-1 / 3, 0, 1 / 3];
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const hu = volume.data[i + nx * (j + ny * k)];
        if (hu <= 0) continue;
        for (const c of parts)
          for (const b of parts)
            for (const a of parts) {
              const world = move(
                pose,
                move(volume.affine, [i + a, j + b, k + c]),
              );
              const [x, y, depth] = project(cam, world);
              const px = Math.round(
                  (x / v.detector_width_mm + 0.5) * side - 0.5,
                ),
                py = Math.round((0.5 - y / v.detector_height_mm) * side - 0.5);
              if (px >= 0 && px < side && py >= 0 && py < side)
                sum[py * side + px] += (hu / 27) * (depth / 745) ** 2;
            }
      }
  const pixels = new Uint16Array(side * side);
  for (let i = 0; i < sum.length; i++) {
    pixels[i] = 60000 * Math.exp(-sum[i] / 9000);
  }
  return { view: v, isocenter: [0, 0, 0], pixels, width: side, height: side };
}

const TARGETS = [-30, 0, 30].flatMap((x) =>
  [-30, 0, 30].flatMap((y) => [-30, 0, 30].map((z) => [x, y, z])),
);
/** Mean distance between where two poses put the targets; with `beam`, only
 * the part across that direction. */
export function apart(a: number[][], b: number[][], beam?: readonly number[]) {
  let sum = 0;
  for (const t of TARGETS) {
    const p = move(a, t),
      q = move(b, t),
      d = [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
    if (beam) {
      const along = d[0] * beam[0] + d[1] * beam[1] + d[2] * beam[2];
      for (let i = 0; i < 3; i++) d[i] -= along * beam[i];
    }
    sum += Math.hypot(...d);
  }
  return sum / TARGETS.length;
}
export const IDENTITY = rigid(0, 0, [0, 0, 0]);
export const TRUE = rigid(4, 3, [6, -4, 10]);

/** A scan far longer than a frame shows: 480 mm of blocks, no two alike. */
export function longSpine(): BoneVolume {
  const nz = 240,
    data = new Int16Array(N * N * nz);
  const set = (x: number[], y: number[], z: number[], hu: number) => {
    for (let k = z[0]; k < z[1]; k++)
      for (let j = y[0]; j < y[1]; j++)
        for (let i = x[0]; i < x[1]; i++) data[i + N * (j + N * k)] = hu;
  };
  for (let at = 4, n = 0; at + 12 < nz; n++) {
    const wide = 7 + ((n * 5) % 4),
      tall = 8 + ((n * 3) % 4);
    set([24 - wide, 24 + wide], [22, 34], [at, at + tall], 700);
    set([24 - wide, 24 - wide + 4], [14, 22], [at + 2, at + 6], 900);
    set([22, 25], [9, 22], [at + 1, at + 4], 900);
    if (n % 2) set([24 + wide, 24 + wide + 8], [25, 28], [at + 5, at + 8], 800);
    at += tall + 3 + (n % 3);
  }
  return {
    data,
    shape: [N, N, nz],
    affine: [
      [MM, 0, 0, (-(N - 1) * MM) / 2],
      [0, MM, 0, (-(N - 1) * MM) / 2],
      [0, 0, MM, (-(nz - 1) * MM) / 2],
      [0, 0, 0, 1],
    ],
  };
}
