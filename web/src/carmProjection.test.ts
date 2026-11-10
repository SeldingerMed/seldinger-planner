import { expect, test } from "vitest";
import type { NVImage } from "@niivue/niivue";
import type { ViewNumbers } from "./carmGeometry";
import {
  detectorToPixel,
  projectOverlay,
  renderProjection,
} from "./carmProjection";
import type { Vec3 } from "./obliqueSlice";

/** 41-voxel 1 mm cube centered on the world origin, background 0. */
function phantom(fill: (x: number, y: number, z: number) => number) {
  const n = 41,
    img = new Float32Array(n * n * n);
  for (let z = 0; z < n; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++)
        img[x + n * (y + n * z)] = fill(x - 20, y - 20, z - 20);
  return {
    img,
    hdr: {
      dims: [3, n, n, n, 1, 1, 1, 1],
      xyzt_units: 2,
      datatypeCode: 16,
      scl_slope: 1,
      scl_inter: 0,
    },
    getAffine: () => [
      [1, 0, 0, -20],
      [0, 1, 0, -20],
      [0, 0, 1, -20],
      [0, 0, 0, 1],
    ],
  } as unknown as NVImage;
}
const VIEW: ViewNumbers = {
  primary_deg: 0,
  secondary_deg: 0,
  source_detector_mm: 1200,
  source_isocenter_mm: 600,
  detector_width_mm: 128,
  detector_height_mm: 128,
};
const OPTIONS = { width_px: 64, height_px: 64, step_mm: 0.5, threshold: 0 };
const darkest = (image: ReturnType<typeof renderProjection>) => {
  let best = 0;
  for (let i = 0; i < image.width * image.height; i++)
    if (image.rgba[i * 4] < image.rgba[best * 4]) best = i;
  return [best % image.width, Math.floor(best / image.width)];
};

test("a point marker lands where the pinhole model predicts, with magnification", () => {
  // Bright 3 mm blob 8 mm toward the patient's left and 6 mm cranial.
  const marker: Vec3 = [-8, 0, 6];
  const volume = phantom((x, y, z) =>
    Math.abs(x - marker[0]) <= 1 &&
    Math.abs(y) <= 1 &&
    Math.abs(z - marker[2]) <= 1
      ? 1000
      : 0,
  );
  const image = renderProjection(volume, VIEW, [0, 0, 0], OPTIONS);
  // Magnification 2: detector position (+16 mm right, +12 mm up). The pixel
  // pitch is 2 mm, so the expected pixel is (32 + 8, 32 - 6) = (40, 26).
  const [px, py] = darkest(image);
  expect(Math.abs(px + 0.5 - 40)).toBeLessThanOrEqual(1);
  expect(Math.abs(py + 0.5 - 26)).toBeLessThanOrEqual(1);
  const overlay = projectOverlay(VIEW, [0, 0, 0], [marker, [0, 0, 0]], image);
  expect(overlay.path[0][0]).toBeCloseTo(40, 9);
  expect(overlay.path[0][1]).toBeCloseTo(26, 9);
  expect(overlay.isocenter).toEqual([32, 32]);
  expect(image.rgba[3]).toBe(255);
  expect(image.rgba[0]).toBe(235); // empty corner stays light
});

test("rotating to a left lateral moves an anterior marker to image left", () => {
  const volume = phantom((x, y, z) =>
    Math.abs(x) <= 1 && Math.abs(y - 8) <= 1 && Math.abs(z) <= 1 ? 1000 : 0,
  );
  const lateral = renderProjection(
    volume,
    { ...VIEW, primary_deg: 90 },
    [0, 0, 0],
    OPTIONS,
  );
  // At LAO 90 image right is the patient's posterior, so +8 mm anterior
  // projects to -16 mm: pixel x = 32 - 8 = 24, on the horizontal midline.
  const [px, py] = darkest(lateral);
  expect(Math.abs(px + 0.5 - 24)).toBeLessThanOrEqual(1);
  expect(Math.abs(py + 0.5 - 32)).toBeLessThanOrEqual(1);
});

test("the central ray sum through a uniform slab equals thickness times excess", () => {
  // 11 voxel-thick slab (y in -5..5) of value 300 across the whole field.
  const volume = phantom((_x, y) => (Math.abs(y) <= 5 ? 300 : 0));
  const image = renderProjection(volume, VIEW, [0, 0, 0], {
    ...OPTIONS,
    step_mm: 0.1,
    threshold: 100,
  });
  // Along the central ray the trilinear profile is 300 for 10 mm, then falls
  // linearly to 0 over 1 mm at each face. Excess over 100 is 200 * 10 = 2000
  // in the plateau, and on each ramp the integral of (200 - 300 s) for s from
  // 0 to 2/3, which is 66.67. Total 2133.33. Oblique rays inside the 40 mm
  // phantom are at most 2.7 degrees off axis, so the peak is under 0.2 percent
  // above the central value.
  const central = 2000 + 2 * (200 * (2 / 3) - 150 * (4 / 9));
  expect(central).toBeCloseTo(2133.3333, 3);
  expect(image.peak).toBeGreaterThan(central * 0.999);
  expect(image.peak).toBeLessThan(central * 1.003);
  expect(image.rays_through_volume).toBeGreaterThan(0);
  expect(image.samples).toBeGreaterThan(image.rays_through_volume);
});

test("threshold above every value yields a blank, light field", () => {
  const volume = phantom(() => 50);
  const image = renderProjection(volume, VIEW, [0, 0, 0], {
    ...OPTIONS,
    threshold: 60,
  });
  expect(image.peak).toBe(0);
  expect(new Set(image.rgba.filter((_, i) => i % 4 === 0))).toEqual(
    new Set([235]),
  );
});

test("a camera that misses the volume renders nothing and does not throw", () => {
  const volume = phantom(() => 500);
  const image = renderProjection(volume, VIEW, [500, 0, 0], OPTIONS);
  expect(image.rays_through_volume).toBe(0);
  expect(image.peak).toBe(0);
});

test("invalid options, nonfinite data and oversize requests fail closed", () => {
  const volume = phantom(() => 1);
  for (const change of [
    { width_px: 4 },
    { height_px: 1024 },
    { width_px: 64.5 },
    { step_mm: 0 },
    { step_mm: Number.NaN },
    { threshold: Number.POSITIVE_INFINITY },
  ])
    expect(() =>
      renderProjection(volume, VIEW, [0, 0, 0], { ...OPTIONS, ...change }),
    ).toThrow();
  expect(() =>
    renderProjection(
      phantom((x) => (x === 0 ? Number.NaN : 1)),
      VIEW,
      [0, 0, 0],
      OPTIONS,
    ),
  ).toThrow(/Nonfinite/);
  expect(() =>
    renderProjection(
      phantom((x) => (x === 0 ? Number.NEGATIVE_INFINITY : 1)),
      VIEW,
      [0, 0, 0],
      OPTIONS,
    ),
  ).toThrow(/Nonfinite/);
  expect(() =>
    renderProjection(volume, VIEW, [0, 0, 0], {
      width_px: 512,
      height_px: 512,
      step_mm: 0.1,
      threshold: 0,
    }),
  ).toThrow(/sample budget/);
  expect(() =>
    renderProjection(
      volume,
      { ...VIEW, source_isocenter_mm: 1200 },
      [0, 0, 0],
      OPTIONS,
    ),
  ).toThrow();
});

test("detector millimeters map to pixels with image up on screen up", () => {
  const size = { width: 100, height: 50 };
  expect(detectorToPixel(VIEW, size, 0, 0)).toEqual([50, 25]);
  expect(detectorToPixel(VIEW, size, 64, 64)).toEqual([100, 0]);
  expect(detectorToPixel(VIEW, size, -64, -64)).toEqual([0, 50]);
});
