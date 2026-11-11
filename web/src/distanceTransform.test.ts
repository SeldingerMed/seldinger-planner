import { describe, expect, it } from "vitest";
import {
  distanceToSeeds,
  FAR_SQUARED,
  squaredDistanceInBox,
} from "./distanceTransform";

function lcg(seed: number) {
  let state = seed >>> 0;
  return () =>
    (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

describe("distance transforms", () => {
  it("matches a brute-force 2D distance and honors the cap", () => {
    const width = 23,
      height = 17,
      random = lcg(3),
      seeds = new Uint8Array(width * height);
    for (let i = 0; i < seeds.length; i++) seeds[i] = random() < 0.04 ? 1 : 0;
    seeds[5 * width + 9] = 1;
    const out = distanceToSeeds(seeds, width, height, 6);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        let best = Infinity;
        for (let j = 0; j < height; j++)
          for (let i = 0; i < width; i++)
            if (seeds[j * width + i])
              best = Math.min(best, Math.hypot(x - i, y - j));
        expect(out[y * width + x]).toBeCloseTo(Math.min(6, best), 5);
      }
  });

  it("reads the cap everywhere when there is no seed, and rejects a wrong grid", () => {
    expect([...distanceToSeeds(new Uint8Array(12), 4, 3, 9)]).toEqual(
      new Array(12).fill(9),
    );
    expect(() => distanceToSeeds(new Uint8Array(11), 4, 3, 9)).toThrow(
      "Invalid seed grid",
    );
  });

  it("matches a brute-force 3D distance on an anisotropic grid", () => {
    const shape = [9, 7, 6] as const,
      spacing = [0.5, 1.25, 2] as const,
      random = lcg(11),
      count = shape[0] * shape[1] * shape[2],
      field = new Float32Array(count),
      zero: number[][] = [];
    for (let z = 0, at = 0; z < shape[2]; z++)
      for (let y = 0; y < shape[1]; y++)
        for (let x = 0; x < shape[0]; x++, at++)
          if (random() < 0.1) zero.push([x, y, z]);
          else field[at] = FAR_SQUARED;
    const steps = squaredDistanceInBox(field, shape, spacing);
    let yields = 0;
    while (!steps.next().done) yields++;
    expect(yields).toBeGreaterThanOrEqual(3);
    for (let z = 0, at = 0; z < shape[2]; z++)
      for (let y = 0; y < shape[1]; y++)
        for (let x = 0; x < shape[0]; x++, at++) {
          let best = Infinity;
          for (const [i, j, k] of zero)
            best = Math.min(
              best,
              ((x - i) * spacing[0]) ** 2 +
                ((y - j) * spacing[1]) ** 2 +
                ((z - k) * spacing[2]) ** 2,
            );
          expect(field[at]).toBeCloseTo(best, 3);
        }
    expect(() =>
      squaredDistanceInBox(new Float32Array(5), shape, spacing).next(),
    ).toThrow("Invalid distance box");
  });
});
