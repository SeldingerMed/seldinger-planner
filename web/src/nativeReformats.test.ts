import { test, expect } from "vitest";
import type { NVImage } from "@niivue/niivue";
import { renderNativeScene } from "./nativeReformats";
function cube() {
  const data = new Float32Array(17 ** 3);
  for (let z = 2; z <= 13; z++)
    for (let y = 2; y <= 13; y++)
      for (let x = 2; x <= 13; x++) data[x + 17 * (y + 17 * z)] = 100;
  return {
    hdr: {
      dims: [3, 17, 17, 17, 1, 1, 1, 1],
      datatypeCode: 16,
      xyzt_units: 2,
      scl_slope: 1,
      scl_inter: 0,
      affine: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
    },
    getAffine: () => [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ],
    img: data,
  } as unknown as NVImage;
}
const options = {
  span_mm: 4,
  roll_degrees: 0,
  station_fraction: 0,
  threshold: 50,
  primary_window: [0, 100] as [number, number],
  secondary_window: [0, 100] as [number, number],
  opacity: 0.5,
};
test("composes real native CPR, perspective boundary rays and registered cross-section", () => {
  const volume = cube();
  const result = renderNativeScene(
    volume,
    [
      [8, 8, 8],
      [8, 8, 10],
    ],
    options,
    {
      volume,
      transform: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
    },
  );
  expect(result.straightened.outside).toBe(0);
  expect(result.stretched.outside).toBe(0);
  expect(result.endoluminal?.depth_mm[16 * 33 + 16]).toBeCloseTo(5.5);
  expect(
    result.fusion?.rgba.slice((16 * 33 + 16) * 4, (16 * 33 + 16) * 4 + 4),
  ).toEqual(new Uint8ClampedArray([128, 255, 255, 255]));
  expect(result.provenance.station_mm).toBe(0);
  expect(result.provenance.fusion_method).toBe("operator_confirmed_rigid_ras");
  expect(JSON.stringify(result.provenance)).not.toMatch(
    /"path"|"transform"|"pixels"/,
  );
});
test("a threshold miss suppresses only the flythrough, not valid CPR", () => {
  const result = renderNativeScene(
    cube(),
    [
      [8, 8, 8],
      [8, 8, 10],
    ],
    { ...options, threshold: 101 },
  );
  expect(result.straightened.rgba.some((x) => x === 255)).toBe(true);
  expect(result.endoluminal).toBeNull();
  expect(result.endoluminal_error).toMatch(/threshold/);
  expect(result.fusion).toBeNull();
});
test("path navigation moves the actual perspective camera in physical millimeters", () => {
  const result = renderNativeScene(
    cube(),
    [
      [8, 8, 8],
      [8, 8, 10],
    ],
    { ...options, station_fraction: 0.5 },
  );
  expect(result.provenance.station_mm).toBe(1);
  expect(result.endoluminal?.depth_mm[16 * 33 + 16]).toBeCloseTo(4.5);
});
