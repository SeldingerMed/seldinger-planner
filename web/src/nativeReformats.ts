/** Local image producers. Receipts contain settings and diagnostics, never pixels. */
import type { NVImage } from "@niivue/niivue";
import type { Vec3 } from "./obliqueSlice";
import { sampleCPR, pointAlongPath, buildPathFrames } from "./curvedPlanar";
import { renderEndoluminal } from "./endoluminal";
import { createFusionSampler } from "./rigidFusion";
export type ViewOptions = {
  span_mm: number;
  roll_degrees: number;
  station_fraction: number;
  threshold: number;
  primary_window: [number, number];
  secondary_window: [number, number];
  opacity: number;
};
export function renderNativeScene(
  volume: NVImage,
  path: Vec3[],
  options: ViewOptions,
  secondary?: { volume: NVImage; transform: number[][] },
) {
  if (
    !Number.isFinite(options.station_fraction) ||
    options.station_fraction < 0 ||
    options.station_fraction > 1
  )
    throw new Error("Invalid path station");
  const length = buildPathFrames(path, 2, options.roll_degrees).length_mm;
  const station = options.station_fraction * length,
    pose = pointAlongPath(path, station, options.roll_degrees);
  const common = {
    width_px: 128,
    height_px: 64,
    span_mm: options.span_mm,
    roll_degrees: options.roll_degrees,
    window: options.primary_window,
  };
  const straightened = sampleCPR(volume, path, {
    ...common,
    mode: "straightened",
  });
  const stretched = sampleCPR(volume, path, { ...common, mode: "stretched" });
  const rayOptions = {
    resolution: 33,
    field_of_view_deg: 60,
    depth_mm: 32,
    step_mm: 0.5,
    threshold: options.threshold,
  };
  let endoluminal: ReturnType<typeof renderEndoluminal> | null = null,
    endoluminalError = "";
  try {
    endoluminal = renderEndoluminal(volume, pose, rayOptions);
  } catch (error) {
    endoluminalError =
      error instanceof Error ? error.message : "Endoluminal rendering failed";
  }
  let fusion: {
    width: number;
    height: number;
    rgba: Uint8ClampedArray;
    secondary_missing: number;
  } | null = null;
  if (secondary) {
    const sampler = createFusionSampler(
      volume,
      secondary.volume,
      secondary.transform,
      {
        primary_window: options.primary_window,
        secondary_window: options.secondary_window,
        opacity: options.opacity,
      },
    );
    const size = 33,
      rgba = new Uint8ClampedArray(size * size * 4);
    let missing = 0;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const a = ((x + 0.5) / size - 0.5) * options.span_mm,
          b = ((y + 0.5) / size - 0.5) * options.span_mm;
        const p = pose.point.map(
          (v, i) => v + pose.u[i] * a + pose.v[i] * b,
        ) as Vec3;
        const pixel = sampler.sample(p);
        rgba.set(pixel.rgba, 4 * (y * size + x));
        if (pixel.secondary_missing) missing++;
      }
    fusion = { width: size, height: size, rgba, secondary_missing: missing };
  }
  return {
    straightened,
    stretched,
    endoluminal,
    endoluminal_error: endoluminalError,
    fusion,
    provenance: {
      renderer_version: "phase4-native-render-v1",
      cpr_modes: "stretched_and_straightened",
      cpr_width_px: 128,
      cpr_height_px: 64,
      span_mm: options.span_mm,
      roll_degrees: options.roll_degrees,
      station_mm: station,
      primary_window_low: options.primary_window[0],
      primary_window_high: options.primary_window[1],
      endoluminal_method: "first_person_intensity_boundary_raycast",
      endoluminal_status: endoluminal ? "rendered" : "unavailable",
      threshold: options.threshold,
      field_of_view_deg: 60,
      depth_mm: 32,
      step_mm: 0.5,
      ray_resolution_px: 33,
      ray_hits: endoluminal?.hit_count ?? null,
      fusion_method: secondary
        ? "operator_confirmed_rigid_ras"
        : "not_selected",
      secondary_window_low: secondary ? options.secondary_window[0] : null,
      secondary_window_high: secondary ? options.secondary_window[1] : null,
      secondary_opacity: secondary ? options.opacity : null,
    },
  };
}
