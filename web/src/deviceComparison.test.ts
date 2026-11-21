// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  compareDevice,
  liesOnPath,
  type PlannedSpan,
} from "./deviceComparison";
import type { Vec3 } from "./obliqueSlice";

// 30 mm along x, then 30 mm along y.
const path: Vec3[] = [
    [0, 0, 0],
    [30, 0, 0],
    [30, 30, 0],
  ],
  planned: PlannedSpan = { path, offset: 20, length: 18 };

describe("a planned device against its marked ends", () => {
  it("reads no shift when the ends are marked where they were planned", () => {
    const found = compareDevice(planned, [
      [20, 0, 0],
      [30, 8, 0],
    ]);
    expect(found.planned_length_mm).toBe(18);
    expect(found.deployed_length_mm).toBeCloseTo(18, 9);
    for (const end of found.ends) {
      expect(end.shift_mm).toBeCloseTo(0, 9);
      expect(end.off_path_mm).toBeCloseTo(0, 9);
    }
  });

  it("measures each end along the path, round its bend, in either order of marking", () => {
    // Starts 3 mm late and ends 5 mm short: a device of 10 mm.
    const ends: [Vec3, Vec3] = [
        [23, 0, 1.5],
        [32, 3, 0],
      ],
      found = compareDevice(planned, ends);
    expect(found.deployed_length_mm).toBeCloseTo(10, 9);
    expect(found.ends[0].shift_mm).toBeCloseTo(3, 9);
    expect(found.ends[0].off_path_mm).toBeCloseTo(1.5, 9);
    expect(found.ends[1].shift_mm).toBeCloseTo(-5, 9);
    expect(found.ends[1].off_path_mm).toBeCloseTo(2, 9);
    expect(compareDevice(planned, [ends[1], ends[0]])).toEqual(found);
  });

  it("refuses a device that does not fit its path, and ends that are not two points", () => {
    const end: Vec3 = [20, 0, 0];
    for (const bad of [
      { ...planned, length: 41 },
      { ...planned, offset: -1 },
      { ...planned, length: 0 },
      { ...planned, offset: NaN },
      { ...planned, path: [path[0]] },
      { ...planned, path: [path[0], [1, NaN, 0] as Vec3] },
    ]) {
      expect(liesOnPath(bad)).toBe(false);
      expect(() => compareDevice(bad, [end, end])).toThrow(
        "Invalid planned device",
      );
    }
    expect(liesOnPath(planned)).toBe(true);
    expect(() =>
      compareDevice(planned, [end] as unknown as [Vec3, Vec3]),
    ).toThrow("Two marked ends are required");
    expect(() => compareDevice(planned, [end, [0, 0, Infinity]])).toThrow(
      "Two marked ends are required",
    );
  });
});
