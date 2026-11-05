import { expect, test } from "vitest";
import { Niivue, NVImage } from "@niivue/niivue";

// Analytic, in-memory NIfTI-1 fixture. No patient or demonstration imagery.
async function nifti(affine: number[][]) {
  const buffer = new ArrayBuffer(352 + 2 * 3 * 4 * 2);
  const view = new DataView(buffer);
  view.setInt32(0, 348, true);
  [3, 2, 3, 4, 1, 1, 1, 1].forEach((v, i) =>
    view.setInt16(40 + i * 2, v, true),
  );
  view.setInt16(70, 4, true);
  view.setInt16(72, 16, true);
  [1, 2, 3, 4, 1, 1, 1, 1].forEach((v, i) =>
    view.setFloat32(76 + i * 4, v, true),
  );
  view.setFloat32(108, 352, true);
  view.setFloat32(112, 1, true);
  view.setUint8(123, 2);
  view.setInt16(254, 1, true);
  affine
    .slice(0, 3)
    .forEach((row, r) =>
      row.forEach((v, c) => view.setFloat32(280 + r * 16 + c * 4, v, true)),
    );
  new Uint8Array(buffer, 344, 4).set([110, 43, 49, 0]);
  return NVImage.loadFromUrl({
    url:
      "data:application/octet-stream;base64," +
      btoa(String.fromCharCode(...new Uint8Array(buffer))),
    name: "analytic-coordinate-fixture.nii",
  });
}

test("LAS voxel storage maps to RAS world coordinates independently of radiological display", async () => {
  const image = await nifti([
    [-2, 0, 0, 10],
    [0, 3, 0, -20],
    [0, 0, 4, 30],
    [0, 0, 0, 1],
  ]);
  const nv = new Niivue({ isRadiologicalConvention: true });
  nv.volumes = [image];
  const fraction = image.convertVox2Frac([0, 1, 1]); // Original LAS voxel (1,1,1), reordered to RAS voxel (0,1,1).
  const expected = [10 - 2, -20 + 3, 30 + 4];
  const first = Array.from(nv.frac2mm(fraction, 0, true)).slice(0, 3);
  first.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 5));
  nv.opts.isRadiologicalConvention = false;
  expect(Array.from(nv.frac2mm(fraction, 0, true)).slice(0, 3)).toEqual(first);
  const back = nv.mm2frac(expected as [number, number, number], 0, true);
  Array.from(back).forEach((v, i) => expect(v).toBeCloseTo(fraction[i], 5));
});

test("oblique physical-affine round trip is consistent in both display conventions", async () => {
  const image = await nifti([
    [2, 0.5, 0, 10],
    [0, 3, 0.25, -20],
    [0, 0, 4, 30],
    [0, 0, 0, 1],
  ]);
  const nv = new Niivue({ isRadiologicalConvention: true });
  nv.volumes = [image];
  const fraction: [number, number, number] = [0.35, 0.45, 0.55];
  const physical = nv.frac2mm(fraction, 0, true);
  const recovered = nv.mm2frac(physical, 0, true);
  Array.from(recovered).forEach((v, i) =>
    expect(v).toBeCloseTo(fraction[i], 5),
  );
  const ortho = nv.frac2mm(fraction, 0, false);
  expect(Array.from(ortho)).not.toEqual(Array.from(physical));
  nv.opts.isRadiologicalConvention = false;
  expect(Array.from(nv.frac2mm(fraction, 0, true))).toEqual(
    Array.from(physical),
  );
});
