export type WorkflowMode = "tavr" | "coronary_pci" | "aortic_peripheral";
export const CALCULATION_VERSION = "territory-traced-geometry-v1";
export type Identity = {
  case_id: string;
  image_sha256: string;
  artifact_version: string;
  reference_revision: string;
};
export type Data = Record<string, unknown>;
export type Workflow = {
  mode: WorkflowMode;
  workflow_revision: number;
  current:
    | { status: "not_computed" }
    | { status: "stale"; result_id: string; inputs: null; result: null }
    | {
        status: "current";
        result_id: string;
        dependencies: Identity & {
          mode: WorkflowMode;
          calculation_version: string;
        };
        input_sha256: string;
        inputs: Data;
        result: Data;
      };
} & Identity;
const fail = (): never => {
  throw new Error("Saved workflow could not be confirmed. Reload saved state.");
};
export function record(value: unknown): value is Data {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
/** Cheap path-index preflight. Geometry and full admission remain server-authoritative. */
export function pathIndexError(
  mode: Exclude<WorkflowMode, "tavr">,
  inputs: Data,
  pathLength: number,
): string {
  const keys =
    mode === "coronary_pci"
      ? ["proximal_reference", "lesion_start", "lesion_end", "distal_reference"]
      : ["suprarenal_index", "neck_start", "neck_end", "sac_index"];
  const values = keys.map((k) => inputs[k]);
  if (
    !values.every(
      (v) =>
        typeof v === "number" &&
        Number.isInteger(v) &&
        v >= 0 &&
        v < pathLength,
    )
  )
    return "Choose all four integer indices within the current path.";
  const [a, b, c, d] = values as number[];
  if (
    mode === "coronary_pci"
      ? !(a <= b && b < c && c <= d)
      : !(a < b && b < c && c < d)
  )
    return mode === "coronary_pci"
      ? "Require proximal reference ≤ lesion start < lesion end ≤ distal reference."
      : "Require suprarenal index < neck start < neck end < sac index.";
  return "";
}
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const sha = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function tree(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return finite(value);
  if (Array.isArray(value))
    return value.length <= 8192 && value.every((x) => tree(x, depth + 1));
  return record(value) && Object.values(value).every((x) => tree(x, depth + 1));
}
export function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (record(value))
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + stable(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "undefined";
}
const numeric: Record<WorkflowMode, string[]> = {
  tavr: [
    "area_mm2",
    "perimeter_mm",
    "area_derived_diameter_mm",
    "perimeter_derived_diameter_mm",
    "min_diameter_mm",
    "max_diameter_mm",
    "left_coronary_height_mm",
    "right_coronary_height_mm",
  ],
  coronary_pci: [
    "lesion_length_mm",
    "proximal_reference_diameter_mm",
    "distal_reference_diameter_mm",
    "reference_taper_mm_per_mm",
    "sampled_minimum_diameter_mm",
    "minimum_station",
    "diameter_narrowing_pct",
  ],
  aortic_peripheral: [
    "neck_length_mm",
    "alpha_deg",
    "beta_deg",
    "sampled_minimum_diameter_mm",
    "minimum_station",
    "sampled_maximum_diameter_mm",
    "maximum_station",
  ],
};
function profiles(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (row) =>
        record(row) &&
        [
          "station",
          "distance_mm",
          "area_mm2",
          "perimeter_mm",
          "area_derived_diameter_mm",
          "perimeter_derived_diameter_mm",
          "min_diameter_mm",
          "max_diameter_mm",
        ].every((k) => finite(row[k])) &&
        ["outer_area_mm2", "thrombus_area_mm2", "calcification_area_mm2"].every(
          (k) => row[k] === null || finite(row[k]),
        ),
    )
  );
}
function inputsValid(mode: WorkflowMode, inputs: Data): boolean {
  const point = (p: unknown) =>
    Array.isArray(p) && p.length === 3 && p.every(finite);
  const section = (s: unknown) =>
    record(s) &&
    point(s.origin) &&
    point(s.normal) &&
    Array.isArray(s.contour) &&
    s.contour.length >= 3 &&
    s.contour.length <= 128 &&
    s.contour.every(point);
  if (mode === "tavr")
    return (
      section(inputs.annulus) &&
      point(inputs.left_ostium) &&
      point(inputs.right_ostium)
    );
  const path = (x: unknown): boolean =>
    record(x) &&
    Array.isArray(x.path) &&
    x.path.length >= 2 &&
    x.path.length <= 128 &&
    x.path.every(point) &&
    Array.isArray(x.profiles) &&
    x.profiles.length > 0 &&
    x.profiles.length <= 32 &&
    x.profiles.every(
      (p) =>
        record(p) &&
        Number.isInteger(p.station) &&
        section(p.section) &&
        ["outer_wall"].every((k) => p[k] === null || section(p[k])) &&
        ["thrombus", "calcification"].every(
          (k) =>
            p[k] === null ||
            (Array.isArray(p[k]) &&
              (p[k] as unknown[]).length <= 8 &&
              (p[k] as unknown[]).every(section)),
        ),
    );
  if (!path(inputs)) return false;
  const indices =
    mode === "coronary_pci"
      ? ["lesion_start", "lesion_end", "proximal_reference", "distal_reference"]
      : ["suprarenal_index", "neck_start", "neck_end", "sac_index"];
  if (
    !indices.every(
      (k) =>
        Number.isInteger(inputs[k]) &&
        (inputs[k] as number) >= 0 &&
        (inputs[k] as number) < (inputs.path as unknown[]).length,
    )
  )
    return false;
  if (mode === "coronary_pci")
    return (
      inputs.bifurcation === null ||
      (record(inputs.bifurcation) &&
        ["carina", "daughter_a", "daughter_b"].every((k) =>
          point((inputs.bifurcation as Data)[k]),
        ))
    );
  return ["left_access", "right_access"].every(
    (k) => inputs[k] === null || path(inputs[k]),
  );
}
export function parseWorkflow(
  value: unknown,
  identity: Identity,
  mode: WorkflowMode,
): Workflow {
  if (
    !record(value) ||
    !tree(value) ||
    !Object.entries(identity).every(([k, v]) => value[k] === v) ||
    value.mode !== mode ||
    !Number.isSafeInteger(value.workflow_revision) ||
    (value.workflow_revision as number) < 0 ||
    (value.workflow_revision as number) > 1e9 ||
    !record(value.current)
  )
    return fail();
  const current = value.current,
    revision = value.workflow_revision as number;
  if (current.status === "not_computed") {
    if (revision !== 0 || Object.keys(current).length !== 1) return fail();
  } else {
    if (
      revision < 1 ||
      typeof current.result_id !== "string" ||
      !/^[A-Za-z0-9_-]{22}$/.test(current.result_id)
    )
      return fail();
    if (current.status === "stale") {
      if (current.inputs !== null || current.result !== null) return fail();
    } else if (current.status === "current") {
      const expected = {
        ...identity,
        mode,
        calculation_version: CALCULATION_VERSION,
      };
      if (
        stable(current.dependencies) !== stable(expected) ||
        !sha(current.input_sha256) ||
        !record(current.inputs) ||
        !inputsValid(mode, current.inputs) ||
        !record(current.result)
      )
        return fail();
      const result = current.result;
      if (
        result.annotation_source !== "operator_traced" ||
        result.calculation_version !== CALCULATION_VERSION ||
        !numeric[mode].every((k) => finite(result[k]))
      )
        return fail();
      if (mode !== "tavr" && !profiles(result.profiles)) return fail();
      if (
        mode === "coronary_pci" &&
        (result.diameter_basis !== "area_equivalent" ||
          (result.bifurcation_angle_deg !== null &&
            !finite(result.bifurcation_angle_deg)))
      )
        return fail();
      if (mode === "aortic_peripheral") {
        if (
          !["thrombus_burden_pct", "calcification_burden_pct"].every(
            (k) => result[k] === null || finite(result[k]),
          )
        )
          return fail();
        for (const key of ["left_access", "right_access"]) {
          const access = result[key];
          if (
            access !== null &&
            (!record(access) ||
              !profiles(access.profiles) ||
              !finite(access.length_mm) ||
              !(
                (access.sampled_minimum_diameter_mm === null &&
                  access.minimum_station === null) ||
                (finite(access.sampled_minimum_diameter_mm) &&
                  Number.isInteger(access.minimum_station))
              ))
          )
            return fail();
        }
      }
    } else return fail();
  }
  // Independent immutable snapshot, not an alias of the provider object.
  return JSON.parse(JSON.stringify(value)) as Workflow;
}
