import { expect, test } from "vitest";
import { NVImage } from "@niivue/niivue";
import { planeBasis, sampleObliqueSlice, type Vec3 } from "./obliqueSlice";

// Native voxel ramp in real NIfTI bytes. No patient data or WebGL.
async function fixture(
  affine = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ],
  short = false,
) {
  const dims = [2, 3, 4];
  const buffer = new ArrayBuffer(352 + 24 * (short ? 2 : 4));
  const view = new DataView(buffer);
  view.setInt32(0, 348, true);
  [3, ...dims, 1, 1, 1, 1].forEach((v, i) =>
    view.setInt16(40 + i * 2, v, true),
  );
  view.setInt16(70, short ? 4 : 16, true);
  view.setInt16(72, short ? 16 : 32, true);
  [1, 1, 1, 1, 1, 1, 1, 1].forEach((v, i) =>
    view.setFloat32(76 + i * 4, v, true),
  );
  view.setFloat32(108, 352, true);
  view.setFloat32(112, short ? 2 : 1, true);
  view.setFloat32(116, short ? -100 : 0, true);
  view.setUint8(123, 2);
  view.setInt16(254, 1, true);
  affine
    .slice(0, 3)
    .forEach((r, i) =>
      r.forEach((v, j) => view.setFloat32(280 + i * 16 + j * 4, v, true)),
    );
  new Uint8Array(buffer, 344, 4).set([110, 43, 49, 0]);
  for (let z = 0; z < 4; z++)
    for (let y = 0; y < 3; y++)
      for (let x = 0; x < 2; x++) {
        const index = x + 2 * y + 6 * z;
        const value = x + 10 * y + 100 * z;
        if (short) view.setInt16(352 + 2 * index, value, true);
        else view.setFloat32(352 + 4 * index, value, true);
      }
  return NVImage.loadFromUrl({
    url:
      "data:application/octet-stream;base64," +
      btoa(String.fromCharCode(...new Uint8Array(buffer))),
    name: "analytic-native.nii",
  });
}
const centered = { minX: -0.5, maxX: 0.5, minY: -0.5, maxY: 0.5 };
const sliceAt = (
  image: NVImage,
  point: Vec3,
  window: [number, number] = [0, 400],
) => sampleObliqueSlice(image, point, [0, 0, 1], centered, window, 1);
const gray = (hu: number, lo = 0, hi = 400) =>
  new Uint8ClampedArray([
    255 * Math.max(0, Math.min(1, (hu - lo) / (hi - lo))),
  ])[0];

test("basis exactly matches existing ref-cross-normal contour orientation", () => {
  const [u, v] = planeBasis([0, 0, 1]);
  expect(u).toEqual([0, -1, 0]);
  expect(v).toEqual([1, 0, -0]);
});

test.each([
  {
    affine: [
      [-2, 0, 0, 10],
      [0, -3, 0, 20],
      [0, 0, 4, -30],
      [0, 0, 0, 1],
    ],
  },
  {
    affine: [
      [0, 0, -4, 10],
      [-2, 0, 0, 20],
      [0, 3, 0, -30],
      [0, 0, 0, 1],
    ],
  },
  {
    affine: [
      [2, 0.5, 0, 10],
      [0, 3, 0.25, -20],
      [0, 0, 4, 30],
      [0, 0, 0, 1],
    ],
  },
])(
  "native affine survives flips, permutation and shear: %j",
  async ({ affine }) => {
    const image = await fixture(affine);
    const native = [0.4, 1.4, 2.4, 1];
    const world = affine
      .slice(0, 3)
      .map((r) => r.reduce((s, v, i) => s + v * native[i], 0)) as Vec3;
    const result = sliceAt(image, world);
    expect(result.outside).toBe(0);
    expect(Array.from(result.rgba)).toEqual([
      gray(254.4),
      gray(254.4),
      gray(254.4),
      255,
    ]);
  },
);

test("a fractional native midpoint interpolates the eight corners, not rounded voxels", async () => {
  const image = await fixture();
  const r = sliceAt(image, [0.5, 0.5, 0.5]);
  expect(r.rgba[0]).toBe(gray(55.5));
  expect(r.rgba[3]).toBe(255);
});

test("actual signed-short NIfTI applies slope and intercept once", async () => {
  const image = await fixture(undefined, true);
  const r = sliceAt(image, [0.5, 0.5, 0.5], [-100, 500]);
  expect(r.rgba[0]).toBe(gray(11, -100, 500));
});

test("plane pixels and contour coordinates use the same positive-u/positive-v directions", async () => {
  const image = await fixture();
  const r = sampleObliqueSlice(
    image,
    [0.5, 1, 1],
    [0, 0, 1],
    { minX: -1, maxX: 1, minY: -1, maxY: 1 },
    [0, 400],
    2,
  );
  // u=-Y,v=+X: world/native top-left(0,1.5,1), top-right(0,.5,1).
  expect(r.rgba[0]).toBe(gray(115));
  expect(r.rgba[4]).toBe(gray(105));
  expect(r.rgba[8]).toBe(gray(116));
  expect(r.rgba[12]).toBe(gray(106));
});

test("native volume edges are included and outside pixels stay transparent", async () => {
  const image = await fixture();
  expect(sliceAt(image, [1, 2, 3]).rgba[3]).toBe(255);
  const outside = sliceAt(image, [-0.01, 1, 1]);
  expect(outside.outside).toBe(1);
  expect(Array.from(outside.rgba)).toEqual([0, 0, 0, 0]);
});

test("bounded output defaults to128 and caps at256", async () => {
  const image = await fixture();
  const a = sampleObliqueSlice(
    image,
    [0.5, 1, 1],
    [0, 0, 1],
    centered,
    [0, 400],
  );
  expect(a.width).toBe(128);
  const b = sampleObliqueSlice(
    image,
    [0.5, 1, 1],
    [0, 0, 1],
    centered,
    [0, 400],
    4096,
  );
  expect(b.width).toBe(256);
  expect(b.rgba.length).toBe(256 * 256 * 4);
});

test("nonfinite sampled pixels refuse the slice", async () => {
  const image = await fixture();
  image.img![0] = NaN;
  expect(() => sliceAt(image, [0.5, 0.5, 0.5])).toThrow(/Nonfinite/);
});

test("source units, datatype, shape and buffer guards fail closed", async () => {
  const image = await fixture();
  const hdr = image.hdr!;
  hdr.xyzt_units = 0;
  expect(() => sliceAt(image, [0, 0, 0])).toThrow(/units/);
  hdr.xyzt_units = 2;
  hdr.datatypeCode = 128;
  expect(() => sliceAt(image, [0, 0, 0])).toThrow(/scalar/);
  hdr.datatypeCode = 16;
  hdr.dims[0] = 4;
  expect(() => sliceAt(image, [0, 0, 0])).toThrow(/3D/);
  hdr.dims[0] = 3;
  hdr.dims[1] = 201;
  hdr.dims[2] = 200;
  hdr.dims[3] = 200;
  expect(() => sliceAt(image, [0, 0, 0])).toThrow(/cap/);
  hdr.dims[1] = 2;
  hdr.dims[2] = 3;
  hdr.dims[3] = 4;
  image.img = new Float32Array(4);
  expect(() => sliceAt(image, [0, 0, 0])).toThrow(/buffer/);
});

test("malformed native affine, scaling and plane inputs are rejected", async () => {
  const image = await fixture();
  const old = image.hdr!.affine;
  image.hdr!.affine = [
    [0, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  expect(() => sliceAt(image, [0, 0, 0])).toThrow(/affine/);
  image.hdr!.affine = old;
  image.hdr!.scl_inter = Infinity;
  expect(() => sliceAt(image, [0, 0, 0])).toThrow(/scaling/);
  image.hdr!.scl_inter = 0;
  for (const n of [
    [0, 0, 0],
    [NaN, 0, 1],
    [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE],
  ] as Vec3[])
    expect(() => planeBasis(n)).toThrow();
  expect(() => sliceAt(image, [Infinity, 0, 0])).toThrow(/origin/);
  expect(() => sliceAt(image, [0, 0, 0], [0, 0])).toThrow(/window/);
  expect(() =>
    sampleObliqueSlice(
      image,
      [0, 0, 0],
      [0, 0, 1],
      { minX: 0, maxX: 201, minY: 0, maxY: 1 },
      [0, 400],
    ),
  ).toThrow(/extent/);
});
