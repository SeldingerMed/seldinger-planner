import { expect, test } from "vitest";
import type { NVImage } from "@niivue/niivue";
import { renderEndoluminal } from "./endoluminal";
test("first-person intensity-boundary rays recover a known physical wall distance", () => {
  const img = new Float32Array(17 ** 3);
  for (let z = 2; z <= 13; z++)
    for (let y = 2; y <= 13; y++)
      for (let x = 2; x <= 13; x++) img[x + 17 * (y + 17 * z)] = 100;
  const volume = {
    img,
    hdr: {
      dims: [3, 17, 17, 17, 1, 1, 1, 1],
      xyzt_units: 2,
      datatypeCode: 16,
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
  const result = renderEndoluminal(
    volume,
    { point: [8, 8, 8], tangent: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    {
      resolution: 33,
      field_of_view_deg: 60,
      depth_mm: 12,
      step_mm: 0.5,
      threshold: 50,
    },
  );
  const center = 16 * 33 + 16;
  expect(result.depth_mm[center]).toBeCloseTo(13 + 0.5 - 8, 5);
  expect(result.rgba[center * 4 + 3]).toBe(255);
  expect(result.hit_count).toBeGreaterThan(0);
});
