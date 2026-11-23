/** Reads the Ljubljana 3D-2D cerebral angiogram set into this planner's
 * view model, for an offline known-pose evaluation. Research only: nothing
 * here is reachable from the application.
 *
 * The set stores, per subject, one frontal and one lateral frame, each with
 * a camera pose and intrinsics in the conventions of DiffDRR, the renderer
 * its Hugging Face copy was prepared for. As read from DiffDRR's source
 * (detector.py, drr.py, data.py and pose.py):
 *
 * - World is volume RAS moved so the volume's center is the origin.
 * - A camera has the source at its origin, +x toward image right, +y toward
 *   image up and +z toward the detector. A camera point maps to world by the
 *   stored pose applied after a fixed turn (x, y, z) -> (x, -z, y).
 * - The central ray meets the detector `x0` and `y0` millimeters from its
 *   middle, toward image right and image down for positive values.
 *
 * The last line was settled on the frames, not the source, whose current
 * version reads as the opposite sign for `x0`. Before the evaluation
 * protocol was fixed, the vessel points of every subject were projected at
 * the stored pose and slid across each of the twenty frames, mirrored and
 * not. The darkest alignment fell at the offsets above, to within the
 * six-pixel search step in all but two frames and within fourteen pixels
 * in those, and never on a mirrored frame.
 *
 * This planner's view model has no principal-point offset and no detector
 * roll. The offset is removed by cutting each frame to the largest window
 * centered on the central ray, to within half a stored pixel. The roll is
 * removed by choosing the C-arm frame: any two camera orientations can be
 * written as two primary and secondary angle pairs in one suitably turned
 * frame, because their relative turn always has an x-z-x decomposition. */
import { viewFrame, type ViewNumbers } from "../carmGeometry";
import type { Vec3 } from "../obliqueSlice";
import { orthonormal } from "../projectionRegistration";
import { VESSEL_TARGET_LIMITS } from "../vesselness2d";

export type StoredView = {
  /** DiffDRR pose, 4 by 4. */
  pose: number[][];
  intrinsics: {
    sdd: number;
    delx: number;
    dely: number;
    x0: number;
    y0: number;
  };
  width: number;
  height: number;
};
export type FrameWindow = {
  /** Window in stored pixels. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Stored pixels averaged into one frame pixel, per axis. */
  factor: number;
  /** How far the window's middle is from the central ray, in stored pixels. */
  residual_px: [number, number];
};
export type ReferencePlane = {
  view: ViewNumbers;
  isocenter: Vec3;
  frame: { width: number; height: number };
  window: FrameWindow;
};
export type ReferenceGeometry = {
  /** Volume center in RAS millimeters. Stored points are relative to it. */
  center: Vec3;
  /** Reference rigid volume-RAS to C-arm-RAS matrix. */
  matrix: number[][];
  /** Frontal, then lateral. */
  planes: [ReferencePlane, ReferencePlane];
};

const rad = Math.PI / 180;
type M3 = number[][];
const mul = (a: M3, b: M3): M3 =>
  a.map((row) =>
    [0, 1, 2].map(
      (j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j],
    ),
  );
const transpose = (a: M3): M3 =>
  [0, 1, 2].map((i) => [0, 1, 2].map((j) => a[j][i]));
const apply = (a: M3, x: readonly number[]): Vec3 => [
  a[0][0] * x[0] + a[0][1] * x[1] + a[0][2] * x[2],
  a[1][0] * x[0] + a[1][1] * x[1] + a[1][2] * x[2],
  a[2][0] * x[0] + a[2][1] * x[1] + a[2][2] * x[2],
];
/** Columns are this planner's image right, image up and beam direction. */
function viewAxes(primary_deg: number, secondary_deg: number): M3 {
  const { u, v, d } = viewFrame(primary_deg, secondary_deg);
  return [0, 1, 2].map((i) => [u[i], v[i], d[i]]);
}
const BASE = viewAxes(0, 0);

/** Camera axes as world columns, and the source, of a stored view. */
function storedCamera(view: StoredView): { axes: M3; source: Vec3 } {
  const p = view.pose;
  if (
    !Array.isArray(p) ||
    p.length !== 4 ||
    p.some(
      (row) =>
        !Array.isArray(row) || row.length !== 4 || !row.every(Number.isFinite),
    )
  )
    throw new Error("Invalid stored pose");
  // Pose after the fixed turn (x, y, z) -> (x, -z, y): columns x, z and -y.
  // `orthonormal` rebuilds the third column from the first two, so a pose
  // that mirrors is refused here instead of being quietly repaired.
  const right = [p[0][0], p[1][0], p[2][0]],
    up = [p[0][2], p[1][2], p[2][2]],
    beam = [-p[0][1], -p[1][1], -p[2][1]];
  const handed =
    (right[1] * up[2] - right[2] * up[1]) * beam[0] +
    (right[2] * up[0] - right[0] * up[2]) * beam[1] +
    (right[0] * up[1] - right[1] * up[0]) * beam[2];
  if (!(Math.abs(handed - 1) < 1e-3)) throw new Error("Invalid stored pose");
  const axes = orthonormal(
    [0, 1, 2].map((i) => [p[i][0], p[i][2], -p[i][1], 0]),
  ).map((row) => row.slice(0, 3));
  return { axes, source: [p[0][3], p[1][3], p[2][3]] };
}

/** The largest window of whole frame pixels centered on the central ray. */
export function frameWindow(view: StoredView): FrameWindow {
  const { delx, dely, x0, y0 } = view.intrinsics,
    { width, height } = view;
  if (
    ![delx, dely, x0, y0].every(Number.isFinite) ||
    !(delx > 0 && dely > 0) ||
    !Number.isInteger(width) ||
    !Number.isInteger(height)
  )
    throw new Error("Invalid stored intrinsics");
  // Where the central ray meets the detector, in stored pixels from the
  // left and top edges.
  const column = width / 2 + x0 / delx,
    row = height / 2 + y0 / dely;
  const reach = (at: number, n: number) => 2 * Math.floor(Math.min(at, n - at));
  const factor = Math.ceil(
    Math.max(reach(column, width), reach(row, height)) /
      VESSEL_TARGET_LIMITS.max_side_px,
  );
  // Of the two largest windows that fit, the one centered more closely.
  const fit = (at: number, n: number): [number, number, number] => {
    const found: [number, number, number][] = [];
    for (
      let size = factor * Math.floor(n / factor);
      size > 0 && found.length < 2;
      size -= factor
    ) {
      const start = Math.round(at - size / 2);
      if (start >= 0 && start + size <= n)
        found.push([start, size, start + size / 2 - at]);
    }
    if (found.length === 0) throw new Error("The central ray misses the frame");
    return found.length === 2 && Math.abs(found[1][2]) < Math.abs(found[0][2])
      ? found[1]
      : found[0];
  };
  const [left, w, dx] = fit(column, width),
    [top, h, dy] = fit(row, height);
  return { left, top, width: w, height: h, factor, residual_px: [dx, dy] };
}

/** The window of a stored 16-bit frame as 8-bit gray: block means, then the
 * high byte. No contrast window is chosen. */
export function windowGray(
  pixels: Uint16Array,
  view: StoredView,
  window: FrameWindow,
): Uint8Array {
  if (pixels.length !== view.width * view.height)
    throw new Error("Frame does not match its stored size");
  const f = window.factor,
    w = window.width / f,
    h = window.height / f,
    out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let j = 0; j < f; j++) {
        const at = (window.top + y * f + j) * view.width + window.left + x * f;
        for (let i = 0; i < f; i++) sum += pixels[at + i];
      }
      out[y * w + x] = Math.min(255, Math.floor(sum / (f * f) / 256));
    }
  return out;
}

export function referenceGeometry(
  volumeShape: readonly number[],
  volumeAffine: number[][],
  frontal: StoredView,
  lateral: StoredView,
): ReferenceGeometry {
  const middle = volumeShape.map((n) => (n - 1) / 2),
    center = [0, 1, 2].map(
      (i) =>
        volumeAffine[i][0] * middle[0] +
        volumeAffine[i][1] * middle[1] +
        volumeAffine[i][2] * middle[2] +
        volumeAffine[i][3],
    ) as Vec3;
  const stored = [frontal, lateral],
    cameras = stored.map(storedCamera);
  // BASE (A^T B) BASE^T = Rx(-secondary A) Rz(primary B - primary A) Rx(secondary B).
  const g = mul(
    mul(BASE, mul(transpose(cameras[0].axes), cameras[1].axes)),
    transpose(BASE),
  );
  let angles: [number, number, number] | null = null;
  for (const sign of [1, -1]) {
    const alpha = Math.atan2(sign * g[2][0], sign * g[1][0]) / rad,
      beta = Math.atan2(sign * Math.hypot(g[1][0], g[2][0]), g[0][0]) / rad,
      gamma = Math.atan2(sign * g[0][2], -sign * g[0][1]) / rad;
    if (Math.abs(alpha) <= 90 && Math.abs(gamma) <= 90) {
      angles = [-alpha, beta, gamma];
      break;
    }
  }
  if (!angles || !(Math.hypot(g[1][0], g[2][0]) > 1e-3))
    throw new Error(
      "These two views have no primary and secondary angles in one frame",
    );
  const pairs = [
    [0, angles[0]],
    [angles[1], angles[2]],
  ];
  // World to C-arm: the turn that takes camera A's axes to its view's axes.
  const turn = mul(
    viewAxes(pairs[0][0], pairs[0][1]),
    transpose(cameras[0].axes),
  );
  const moved = apply(turn, center);
  const matrix = orthonormal(turn.map((row, i) => [...row, -moved[i]]));
  const planes = stored.map((view, k): ReferencePlane => {
    const [primary_deg, secondary_deg] = pairs[k],
      { d } = viewFrame(primary_deg, secondary_deg),
      source = apply(turn, cameras[k].source);
    // The isocenter is the point of the central ray nearest the volume center.
    const source_isocenter_mm = -(
      source[0] * d[0] +
      source[1] * d[1] +
      source[2] * d[2]
    );
    const window = frameWindow(view);
    return {
      view: {
        primary_deg,
        secondary_deg,
        source_detector_mm: view.intrinsics.sdd,
        source_isocenter_mm,
        detector_width_mm: window.width * view.intrinsics.delx,
        detector_height_mm: window.height * view.intrinsics.dely,
      },
      isocenter: source.map(
        (value, i) => value + source_isocenter_mm * d[i],
      ) as Vec3,
      frame: {
        width: window.width / window.factor,
        height: window.height / window.factor,
      },
      window,
    };
  });
  return { center, matrix, planes: [planes[0], planes[1]] };
}

/** One stored view on its own: the C-arm frame is chosen so that the view is
 * the one at primary 0 and secondary 0, with the volume center at its
 * origin. For sets whose frames are not a frontal and lateral pair. A set
 * whose frames are already cut gives its own `window`. */
export function singleViewGeometry(
  volumeShape: readonly number[],
  volumeAffine: number[][],
  view: StoredView,
  window: FrameWindow = frameWindow(view),
): { center: Vec3; matrix: number[][]; plane: ReferencePlane } {
  const middle = volumeShape.map((n) => (n - 1) / 2),
    center = [0, 1, 2].map(
      (i) =>
        volumeAffine[i][0] * middle[0] +
        volumeAffine[i][1] * middle[1] +
        volumeAffine[i][2] * middle[2] +
        volumeAffine[i][3],
    ) as Vec3;
  const stored = storedCamera(view),
    turn = mul(BASE, transpose(stored.axes)),
    moved = apply(turn, center),
    source = apply(turn, stored.source),
    { d } = viewFrame(0, 0);
  const source_isocenter_mm = -(
    source[0] * d[0] +
    source[1] * d[1] +
    source[2] * d[2]
  );
  return {
    center,
    matrix: orthonormal(turn.map((row, i) => [...row, -moved[i]])),
    plane: {
      view: {
        primary_deg: 0,
        secondary_deg: 0,
        source_detector_mm: view.intrinsics.sdd,
        source_isocenter_mm,
        detector_width_mm: window.width * view.intrinsics.delx,
        detector_height_mm: window.height * view.intrinsics.dely,
      },
      isocenter: source.map(
        (value, i) => value + source_isocenter_mm * d[i],
      ) as Vec3,
      frame: {
        width: window.width / window.factor,
        height: window.height / window.factor,
      },
      window,
    },
  };
}

/** Stored points, relative to the volume center, as volume RAS triples. */
export function storedPoints(
  relative: Float32Array,
  center: Vec3,
): Float32Array {
  const out = new Float32Array(relative.length);
  for (let k = 0; k < relative.length; k++)
    out[k] = relative[k] + center[k % 3];
  return out;
}

/** Mean distance, in millimeters, between where two rigid matrices put the
 * same points: the mean target registration error at those points. */
export function meanTargetError(
  points: Float32Array,
  a: number[][],
  b: number[][],
): number {
  let sum = 0;
  for (let k = 0; k < points.length; k += 3) {
    let square = 0;
    for (let i = 0; i < 3; i++) {
      const delta =
        (a[i][0] - b[i][0]) * points[k] +
        (a[i][1] - b[i][1]) * points[k + 1] +
        (a[i][2] - b[i][2]) * points[k + 2] +
        (a[i][3] - b[i][3]);
      square += delta * delta;
    }
    sum += Math.sqrt(square);
  }
  return sum / (points.length / 3);
}
