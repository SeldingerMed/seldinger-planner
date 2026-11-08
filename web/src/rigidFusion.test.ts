import { expect, test } from "vitest";
import type { NVImage } from "@niivue/niivue";
import { createFusionSampler, validateRigid } from "./rigidFusion";
function ramp() {
  const img = new Float32Array(125);
  for (let z = 0; z < 5; z++)
    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 5; x++) img[x + 5 * (y + 5 * z)] = x + 2 * y + 4 * z;
  return {
    img,
    hdr: {
      dims: [3, 5, 5, 5, 1, 1, 1, 1],
      datatypeCode: 16,
      xyzt_units: 2,
      scl_slope: 1,
      scl_inter: 0,
    },
    getAffine: () => [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ],
  } as unknown as NVImage;
}
test("fusion samples the inverse secondary-to-primary RAS transform", () => {
  const t = [
    [0, -1, 0, 4],
    [1, 0, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  const sampler = createFusionSampler(ramp(), ramp(), t, {
    primary_window: [0, 16],
    secondary_window: [0, 16],
    opacity: 0.5,
  });
  const result = sampler.sample([2, 1, 1]);
  const g0 = ((2 + 2 * 1 + 4 * 1) / 16) * 255,
    g1 = ((1 + 2 * 2 + 4 * 1) / 16) * 255;
  expect(result.rgba).toEqual(
    Array.from(
      new Uint8ClampedArray([
        g0 * 0.5,
        g0 * 0.5 + g1 * 0.5,
        g0 * 0.5 + g1 * 0.5,
        255,
      ]),
    ),
  );
  expect(result.secondary_missing).toBe(false);
});

test("rigid registration rejects scale, reflection and nonhomogeneous rows without silently fixing them", () => {
  for (const t of [
    [
      [2, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ],
    [
      [-1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ],
    [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [1, 0, 0, 1],
    ],
  ])
    expect(() => validateRigid(t)).toThrow();
});
test("missing moving data retains primary grayscale rather than blending a fabricated zero", () => {
  const sampler = createFusionSampler(
    ramp(),
    ramp(),
    [
      [1, 0, 0, 100],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ],
    { primary_window: [0, 16], secondary_window: [0, 16], opacity: 1 },
  );
  expect(sampler.sample([2, 1, 1])).toEqual({
    rgba: [128, 128, 128, 255],
    secondary_missing: true,
    primary_outside: false,
  });
  expect(sampler.sample([99, 1, 1]).rgba).toEqual([0, 0, 0, 0]);
});
