import { describe, expect, it } from "vitest";
import { TREE, treeMask } from "./__fixtures__/angioPhantom";
import {
  centroid,
  MASK_POINT_LIMITS,
  medialPoints,
  medialPointSteps,
} from "./maskPoints";

/** Straight tube of `radius` mm along the grid's third axis. */
function tube(
  shape: [number, number, number],
  spacing: [number, number, number],
  radius: number,
  affine?: number[][],
) {
  const mask = new Uint8Array(shape[0] * shape[1] * shape[2]),
    cx = ((shape[0] - 1) * spacing[0]) / 2,
    cy = ((shape[1] - 1) * spacing[1]) / 2;
  for (let z = 2, at = 0; z < shape[2] - 2; z++)
    for (let y = 0; y < shape[1]; y++)
      for (let x = 0; x < shape[0]; x++) {
        at = x + shape[0] * (y + shape[1] * z);
        if (Math.hypot(x * spacing[0] - cx, y * spacing[1] - cy) < radius)
          mask[at] = 1;
      }
  return {
    mask,
    shape,
    affine: affine ?? [
      [spacing[0], 0, 0, 0],
      [0, spacing[1], 0, 0],
      [0, 0, spacing[2], 0],
      [0, 0, 0, 1],
    ],
    cx,
    cy,
  };
}

describe("medial points", () => {
  it("keeps points near the axis of a tube, with its radius", () => {
    const { mask, shape, affine, cx, cy } = tube(
      [31, 31, 80],
      [0.5, 0.5, 0.5],
      3,
    );
    const result = medialPoints(mask, shape, affine);
    expect(result.points.length / 3).toBeGreaterThanOrEqual(60);
    expect(result.pooling).toBe(1);
    expect(result.medial_voxels).toBe(result.points.length / 3);
    expect(result.foreground_voxels).toBeGreaterThan(3000);
    for (let k = 0; k < result.radii.length; k++) {
      const off = Math.hypot(
        result.points[3 * k] - cx,
        result.points[3 * k + 1] - cy,
      );
      // The ends are capped, so only the shaft has the tube radius.
      if (result.points[3 * k + 2] > 4 && result.points[3 * k + 2] < 35) {
        expect(off).toBeLessThan(0.75);
        expect(Math.abs(result.radii[k] - 3)).toBeLessThan(0.6);
      }
    }
  });

  it("measures in millimeters on an anisotropic grid", () => {
    const { mask, shape, affine, cx, cy } = tube(
      [41, 41, 48],
      [0.4, 0.4, 1.5],
      3.2,
    );
    const result = medialPoints(mask, shape, affine);
    let shaft = 0;
    for (let k = 0; k < result.radii.length; k++) {
      const z = result.points[3 * k + 2];
      if (z < 9 || z > 60) continue;
      shaft++;
      expect(
        Math.hypot(result.points[3 * k] - cx, result.points[3 * k + 1] - cy),
      ).toBeLessThan(0.6);
      expect(Math.abs(result.radii[k] - 3.2)).toBeLessThan(0.5);
    }
    expect(shaft).toBeGreaterThan(8);
  });

  it("places points with the grid's own affine", () => {
    // Voxel axes permuted and flipped: i runs toward -y, j toward +z, k toward +x.
    const affine = [
      [0, 0, 0.5, 10],
      [-0.5, 0, 0, 20],
      [0, 0.5, 0, -30],
      [0, 0, 0, 1],
    ];
    const { mask, shape } = tube([31, 31, 80], [0.5, 0.5, 0.5], 3, affine);
    const result = medialPoints(mask, shape, affine);
    for (let k = 0; k < result.radii.length; k++) {
      const x = result.points[3 * k];
      if (x < 14 || x > 46) continue;
      expect(Math.abs(result.points[3 * k + 1] - (20 - 7.5))).toBeLessThan(
        0.75,
      );
      expect(Math.abs(result.points[3 * k + 2] - (-30 + 7.5))).toBeLessThan(
        0.75,
      );
    }
    expect(centroid(result.points)[0]).toBeGreaterThan(28);
    expect(centroid(result.points)[0]).toBeLessThan(32);
  });

  it("follows every branch of the phantom tree", () => {
    const { mask, shape, affine } = treeMask();
    const result = medialPoints(mask, shape, affine);
    for (const { path, radius } of TREE)
      for (const [i, b] of path.slice(1).entries()) {
        const a = path[i],
          mid = [0, 1, 2].map((axis) => (a[axis] + b[axis]) / 2);
        let nearest = Infinity;
        for (let k = 0; k < result.radii.length; k++)
          nearest = Math.min(
            nearest,
            Math.hypot(
              result.points[3 * k] - mid[0],
              result.points[3 * k + 1] - mid[1],
              result.points[3 * k + 2] - mid[2],
            ),
          );
        expect(nearest).toBeLessThan(radius + 1);
      }
  });

  it("treats a vessel at the grid edge as bounded by the edge", () => {
    const shape: [number, number, number] = [8, 8, 40],
      mask = new Uint8Array(8 * 8 * 40).fill(1),
      affine = [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ];
    const result = medialPoints(mask, shape, affine);
    expect(Math.max(...result.radii)).toBeLessThanOrEqual(4.01);
  });

  it("caps the point count with an even stride", () => {
    // A slab one voxel thick: every voxel is medial.
    const shape: [number, number, number] = [200, 200, 1],
      mask = new Uint8Array(200 * 200).fill(1),
      affine = [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ];
    const result = medialPoints(mask, shape, affine);
    expect(result.medial_voxels).toBeGreaterThan(MASK_POINT_LIMITS.max_points);
    expect(result.points.length / 3).toBeLessThanOrEqual(
      MASK_POINT_LIMITS.max_points,
    );
    expect(result.points.length / 3).toBeGreaterThan(
      MASK_POINT_LIMITS.max_points / 2,
    );
    // Spread across the slab, not its first rows only.
    expect(centroid(result.points)[1]).toBeGreaterThan(80);
  });

  it("yields while working and equals the one-shot result", () => {
    const { mask, shape, affine } = treeMask();
    const steps = medialPointSteps(mask, shape, affine);
    let yields = 0,
      next = steps.next();
    while (!next.done) {
      yields++;
      next = steps.next();
    }
    expect(yields).toBeGreaterThan(8);
    expect([...next.value.points]).toEqual([
      ...medialPoints(mask, shape, affine).points,
    ]);
  });

  it("refuses masks it cannot measure", () => {
    const identity = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ];
    const small = new Uint8Array(1000);
    expect(() => medialPoints(small, [10, 10, 10], identity)).toThrow(
      "empty or too small",
    );
    small.fill(1, 0, 20);
    expect(() => medialPoints(small, [10, 10, 10], identity)).toThrow(
      "empty or too small",
    );
    expect(() => medialPoints(small, [10, 10, 11], identity)).toThrow(
      "outside the supported range",
    );
    expect(() => medialPoints(small, [0, 10, 100], identity)).toThrow(
      "outside the supported range",
    );
    expect(() =>
      medialPoints(
        { length: 8e8 } as ArrayLike<number>,
        [2000, 2000, 200],
        identity,
      ),
    ).toThrow("outside the supported range");
    const nan = new Float32Array(1000).fill(1);
    nan[500] = NaN;
    expect(() => medialPoints(nan, [10, 10, 10], identity)).toThrow(
      "Nonfinite vessel mask",
    );
    const full = new Uint8Array(1000).fill(1);
    const sheared = identity.map((row) => [...row]);
    sheared[0][1] = 0.2;
    expect(() => medialPoints(full, [10, 10, 10], sheared)).toThrow("Sheared");
    const tiny = identity.map((row) => [...row]);
    tiny[0][0] = 0.01;
    expect(() => medialPoints(full, [10, 10, 10], tiny)).toThrow("spacing");
    const projective = identity.map((row) => [...row]);
    projective[3][0] = 1;
    expect(() => medialPoints(full, [10, 10, 10], projective)).toThrow(
      "Invalid mask affine",
    );
  });

  it("pools a mask whose extent is above the working size", () => {
    // A 3 mm tube on a 0.25 mm grid whose box needs a factor of two.
    const { mask, shape, affine, cx, cy } = tube(
      [200, 200, 400],
      [0.25, 0.25, 0.25],
      3,
    );
    // Two far corners stretch the bounding box to the whole grid.
    mask[0] = 1;
    mask[mask.length - 1] = 1;
    const result = medialPoints(mask, shape, affine);
    expect(result.pooling).toBe(2);
    let shaft = 0;
    for (let k = 0; k < result.radii.length; k++) {
      const z = result.points[3 * k + 2];
      if (z < 5 || z > 90) continue;
      shaft++;
      expect(
        Math.hypot(result.points[3 * k] - cx, result.points[3 * k + 1] - cy),
      ).toBeLessThan(0.75);
      // Pooling may thicken the radius by up to one 0.5 mm cell.
      expect(result.radii[k]).toBeGreaterThan(2.6);
      expect(result.radii[k]).toBeLessThan(3.8);
    }
    expect(shaft).toBeGreaterThan(100);
  });
});
