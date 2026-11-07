import { expect, test } from "vitest";
import { volumeMetadata, point3 } from "./geometry";
test("reads NIfTI dimensions and absolute physical spacing without inventing measurements", () => {
  expect(
    volumeMetadata({
      dims: [3, 512, 512, 240],
      pixDims: [1, -0.4, 0.4, 0.7],
      sform_code: 1,
    }),
  ).toEqual({
    dimensions: [512, 512, 240],
    spacing_mm: [0.4, 0.4, 0.7],
    spatial_units: "unknown",
  });
});
test("rejects nonphysical image metadata and nonfinite locations", () => {
  expect(() =>
    volumeMetadata({ dims: [3, 0, 512, 240], pixDims: [1, 1, 1, 1] }),
  ).toThrow();
  expect(point3([1, 2, NaN])).toBeNull();
  expect(point3([12.3, -4, 8, 1])).toEqual([12.3, -4, 8]);
});

test("rejects a millimeter header with no declared spatial orientation", () => {
  expect(() =>
    volumeMetadata({
      dims: [3, 10, 10, 10],
      pixDims: [1, 1, 1, 1],
      xyzt_units: 2,
      qform_code: 0,
      sform_code: 0,
    }),
  ).toThrow(/orientation/);
});
