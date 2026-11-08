/** First-person intensity-boundary ray casting, not an animated orthogonal slice. */
import type { NVImage } from "@niivue/niivue";
import type { Vec3 } from "./obliqueSlice";
import { createNativeSampler } from "./nativeSampling";
export type CameraPose = { point: Vec3; tangent: Vec3; u: Vec3; v: Vec3 };
export type EndoluminalOptions = {
  resolution: number;
  field_of_view_deg: number;
  depth_mm: number;
  step_mm: number;
  threshold: number;
};
const dot = (a: Vec3, b: Vec3) => a.reduce((s, x, i) => s + x * b[i], 0);
export function renderEndoluminal(
  volume: NVImage,
  pose: CameraPose,
  options: EndoluminalOptions,
) {
  const {
    resolution: size,
    field_of_view_deg: fov,
    depth_mm: depth,
    step_mm: step,
    threshold,
  } = options;
  if (
    !Number.isInteger(size) ||
    size < 16 ||
    size > 96 ||
    ![fov, depth, step, threshold].every(Number.isFinite) ||
    fov <= 0 ||
    fov > 120 ||
    depth <= 0 ||
    depth > 200 ||
    step <= 0 ||
    step > 2 ||
    Math.ceil(depth / step) > 128
  )
    throw new Error("Invalid bounded endoluminal sampling options");
  const { point, tangent: t, u, v } = pose;
  if (
    ![point, t, u, v].every(
      (p) => p.length === 3 && p.every(Number.isFinite),
    ) ||
    [t, u, v].some((p) => Math.abs(Math.hypot(...p) - 1) > 1e-6) ||
    Math.abs(dot(t, u)) > 1e-6 ||
    Math.abs(dot(t, v)) > 1e-6 ||
    Math.abs(dot(u, v)) > 1e-6
  )
    throw new Error("Invalid camera frame");
  const cross: Vec3 = [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
  if (dot(cross, t) < 1 - 1e-6)
    throw new Error("Camera frame must preserve handedness");
  const sampler = createNativeSampler(volume),
    camera = sampler.sample(point);
  if (camera === null || camera < threshold)
    throw new Error(
      "Path station is outside the threshold-defined bright lumen",
    );
  const rgba = new Uint8ClampedArray(size * size * 4),
    depths = new Float32Array(size * size);
  depths.fill(NaN);
  const scale = Math.tan((fov * Math.PI) / 360),
    steps = Math.ceil(depth / step);
  let hitCount = 0;
  for (let row = 0; row < size; row++)
    for (let col = 0; col < size; col++) {
      const x = (((col + 0.5) / size) * 2 - 1) * scale,
        y = (((row + 0.5) / size) * 2 - 1) * scale;
      let ray = t.map((n, i) => n + u[i] * x + v[i] * y) as Vec3;
      const len = Math.hypot(...ray);
      ray = ray.map((n) => n / len) as Vec3;
      let previous = camera,
        previousDistance = 0;
      for (let k = 1; k <= steps; k++) {
        const distance = Math.min(depth, k * step),
          p = point.map((n, i) => n + distance * ray[i]) as Vec3,
          value = sampler.sample(p);
        if (value === null) break;
        if (value < threshold) {
          const fraction = (previous - threshold) / (previous - value),
            hit = previousDistance + (distance - previousDistance) * fraction;
          const surface = point.map((n, i) => n + hit * ray[i]) as Vec3;
          const gradient = ([0, 1, 2] as const).map((axis) => {
            const a = [...surface] as Vec3,
              b = [...surface] as Vec3;
            a[axis] -= 0.25;
            b[axis] += 0.25;
            const sa = sampler.sample(a),
              sb = sampler.sample(b);
            return sa === null || sb === null ? 0 : sb - sa;
          }) as Vec3;
          const normalLength = Math.hypot(...gradient),
            light =
              normalLength > 1e-12
                ? Math.abs(dot(gradient, ray)) / normalLength
                : 1;
          const shade = 0.2 + 0.8 * light,
            index = row * size + col;
          rgba.set([150 * shade, 190 * shade, 210 * shade, 255], index * 4);
          depths[index] = hit;
          hitCount++;
          break;
        }
        previous = value;
        previousDistance = distance;
      }
    }
  return {
    width: size,
    height: size,
    rgba,
    depth_mm: depths,
    hit_count: hitCount,
  };
}
