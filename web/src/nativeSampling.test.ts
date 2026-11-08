import { expect, test } from "vitest";
import type { NVImage } from "@niivue/niivue";
import { createNativeSampler } from "./nativeSampling";
function volume() {
  const img = new Float32Array(4 * 5 * 6);
  for (let z = 0; z < 6; z++)
    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 4; x++) img[x + 4 * (y + 5 * z)] = x + 2 * y + 4 * z;
  return {
    img,
    hdr: {
      dims: [3, 4, 5, 6, 1, 1, 1, 1],
      xyzt_units: 2,
      datatypeCode: 16,
      scl_slope: 2,
      scl_inter: -100,
    },
    getAffine: () => [
      [0, -2, 0, 10],
      [3, 0, 0, -5],
      [0, 0, 4, 7],
      [0, 0, 0, 1],
    ],
  } as unknown as NVImage;
}
test("native sampler preserves physical affine, fractional interpolation and intensity scaling", () => {
  const sampler = createNativeSampler(volume());
  expect(sampler.sample([5, -1.25, 19])).toBeCloseTo(
    (1.25 + 2 * 2.5 + 4 * 3) * 2 - 100,
    10,
  );
  expect(sampler.sample([10, 1000, 7])).toBe(null);
});

test("zero NIfTI slope disables both scaling terms as in the upstream reader", () => {
  const image = volume();
  image.hdr!.scl_slope = 0;
  expect(createNativeSampler(image).sample([5, -1.25, 19])).toBeCloseTo(
    1.25 + 2 * 2.5 + 4 * 3,
    10,
  );
});
