/** Pinhole C-arm geometry in patient RAS millimeters. Mirrors
 * planner/carm_geometry.py; both are checked against the same independently
 * derived vectors in __fixtures__/carm-geometry-vectors.json.
 *
 * Declared convention, not verified against a vendor system: primary is
 * positive toward the patient's left (LAO), secondary is positive toward the
 * head (cranial), and at 0/0 the detector is anterior. Image right is the
 * patient's left at 0/0 and image up is cranial. */
import type { Vec3 } from "./obliqueSlice";

export const CARM_CONVENTION = "dicom_xa_patient_longitude_latitude_ras_v1";
export const FORESHORTENING_METHOD = "central_ray_parallel_approximation";
export const VIEW_LIMITS = {
  primary_deg: [-180, 180],
  secondary_deg: [-90, 90],
  source_detector_mm: [300, 2000],
  source_isocenter_mm: [100, 2000],
  detector_width_mm: [50, 600],
  detector_height_mm: [50, 600],
} as const;
export type ViewNumbers = { -readonly [K in keyof typeof VIEW_LIMITS]: number };
export type ViewSummary = ViewNumbers & {
  foreshortening_percent: number;
  magnification_at_isocenter: number;
  target_in_field: boolean;
};
export type Camera = {
  u: Vec3;
  v: Vec3;
  d: Vec3;
  source: Vec3;
  source_detector_mm: number;
  half_width_mm: number;
  half_height_mm: number;
};
const MIN_DEPTH_MM = 1;
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const point3 = (value: readonly number[]): Vec3 => {
  if (
    value.length !== 3 ||
    !value.every((x) => typeof x === "number" && Number.isFinite(x))
  )
    throw new Error("Invalid point");
  if (value.some((x) => Math.abs(x) > 1e6)) throw new Error("Invalid point");
  return [value[0], value[1], value[2]];
};

export function viewFrame(
  primary_deg: number,
  secondary_deg: number,
): { u: Vec3; v: Vec3; d: Vec3 } {
  if (
    !Number.isFinite(primary_deg) ||
    !Number.isFinite(secondary_deg) ||
    Math.abs(primary_deg) > 180 ||
    Math.abs(secondary_deg) > 90
  )
    throw new Error("Invalid C-arm angles");
  const a = (primary_deg * Math.PI) / 180,
    b = (secondary_deg * Math.PI) / 180;
  const sa = Math.sin(a),
    ca = Math.cos(a),
    sb = Math.sin(b),
    cb = Math.cos(b);
  return {
    u: [-ca, -sa, 0],
    v: [sa * sb, -ca * sb, cb],
    d: [-sa * cb, ca * cb, sb],
  };
}

export function validateView(view: ViewNumbers): ViewNumbers {
  const result = {} as ViewNumbers;
  for (const key of Object.keys(VIEW_LIMITS) as (keyof ViewNumbers)[]) {
    const value = view[key],
      [low, high] = VIEW_LIMITS[key];
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < low ||
      value > high
    )
      throw new Error("Invalid C-arm view: " + key.replace(/_/g, " "));
    result[key] = value;
  }
  if (result.source_detector_mm - result.source_isocenter_mm < MIN_DEPTH_MM)
    throw new Error(
      "The isocenter must lie between the source and the detector",
    );
  return result;
}

export function camera(
  view: ViewNumbers,
  isocenter: readonly number[],
): Camera {
  const numbers = validateView(view),
    iso = point3(isocenter);
  const { u, v, d } = viewFrame(numbers.primary_deg, numbers.secondary_deg);
  return {
    u,
    v,
    d,
    source: iso.map((x, i) => x - d[i] * numbers.source_isocenter_mm) as Vec3,
    source_detector_mm: numbers.source_detector_mm,
    half_width_mm: numbers.detector_width_mm / 2,
    half_height_mm: numbers.detector_height_mm / 2,
  };
}

/** Detector millimeters (right, up) from the central ray, plus depth. */
export function project(
  cam: Camera,
  point: readonly number[],
): [number, number, number] {
  const p = point3(point);
  const relative: Vec3 = [
    p[0] - cam.source[0],
    p[1] - cam.source[1],
    p[2] - cam.source[2],
  ];
  const depth = dot(relative, cam.d);
  if (!Number.isFinite(depth) || depth < MIN_DEPTH_MM)
    throw new Error("Point is not in front of the X-ray source");
  // The detector cannot sit inside the anatomy it images.
  if (depth > cam.source_detector_mm)
    throw new Error("Point is beyond the detector");
  const scale = cam.source_detector_mm / depth;
  const x = dot(relative, cam.u) * scale,
    y = dot(relative, cam.v) * scale;
  if (!Number.isFinite(x) || !Number.isFinite(y))
    throw new Error("Projection is not finite");
  return [x, y, depth];
}

export function pathLength(path: readonly (readonly number[])[]): number {
  if (path.length < 2 || path.length > 128)
    throw new Error("Target path needs 2 to 128 points");
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const a = point3(path[i - 1]),
      b = point3(path[i]);
    const step = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (!(step > 1e-8)) throw new Error("Target path has a repeated point");
    total += step;
  }
  if (!Number.isFinite(total)) throw new Error("Invalid target path");
  return total;
}

export function foreshorteningFraction(
  path: readonly (readonly number[])[],
  direction: Vec3,
): number {
  const total = pathLength(path);
  let visible = 0;
  for (let i = 1; i < path.length; i++) {
    const s: Vec3 = [
      path[i][0] - path[i - 1][0],
      path[i][1] - path[i - 1][1],
      path[i][2] - path[i - 1][2],
    ];
    const along = dot(s, direction);
    visible += Math.sqrt(Math.max(0, dot(s, s) - along * along));
  }
  return Math.min(1, Math.max(0, 1 - visible / total));
}

export function angleLabel(primary_deg: number, secondary_deg: number): string {
  const part = (value: number, positive: string, negative: string) =>
    Math.abs(value) < 0.05
      ? `${positive}/${negative} 0.0`
      : `${value > 0 ? positive : negative} ${Math.abs(value).toFixed(1)}`;
  return `${part(primary_deg, "LAO", "RAO")} / ${part(secondary_deg, "CRA", "CAU")}`;
}

export function summarizeView(
  view: ViewNumbers,
  isocenter: readonly number[],
  path: readonly (readonly number[])[],
): ViewSummary {
  const numbers = validateView(view),
    cam = camera(numbers, isocenter);
  const projected = path.map((p) => project(cam, p));
  return {
    ...numbers,
    foreshortening_percent: 100 * foreshorteningFraction(path, cam.d),
    magnification_at_isocenter:
      numbers.source_detector_mm / numbers.source_isocenter_mm,
    target_in_field: projected.every(
      ([x, y]) =>
        Math.abs(x) <= cam.half_width_mm && Math.abs(y) <= cam.half_height_mm,
    ),
  };
}

/** Search bounds for the geometric proposal. These are planning defaults,
 * not the travel limits of any particular angiography system. */
export const PROPOSAL_LIMITS = { primary_deg: 120, secondary_deg: 45 } as const;
const PROPOSAL_TIE_PERCENT = 0.5;

/** Whole-degree view with the lowest central-ray foreshortening of the path.
 * Views within half a percentage point of the minimum are treated as tied and
 * the one with the least total angulation is returned. A proposal only: it
 * ignores vessel overlap, table position and equipment collision. */
export function proposeLowForeshorteningAngles(
  path: readonly (readonly number[])[],
): {
  primary_deg: number;
  secondary_deg: number;
  foreshortening_percent: number;
} {
  pathLength(path);
  const scored: [number, number, number][] = [];
  let best = Infinity;
  for (
    let primary = -PROPOSAL_LIMITS.primary_deg;
    primary <= PROPOSAL_LIMITS.primary_deg;
    primary++
  )
    for (
      let secondary = -PROPOSAL_LIMITS.secondary_deg;
      secondary <= PROPOSAL_LIMITS.secondary_deg;
      secondary++
    ) {
      const percent =
        100 * foreshorteningFraction(path, viewFrame(primary, secondary).d);
      scored.push([primary, secondary, percent]);
      if (percent < best) best = percent;
    }
  let chosen: [number, number, number] | null = null;
  for (const candidate of scored) {
    if (candidate[2] > best + PROPOSAL_TIE_PERCENT) continue;
    const cost = Math.abs(candidate[0]) + Math.abs(candidate[1]);
    if (
      chosen === null ||
      cost < Math.abs(chosen[0]) + Math.abs(chosen[1]) ||
      (cost === Math.abs(chosen[0]) + Math.abs(chosen[1]) &&
        candidate[2] < chosen[2])
    )
      chosen = candidate;
  }
  if (chosen === null) throw new Error("No view could be proposed");
  return {
    primary_deg: chosen[0] + 0,
    secondary_deg: chosen[1] + 0,
    foreshortening_percent: chosen[2],
  };
}
