import { describe, expect, it } from "vitest";
import { camera } from "../carmGeometry";
import { inPlaneErrorMm, poseDistanceMm, vesselScores } from "./controlScore";

const I = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];
const shifted = (x: number, y: number, z: number) => [
  [1, 0, 0, x],
  [0, 1, 0, y],
  [0, 0, 1, z],
  [0, 0, 0, 1],
];
const VIEW = {
  primary_deg: 0,
  secondary_deg: 0,
  source_detector_mm: 1200,
  source_isocenter_mm: 800,
  detector_width_mm: 360,
  detector_height_mm: 360,
};
const points = new Float64Array([0, 0, 0, 10, 0, 0, 0, 0, 10, -5, 3, 2]);

describe("control scoring", () => {
  it("measures where two poses put the points in three dimensions", () => {
    expect(poseDistanceMm(points, I, I)).toEqual({ mean: 0, max: 0 });
    const d = poseDistanceMm(points, I, shifted(3, 4, 0));
    expect(d.mean).toBeCloseTo(5);
    expect(d.max).toBeCloseTo(5);
  });

  it("counts a move across the beam and ignores one along it, at the isocentre", () => {
    const cam = camera(VIEW, [0, 0, 0]);
    // An AP view looks along RAS y: a move along y leaves the points'
    // places on the frame nearly where they were.
    const along = inPlaneErrorMm(cam, 1.5, points, I, shifted(0, 6, 0));
    const across = inPlaneErrorMm(cam, 1.5, points, I, shifted(6, 0, 0));
    expect(across.mean).toBeCloseTo(6, 0);
    expect(along.mean).toBeLessThan(0.2);
  });

  it("scores each vessel group, and all vessel points together", () => {
    const cam = camera(VIEW, [0, 0, 0]);
    const groups = {
      aorta: [
        [0, 0, 0],
        [0, 0, 10],
      ],
      bifurcation: [[0, 0, 0]],
    };
    const out = vesselScores(cam, 1.5, groups, I, shifted(0, 0, 2));
    expect(Object.keys(out).sort()).toEqual(["all", "aorta", "bifurcation"]);
    expect(out.all.three_d_mm.mean).toBeCloseTo(2, 9);
    expect(out.bifurcation.three_d_mm.max).toBeCloseTo(2, 9);
    // 2 mm along the patient's long axis is across an AP beam.
    expect(out.aorta.in_plane_mm.mean).toBeGreaterThan(1.5);
    expect(out.aorta.in_plane_mm.mean).toBeLessThan(2.5);
  });
});
