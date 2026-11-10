/** Strict client-side parsers for the C-arm working-view plan and for the
 * geometry-only projection-series manifest. They mirror
 * planner/projection_plan.py and planner/projection_source.py. Admission stays
 * server-authoritative; these validate DTOs before the UI renders numbers. */
import type { Identity } from "./territoryWorkflow";
import { record, stable } from "./territoryWorkflow";
import {
  CARM_CONVENTION,
  FORESHORTENING_METHOD,
  pathLength,
  summarizeView,
  VIEW_LIMITS,
  type ViewNumbers,
  type ViewSummary,
} from "./carmGeometry";
import type { Vec3 } from "./obliqueSlice";

export const PLAN_VERSION = "step-a-carm-views-v1";
/** Target-length bound of planner/projection_plan.py. */
export const MAX_PATH_LENGTH_MM = 10000;
export const MAX_VIEWS = 8;
export const VIEW_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/;
export type PlanView = ViewNumbers & { name: string };
export type PlanInputs = {
  confirmed: true;
  isocenter: Vec3;
  target_path: Vec3[];
  views: PlanView[];
};
export type PlanResult = {
  version: string;
  convention: string;
  foreshortening_method: string;
  view_source: "operator_confirmed";
  target_point_count: number;
  target_length_mm: number;
  views: (ViewSummary & { name: string })[];
};
export type PlanCurrent =
  | { status: "not_confirmed" }
  | { status: "stale"; plan_id: string; inputs: null; result: null }
  | {
      status: "current";
      plan_id: string;
      dependencies: Identity & { version: string };
      input_sha256: string;
      inputs: PlanInputs;
      result: PlanResult;
    };
export type Plan = Identity & { plan_revision: number; current: PlanCurrent };

const fail = (): never => {
  throw new Error(
    "Saved C-arm views could not be confirmed. Reload saved state.",
  );
};
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const hex64 = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const point = (value: unknown): value is Vec3 =>
  Array.isArray(value) &&
  value.length === 3 &&
  value.every((v) => finite(v) && Math.abs(v) <= 1e6);
const close = (a: number, b: number) =>
  Math.abs(a - b) <= 1e-6 + 1e-9 * Math.max(1, Math.abs(b));
const NUMBER_KEYS = Object.keys(VIEW_LIMITS) as (keyof ViewNumbers)[];

function viewValid(value: unknown): value is PlanView {
  return (
    record(value) &&
    Object.keys(value).length === NUMBER_KEYS.length + 1 &&
    typeof value.name === "string" &&
    VIEW_NAME.test(value.name) &&
    NUMBER_KEYS.every((key) => finite(value[key]))
  );
}

export function inputsValid(value: unknown): value is PlanInputs {
  if (
    !record(value) ||
    Object.keys(value).length !== 4 ||
    value.confirmed !== true ||
    !point(value.isocenter) ||
    !Array.isArray(value.target_path) ||
    !value.target_path.every(point) ||
    !Array.isArray(value.views) ||
    value.views.length < 1 ||
    value.views.length > MAX_VIEWS ||
    !value.views.every(viewValid)
  )
    return false;
  const views = value.views as PlanView[];
  if (new Set(views.map((view) => view.name)).size !== views.length)
    return false;
  try {
    if (pathLength(value.target_path as Vec3[]) > MAX_PATH_LENGTH_MM)
      return false;
    for (const view of views)
      summarizeView(view, value.isocenter, value.target_path as Vec3[]);
  } catch {
    return false;
  }
  return true;
}

function resultValid(result: unknown, inputs: PlanInputs): boolean {
  if (
    !record(result) ||
    Object.keys(result).length !== 7 ||
    result.version !== PLAN_VERSION ||
    result.convention !== CARM_CONVENTION ||
    result.foreshortening_method !== FORESHORTENING_METHOD ||
    result.view_source !== "operator_confirmed" ||
    result.target_point_count !== inputs.target_path.length ||
    !finite(result.target_length_mm) ||
    !close(result.target_length_mm, pathLength(inputs.target_path)) ||
    !Array.isArray(result.views) ||
    result.views.length !== inputs.views.length
  )
    return false;
  return result.views.every((reported: unknown, index: number) => {
    const view = inputs.views[index];
    if (
      !record(reported) ||
      Object.keys(reported).length !== NUMBER_KEYS.length + 4 ||
      reported.name !== view.name ||
      !NUMBER_KEYS.every((key) => reported[key] === view[key])
    )
      return false;
    const derived = summarizeView(view, inputs.isocenter, inputs.target_path);
    return (
      finite(reported.foreshortening_percent) &&
      close(reported.foreshortening_percent, derived.foreshortening_percent) &&
      finite(reported.magnification_at_isocenter) &&
      close(
        reported.magnification_at_isocenter,
        derived.magnification_at_isocenter,
      ) &&
      reported.target_in_field === derived.target_in_field
    );
  });
}

export function parsePlan(value: unknown, identity: Identity): Plan {
  if (
    !record(value) ||
    Object.keys(value).length !== Object.keys(identity).length + 2 ||
    !Object.entries(identity).every(([k, v]) => value[k] === v) ||
    !Number.isSafeInteger(value.plan_revision) ||
    (value.plan_revision as number) < 0 ||
    (value.plan_revision as number) > 1e9 ||
    !record(value.current)
  )
    return fail();
  const current = value.current,
    revision = value.plan_revision as number;
  if (current.status === "not_confirmed") {
    if (revision !== 0 || Object.keys(current).length !== 1) return fail();
    return {
      ...identity,
      plan_revision: 0,
      current: { status: "not_confirmed" },
    };
  }
  if (
    typeof current.plan_id !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(current.plan_id) ||
    revision < 1
  )
    return fail();
  if (current.status === "stale") {
    if (
      Object.keys(current).length !== 4 ||
      current.inputs !== null ||
      current.result !== null
    )
      return fail();
    return {
      ...identity,
      plan_revision: revision,
      current: {
        status: "stale",
        plan_id: current.plan_id,
        inputs: null,
        result: null,
      },
    };
  }
  if (
    current.status !== "current" ||
    Object.keys(current).length !== 6 ||
    !record(current.dependencies) ||
    stable(current.dependencies) !==
      stable({ ...identity, version: PLAN_VERSION }) ||
    !hex64(current.input_sha256) ||
    !inputsValid(current.inputs) ||
    !resultValid(current.result, current.inputs)
  )
    return fail();
  return {
    ...identity,
    plan_revision: revision,
    current: current as PlanCurrent,
  };
}

export type ProjectionPlane = {
  plane: "single" | "a" | "b" | "unknown";
  sop_class: "xa" | "enhanced_xa";
  rows: number;
  columns: number;
  frame_count: number;
  burned_in_annotation: "yes" | "no" | "unknown";
  positioner_motion: "static" | "dynamic" | "unknown";
  primary_angle_deg: number | null;
  secondary_angle_deg: number | null;
  source_detector_mm: number | null;
  source_isocenter_mm: number | null;
  imager_pixel_spacing_mm: [number, number] | null;
  frame_time_ms: number | null;
  frame_time_vector_ms: number[] | null;
  mask_operation: "none" | "avg_sub" | "tid" | "rev_tid" | "unknown";
  mask_frame_numbers: number[] | null;
  calibration: { status: "calibrated" | "uncalibrated"; missing: string[] };
};
export type ProjectionSeries = {
  source_id: string;
  manifest_revision: string;
  scope: string;
  biplane_linkage: "not_applicable" | "cross_referenced";
  planes: ProjectionPlane[];
};
// Bounds of planner/projection_source.py.
const MAX_FRAMES = 2048,
  MAX_DIMENSION = 4096;
const seriesFail = (): never => {
  throw new Error("Projection series failed integrity checks.");
};
const optional = (value: unknown, low: number, high: number) =>
  value === null || (finite(value) && value >= low && value <= high);
const oneOf = (value: unknown, ...allowed: string[]) =>
  typeof value === "string" && allowed.includes(value);

function planeValid(value: unknown): value is ProjectionPlane {
  if (!record(value) || Object.keys(value).length !== 19) return false;
  const spacing = value.imager_pixel_spacing_mm,
    gate = value.calibration,
    frames = value.frame_count as number,
    vector = value.frame_time_vector_ms,
    masks = value.mask_frame_numbers;
  const whole = (n: unknown, low: number, high: number) =>
    Number.isSafeInteger(n) && (n as number) >= low && (n as number) <= high;
  if (
    !oneOf(value.plane, "single", "a", "b", "unknown") ||
    !oneOf(value.sop_class, "xa", "enhanced_xa") ||
    typeof value.input_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.input_sha256) ||
    !whole(value.input_bytes, 1, 2 ** 40) ||
    !whole(value.rows, 1, MAX_DIMENSION) ||
    !whole(value.columns, 1, MAX_DIMENSION) ||
    !whole(frames, 1, MAX_FRAMES) ||
    !oneOf(value.burned_in_annotation, "yes", "no", "unknown") ||
    !oneOf(value.positioner_motion, "static", "dynamic", "unknown") ||
    !optional(value.primary_angle_deg, -180, 180) ||
    !optional(value.secondary_angle_deg, -90, 90) ||
    !optional(value.source_detector_mm, 1e-9, 1e4) ||
    !optional(value.source_isocenter_mm, 1e-9, 1e4) ||
    !optional(value.frame_time_ms, 1e-9, 1e5) ||
    // The first entry of a frame time vector is zero by definition.
    !(
      vector === null ||
      (Array.isArray(vector) &&
        vector.length === frames &&
        vector.every((v) => finite(v) && v >= 0 && v <= 1e5))
    ) ||
    !oneOf(
      value.mask_operation,
      "none",
      "avg_sub",
      "tid",
      "rev_tid",
      "unknown",
    ) ||
    !(
      masks === null ||
      (value.mask_operation === "avg_sub" &&
        Array.isArray(masks) &&
        masks.length >= 1 &&
        new Set(masks).size === masks.length &&
        masks.every((n) => whole(n, 1, frames)))
    ) ||
    !(
      spacing === null ||
      (Array.isArray(spacing) &&
        spacing.length === 2 &&
        spacing.every((v) => finite(v) && v > 0 && v <= 10))
    ) ||
    !record(gate) ||
    Object.keys(gate).length !== 2 ||
    !Array.isArray(gate.missing) ||
    !gate.missing.every((term) => typeof term === "string")
  )
    return false;
  // Re-derive the gate: a manifest cannot claim calibration it does not carry.
  const missing: string[] = [];
  if (value.primary_angle_deg === null) missing.push("primary_angle");
  if (value.secondary_angle_deg === null) missing.push("secondary_angle");
  const sid = value.source_detector_mm as number | null,
    sod = value.source_isocenter_mm as number | null;
  if (sid === null) missing.push("source_detector_distance");
  if (sod === null) missing.push("source_isocenter_distance");
  if (sid !== null && sod !== null && !(sod < sid))
    missing.push("consistent_distances");
  if (spacing === null) missing.push("imager_pixel_spacing");
  if (value.positioner_motion !== "static") missing.push("static_positioner");
  return (
    gate.status === (missing.length ? "uncalibrated" : "calibrated") &&
    stable(gate.missing) === stable(missing)
  );
}

export function parseProjectionSeries(
  value: unknown,
  source_id: string,
): ProjectionSeries {
  if (
    !record(value) ||
    Object.keys(value).length !== 3 ||
    value.source_id !== source_id ||
    !hex64(value.manifest_revision) ||
    !record(value.manifest)
  )
    return seriesFail();
  const manifest = value.manifest;
  if (
    Object.keys(manifest).length !== 9 ||
    manifest.version !== 1 ||
    manifest.kind !== "projection_series" ||
    manifest.clinical_validation !== false ||
    manifest.pixels_retained !== false ||
    manifest.method !== "converted_dicom_xa_geometry" ||
    manifest.angle_convention !== "dicom_xa_patient_positioner_angles" ||
    !oneOf(manifest.scope, "synthetic", "public", "authorized") ||
    !Array.isArray(manifest.planes) ||
    !manifest.planes.every(planeValid)
  )
    return seriesFail();
  const planes = manifest.planes as ProjectionPlane[];
  const labels = planes.map((plane) => plane.plane).join(",");
  if (!(
    (planes.length === 1 && manifest.biplane_linkage === "not_applicable") ||
    (planes.length === 2 &&
      labels === "a,b" &&
      manifest.biplane_linkage === "cross_referenced")
  ))
    return seriesFail();
  return {
    source_id,
    manifest_revision: value.manifest_revision as string,
    scope: manifest.scope as string,
    biplane_linkage:
      manifest.biplane_linkage as ProjectionSeries["biplane_linkage"],
    planes,
  };
}

/** View numbers for a calibrated acquired plane. The detector size is the
 * stored matrix times the imager pixel spacing (row spacing, column spacing).
 * Returns null when the plane is uncalibrated or outside the planning bounds. */
export function planeToView(plane: ProjectionPlane): ViewNumbers | null {
  if (
    plane.calibration.status !== "calibrated" ||
    plane.imager_pixel_spacing_mm === null
  )
    return null;
  const view = {
    primary_deg: plane.primary_angle_deg as number,
    secondary_deg: plane.secondary_angle_deg as number,
    source_detector_mm: plane.source_detector_mm as number,
    source_isocenter_mm: plane.source_isocenter_mm as number,
    detector_width_mm: plane.columns * plane.imager_pixel_spacing_mm[1],
    detector_height_mm: plane.rows * plane.imager_pixel_spacing_mm[0],
  };
  return NUMBER_KEYS.every(
    (key) =>
      view[key] >= VIEW_LIMITS[key][0] && view[key] <= VIEW_LIMITS[key][1],
  ) && view.source_detector_mm - view.source_isocenter_mm >= 1
    ? view
    : null;
}
