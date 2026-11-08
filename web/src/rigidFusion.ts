/** Operator-authored secondary-RAS→primary-RAS rigid fusion. No registration inference. */
import type { NVImage } from "@niivue/niivue";
import type { Vec3 } from "./obliqueSlice";
import { createNativeSampler } from "./nativeSampling";
export function validateRigid(value: unknown): number[][] {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every(
      (row) =>
        Array.isArray(row) &&
        row.length === 4 &&
        row.every(
          (v) =>
            typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e6,
        ),
    )
  )
    throw new Error("Rigid transform must be a finite4×4 matrix");
  const m = value as number[][];
  if (m[3].some((v, i) => v !== [0, 0, 0, 1][i]))
    throw new Error("Rigid transform needs a homogeneous row");
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      let dot = 0;
      for (let k = 0; k < 3; k++) dot += m[k][i] * m[k][j];
      if (Math.abs(dot - (i === j ? 1 : 0)) > 1e-6)
        throw new Error("Rotation must be orthonormal");
    }
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det - 1) > 1e-6)
    throw new Error("Rotation must preserve handedness");
  return m.map((row) => [...row]);
}
export function inverseRigidPoint(matrix: number[][], point: Vec3): Vec3 {
  return [0, 1, 2].map(
    (i) =>
      matrix[0][i] * (point[0] - matrix[0][3]) +
      matrix[1][i] * (point[1] - matrix[1][3]) +
      matrix[2][i] * (point[2] - matrix[2][3]),
  ) as Vec3;
}
export function grayWindow(value: number, window: [number, number]): number {
  return Math.max(
    0,
    Math.min(255, ((value - window[0]) / (window[1] - window[0])) * 255),
  );
}
export function validateWindow(window: [number, number]) {
  if (
    window.length !== 2 ||
    !window.every(Number.isFinite) ||
    !Number.isFinite(window[1] - window[0]) ||
    window[1] <= window[0]
  )
    throw new Error("Invalid intensity window");
}
export function createFusionSampler(
  primary: NVImage,
  secondary: NVImage,
  transform: unknown,
  options: {
    primary_window: [number, number];
    secondary_window: [number, number];
    opacity: number;
  },
) {
  const matrix = validateRigid(transform),
    base = createNativeSampler(primary),
    moving = createNativeSampler(secondary);
  validateWindow(options.primary_window);
  validateWindow(options.secondary_window);
  const alpha = options.opacity;
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1)
    throw new Error("Opacity must be between0 and1");
  return {
    sample(point: Vec3) {
      const p = base.sample(point);
      if (p === null)
        return {
          rgba: [0, 0, 0, 0],
          secondary_missing: true,
          primary_outside: true,
        };
      const s = moving.sample(inverseRigidPoint(matrix, point)),
        g = grayWindow(p, options.primary_window);
      if (s === null)
        return {
          rgba: Array.from(new Uint8ClampedArray([g, g, g, 255])),
          secondary_missing: true,
          primary_outside: false,
        };
      const q = grayWindow(s, options.secondary_window);
      return {
        rgba: Array.from(
          new Uint8ClampedArray([
            g * (1 - alpha),
            g * (1 - alpha) + q * alpha,
            g * (1 - alpha) + q * alpha,
            255,
          ]),
        ),
        secondary_missing: false,
        primary_outside: false,
      };
    },
  };
}
