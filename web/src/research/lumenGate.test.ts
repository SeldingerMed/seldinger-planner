import { describe, expect, it } from "vitest";

import { decide, type LumenCamera } from "./lumenGate";

// A 40x40 frame, bright everywhere except one dark pixel at (10,10).
const SIZE = 40;
const bright = () => new Uint8Array(SIZE * SIZE).fill(255);
const gray = bright();
gray[10 * SIZE + 10] = 40;

// Detector scale fixed: 1000 mm source-detector over 100 px focal gives
// 10 mm per pixel at the detector.
const camera: LumenCamera = {
  fx_px: 100,
  fy_px: 100,
  cx_px: 20,
  cy_px: 20,
  width_px: SIZE,
  height_px: SIZE,
  source_to_detector_mm: 1000,
};

// Identity pose: model point [x, y, z] lands in camera coordinates directly,
// so u = 100 * x / z + 20. With z = 100 the model x equals the pixel u - 20.
const atPixel = (u: number, v: number) => [u - 20, v - 20, 100];
const pose = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];
const shiftedPose = (du: number) => [
  [1, 0, 0, du * 1],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

describe("lumenGate.decide", () => {
  it("accepts when all branches are supported and the paired start agrees", () => {
    const branches = [
      [atPixel(10, 10), atPixel(10, 10), atPixel(10, 10), atPixel(10, 10)],
      [atPixel(10, 10), atPixel(10, 10), atPixel(10, 10), atPixel(10, 10)],
    ];
    const result = decide(camera, branches, gray, pose, pose);
    expect(result).toEqual({
      accepted: true,
      reasons: [],
      supported_fraction: 1,
      start_disagreement_mm: 0,
    });
  });

  it("rejects with a preserved reason when branch support is partial", () => {
    const branches = [
      [atPixel(10, 10), atPixel(10, 10), atPixel(10, 10), atPixel(10, 10)],
      [atPixel(30, 30), atPixel(30, 30), atPixel(30, 30), atPixel(30, 30)],
    ];
    const result = decide(camera, branches, gray, pose, pose);
    expect(result.accepted).toBe(false);
    expect(result.reasons).toContain("unsupported_branches");
    expect(result.supported_fraction).toBeCloseTo(0.5, 12);
    expect(result.start_disagreement_mm).toBe(0);
  });

  it("refuses and skips comparison when the pose is a native failure", () => {
    const branches = [[atPixel(10, 10), atPixel(10, 10)]];
    const result = decide(camera, branches, gray, null, pose);
    expect(result.accepted).toBe(false);
    expect(result.reasons).toEqual(["missing_pose"]);
    expect(result.supported_fraction).toBeNull();
    expect(result.start_disagreement_mm).toBeNull();
  });

  it("refuses with no comparison when the paired start is missing", () => {
    const branches = [[atPixel(10, 10), atPixel(10, 10)]];
    const result = decide(camera, branches, gray, pose, null);
    expect(result.accepted).toBe(false);
    expect(result.reasons).toContain("missing_paired_start");
    expect(result.start_disagreement_mm).toBeNull();
    expect(result.supported_fraction).toBe(1);
  });

  it("counts an off-frame sample as unsupported, not a separate veto", () => {
    // One of the two points projects to u = -1, off the detector; the other
    // lands on ink, so the branch still reaches half-support.
    const branches = [[atPixel(-1, 10), atPixel(10, 10)]];
    const result = decide(camera, branches, gray, pose, pose);
    expect(result.accepted).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.supported_fraction).toBe(1);
  });

  it("rejects depth disagreement even on the identical central ray", () => {
    const other = pose.map((row) => [...row]);
    other[2][3] = 20;
    const r = decide(camera, [[[0, 0, 100]]], bright().fill(0), pose, other);
    expect(r.start_disagreement_mm).toBe(20);
    expect(r.accepted).toBe(false);
  });

  it("accepts paired starts exactly 5 mm apart (inclusive boundary)", () => {
    // The pose translations are physical mm, not detector mm.
    const branches = [[atPixel(10, 10), atPixel(10, 10)]];
    const result = decide(camera, branches, gray, pose, shiftedPose(5));
    expect(result.start_disagreement_mm).toBeCloseTo(5, 12);
    expect(result.accepted).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("rejects paired starts just past the 5 mm boundary", () => {
    const branches = [[atPixel(10, 10), atPixel(10, 10)]];
    const result = decide(camera, branches, gray, pose, shiftedPose(6));
    expect(result.start_disagreement_mm).toBeCloseTo(6, 12);
    expect(result.accepted).toBe(false);
    expect(result.reasons).toContain("start_disagreement_exceeds_5_mm");
  });
});
