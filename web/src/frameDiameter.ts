/** The width of the vessel in a frame at each axis sample of the 3D mask.
 *
 * At a sample the frame's brightness is read along the line across the
 * projected axis. The vessel's width is the width of that profile at half
 * its depth, each side measured against its own background. For a round
 * vessel filled evenly the profile is half an ellipse and its width at half
 * depth is 0.866 of the diameter. A pixel is as many millimeters as it
 * spans at the sample's distance from the source. */
import type { PlacedSamples } from "./framePlacement";
import type { Polarity } from "./vesselness2d";
import type { VesselSegments } from "./vesselSegments";

export const FRAME_DIAMETER_METHOD = "profile_half_depth_v1";
export const FRAME_DIAMETER_LIMITS = {
  /** The profile reaches this far to each side of the projected axis. */
  half_window_mm: 6,
  /** The vessel's middle is looked for this near the projected axis. */
  center_mm: 1.5,
  step_px: 0.25,
  /** Brightness levels the middle must stand over each side's background. */
  min_depth: 8,
  /** Width at half depth over diameter, for a round vessel filled evenly. */
  half_depth_ratio: Math.sqrt(3) / 2,
  /** A sample with another vessel's axis this near in the frame is not
   * measured. Another vessel: of another run, or apart in the volume. */
  clear_mm: 3,
  apart_mm: 6,
  /** The axis must show at least this share of its length in the frame. */
  min_shown: 0.3,
} as const;

export type FrameForDiameter = {
  width: number;
  height: number;
  /** Row-major 8-bit brightness. */
  gray: Uint8Array;
  polarity: Polarity;
};

/** Vessel diameter in millimeters at each axis sample, NaN where it was
 * not measured. */
export function frameDiameters(
  frame: FrameForDiameter,
  placed: PlacedSamples,
  segments: VesselSegments,
): Float32Array {
  const L = FRAME_DIAMETER_LIMITS,
    { width: w, height: h, gray } = frame,
    { points, labels } = segments,
    count = labels.length,
    { pixels, mm_per_px } = placed,
    out = new Float32Array(count).fill(NaN);
  if (
    !Number.isInteger(w) ||
    !Number.isInteger(h) ||
    w < 2 ||
    h < 2 ||
    gray.length !== w * h
  )
    throw new Error("Invalid frame");
  if (
    points.length !== 3 * count ||
    pixels.length !== 2 * count ||
    mm_per_px.length !== count
  )
    throw new Error("Invalid vessel segments");
  const run = (k: number) => segments.segments[labels[k]].run,
    sign = frame.polarity === "dark" ? -1 : 1,
    // Brightness with the vessel counted upward, between pixel centers.
    at = (x: number, y: number) => {
      const fx = Math.min(w - 1, Math.max(0, x - 0.5)),
        fy = Math.min(h - 1, Math.max(0, y - 0.5)),
        x0 = Math.min(w - 2, Math.floor(fx)),
        y0 = Math.min(h - 2, Math.floor(fy)),
        tx = fx - x0,
        ty = fy - y0,
        c = y0 * w + x0;
      return (
        sign *
        (gray[c] * (1 - tx) * (1 - ty) +
          gray[c + 1] * tx * (1 - ty) +
          gray[c + w] * (1 - tx) * ty +
          gray[c + w + 1] * tx * ty)
      );
    },
    apart = (a: number, b: number) =>
      Math.hypot(
        points[3 * a] - points[3 * b],
        points[3 * a + 1] - points[3 * b + 1],
        points[3 * a + 2] - points[3 * b + 2],
      );
  for (let k = 0; k < count; k++) {
    const x = pixels[2 * k],
      y = pixels[2 * k + 1],
      mm = mm_per_px[k];
    if (!(x >= 0 && y >= 0 && x <= w && y <= h) || !(mm > 0)) continue;
    // The axis in the frame, from the samples before and after on the run.
    const before = k > 0 && run(k - 1) === run(k) ? k - 1 : k,
      after = k + 1 < count && run(k + 1) === run(k) ? k + 1 : k;
    if (before === after) continue;
    const tx = pixels[2 * after] - pixels[2 * before],
      ty = pixels[2 * after + 1] - pixels[2 * before + 1],
      shown = Math.hypot(tx, ty);
    if (!(shown * mm >= L.min_shown * apart(before, after))) continue;
    let over = false;
    for (let j = 0; j < count && !over; j++)
      over =
        (run(j) !== run(k) || apart(j, k) >= L.apart_mm) &&
        Math.hypot(pixels[2 * j] - x, pixels[2 * j + 1] - y) * mm <= L.clear_mm;
    if (over) continue;
    const nx = -ty / shown,
      ny = tx / shown,
      reach = Math.ceil(L.half_window_mm / mm / L.step_px),
      size = 2 * reach + 1;
    // A window that leaves the frame is not measured.
    if (!(
      x - Math.abs(nx) * reach * L.step_px >= 0 &&
      x + Math.abs(nx) * reach * L.step_px <= w &&
      y - Math.abs(ny) * reach * L.step_px >= 0 &&
      y + Math.abs(ny) * reach * L.step_px <= h
    ))
      continue;
    const raw = new Float32Array(size),
      profile = new Float32Array(size);
    for (let i = 0; i < size; i++)
      raw[i] = at(
        x + nx * (i - reach) * L.step_px,
        y + ny * (i - reach) * L.step_px,
      );
    // Smoothed over one pixel.
    const blur = Math.round(0.5 / L.step_px);
    for (let i = 0; i < size; i++) {
      let sum = 0,
        n = 0;
      for (
        let j = Math.max(0, i - blur);
        j <= Math.min(size - 1, i + blur);
        j++, n++
      )
        sum += raw[j];
      profile[i] = sum / n;
    }
    const near = Math.round(L.center_mm / mm / L.step_px);
    let top = reach;
    for (let i = reach - near; i <= reach + near; i++)
      if (profile[i] > profile[top]) top = i;
    // Each side: its background, then where the profile falls to half way.
    const side = (step: -1 | 1): number => {
      let ground = profile[top];
      for (let i = top; i >= 0 && i < size; i += step)
        if (profile[i] < ground) ground = profile[i];
      if (!(profile[top] - ground >= L.min_depth)) return NaN;
      const level = (profile[top] + ground) / 2;
      for (let i = top + step; i >= 0 && i < size; i += step)
        if (profile[i] <= level)
          return (
            Math.abs(i - top) -
            (level - profile[i]) / (profile[i - step] - profile[i])
          );
      return NaN;
    };
    const span = side(-1) + side(1);
    if (Number.isFinite(span))
      out[k] = (span * L.step_px * mm) / L.half_depth_ratio;
  }
  return out;
}
