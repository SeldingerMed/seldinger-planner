import { describe, expect, it } from "vitest";
import {
  LJUBLJANA_PROTOCOL as P,
  perturbed,
  protocolStarts,
  quantile,
  summarize,
} from "./ljubljanaProtocol";
import { meanTargetError } from "./ljubljanaGeometry";

const identity = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

describe("Ljubljana evaluation protocol", () => {
  it("draws the same starts every time, inside the stated range", () => {
    const starts = protocolStarts();
    expect(starts).toEqual(protocolStarts());
    expect(starts.length).toBe(P.subjects);
    const flat = starts.flat();
    expect(flat.length).toBe(50);
    for (const start of flat)
      for (const value of [...start.degrees, ...start.shift_mm]) {
        expect(Math.abs(value)).toBeLessThanOrEqual(10);
        expect(Math.round(value * 10)).toBeCloseTo(value * 10, 9);
      }
    // Pinned so a changed generator or seed cannot pass unnoticed.
    expect(flat[0]).toEqual({
      degrees: [-0.4, 2.1, -6.4],
      shift_mm: [-0.5, -5.8, 4.8],
    });
    expect(flat[49]).toEqual({
      degrees: [-3.8, 8.6, 0.1],
      shift_mm: [-2, -9.5, -8.5],
    });
    expect(new Set(flat.map((start) => JSON.stringify(start))).size).toBe(50);
  });

  it("turns about the pivot and then shifts", () => {
    const moved = perturbed(identity, [10, 0, 0], {
      degrees: [0, 0, 90],
      shift_mm: [1, 2, 3],
    });
    // The pivot itself only shifts; a point 5 mm along x from it swings to y.
    const at = (x: number[]) =>
      moved
        .slice(0, 3)
        .map((row) => row[0] * x[0] + row[1] * x[1] + row[2] * x[2] + row[3]);
    expect(at([10, 0, 0])).toEqual([11, 2, 3]);
    at([15, 0, 0]).forEach((value, i) =>
      expect(value).toBeCloseTo([11, 7, 3][i], 6),
    );
    // Composed onto a reference that is not the identity.
    const reference = perturbed(identity, [0, 0, 0], {
      degrees: [20, -30, 40],
      shift_mm: [5, 6, 7],
    });
    const still = perturbed(reference, [3, 4, 5], {
      degrees: [0, 0, 0],
      shift_mm: [0, 0, 0],
    });
    expect(
      meanTargetError(new Float32Array([1, 2, 3, -4, 5, 6]), still, reference),
    ).toBeLessThan(1e-5);
    const shifted = perturbed(reference, [3, 4, 5], {
      degrees: [0, 0, 0],
      shift_mm: [0, 3, 4],
    });
    expect(
      meanTargetError(
        new Float32Array([1, 2, 3, -4, 5, 6]),
        shifted,
        reference,
      ),
    ).toBeCloseTo(5, 5);
  });

  it("summarizes errors, counting runs with no proposal as failures", () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4, 5], 0.9)).toBeCloseTo(4.6);
    expect(summarize([0.5, 1.5, 4, 8, null])).toEqual({
      runs: 5,
      no_proposal: 1,
      median: 2.75,
      mean: 3.5,
      p90: 6.8,
      max: 8,
      success: [0.2, 0.4, 0.6],
    });
    expect(summarize([null])).toEqual({
      runs: 1,
      no_proposal: 1,
      median: null,
      mean: null,
      p90: null,
      max: null,
      success: [0, 0, 0],
    });
  });
});
