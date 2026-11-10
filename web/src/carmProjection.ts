/** Simulated cone-beam projection of a native volume through a C-arm camera.
 *
 * This is a planning preview computed from the cross-sectional source. It is
 * not an acquired angiogram and nothing is registered to one. The image is a
 * perspective ray sum of intensity above an operator threshold, so in CTA it
 * shows contrast-filled lumen together with bone and calcium. */
import type { NVImage } from "@niivue/niivue";
import { camera, project, type ViewNumbers } from "./carmGeometry";
import { createNativeSampler } from "./nativeSampling";
import type { Vec3 } from "./obliqueSlice";

export type ProjectionOptions = {
  width_px: number;
  height_px: number;
  step_mm: number;
  threshold: number;
};
export type ProjectionImage = {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  /** Largest ray sum, in intensity units times millimeters. */
  peak: number;
  rays_through_volume: number;
  samples: number;
};
const MAX_SAMPLES = 40_000_000;

function validateOptions(options: ProjectionOptions) {
  const { width_px, height_px, step_mm, threshold } = options;
  if (
    !Number.isInteger(width_px) ||
    !Number.isInteger(height_px) ||
    width_px < 8 ||
    height_px < 8 ||
    width_px > 512 ||
    height_px > 512
  )
    throw new Error("Invalid projection size");
  if (!Number.isFinite(step_mm) || step_mm < 0.1 || step_mm > 10)
    throw new Error("Invalid projection step");
  if (!Number.isFinite(threshold) || Math.abs(threshold) > 1e6)
    throw new Error("Invalid projection threshold");
}

/** Detector-plane millimeters to pixel coordinates (x right, y down). */
export function detectorToPixel(
  view: ViewNumbers,
  size: { width: number; height: number },
  x_mm: number,
  y_mm: number,
): [number, number] {
  return [
    (x_mm / view.detector_width_mm + 0.5) * size.width,
    (0.5 - y_mm / view.detector_height_mm) * size.height,
  ];
}

export function renderProjection(
  volume: NVImage,
  view: ViewNumbers,
  isocenter: Vec3,
  options: ProjectionOptions,
): ProjectionImage {
  validateOptions(options);
  const sampler = createNativeSampler(volume),
    cam = camera(view, isocenter);
  const { raw, slope, inter, toVoxel } = sampler,
    [nx, ny, nz] = sampler.shape;
  const { width_px: width, height_px: height, step_mm, threshold } = options;
  const source = toVoxel(cam.source);
  const center = cam.source.map(
    (x, i) => x + cam.d[i] * cam.source_detector_mm,
  ) as Vec3;
  const sums = new Float64Array(width * height);
  const limit = [nx - 1, ny - 1, nz - 1];
  let peak = 0,
    through = 0,
    samples = 0;
  for (let j = 0; j < height; j++) {
    const y = (0.5 - (j + 0.5) / height) * 2 * cam.half_height_mm;
    for (let i = 0; i < width; i++) {
      const x = ((i + 0.5) / width - 0.5) * 2 * cam.half_width_mm;
      const pixel: Vec3 = [
        center[0] + cam.u[0] * x + cam.v[0] * y,
        center[1] + cam.u[1] * x + cam.v[1] * y,
        center[2] + cam.u[2] * x + cam.v[2] * y,
      ];
      const length = Math.hypot(
        pixel[0] - cam.source[0],
        pixel[1] - cam.source[1],
        pixel[2] - cam.source[2],
      );
      // The affine is linear, so a fraction t of the world ray is the same
      // fraction of the voxel-space ray. Clip that ray to the voxel box.
      const end = toVoxel(pixel);
      let enter = 0,
        exit = 1,
        miss = false;
      for (let axis = 0; axis < 3; axis++) {
        const origin = source[axis],
          delta = end[axis] - origin;
        if (Math.abs(delta) < 1e-12) {
          if (origin < 0 || origin > limit[axis]) miss = true;
          continue;
        }
        let a = (0 - origin) / delta,
          b = (limit[axis] - origin) / delta;
        if (a > b) [a, b] = [b, a];
        if (a > enter) enter = a;
        if (b < exit) exit = b;
      }
      if (miss || !(exit > enter)) continue;
      const dt = step_mm / length,
        count = Math.floor((exit - enter) / dt);
      if (count < 1) continue;
      samples += count;
      if (samples > MAX_SAMPLES)
        throw new Error("Projection exceeds the sample budget");
      through++;
      let sum = 0;
      for (let k = 0; k < count; k++) {
        const t = enter + (k + 0.5) * dt;
        const vx = Math.min(
            limit[0],
            Math.max(0, source[0] + (end[0] - source[0]) * t),
          ),
          vy = Math.min(
            limit[1],
            Math.max(0, source[1] + (end[1] - source[1]) * t),
          ),
          vz = Math.min(
            limit[2],
            Math.max(0, source[2] + (end[2] - source[2]) * t),
          );
        const x0 = Math.floor(vx),
          y0 = Math.floor(vy),
          z0 = Math.floor(vz),
          x1 = Math.min(x0 + 1, limit[0]),
          y1 = Math.min(y0 + 1, limit[1]),
          z1 = Math.min(z0 + 1, limit[2]),
          fx = vx - x0,
          fy = vy - y0,
          fz = vz - z0;
        const r0 = nx * (y0 + ny * z0),
          r1 = nx * (y1 + ny * z0),
          r2 = nx * (y0 + ny * z1),
          r3 = nx * (y1 + ny * z1);
        const value =
          ((raw[x0 + r0] * (1 - fx) + raw[x1 + r0] * fx) * (1 - fy) +
            (raw[x0 + r1] * (1 - fx) + raw[x1 + r1] * fx) * fy) *
            (1 - fz) +
          ((raw[x0 + r2] * (1 - fx) + raw[x1 + r2] * fx) * (1 - fy) +
            (raw[x0 + r3] * (1 - fx) + raw[x1 + r3] * fx) * fy) *
            fz;
        const scaled = value * slope + inter;
        // NaN and both infinities fail this test; a comparison alone would
        // silently skip them.
        if (scaled - scaled !== 0)
          throw new Error("Nonfinite source sample; refusing projection");
        if (scaled > threshold) sum += scaled - threshold;
      }
      sum *= step_mm;
      if (!Number.isFinite(sum))
        throw new Error("Nonfinite source sample; refusing projection");
      sums[i + width * j] = sum;
      if (sum > peak) peak = sum;
    }
  }
  // Dense structures are dark on a light field, as in an unsubtracted run.
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < sums.length; index++) {
    const shade = peak > 0 ? Math.round(235 * (1 - sums[index] / peak)) : 235;
    rgba[index * 4] = rgba[index * 4 + 1] = rgba[index * 4 + 2] = shade;
    rgba[index * 4 + 3] = 255;
  }
  return { width, height, rgba, peak, rays_through_volume: through, samples };
}

/** Target path and isocenter in pixel coordinates for the overlay. */
export function projectOverlay(
  view: ViewNumbers,
  isocenter: Vec3,
  path: readonly Vec3[],
  size: { width: number; height: number },
): { path: [number, number][]; isocenter: [number, number] } {
  const cam = camera(view, isocenter);
  const pixel = (p: Vec3) => {
    const [x, y] = project(cam, p);
    return detectorToPixel(view, size, x, y);
  };
  return { path: path.map(pixel), isocenter: pixel(isocenter) };
}
