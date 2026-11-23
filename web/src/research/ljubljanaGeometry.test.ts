import { describe, expect, it } from "vitest";
import { camera, project } from "../carmGeometry";
import { rotation } from "../projectionRegistration";
import {
  frameWindow,
  meanTargetError,
  referenceGeometry,
  singleViewGeometry,
  storedPoints,
  windowGray,
  type StoredView,
} from "./ljubljanaGeometry";

/** A stored pose: rotation by `degrees` about fixed x, y, z, then `shift`. */
function pose(degrees: number[], shift: number[]): number[][] {
  const r = rotation(degrees[0], degrees[1], degrees[2]);
  return [
    [r[0], r[1], r[2], shift[0]],
    [r[3], r[4], r[5], shift[1]],
    [r[6], r[7], r[8], shift[2]],
    [0, 0, 0, 1],
  ];
}
/** Detector position in stored pixels from the left and top edges, written
 * out from the stored conventions with no code from the module under test:
 * the camera sees (x, y, z) where world is pose * (x, -z, y), and the
 * central ray lands `x0` right of and `y0` below the detector's middle. */
function storedPixel(view: StoredView, world: number[]): [number, number] {
  const p = view.pose,
    rel = [0, 1, 2].map((i) => world[i] - p[i][3]),
    turned = [0, 1, 2].map(
      (j) => p[0][j] * rel[0] + p[1][j] * rel[1] + p[2][j] * rel[2],
    ),
    cam = [turned[0], turned[2], -turned[1]],
    { sdd, delx, dely, x0, y0 } = view.intrinsics;
  return [
    view.width / 2 + x0 / delx + ((sdd / delx) * cam[0]) / cam[2],
    view.height / 2 + y0 / dely - ((sdd / dely) * cam[1]) / cam[2],
  ];
}

const AFFINE = [
  [-0.5, 0, 0, 60],
  [0, 0.5, 0, -70],
  [0, 0, 0.5, -40],
  [0, 0, 0, 1],
];
const SHAPE = [240, 260, 200];
const frontal: StoredView = {
  pose: pose([2, -3, 18], [219, 713, -4]),
  intrinsics: { sdd: 1196, delx: 0.154, dely: 0.154, x0: -24.9, y0: 4.1 },
  width: 2480,
  height: 1920,
};
const lateral: StoredView = {
  pose: pose([-4, 2, 88], [-782, 9, 6]),
  intrinsics: { sdd: 1250, delx: 0.154, dely: 0.154, x0: 15.3, y0: -3.2 },
  width: 1920,
  height: 2480,
};

describe("Ljubljana reference geometry", () => {
  it("reproduces the stored cameras through this planner's view model", () => {
    const g = referenceGeometry(SHAPE, AFFINE, frontal, lateral);
    // The volume center, by hand: index (119.5, 129.5, 99.5).
    expect(g.center).toEqual([0.25, -5.25, 9.75]);
    let state = 7;
    const draw = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return (state / 2 ** 32) * 120 - 60;
    };
    [frontal, lateral].forEach((view, k) => {
      const plane = g.planes[k],
        cam = camera(plane.view, plane.isocenter),
        { window } = plane;
      expect(plane.view.source_detector_mm).toBe(view.intrinsics.sdd);
      expect(Math.abs(window.residual_px[0])).toBeLessThanOrEqual(0.5);
      expect(Math.abs(window.residual_px[1])).toBeLessThanOrEqual(0.5);
      for (let n = 0; n < 50; n++) {
        const ras = [
            g.center[0] + draw(),
            g.center[1] + draw(),
            g.center[2] + draw(),
          ],
          carm = g.matrix
            .slice(0, 3)
            .map(
              (row) =>
                row[0] * ras[0] + row[1] * ras[1] + row[2] * ras[2] + row[3],
            ),
          [right, up] = project(cam, carm),
          expected = storedPixel(
            view,
            ras.map((value, i) => value - g.center[i]),
          );
        // Through the view model, back to stored pixels by way of the window.
        const column =
            window.left + window.width / 2 + right / view.intrinsics.delx,
          row = window.top + window.height / 2 - up / view.intrinsics.dely;
        expect(column - window.residual_px[0]).toBeCloseTo(expected[0], 3);
        expect(row - window.residual_px[1]).toBeCloseTo(expected[1], 3);
      }
    });
    // The isocenter is the foot of the volume center on each central ray.
    for (const plane of g.planes) {
      const { d } = camera(plane.view, plane.isocenter);
      expect(
        plane.isocenter[0] * d[0] +
          plane.isocenter[1] * d[1] +
          plane.isocenter[2] * d[2],
      ).toBeCloseTo(0, 6);
    }
    expect(g.planes[0].view.primary_deg).toBe(0);
    expect(Math.abs(g.planes[1].view.primary_deg)).toBeGreaterThan(60);
  });

  it("cuts the largest whole-pixel window centered on the central ray", () => {
    const w = frameWindow(frontal);
    // Central ray at column 1240 - 24.9 / 0.154 = 1078.31 and row
    // 960 + 4.1 / 0.154 = 986.62; the nearer edges allow 2156 by 1866.
    expect(w.factor).toBe(3);
    expect(w.width % 3).toBe(0);
    expect(w.height % 3).toBe(0);
    expect(w.left).toBeGreaterThanOrEqual(0);
    expect(w.top + w.height).toBeLessThanOrEqual(1920);
    expect(w.left + w.width / 2 - w.residual_px[0]).toBeCloseTo(1078.3117, 3);
    expect(w.top + w.height / 2 - w.residual_px[1]).toBeCloseTo(986.6234, 3);
    expect(w.width).toBeGreaterThan(2156 - 6);
    expect(w.height).toBeGreaterThan(1866 - 6);
    expect(Math.max(w.width, w.height) / w.factor).toBeLessThanOrEqual(1024);
    const small = frameWindow({
      ...frontal,
      width: 600,
      height: 400,
      intrinsics: { ...frontal.intrinsics, x0: 0, y0: 0 },
    });
    expect(small).toEqual({
      left: 0,
      top: 0,
      width: 600,
      height: 400,
      factor: 1,
      residual_px: [0, 0],
    });
    expect(() =>
      frameWindow({
        ...frontal,
        intrinsics: { ...frontal.intrinsics, x0: 400 },
      }),
    ).toThrow("The central ray misses the frame");
    expect(() =>
      frameWindow({
        ...frontal,
        intrinsics: { ...frontal.intrinsics, delx: 0 },
      }),
    ).toThrow("Invalid stored intrinsics");
  });

  it("averages blocks of the window and keeps the high byte", () => {
    const view: StoredView = {
      ...frontal,
      width: 6,
      height: 4,
      intrinsics: { ...frontal.intrinsics, x0: 0, y0: 0 },
    };
    const pixels = new Uint16Array(24);
    for (let i = 0; i < 24; i++) pixels[i] = 256 * (i + 1);
    const window = {
      left: 2,
      top: 0,
      width: 4,
      height: 4,
      factor: 2,
      residual_px: [0, 0] as [number, number],
    };
    // Blocks of rows 0-1 and 2-3, columns 2-3 and 4-5.
    expect([...windowGray(pixels, view, window)]).toEqual([6, 8, 18, 20]);
    pixels.fill(65535);
    expect([...windowGray(pixels, view, window)]).toEqual([255, 255, 255, 255]);
    expect(() => windowGray(pixels.slice(1), view, window)).toThrow(
      "Frame does not match its stored size",
    );
  });

  it("refuses views it cannot express", () => {
    expect(() => referenceGeometry(SHAPE, AFFINE, frontal, frontal)).toThrow(
      "These two views have no primary and secondary angles in one frame",
    );
    expect(() =>
      referenceGeometry(
        SHAPE,
        AFFINE,
        { ...frontal, pose: [[1, 0, 0, 0]] },
        lateral,
      ),
    ).toThrow("Invalid stored pose");
    // A pose that mirrors, or scales, is not a camera pose.
    const mirrored = frontal.pose.map((row) => [
      row[0],
      -row[1],
      row[2],
      row[3],
    ]);
    expect(() =>
      referenceGeometry(SHAPE, AFFINE, { ...frontal, pose: mirrored }, lateral),
    ).toThrow("Invalid stored pose");
  });

  it("measures the mean target error between two matrices", () => {
    const points = storedPoints(
      new Float32Array([0, 0, 0, 10, 0, 0]),
      [1, 2, 3],
    );
    expect([...points]).toEqual([1, 2, 3, 11, 2, 3]);
    const still = pose([0, 0, 0], [0, 0, 0]);
    expect(meanTargetError(points, still, still)).toBe(0);
    expect(
      meanTargetError(points, still, pose([0, 0, 0], [3, 4, 0])),
    ).toBeCloseTo(5);
    // A quarter turn about z moves (1, 2, 3) by |(-3, -1)| and (11, 2, 3) by |(-13, 9)|.
    expect(
      meanTargetError(points, still, pose([0, 0, 90], [0, 0, 0])),
    ).toBeCloseTo((Math.hypot(3, 1) + Math.hypot(13, 9)) / 2);
  });
});

describe("one stored view on its own", () => {
  it("is the view at primary 0, secondary 0 of its own C-arm frame", () => {
    for (const view of [frontal, lateral]) {
      const g = singleViewGeometry(SHAPE, AFFINE, view),
        { plane } = g,
        { window } = plane,
        cam = camera(plane.view, plane.isocenter);
      expect(g.center).toEqual([0.25, -5.25, 9.75]);
      expect(plane.view.primary_deg).toBe(0);
      expect(plane.view.secondary_deg).toBe(0);
      expect(plane.view.source_detector_mm).toBe(view.intrinsics.sdd);
      // The volume center sits at the C-arm frame's origin.
      for (let i = 0; i < 3; i++)
        expect(
          g.matrix[i][0] * g.center[0] +
            g.matrix[i][1] * g.center[1] +
            g.matrix[i][2] * g.center[2] +
            g.matrix[i][3],
        ).toBeCloseTo(0, 6);
      for (const offset of [
        [0, 0, 0],
        [40, -25, 10],
        [-30, 15, -45],
        [5, 50, 35],
      ]) {
        const ras = offset.map((value, i) => g.center[i] + value),
          carm = g.matrix
            .slice(0, 3)
            .map(
              (row) =>
                row[0] * ras[0] + row[1] * ras[1] + row[2] * ras[2] + row[3],
            ),
          [right, up] = project(cam, carm),
          expected = storedPixel(view, offset);
        const column =
            window.left + window.width / 2 + right / view.intrinsics.delx,
          row = window.top + window.height / 2 - up / view.intrinsics.dely;
        expect(column - window.residual_px[0]).toBeCloseTo(expected[0], 3);
        expect(row - window.residual_px[1]).toBeCloseTo(expected[1], 3);
      }
    }
  });
});
