/** Contract tests for the Lumen-to-native proposal adapter
 * (lumen-registration-protocol.md step 1). The camera contract, the fixed
 * improper basis shared by camera and model mirror, the pixel/mm tracer,
 * the rigid conversion in both directions, one real proposal against a
 * synthetic rendered frame, and the blank-frame failure. */
import { describe, expect, it } from "vitest";
import { camera as carmCamera, project, viewFrame } from "../carmGeometry";
import { EVIDENCE_REGISTRATION_METHOD } from "../evidenceRegistration";
import { validateRigid } from "../rigidFusion";
import type { LumenCamera } from "./lumenGate";
import {
  LUMEN_DEPTH_PRIOR_FRACTION,
  LUMEN_MIRROR_BASIS,
  fromNativeMatrix,
  lumenIsocenterDepth,
  lumenMmPerPixel,
  lumenView,
  mirrorModelPoint,
  runProposal,
  toNativeStart,
  validateLumenCamera,
} from "./lumenProposal";

const SID = 900;
const baseCamera: LumenCamera = {
  fx_px: 1000,
  fy_px: 1000,
  cx_px: 255.5,
  cy_px: 255.5,
  width_px: 512,
  height_px: 512,
  source_to_detector_mm: SID,
};

const det3 = (m: number[][]): number =>
  m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
  m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
  m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);

const mul3 = (a: number[][], b: number[][]): number[][] =>
  [0, 1, 2].map((i) =>
    [0, 1, 2].map(
      (j) => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j],
    ),
  );

const apply4 = (m: number[][], p: number[]): number[] =>
  [0, 1, 2].map(
    (i) => m[i][0] * p[0] + m[i][1] * p[1] + m[i][2] * p[2] + m[i][3],
  );

const axisRotation = (axis: number[], deg: number): number[][] => {
  const n = Math.hypot(axis[0], axis[1], axis[2]),
    [x, y, z] = axis.map((a) => a / n),
    t = (deg * Math.PI) / 180,
    c = Math.cos(t),
    s = Math.sin(t),
    k = 1 - c;
  return [
    [c + x * x * k, x * y * k - z * s, x * z * k + y * s],
    [y * x * k + z * s, c + y * y * k, y * z * k - x * s],
    [z * x * k - y * s, z * y * k + x * s, c + z * z * k],
  ];
};

const mat4 = (r: number[][], t: number[]): number[][] => [
  [...r[0], t[0]],
  [...r[1], t[1]],
  [...r[2], t[2]],
  [0, 0, 0, 1],
];

/** Two smooth model branches, 40 points in all, spread over roughly a
 * hundred millimetres and kept apart. */
const mirroredBranches: number[][][] = [
  Array.from({ length: 20 }, (_, k) => {
    const t = k / 19;
    return [
      -25 + 60 * t,
      22 + 6 * Math.sin(2 * Math.PI * t),
      10 * Math.sin(2 * Math.PI * t),
    ];
  }),
  Array.from({ length: 20 }, (_, k) => {
    const t = k / 19;
    return [
      -34 - 2 * Math.sin(Math.PI * t),
      -33 + 60 * t,
      -6 * Math.cos(2 * Math.PI * t),
    ];
  }),
];
const rawBranches = mirroredBranches;

/** Lumen camera millimetres to pixels: the declared pinhole, as the gate
 * projects it. */
const lumenPixel = (cam: LumenCamera, c: number[]): [number, number] => [
  (cam.fx_px * c[0]) / c[2] + cam.cx_px,
  (cam.fy_px * c[1]) / c[2] + cam.cy_px,
];

/** Paints the branches at the given pose as dark lines on a light frame. */
function renderFrame(
  branches: number[][][],
  pose: number[][],
  cam: LumenCamera,
): Uint8Array {
  const { width_px: w, height_px: h } = cam,
    gray = new Uint8Array(w * h).fill(240);
  for (const branch of branches)
    for (let k = 1; k < branch.length; k++) {
      const [x0, y0] = lumenPixel(cam, apply4(pose, branch[k - 1])),
        [x1, y1] = lumenPixel(cam, apply4(pose, branch[k])),
        steps = Math.max(
          1,
          Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))),
        );
      for (let s = 0; s <= steps; s++) {
        const x = Math.round(x0 + ((x1 - x0) * s) / steps),
          y = Math.round(y0 + ((y1 - y0) * s) / steps);
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const i = y + dy,
            j = x + dx;
          if (i >= 0 && i < h && j >= 0 && j < w)
            gray[i * w + j] = dx === 0 && dy === 0 ? 25 : 130;
        }
      }
    }
  return gray;
}

const zeroed = (v: number[]): number[] => v.map((x) => (x === 0 ? 0 : x));

describe("Lumen camera and mirror contract", () => {
  it("uses the camera's fixed improper basis at zero angles", () => {
    const { u, v, d } = viewFrame(0, 0);
    expect(zeroed(u)).toEqual([-1, 0, 0]);
    expect(zeroed(v)).toEqual([0, 0, 1]);
    expect(zeroed(d)).toEqual([0, 1, 0]);
    // Mirror columns are (u, -v, d): model (x, y, z) maps to (-x, z, -y).
    expect(LUMEN_MIRROR_BASIS.map(zeroed)).toEqual([
      [-1, 0, 0],
      [0, 0, 1],
      [0, -1, 0],
    ]);
    expect(det3(LUMEN_MIRROR_BASIS)).toBeCloseTo(-1, 12);
    expect(mirrorModelPoint([3, 4, 5])).toEqual([-3, 5, -4]);
    // The native-world placement contract: B·c has the camera's u and d
    // components and the flipped v, so the native pixel mapping (py measured
    // down from the center against v) reproduces the Lumen pinhole.
    for (const c of [
      [10, -7, 3],
      [-2, 5, -11],
    ]) {
      const w = [0, 1, 2].map(
        (i) =>
          LUMEN_MIRROR_BASIS[i][0] * c[0] +
          LUMEN_MIRROR_BASIS[i][1] * c[1] +
          LUMEN_MIRROR_BASIS[i][2] * c[2],
      );
      expect(u[0] * w[0] + u[1] * w[1] + u[2] * w[2]).toBeCloseTo(c[0], 12);
      expect(v[0] * w[0] + v[1] * w[1] + v[2] * w[2]).toBeCloseTo(-c[1], 12);
      expect(d[0] * w[0] + d[1] * w[1] + d[2] * w[2]).toBeCloseTo(c[2], 12);
    }
  });

  it("validates the centered square fx/fy pinhole axis and size contract", () => {
    expect(validateLumenCamera(baseCamera)).toBe(baseCamera);
    const wrong = (patch: Partial<LumenCamera>): LumenCamera => ({
      ...baseCamera,
      ...patch,
    });
    expect(() => validateLumenCamera(wrong({ fy_px: 999 }))).toThrow(/square/);
    expect(() => validateLumenCamera(wrong({ cx_px: 256 }))).toThrow(
      /centered/,
    );
    expect(() => validateLumenCamera(wrong({ cy_px: 255 }))).toThrow(
      /centered/,
    );
    expect(() => validateLumenCamera(wrong({ fx_px: 0 }))).toThrow(/focal/);
    expect(() => validateLumenCamera(wrong({ width_px: 63 }))).toThrow(/size/);
    expect(() => validateLumenCamera(wrong({ height_px: 1025 }))).toThrow(
      /size/,
    );
    expect(() => validateLumenCamera(wrong({ width_px: 511.5 }))).toThrow(
      /size/,
    );
    expect(() =>
      validateLumenCamera(wrong({ source_to_detector_mm: 250 })),
    ).toThrow(/source-detector/);
    // Derived detector sides must stay inside the view model.
    expect(() =>
      validateLumenCamera(wrong({ fx_px: 100, fy_px: 100 })),
    ).toThrow(/detector/);
  });

  it("builds the declared single-plane view from the intrinsics", () => {
    const view = lumenView(baseCamera);
    expect(view.primary_deg).toBe(0);
    expect(view.secondary_deg).toBe(0);
    expect(view.source_detector_mm).toBe(SID);
    expect(view.source_isocenter_mm).toBeCloseTo(
      LUMEN_DEPTH_PRIOR_FRACTION * SID,
      12,
    );
    expect(view.detector_width_mm).toBeCloseTo((SID * 512) / 1000, 12);
    expect(view.detector_height_mm).toBeCloseTo((SID * 512) / 1000, 12);
  });

  it("traces pixels to millimetres at the declared detector scale", () => {
    expect(lumenMmPerPixel(baseCamera)).toBeCloseTo(SID / 1000, 12);
    // Two points at the generic-prior depth, 30 mm apart along the camera
    // u axis, land 30 mm divided by the millimetres per pixel at that
    // depth apart, in pixels.
    const view = lumenView(baseCamera),
      sod = lumenIsocenterDepth(SID),
      cam = carmCamera(view, [0, sod, 0]),
      B = LUMEN_MIRROR_BASIS;
    const world = (cu: number): number[] =>
      [0, 1, 2].map((i) => B[i][0] * cu + B[i][2] * sod);
    const pixel = (w: number[]): number => {
      const [x] = project(cam, w);
      return x * (512 / view.detector_width_mm) + 255.5;
    };
    const a = pixel(world(-15)),
      b = pixel(world(15));
    expect(b - a).toBeCloseTo(30 / (sod / baseCamera.fx_px), 6);
  });
});

describe("Rigid conversion between the Lumen pose and the native matrix", () => {
  const P = mat4(axisRotation([0.3, 1, -0.5], 17), [12, -8, 640]);

  it("keeps the native start proper and conjugates back exactly", () => {
    const n = toNativeStart(P);
    expect(validateRigid(n)).toBeDefined();
    expect(
      det3([n[0].slice(0, 3), n[1].slice(0, 3), n[2].slice(0, 3)]),
    ).toBeCloseTo(1, 9);
    const back = fromNativeMatrix(n);
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 4; j++) expect(back[i][j]).toBeCloseTo(P[i][j], 9);
  });

  it("places mirrored points where the camera geometry says", () => {
    const B = LUMEN_MIRROR_BASIS;
    const n = toNativeStart(P);
    for (const q of mirroredBranches.flat().slice(0, 5)) {
      // Native points are the mirrored coords q = B·p; the conjugated
      // start must land them at B·(pose·p).
      const p = [-q[0], -q[2], q[1]];
      const got = apply4(n, q),
        want = [0, 1, 2].map(
          (i) =>
            B[i][0] * apply4(P, p)[0] +
            B[i][1] * apply4(P, p)[1] +
            B[i][2] * apply4(P, p)[2],
        );
      for (let i = 0; i < 3; i++) expect(got[i]).toBeCloseTo(want[i], 9);
    }
  });

  it("refuses an improper or malformed start", () => {
    const improper = mat4(axisRotation([1, 0, 0], 30), [0, 0, 600]).map(
      (row, i) => (i === 0 ? [-row[0], row[1], row[2], row[3]] : row),
    );
    expect(() => toNativeStart(improper)).toThrow(/handedness/);
    expect(() => toNativeStart([[1, 0, 0, 0]])).toThrow(/4×4/);
  });
});

describe("runProposal against a rendered frame", () => {
  const truth = mat4(
    [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    [5, -3, 600],
  );
  const start = mat4(axisRotation([0, 0, 1], 2), [8, -5, 604]);

  it("recovers the pose with the native method and fixed detector scale", () => {
    const gray = renderFrame(mirroredBranches, truth, baseCamera);
    const { pose, native } = runProposal(baseCamera, rawBranches, gray, start);
    expect(native.method).toBe(EVIDENCE_REGISTRATION_METHOD);
    expect(native.point_count).toBe(40);
    expect(native.planes).toHaveLength(1);
    expect(native.detector_fit).toBe("not_requested");
    expect(native.fit_gain).toBeNull();
    expect(native.planes[0].detector_scale).toBe(1);
    expect(native.planes[0].view.detector_width_mm).toBeCloseTo(
      (SID * 512) / 1000,
      9,
    );
    expect(native.planes[0].score.mean_evidence).toBeGreaterThan(
      native.planes[0].start_score.mean_evidence,
    );
    validateRigid(pose);
    // Whole-tree pose error against the truth, in millimetres.
    let sum = 0;
    let count = 0;
    for (const branch of mirroredBranches)
      for (const q of branch) {
        const got = apply4(pose, q),
          want = apply4(truth, q);
        sum +=
          (got[0] - want[0]) ** 2 +
          (got[1] - want[1]) ** 2 +
          (got[2] - want[2]) ** 2;
        count++;
        const step = Math.hypot(
          got[0] - want[0],
          got[1] - want[1],
          got[2] - want[2],
        );
        expect(step).toBeLessThan(5);
      }
    expect(Math.sqrt(sum / count)).toBeLessThan(3);
    // Rotation within two degrees of the truth.
    const dot =
      (pose[0][0] * truth[0][0] +
        pose[0][1] * truth[0][1] +
        pose[0][2] * truth[0][2] +
        pose[1][0] * truth[1][0] +
        pose[1][1] * truth[1][1] +
        pose[1][2] * truth[1][2] +
        pose[2][0] * truth[2][0] +
        pose[2][1] * truth[2][1] +
        pose[2][2] * truth[2][2] -
        1) /
      2;
    expect(
      (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI,
    ).toBeLessThan(2);
  }, 300_000);

  it("preserves the native failure reason on a blank frame", () => {
    const gray = new Uint8Array(512 * 512).fill(240);
    expect(() => runProposal(baseCamera, rawBranches, gray, start)).toThrow(
      /line-like vessels/,
    );
  });

  it("refuses malformed inputs before any search", () => {
    const gray = new Uint8Array(512 * 512).fill(240);
    expect(() => runProposal(baseCamera, [], gray, start)).toThrow(
      /vessel points/,
    );
    expect(() =>
      runProposal(
        baseCamera,
        [
          [
            [-1, -33, 6],
            [2, 20, 0],
          ],
        ],
        gray,
        start,
      ),
    ).toThrow(/vessel points/);
    expect(() =>
      runProposal(
        baseCamera,
        rawBranches,
        new Uint8Array(512 * 511).fill(240),
        start,
      ),
    ).toThrow(/byte per pixel/);
    expect(() =>
      runProposal(baseCamera, rawBranches, gray, [
        [1, 0, 0, 1e7],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ]),
    ).toThrow(/rigid/i);
  });
});
