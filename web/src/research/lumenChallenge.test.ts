import { it, expect } from "vitest";
import { admit, transfer } from "./lumenChallenge";
const p = {
  schema: "lumen-registration/1",
  case_id: "full-tree-v1",
  image: "image.png",
  geometry: "geometry.json",
  provenance: "procedural",
  camera: {
    axes: "+x right, +y down, +z forward (right-handed, source at origin, screen y down)",
    width_px: 512,
    height_px: 512,
    fx_px: 1600,
    fy_px: 1600,
    cx_px: 255.5,
    cy_px: 255.5,
    source_to_detector_mm: 600,
  },
};
it("checks the pinned frame identity and axes before running the method", () => {
  expect(admit(p, p.case_id)).toEqual(p.camera);
  expect(() => admit(p, "selective-b-v1")).toThrow(/problem contract/);
  expect(() =>
    admit({ ...p, camera: { ...p.camera, axes: "metres" } }, p.case_id),
  ).toThrow(/problem contract/);
});
it("left-multiplies camera calibration, including its rotation", () => {
  const cal = [
      [0, -1, 0, 2],
      [1, 0, 0, 3],
      [0, 0, 1, 4],
      [0, 0, 0, 1],
    ],
    a = [
      [1, 0, 0, 5],
      [0, 1, 0, 0],
      [0, 0, 1, 400],
      [0, 0, 0, 1],
    ];
  const c = {
    schema: "lumen-camera-pair/1",
    from_case: "overlap-a-v1",
    to_case: "overlap-b-v1",
    camera_a_to_camera_b_mm: cal,
  };
  expect(transfer(c, a)).toEqual([
    [0, -1, 0, 2],
    [1, 0, 0, 8],
    [0, 0, 1, 404],
    [0, 0, 0, 1],
  ]);
  expect(() => transfer({ ...c, from_case: c.to_case }, a)).toThrow(
    /calibration/,
  );
});
