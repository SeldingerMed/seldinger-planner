/** The diameter of the vessel mask at each sample of its axis.
 *
 * At a sample the mask is cut by a thin slab across the axis. The diameter
 * is that of the circle with the area of the cut: the volume of mask in the
 * slab over the slab's thickness. Counting volume keeps the answer steady
 * on a grid whose voxels are a good part of a vessel's width.
 *
 * The cut is of one vessel. Axis samples come from a coarser grid and can
 * lie off the vessel's middle, and a mask often runs two vessels into each
 * other. So the cut is centered where the mask is deepest about the
 * sample, and holds the mask that joins that place and lies in the round
 * vessel about it: a voxel as deep in the mask as a round vessel of the
 * center's depth would have it at that distance from the center. */
import { spacingOf } from "./maskPoints";
import type { VesselSegments } from "./vesselSegments";

export const AXIS_DIAMETER_METHOD = "mask_vessel_slab_area_v1";
export const AXIS_DIAMETER_LIMITS = {
  /** Half the slab's thickness; one voxel on a coarser grid. */
  half_slab_mm: 1,
  /** The cut starts from mask within this distance of the sample. */
  seed_mm: 1,
  /** A voxel's depth in the mask and its distance from the center may
   * together pass the center's depth by one voxel and this share of that
   * depth: so far a vessel may be out of round. */
  out_of_round: 0.25,
  /** Depth in the mask is not followed farther than this. */
  deepest_mm: 10,
} as const;

export type AxisCuts = {
  /** Diameter in millimeters at each axis sample; NaN where not measured. */
  mm: Float32Array;
  /** Where each sample's cut is centered, in the volume's millimeters,
   * three per sample; NaN where `mm` is. */
  centers: Float32Array;
};

/** The cut at each axis sample. A sample with no neighbor on its run to
 * give the axis a direction is not measured, nor one that lies off the
 * mask. Yields between slices of samples. */
export function* axisDiameterSteps(
  mask: Uint8Array,
  shape: readonly [number, number, number],
  affine: number[][],
  segments: VesselSegments,
): Generator<void, AxisCuts> {
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
    coarse = Math.max(...spacing),
    fine = Math.min(...spacing),
    shells = Math.ceil(L.deepest_mm / fine),
    run = (k: number) => segments.segments[labels[k]].run,
    out = new Float32Array(count).fill(NaN),
    centers = new Float32Array(3 * count).fill(NaN),
    filled = (x: number, y: number, z: number) =>
      x >= 0 &&
      y >= 0 &&
      z >= 0 &&
      x < nx &&
      y < ny &&
      z < nz &&
      mask[x + nx * (y + ny * z)] !== 0,
    depths = new Map<number, number>(),
    /** How deep a voxel lies in the mask: the distance from its center to
     * the nearest voxel center outside the mask. */
    depth = (x: number, y: number, z: number): number => {
      if (!filled(x, y, z)) return 0;
      const key = x + nx * (y + ny * z),
        known = depths.get(key);
      if (known !== undefined) return known;
      let best: number = L.deepest_mm;
      // Shell by shell of voxels; one not yet looked at is at least as far
      // as its shell.
      for (let s = 1; s <= shells && best > s * fine; s++)
        for (let dz = -s; dz <= s; dz++)
          for (let dy = -s; dy <= s; dy++) {
            const inner = Math.abs(dz) < s && Math.abs(dy) < s;
            for (let dx = -s; dx <= s; dx += inner ? 2 * s : 1) {
              if (filled(x + dx, y + dy, z + dz)) continue;
              const far = Math.hypot(
                dx * spacing[0],
                dy * spacing[1],
                dz * spacing[2],
              );
              if (far < best) best = far;
            }
          }
      depths.set(key, best);
      return best;
    };
  // The cut is grown in a box of voxels about its center.
  let seen = new Uint8Array(0),
    queue = new Int32Array(0);
  for (let k = 0; k < count; k++) {
    // One sample of a wide vessel can take a slice's time: the job can be
    // stopped after each.
    yield;
    const before = k > 0 && run(k - 1) === run(k) ? k - 1 : k,
      after = k + 1 < count && run(k + 1) === run(k) ? k + 1 : k,
      t = [0, 1, 2].map((i) => points[3 * after + i] - points[3 * before + i]),
      length = Math.hypot(t[0], t[1], t[2]);
    if (!(length > 1e-6)) continue;
    for (let i = 0; i < 3; i++) t[i] /= length;
    const rel = [0, 1, 2].map((i) => points[3 * k + i] - a[i][3]),
      v = inv.map((row) => row[0] * rel[0] + row[1] * rel[1] + row[2] * rel[2]),
      /** A voxel's place from a point given in voxels: along the axis and
       * off it, in millimeters. */
      from = (o: number[], x: number, y: number, z: number) => {
        const d = [0, 1, 2].map(
            (i) =>
              a[i][0] * (x - o[0]) +
              a[i][1] * (y - o[1]) +
              a[i][2] * (z - o[2]),
          ),
          along = d[0] * t[0] + d[1] * t[1] + d[2] * t[2],
          whole = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
        return { along, off: Math.sqrt(Math.max(0, whole - along * along)) };
      },
      slab = (x: number, y: number, z: number) =>
        filled(x, y, z) && Math.abs(from(v, x, y, z).along) <= half;
    // The mask nearest the sample. The axis of a thin vessel can lie just
    // outside its mask; farther out the sample is between vessels and is
    // not measured.
    const near = spacing.map((step) => Math.ceil(L.seed_mm / step)),
      first = v.map(Math.round);
    let seed: number[] | null = null,
      least: number = L.seed_mm;
    for (let z = first[2] - near[2]; z <= first[2] + near[2]; z++)
      for (let y = first[1] - near[1]; y <= first[1] + near[1]; y++)
        for (let x = first[0] - near[0]; x <= first[0] + near[0]; x++) {
          if (!slab(x, y, z)) continue;
          const { along, off } = from(v, x, y, z),
            far = Math.hypot(along, off);
          if (far <= least) {
            least = far;
            seed = [x, y, z];
          }
        }
    if (!seed) continue;
    let center: number[] = seed;
    // From there to where the mask is deepest, inside the slab.
    for (let moved = true; moved;) {
      moved = false;
      let deepest = depth(center[0], center[1], center[2]),
        next: number[] = center;
      for (let dz = -1; dz <= 1; dz++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const x = center[0] + dx,
              y = center[1] + dy,
              z = center[2] + dz;
            if (!slab(x, y, z)) continue;
            const here = depth(x, y, z);
            if (here > deepest) {
              deepest = here;
              next = [x, y, z];
              moved = true;
            }
          }
      center = next;
    }
    const middle = center,
      round = depth(middle[0], middle[1], middle[2]),
      reach = round * (1 + L.out_of_round) + coarse,
      box = Math.hypot(reach, half),
      low = middle.map((c, i) => Math.max(0, Math.floor(c - box / spacing[i]))),
      high = middle.map((c, i) =>
        Math.min(shape[i] - 1, Math.ceil(c + box / spacing[i])),
      ),
      size = [0, 1, 2].map((i) => high[i] - low[i] + 1),
      cells = size[0] * size[1] * size[2];
    if (seen.length < cells) {
      seen = new Uint8Array(cells);
      queue = new Int32Array(cells);
    } else seen.fill(0, 0, cells);
    /** Whether a voxel is mask of the vessel about the center, inside the
     * slab. */
    const cut = (x: number, y: number, z: number) =>
      slab(x, y, z) && depth(x, y, z) + from(middle, x, y, z).off <= reach;
    let head = 0,
      tail = 0;
    const visit = (x: number, y: number, z: number) => {
      if (
        x < low[0] ||
        y < low[1] ||
        z < low[2] ||
        x > high[0] ||
        y > high[1] ||
        z > high[2]
      )
        return;
      const at = x - low[0] + size[0] * (y - low[1] + size[1] * (z - low[2]));
      if (seen[at]) return;
      seen[at] = 1;
      if (cut(x, y, z)) queue[tail++] = at;
    };
    visit(middle[0], middle[1], middle[2]);
    while (head < tail) {
      const at = queue[head++],
        x = (at % size[0]) + low[0],
        y = (Math.floor(at / size[0]) % size[1]) + low[1],
        z = Math.floor(at / (size[0] * size[1])) + low[2];
      // Corner neighbors too: a thin vessel oblique to the grid is a chain
      // of voxels that touch at their corners.
      for (let dz = -1; dz <= 1; dz++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) visit(x + dx, y + dy, z + dz);
    }
    out[k] = 2 * Math.sqrt((tail * cell) / (2 * half) / Math.PI);
    for (let i = 0; i < 3; i++)
      centers[3 * k + i] =
        a[i][0] * middle[0] +
        a[i][1] * middle[1] +
        a[i][2] * middle[2] +
        a[i][3];
  }
  return { mm: out, centers };
}

/** One-shot. Interactive callers step `axisDiameterSteps`. */
export function axisCuts(
  mask: Uint8Array,
  shape: readonly [number, number, number],
  affine: number[][],
  segments: VesselSegments,
): AxisCuts {
  const steps = axisDiameterSteps(mask, shape, affine, segments);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

/** The diameters alone. */
export function axisDiameters(
  mask: Uint8Array,
  shape: readonly [number, number, number],
  affine: number[][],
  segments: VesselSegments,
): Float32Array {
  return axisCuts(mask, shape, affine, segments).mm;
}
