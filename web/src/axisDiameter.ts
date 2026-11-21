/** The diameter of the vessel mask at each sample of its axis.
 *
 * At a sample the mask is cut by a thin slab across the axis. The diameter
 * is that of the circle with the area of the cut: the volume of mask in the
 * slab over the slab's thickness. Counting volume keeps the answer steady
 * on a grid whose voxels are a good part of a vessel's width. */
import { spacingOf } from "./maskPoints";
import type { VesselSegments } from "./vesselSegments";

export const AXIS_DIAMETER_METHOD = "mask_slab_area_v1";
export const AXIS_DIAMETER_LIMITS = {
  /** Half the slab's thickness; one voxel on a coarser grid. */
  half_slab_mm: 1,
  /** Mask farther from the axis than this many mean radii of the sample's
   * segment, plus `margin_mm`, is another vessel's. */
  reach_radii: 2,
  margin_mm: 1.5,
  /** Samples between yields of `axisDiameterSteps`. */
  slice: 64,
} as const;

/** Millimeters at each axis sample, NaN at a sample with no neighbor on its
 * run to give the axis a direction. Yields between slices of samples. */
export function* axisDiameterSteps(
  mask: Uint8Array,
  shape: readonly [number, number, number],
  affine: number[][],
  segments: VesselSegments,
): Generator<void, Float32Array> {
  const L = AXIS_DIAMETER_LIMITS,
    [nx, ny, nz] = shape,
    spacing = spacingOf(affine),
    { points, labels } = segments,
    count = labels.length;
  if (
    ![nx, ny, nz].every((n) => Number.isInteger(n) && n > 0) ||
    mask.length !== nx * ny * nz
  )
    throw new Error("Invalid vessel mask");
  if (points.length !== 3 * count) throw new Error("Invalid vessel segments");
  const a = affine,
    det =
      a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
      a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
      a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  // Inverse of the affine's 3 by 3 part. `spacingOf` has refused a grid
  // whose axes are not at right angles, so the determinant is not zero.
  const inv = [
    [
      (a[1][1] * a[2][2] - a[1][2] * a[2][1]) / det,
      (a[0][2] * a[2][1] - a[0][1] * a[2][2]) / det,
      (a[0][1] * a[1][2] - a[0][2] * a[1][1]) / det,
    ],
    [
      (a[1][2] * a[2][0] - a[1][0] * a[2][2]) / det,
      (a[0][0] * a[2][2] - a[0][2] * a[2][0]) / det,
      (a[0][2] * a[1][0] - a[0][0] * a[1][2]) / det,
    ],
    [
      (a[1][0] * a[2][1] - a[1][1] * a[2][0]) / det,
      (a[0][1] * a[2][0] - a[0][0] * a[2][1]) / det,
      (a[0][0] * a[1][1] - a[0][1] * a[1][0]) / det,
    ],
  ];
  const cell = Math.abs(det),
    half = Math.max(L.half_slab_mm, ...spacing),
    run = (k: number) => segments.segments[labels[k]].run,
    out = new Float32Array(count).fill(NaN);
  for (let k = 0; k < count; k++) {
    if (k % L.slice === L.slice - 1) yield;
    const before = k > 0 && run(k - 1) === run(k) ? k - 1 : k,
      after = k + 1 < count && run(k + 1) === run(k) ? k + 1 : k,
      t = [0, 1, 2].map((i) => points[3 * after + i] - points[3 * before + i]),
      length = Math.hypot(t[0], t[1], t[2]);
    if (!(length > 1e-6)) continue;
    for (let i = 0; i < 3; i++) t[i] /= length;
    const reach =
        L.reach_radii * segments.segments[labels[k]].mean_radius_mm +
        L.margin_mm,
      rel = [0, 1, 2].map((i) => points[3 * k + i] - a[i][3]),
      v = inv.map((row) => row[0] * rel[0] + row[1] * rel[1] + row[2] * rel[2]),
      box = Math.hypot(reach, half),
      low = v.map((c, i) => Math.max(0, Math.floor(c - box / spacing[i]))),
      high = v.map((c, i) =>
        Math.min(shape[i] - 1, Math.ceil(c + box / spacing[i])),
      );
    let inside = 0;
    for (let z = low[2]; z <= high[2]; z++)
      for (let y = low[1]; y <= high[1]; y++)
        for (let x = low[0]; x <= high[0]; x++) {
          if (!mask[x + nx * (y + ny * z)]) continue;
          const o = [x - v[0], y - v[1], z - v[2]],
            d = [0, 1, 2].map(
              (i) => a[i][0] * o[0] + a[i][1] * o[1] + a[i][2] * o[2],
            ),
            along = d[0] * t[0] + d[1] * t[1] + d[2] * t[2];
          if (
            Math.abs(along) <= half &&
            Math.hypot(d[0], d[1], d[2]) ** 2 - along ** 2 <= reach ** 2
          )
            inside++;
        }
    out[k] = 2 * Math.sqrt((inside * cell) / (2 * half) / Math.PI);
  }
  return out;
}

/** One-shot. Interactive callers step `axisDiameterSteps`. */
export function axisDiameters(
  mask: Uint8Array,
  shape: readonly [number, number, number],
  affine: number[][],
  segments: VesselSegments,
): Float32Array {
  const steps = axisDiameterSteps(mask, shape, affine, segments);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}
