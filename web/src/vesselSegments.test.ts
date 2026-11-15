import { describe, expect, it } from "vitest";
import { treeMask, TREE, type Tube } from "./__fixtures__/angioPhantom";
import { MASK_POINT_LIMITS } from "./maskPoints";
import type { Vec3 } from "./obliqueSlice";
import {
  VESSEL_SEGMENT_LIMITS as LIMITS,
  vesselSegments,
  vesselSegmentSteps,
  type VesselSegments,
} from "./vesselSegments";

const pathLength = (path: Vec3[]) =>
  path
    .slice(1)
    .reduce(
      (sum, b, i) =>
        sum +
        Math.hypot(b[0] - path[i][0], b[1] - path[i][1], b[2] - path[i][2]),
      0,
    );
function axisDistance(p: number[], a: Vec3, b: Vec3) {
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
/** Per segment, how many of its axis samples are nearest to each tube, and
 * the largest distance of any sample from the nearest tube axis. */
function against(result: VesselSegments, tree: Tube[]) {
  const counts = result.segments.map(() => tree.map(() => 0));
  let offset = 0;
  result.labels.forEach((label, i) => {
    const p = Array.from(result.points.subarray(3 * i, 3 * i + 3)),
      d = tree.map(({ path }) =>
        Math.min(...path.slice(1).map((b, k) => axisDistance(p, path[k], b))),
      ),
      tube = d.indexOf(Math.min(...d));
    counts[label][tube]++;
    offset = Math.max(offset, d[tube]);
  });
  return { counts, offset };
}
function segmented(tree: Tube[], spacing = 1) {
  const { mask, shape, affine } = treeMask(spacing, tree);
  return vesselSegments(mask, shape, affine);
}
/** Band width on an isotropic grid of this spacing. */
const band = (spacing: number) =>
  Math.max(LIMITS.band_mm, 2 * Math.sqrt(3) * spacing);
const total = (result: VesselSegments) =>
  result.segments.reduce((sum, segment) => sum + segment.length_mm, 0);

describe("vessel segments", () => {
  it.each([1, 0.6])(
    "cuts the phantom tree into stretches of one vessel each, at %f mm",
    (spacing) => {
      const result = segmented(TREE, spacing),
        { segments, labels, points } = result;
      expect(result.unassigned_fraction).toBe(0);
      expect(result.pooling).toBe(1);
      expect(points.length).toBe(3 * labels.length);
      segments.forEach((segment, index) => {
        expect(segment.index).toBe(index);
        expect(segment.sample_count).toBe(
          labels.filter((label) => label === index).length,
        );
        expect(segment.sample_count).toBeGreaterThan(0);
        expect(segment.length_mm).toBeGreaterThan(0);
        expect(segment.length_mm).toBeLessThanOrEqual(LIMITS.max_segment_mm);
        // One sample per millimeter of length, give or take the ends.
        expect(
          Math.abs(segment.sample_count - segment.length_mm / LIMITS.sample_mm),
        ).toBeLessThan(2);
      });
      // Each segment lies along one tube; a sample or two at a junction may
      // be nearer the neighbor. The samples follow the tube axes.
      const { counts, offset } = against(result, TREE),
        lengthByTube = TREE.map(() => 0);
      expect(offset).toBeLessThan(2);
      counts.forEach((row, index) => {
        const main = row.indexOf(Math.max(...row));
        expect(row[main] / segments[index].sample_count).toBeGreaterThan(0.8);
        lengthByTube[main] += segments[index].length_mm;
        expect(
          Math.abs(segments[index].mean_radius_mm - TREE[main].radius),
        ).toBeLessThan(1);
      });
      // Every tube is found. A tube can be measured long by up to a band at
      // each end, because the path runs through the center of the band at a
      // junction and that center is off the tube's own axis.
      TREE.forEach(({ path }, tube) =>
        expect(Math.abs(lengthByTube[tube] - pathLength(path))).toBeLessThan(
          2 * band(spacing),
        ),
      );
    },
  );

  it("cuts one straight vessel into equal pieces of bounded length", () => {
    const tube: Tube = {
        path: [
          [-20, 0, -20],
          [20, 0, 20],
        ],
        radius: 2,
      },
      result = segmented([tube]);
    // 56.6 mm between the end points, so four pieces.
    expect(result.segments).toHaveLength(4);
    expect(Math.abs(total(result) - pathLength(tube.path))).toBeLessThan(
      band(1),
    );
    for (const segment of result.segments) {
      expect(segment.length_mm).toBeCloseTo(total(result) / 4, 9);
      expect(Math.abs(segment.mean_radius_mm - 2)).toBeLessThan(0.3);
    }
    expect(against(result, [tube]).offset).toBeLessThan(1);
  });

  it("keeps vessels that do not touch in separate segments", () => {
    const tree: Tube[] = [
        {
          path: [
            [-20, -10, 0],
            [20, -10, 0],
          ],
          radius: 2,
        },
        {
          path: [
            [-20, 10, 0],
            [20, 10, 0],
          ],
          radius: 1.5,
        },
      ],
      result = segmented(tree),
      { counts } = against(result, tree);
    for (const row of counts) expect(Math.min(...row)).toBe(0);
    expect(counts.filter((row) => row[0] > 0)).toHaveLength(3);
    expect(counts.filter((row) => row[1] > 0)).toHaveLength(3);
    expect(result.unassigned_fraction).toBe(0);
  });

  it("follows a closed loop all the way round", () => {
    const ring: Vec3[] = Array.from({ length: 25 }, (_, k) => [
        18 * Math.cos((k * Math.PI) / 12),
        18 * Math.sin((k * Math.PI) / 12),
        0,
      ]),
      result = segmented([{ path: ring, radius: 2 }]);
    // The sweep starts in the middle of the loop. The start is not left out
    // and does not end a segment.
    expect(result.unassigned_fraction).toBe(0);
    expect(Math.abs(total(result) - pathLength(ring))).toBeLessThan(band(1));
    expect(result.segments).toHaveLength(8);
    for (const segment of result.segments)
      expect(Math.abs(segment.mean_radius_mm - 2)).toBeLessThan(0.5);
  });

  it("leaves out a piece too short to be a vessel", () => {
    const tree: Tube[] = [
        {
          path: [
            [-20, 0, 0],
            [20, 0, 0],
          ],
          radius: 2,
        },
        {
          path: [
            [0, 20, 0],
            [3, 20, 0],
          ],
          radius: 1.5,
        },
      ],
      result = segmented(tree),
      alone = segmented([tree[0]]);
    expect(result.unassigned_fraction).toBeGreaterThan(0.05);
    expect(result.unassigned_fraction).toBeLessThan(0.2);
    // What is left is exactly the long vessel on its own grid position.
    expect(result.segments).toEqual(alone.segments);
    for (const row of against(result, tree).counts) expect(row[1]).toBe(0);
  });

  it("moves with the grid and repeats exactly", () => {
    const { mask, shape, affine } = treeMask(1, TREE),
      result = vesselSegments(mask, shape, affine),
      moved = affine.map((row, a) =>
        a < 3 ? [...row.slice(0, 3), row[3] + [12, -7, 30][a]] : row,
      ),
      again = vesselSegments(mask, shape, moved);
    expect(vesselSegments(mask, shape, affine)).toEqual(result);
    expect(again.labels).toEqual(result.labels);
    again.segments.forEach((segment, index) => {
      const before = result.segments[index];
      expect(segment.index).toBe(before.index);
      expect(segment.sample_count).toBe(before.sample_count);
      expect(segment.length_mm).toBeCloseTo(before.length_mm, 9);
      expect(segment.mean_radius_mm).toBeCloseTo(before.mean_radius_mm, 9);
    });
    again.points.forEach((value, i) =>
      expect(value - result.points[i]).toBeCloseTo([12, -7, 30][i % 3], 4),
    );
  });

  it("measures a pooled grid in millimeters", () => {
    // 220 cells a side at 0.5 mm is more than the box limit, so the box is
    // pooled by two. One vessel runs along the diagonal of the x, y plane.
    const n = 220,
      spacing = 0.5,
      mask = new Uint8Array(n * n * n),
      affine = [
        [spacing, 0, 0, -55],
        [0, spacing, 0, -55],
        [0, 0, spacing, -55],
        [0, 0, 0, 1],
      ],
      tube: Tube = {
        path: [
          [-50, -50, 0],
          [50, 50, 0],
        ],
        radius: 2.5,
      };
    expect(n ** 3).toBeGreaterThan(MASK_POINT_LIMITS.max_box_voxels);
    for (let z = 95; z <= 125; z++)
      for (let y = 0; y < n; y++)
        for (let x = Math.max(0, y - 12); x <= Math.min(n - 1, y + 12); x++)
          if (
            axisDistance(
              [x * spacing - 55, y * spacing - 55, z * spacing - 55],
              tube.path[0],
              tube.path[1],
            ) < tube.radius
          )
            mask[x + n * (y + n * z)] = 1;
    // A second vessel far away makes the box span the whole grid.
    for (let z = 0; z < 40; z++)
      for (let y = n - 8; y < n; y++)
        for (let x = 0; x < 8; x++) mask[x + n * (y + n * z)] = 1;
    for (let z = n - 8; z < n; z++)
      for (let y = 0; y < 8; y++)
        for (let x = n - 40; x < n; x++) mask[x + n * (y + n * z)] = 1;
    const result = vesselSegments(mask, [n, n, n], affine),
      near = result.segments.map(() => true);
    result.labels.forEach((label, i) => {
      if (Math.abs(result.points[3 * i + 2]) > 5) near[label] = false;
    });
    const diagonal = result.segments.filter((_, index) => near[index]),
      bars = result.segments.filter((_, index) => !near[index]);
    expect(result.pooling).toBe(2);
    expect(result.unassigned_fraction).toBe(0);
    // The long vessel: ten pieces, 141.4 mm, its radius thickened by pooling
    // by less than a pooled cell.
    expect(diagonal).toHaveLength(10);
    expect(
      Math.abs(
        diagonal.reduce((sum, segment) => sum + segment.length_mm, 0) -
          pathLength(tube.path),
      ),
    ).toBeLessThan(band(2 * spacing));
    for (const segment of diagonal) {
      expect(segment.mean_radius_mm).toBeGreaterThan(2.3);
      expect(segment.mean_radius_mm).toBeLessThan(3.5);
    }
    // The two bars are 20 mm long and 4 mm square.
    expect(bars).toHaveLength(4);
    for (const bar of bars) {
      expect(bar.length_mm).toBeGreaterThan(7);
      expect(bar.length_mm).toBeLessThan(10.5);
      expect(
        Math.abs(bar.mean_radius_mm - 4 / Math.sqrt(Math.PI)),
      ).toBeLessThan(0.5);
    }
  });

  it("can be stepped, with the same result", () => {
    const { mask, shape, affine } = treeMask(0.6, TREE),
      steps = vesselSegmentSteps(mask, shape, affine);
    let yields = 0;
    for (;;) {
      const next = steps.next();
      if (next.done) {
        expect(next.value).toEqual(vesselSegments(mask, shape, affine));
        break;
      }
      yields++;
    }
    expect(yields).toBeGreaterThan(10);
  });

  it("refuses masks it cannot segment", () => {
    const { mask, shape, affine } = treeMask(1, TREE),
      refused = (
        message: string,
        m: ArrayLike<number> = mask,
        s: readonly [number, number, number] = shape,
        a: number[][] = affine,
      ) => expect(() => vesselSegments(m, s, a)).toThrow(new Error(message));
    refused("Vessel mask grid is outside the supported range", mask.slice(1));
    refused("Vessel mask grid is outside the supported range", mask, [
      shape[0] + 0.5,
      shape[1],
      shape[2],
    ]);
    refused("Vessel mask grid is outside the supported range", mask, [
      2049,
      shape[1],
      shape[2],
    ]);
    refused("Vessel mask is empty or too small", new Uint8Array(mask.length));
    const few = new Uint8Array(mask.length);
    few.fill(1, 0, MASK_POINT_LIMITS.min_points - 1);
    refused("Vessel mask is empty or too small", few);
    const broken = Float32Array.from(mask);
    broken[7] = Number.NaN;
    refused("Nonfinite vessel mask", broken);
    // The affine is checked as `maskPoints` checks it.
    expect(() => vesselSegments(mask, shape, affine.slice(0, 3))).toThrow();
    expect(() =>
      vesselSegments(
        mask,
        shape,
        affine.map((row) => row.map(() => 0)),
      ),
    ).toThrow();
  });

  // Two rails joined by two rungs: every run but the rails' free ends lies
  // between two branchings. A real vessel mask is full of these, and one of
  // them used to be left with no volume, and so a radius of zero, when the
  // runs before it had taken both of its ends.
  it.each([1, 0.8, 0.6])(
    "gives every piece the volume that lies along it, at %f mm",
    (spacing) => {
      const radius = 1.5,
        ladder: Tube[] = [
          [
            [-5, 0, -30],
            [-5, 0, 30],
          ],
          [
            [5, 0, -30],
            [5, 0, 30],
          ],
          [
            [-5, 0, -10],
            [5, 0, -10],
          ],
          [
            [-5, 0, 12],
            [5, 0, 12],
          ],
        ].map((path) => ({ path: path as Vec3[], radius })),
        { mask, shape, affine } = treeMask(spacing, ladder),
        result = vesselSegments(mask, shape, affine);
      expect(result.unassigned_fraction).toBe(0);
      // Eight runs: each rail in three, and the two rungs.
      expect(new Set(result.segments.map((segment) => segment.run)).size).toBe(
        8,
      );
      for (const segment of result.segments) {
        expect(segment.mean_radius_mm).toBeGreaterThan(0.6 * radius);
        expect(segment.mean_radius_mm).toBeLessThan(1.4 * radius);
      }
      // Nothing is counted twice or dropped: the pieces hold the mask.
      const voxels = mask.reduce((sum, value) => sum + value, 0);
      expect(
        result.segments.reduce(
          (sum, segment) =>
            sum + Math.PI * segment.mean_radius_mm ** 2 * segment.length_mm,
          0,
        ),
      ).toBeCloseTo(voxels * spacing ** 3, 6);
    },
  );

  // On a grid this coarse a band is longer than half a piece, so a piece can
  // lie between two of the sweep's nodes and hold neither. It still holds
  // the vessel along it.
  it("leaves no piece empty on a grid coarser than its pieces", () => {
    const radius = 8,
      { mask, shape, affine } = treeMask(4, [
        {
          path: [
            [0, 0, -50],
            [0, 0, 50],
          ],
          radius,
        },
      ]),
      { segments } = vesselSegments(mask, shape, affine);
    expect(segments.length).toBeGreaterThan(3);
    for (const segment of segments) {
      expect(segment.mean_radius_mm).toBeGreaterThan(0.75 * radius);
      expect(segment.mean_radius_mm).toBeLessThan(1.25 * radius);
    }
  });

  it("refuses more segments than it is built to list", () => {
    // Separate rods, each long enough to be a segment: 45 by 45 of them.
    const n = 180,
      mask = new Uint8Array(n * n * 12),
      affine = [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ];
    for (let z = 1; z < 11; z++)
      for (let y = 0; y < n; y += 4)
        for (let x = 0; x < n; x += 4) mask[x + n * (y + n * z)] = 1;
    expect(45 * 45).toBeGreaterThan(LIMITS.max_segments);
    expect(() => vesselSegments(mask, [n, n, 12], affine)).toThrow(
      new Error("Vessel mask has too many segments"),
    );
    // One fewer row of rods is within the limit.
    for (let z = 1; z < 11; z++)
      for (let x = 0; x < n; x += 4) mask[x + n * n * z] = 0;
    expect(vesselSegments(mask, [n, n, 12], affine).segments).toHaveLength(
      44 * 45,
    );
  });
});
