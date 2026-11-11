/** Medial points of a binary vessel mask, in the RAS millimeters of its grid.
 *
 * A voxel is kept when no neighbor lies more than a fraction of a voxel
 * deeper inside the mask, which leaves points near the vessel axis with
 * their distance to the wall. It is a point
 * set for projection matching, not a topological centerline: it has no
 * ordering, no branches, and can keep extra points in blob-like regions. */
import { FAR_SQUARED, squaredDistanceInBox } from "./distanceTransform";
import type { Vec3 } from "./obliqueSlice";

export const MASK_POINT_LIMITS = {
  max_grid_voxels: 600_000_000,
  /** The vessels' bounding box is pooled by a whole factor until it has at
   * most this many cells. */
  max_box_voxels: 8_000_000,
  max_pooling: 8,
  min_points: 30,
  max_points: 20_000,
  /** A neighbor may be this much deeper, in units of the smallest voxel
   * side, before a voxel stops counting as medial. Zero would keep only
   * exact local maxima, which a discrete grid scatters thinly. */
  crest_tolerance: 0.3,
} as const;

export type MedialPoints = {
  /** x, y, z triples in RAS millimeters. */
  points: Float32Array;
  /** Millimeters from each point to the mask boundary. */
  radii: Float32Array;
  foreground_voxels: number;
  /** Medial voxels found before the point cap was applied. */
  medial_voxels: number;
  /** Grid voxels per measured cell along each axis. Above 1, a cell counts
   * as vessel when any voxel in it does, which thickens radii by up to one
   * cell. */
  pooling: number;
};

function spacingOf(affine: number[][]): [number, number, number] {
  if (
    affine.length !== 4 ||
    affine.some(
      (row) =>
        !Array.isArray(row) || row.length !== 4 || !row.every(Number.isFinite),
    ) ||
    affine[3].some((value, i) => value !== [0, 0, 0, 1][i])
  )
    throw new Error("Invalid mask affine");
  const spacing = [0, 1, 2].map((j) =>
    Math.hypot(affine[0][j], affine[1][j], affine[2][j]),
  ) as [number, number, number];
  if (spacing.some((value) => !(value >= 0.05 && value <= 20)))
    throw new Error("Mask voxel spacing is outside the supported range");
  // The distance transform is separable only along orthogonal grid axes.
  for (let i = 0; i < 3; i++)
    for (let j = i + 1; j < 3; j++) {
      const dot =
        affine[0][i] * affine[0][j] +
        affine[1][i] * affine[1][j] +
        affine[2][i] * affine[2][j];
      if (Math.abs(dot) > 1e-3 * spacing[i] * spacing[j])
        throw new Error("Sheared mask grids are not supported");
    }
  return spacing;
}

/** Resumable extraction. `mask` is nonzero inside the vessel, x fastest. */
export function* medialPointSteps(
  mask: ArrayLike<number>,
  shape: readonly [number, number, number],
  affine: number[][],
): Generator<void, MedialPoints> {
  const L = MASK_POINT_LIMITS,
    [nx, ny, nz] = shape;
  if (
    shape.length !== 3 ||
    shape.some((n) => !Number.isInteger(n) || n < 1 || n > 2048) ||
    nx * ny * nz > L.max_grid_voxels ||
    mask.length !== nx * ny * nz
  )
    throw new Error("Vessel mask grid is outside the supported range");
  const spacing = spacingOf(affine);
  const low = [nx, ny, nz],
    high = [-1, -1, -1];
  let foreground = 0;
  for (let z = 0, at = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++, at++) {
        const value = mask[at];
        if (!Number.isFinite(value)) throw new Error("Nonfinite vessel mask");
        if (value === 0) continue;
        foreground++;
        if (x < low[0]) low[0] = x;
        if (y < low[1]) low[1] = y;
        if (z < low[2]) low[2] = z;
        if (x > high[0]) high[0] = x;
        if (y > high[1]) high[1] = y;
        if (z > high[2]) high[2] = z;
      }
    if ((z & 15) === 15) yield;
  }
  if (foreground < L.min_points)
    throw new Error("Vessel mask is empty or too small");
  // One cell of padding, so the grid edge counts as outside the vessel.
  let pooling = 1,
    box: [number, number, number] = [0, 0, 0];
  for (; ; pooling++) {
    if (pooling > L.max_pooling)
      throw new Error("Vessel mask extent exceeds the supported size");
    box = [0, 1, 2].map(
      (i) => Math.floor((high[i] - low[i]) / pooling) + 3,
    ) as [number, number, number];
    if (box[0] * box[1] * box[2] <= L.max_box_voxels) break;
  }
  const [bx, by, bz] = box,
    cell = spacing.map((value) => value * pooling) as [number, number, number];
  const field = new Float32Array(bx * by * bz);
  for (let z = low[2]; z <= high[2]; z++) {
    const cz = Math.floor((z - low[2]) / pooling) + 1;
    for (let y = low[1]; y <= high[1]; y++) {
      const row = bx * (Math.floor((y - low[1]) / pooling) + 1 + by * cz);
      for (let x = low[0]; x <= high[0]; x++)
        if (mask[x + nx * (y + ny * z)] !== 0)
          field[Math.floor((x - low[0]) / pooling) + 1 + row] = FAR_SQUARED;
    }
    if ((z & 15) === 15) yield;
  }
  yield;
  yield* squaredDistanceInBox(field, box, cell);
  const kept: number[] = [],
    slack = L.crest_tolerance * Math.min(...cell);
  for (let z = 1; z < bz - 1; z++) {
    for (let y = 1; y < by - 1; y++)
      for (let x = 1; x < bx - 1; x++) {
        const at = x + bx * (y + by * z),
          value = field[at];
        if (value === 0) continue;
        const limit = (Math.sqrt(value) + slack) ** 2;
        let crest = true;
        for (let dz = -1; dz <= 1 && crest; dz++)
          for (let dy = -1; dy <= 1 && crest; dy++)
            for (let dx = -1; dx <= 1; dx++)
              if (field[at + dx + bx * (dy + by * dz)] > limit) {
                crest = false;
                break;
              }
        if (crest) kept.push(at);
      }
    if ((z & 15) === 15) yield;
  }
  // An even stride keeps the capped subset spread along every vessel.
  const stride = Math.ceil(kept.length / L.max_points),
    count = Math.ceil(kept.length / stride);
  if (count < L.min_points)
    throw new Error("Vessel mask is empty or too small");
  const points = new Float32Array(3 * count),
    radii = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    // Center of the cell, in voxel coordinates of the mask grid.
    const at = kept[k * stride],
      middle = (pooling - 1) / 2,
      x = ((at % bx) - 1) * pooling + low[0] + middle,
      y = ((Math.floor(at / bx) % by) - 1) * pooling + low[1] + middle,
      z = (Math.floor(at / (bx * by)) - 1) * pooling + low[2] + middle;
    for (let i = 0; i < 3; i++)
      points[3 * k + i] =
        affine[i][0] * x + affine[i][1] * y + affine[i][2] * z + affine[i][3];
    radii[k] = Math.sqrt(field[at]);
  }
  return {
    points,
    radii,
    foreground_voxels: foreground,
    medial_voxels: kept.length,
    pooling,
  };
}

/** One-shot extraction. Interactive callers should step `medialPointSteps`. */
export function medialPoints(
  mask: ArrayLike<number>,
  shape: readonly [number, number, number],
  affine: number[][],
): MedialPoints {
  const steps = medialPointSteps(mask, shape, affine);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

/** Mean of a point set, used as the pivot of a registration search. */
export function centroid(points: Float32Array): Vec3 {
  const sum = [0, 0, 0],
    count = points.length / 3;
  for (let k = 0; k < count; k++)
    for (let i = 0; i < 3; i++) sum[i] += points[3 * k + i];
  return sum.map((value) => value / count) as Vec3;
}
