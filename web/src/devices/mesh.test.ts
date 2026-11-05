import { describe, expect, it } from "vitest";
import { lineTubes, binarySTL } from "./mesh";

describe("physical-space device rendering buffers", () => {
  it("keeps translated RAS vertices and fixed display wire radius", () => {
    const m = lineTubes(
      [
        [
          [10, 20, 30],
          [10, 20, 35],
        ],
      ],
      0.1,
      6,
    );
    expect(m.points.length).toBe(12);
    expect(m.triangles.length).toBe(12);
    expect(Math.min(...m.points.map((p) => p[2]))).toBe(30);
    expect(Math.max(...m.points.map((p) => p[2]))).toBe(35);
    for (const p of m.points)
      expect(Math.hypot(p[0] - 10, p[1] - 20)).toBeCloseTo(0.1);
    const b = binarySTL(m);
    expect(new DataView(b).getUint32(80, true)).toBe(12);
    expect(b.byteLength).toBe(84 + 50 * 12);
  });
});
