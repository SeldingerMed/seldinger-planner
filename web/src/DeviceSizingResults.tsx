import type { CaseState } from "./api";
import type { MorphometryBinding } from "./MorphometryInputs";
import "./device-sizing-results.css";

export const SIZING_CALCULATION_VERSION = "historical-operator-sizing-v1";
export const GEOMETRY_CALCULATION_VERSION = "native-mask-operator-plane-v1";
export const INPUTS_VERSION = "operator-reported-device-inputs-v1";

const PIPELINE_STATUSES = [
  "geometric_checks_only",
  "missing_inputs",
  "out_of_family_range",
] as const;

const WEB_STATUSES = [...PIPELINE_STATUSES, "unsupported"];

const MEASUREMENT_KEYS = [
  "average_sac_diameter",
  "distal_parent",
  "dome_diameter",
  "neck_coverage_length",
  "proximal_parent",
  "smallest_sac_height",
] as const;

export type SizingMetricView = { label: string; value_mm: number };

export type ParsedSizingReport = {
  geometry_status: string;
  inputs_status: string;
  result_status: string;
  numbers_available: boolean;
  input_revision: string | null;
  result_id: string | null;
  missing_inputs: string[];
  pipeline_status: string | null;
  pipeline_metrics: SizingMetricView[];
  pipeline_source: string | null;
  web_status: string | null;
  web_metrics: SizingMetricView[];
  web_approximate: boolean;
  web_source: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

const hex = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const token = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);

function sameJson(a: unknown, b: unknown): boolean {
  const ordered = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(ordered)
      : isRecord(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, ordered(v[k])]),
          )
        : v;
  return JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
}

function sourceText(source: unknown): string | null {
  if (!isRecord(source)) return null;
  const parts = [source.table, source.section, source.revision].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.length > 0 ? parts.join(", ") : null;
}

function metric(
  record: Record<string, unknown>,
  key: string,
  label: string,
): SizingMetricView | null {
  const value = record[key];
  return isFiniteNonnegative(value) ? { label, value_mm: value } : null;
}

function validProvenance(provenance: unknown): boolean {
  if (!isRecord(provenance) || provenance.kind !== "operator_reported")
    return false;
  if (Object.keys(provenance).sort().join(",") !== "kind,note") return false;
  const note = provenance.note;
  if (
    typeof note !== "string" ||
    note.trim().length === 0 ||
    note.length > 512
  ) {
    return false;
  }
  return true;
}

function validMeasurements(measurements: unknown): boolean {
  if (!isRecord(measurements)) return false;
  if (
    Object.keys(measurements).sort().join(",") !==
    [...MEASUREMENT_KEYS].sort().join(",")
  )
    return false;
  for (const key of MEASUREMENT_KEYS) {
    const value = measurements[key];
    if (value !== null && (!isFiniteNonnegative(value) || value > 100))
      return false;
  }
  return true;
}

/**
 * Pure synchronous validation of a sizing report envelope against the current
 * case, morphometry binding and geometry capture. Returns a typed view or
 * null. Recognized stale/not-saved/not-computed states return a view with
 * numbers hidden; unknown status/schema or any dependency mismatch returns
 * null. Never recomputes arithmetic.
 */
export function parseSizingReport(
  raw: unknown,
  caseState: CaseState,
  binding: MorphometryBinding | null,
): ParsedSizingReport | null {
  if (!isRecord(raw) || caseState.spatial_units !== "mm") return null;
  if (
    raw.clinical_suitability_established !== false ||
    raw.validated_sizing !== false
  )
    return null;
  if (
    raw.case_id !== caseState.case_id ||
    raw.image_sha256 !== caseState.image_sha256
  )
    return null;
  if (raw.artifact_version !== caseState.artifact_version) return null;
  if (!hex(raw.reference_revision) || !hex(raw.image_sha256)) return null;
  if (
    !binding ||
    binding.case_id !== caseState.case_id ||
    binding.image_sha256 !== caseState.image_sha256 ||
    binding.reference_revision !== raw.reference_revision
  ) {
    return null;
  }
  if (!hex(raw.catalog_version)) return null;
  if (raw.calculation_version !== SIZING_CALCULATION_VERSION) return null;

  const geometryStatus = raw.geometry_status;
  const geometryDeps = raw.geometry_dependencies;
  if (!["current", "stale", "not_computed"].includes(String(geometryStatus)))
    return null;
  if (
    !isRecord(raw.inputs) ||
    !["current", "stale", "not_saved"].includes(String(raw.inputs.status)) ||
    raw.inputs.inputs_version !== INPUTS_VERSION
  )
    return null;
  if (
    !isRecord(raw.current) ||
    !["current", "stale", "not_computed"].includes(String(raw.current.status))
  )
    return null;
  if (raw.current.status !== "current" && raw.current.result !== null)
    return null;
  if (geometryStatus !== "current") {
    if (
      geometryDeps !== null ||
      raw.geometry_result_id !== null ||
      raw.inputs.status === "current" ||
      raw.current.status === "current"
    )
      return null;
    return hiddenView(String(geometryStatus), "unknown", "unknown");
  }
  if (!isRecord(geometryDeps)) return null;
  if (geometryDeps.calculation_version !== GEOMETRY_CALCULATION_VERSION)
    return null;
  if (geometryDeps.case_id !== caseState.case_id) return null;
  if (geometryDeps.image_sha256 !== caseState.image_sha256) return null;
  if (
    geometryDeps.source_revision !== raw.reference_revision ||
    geometryDeps.artifact_version !== caseState.artifact_version ||
    !hex(geometryDeps.operator_sha256) ||
    !token(raw.geometry_result_id)
  )
    return null;

  const inputs = raw.inputs;
  if (!isRecord(inputs)) return null;
  const inputsStatus = inputs.status;
  if (inputsStatus !== "current") {
    if (
      inputs.measurements !== null ||
      inputs.provenance !== null ||
      inputs.inputs_sha256 !== null ||
      raw.current.status === "current"
    )
      return null;
    return hiddenView("current", String(inputsStatus), "unknown");
  }
  if (inputs.inputs_version !== INPUTS_VERSION) return null;
  if (!sameJson(inputs.geometry_dependencies, geometryDeps)) return null;
  if (
    !validProvenance(inputs.provenance) ||
    !validMeasurements(inputs.measurements)
  )
    return null;
  if (!token(inputs.input_revision) || !hex(inputs.inputs_sha256)) return null;

  const current = raw.current;
  if (!isRecord(current)) return null;
  const resultStatus = current.status;
  if (resultStatus !== "current") {
    return hiddenView("current", "current", String(resultStatus));
  }
  const result = current.result;
  if (!isRecord(result) || result.binding_status !== "case_bound_calculation")
    return null;
  if (
    result.clinical_suitability_established !== false ||
    result.validated_sizing !== false
  ) {
    return null;
  }
  if (result.calculation_version !== SIZING_CALCULATION_VERSION) return null;
  if (result.catalog_version !== raw.catalog_version) return null;
  if (!token(current.result_id)) return null;
  if (!isRecord(current.dependencies)) return null;
  const deps = current.dependencies;
  if (!sameJson(deps.geometry, geometryDeps)) return null;
  if (deps.geometry_result_id !== raw.geometry_result_id) return null;
  if (deps.input_revision !== inputs.input_revision) return null;
  if (deps.inputs_sha256 !== inputs.inputs_sha256) return null;
  if (deps.catalog_version !== raw.catalog_version) return null;
  if (deps.calculation_version !== SIZING_CALCULATION_VERSION) return null;

  const pipeline = isRecord(result.pipeline) ? result.pipeline : null;
  if (
    !pipeline ||
    !(PIPELINE_STATUSES as readonly string[]).includes(String(pipeline.status))
  )
    return null;
  if (pipeline) {
    if (
      pipeline.clinical_suitability_established !== false ||
      pipeline.validated_sizing !== false ||
      pipeline.spatial_units !== "mm"
    ) {
      return null;
    }
  }
  const web = isRecord(result.web) ? result.web : null;
  if (
    !web ||
    !WEB_STATUSES.includes(
      String(web.status) as (typeof WEB_STATUSES)[number],
    ) ||
    web.approximate !== true
  )
    return null;
  if (web) {
    if (
      web.clinical_suitability_established !== false ||
      web.validated_sizing !== false ||
      web.spatial_units !== "mm"
    ) {
      return null;
    }
  }

  for (const [obj, keys] of [
    [pipeline, ["largest_parent_mm", "minimum_labeled_coverage_length_mm"]],
    [web, ["nominal_target_diameter_mm", "nominal_target_height_mm"]],
  ] as const) {
    for (const key of keys)
      if (
        obj[key] !== null &&
        obj[key] !== undefined &&
        !isFiniteNonnegative(obj[key])
      )
        return null;
  }

  const missingInputs =
    Array.isArray(result.missing_inputs) &&
    result.missing_inputs.every((name) => typeof name === "string")
      ? (result.missing_inputs as string[])
      : [];

  if (
    !Array.isArray(result.missing_inputs) ||
    result.missing_inputs.length !== missingInputs.length ||
    !sameJson(
      [...missingInputs].sort(),
      MEASUREMENT_KEYS.filter(
        (k) => (inputs.measurements as Record<string, unknown>)[k] === null,
      ).sort(),
    ) ||
    result.status !==
      (missingInputs.length ? "partial_inputs" : "calculated") ||
    result.compatibility_status !== "not_established" ||
    result.input_basis !== "operator_reported_unvalidated_measurements" ||
    !sameJson(result.provenance, inputs.provenance)
  )
    return null;
  if (pipeline.status === "geometric_checks_only") {
    if (
      !isFiniteNonnegative(pipeline.largest_parent_mm) ||
      !isFiniteNonnegative(pipeline.minimum_labeled_coverage_length_mm)
    )
      return null;
  } else if (pipeline.status === "missing_inputs") {
    if (
      pipeline.largest_parent_mm !== null ||
      pipeline.minimum_labeled_coverage_length_mm !== null
    )
      return null;
  } else if (
    !isFiniteNonnegative(pipeline.largest_parent_mm) ||
    pipeline.minimum_labeled_coverage_length_mm !== null
  )
    return null;
  if (web.status === "geometric_checks_only") {
    if (
      !isFiniteNonnegative(web.nominal_target_diameter_mm) ||
      !isFiniteNonnegative(web.nominal_target_height_mm)
    )
      return null;
  } else if (
    web.nominal_target_diameter_mm != null ||
    web.nominal_target_height_mm != null
  )
    return null;

  return {
    geometry_status: "current",
    inputs_status: "current",
    result_status: "current",
    numbers_available: true,
    input_revision: inputs.input_revision,
    result_id: current.result_id,
    missing_inputs: [...missingInputs].sort(),
    pipeline_status:
      pipeline &&
      (PIPELINE_STATUSES as readonly string[]).includes(String(pipeline.status))
        ? String(pipeline.status)
        : null,
    pipeline_metrics: pipeline
      ? [
          metric(pipeline, "largest_parent_mm", "Largest parent diameter"),
          metric(
            pipeline,
            "minimum_labeled_coverage_length_mm",
            "Minimum labeled coverage length",
          ),
        ].filter((entry): entry is SizingMetricView => entry !== null)
      : [],
    pipeline_source: pipeline ? sourceText(pipeline.source) : null,
    web_status:
      web && (WEB_STATUSES as readonly string[]).includes(String(web.status))
        ? String(web.status)
        : null,
    web_metrics: web
      ? [
          metric(
            web,
            "nominal_target_diameter_mm",
            "Approximate WEB nominal target diameter",
          ),
          metric(
            web,
            "nominal_target_height_mm",
            "Approximate WEB nominal target height",
          ),
        ].filter((entry): entry is SizingMetricView => entry !== null)
      : [],
    web_approximate: web ? web.approximate === true : false,
    web_source: web ? sourceText(web.source) : null,
  };
}

function hiddenView(
  geometry_status: string,
  inputs_status: string,
  result_status: string,
): ParsedSizingReport {
  return {
    geometry_status,
    inputs_status,
    result_status,
    numbers_available: false,
    input_revision: null,
    result_id: null,
    missing_inputs: [],
    pipeline_status: null,
    pipeline_metrics: [],
    pipeline_source: null,
    web_status: null,
    web_metrics: [],
    web_approximate: false,
    web_source: null,
  };
}

const STATUS_WORDING: Record<string, string> = {
  calculated:
    "Historical calculation completed for the operator-reported inputs.",
  geometric_checks_only: "Geometric checks only; no device was calculated.",
  missing_inputs: "Not all required operator-reported inputs were present.",
  out_of_family_range:
    "Operator-reported inputs fall outside the historical documented range; this is a factual interval note, not a clinical rejection.",
  unsupported: "The historical rules do not cover this configuration.",
};

function formatMm(value: number): string {
  return `${value.toFixed(1)} mm`;
}

export default function DeviceSizingResults({
  caseState,
  binding,
  report,
  disabled = false,
}: {
  caseState: CaseState;
  binding: MorphometryBinding | null;
  report: unknown;
  disabled?: boolean;
}) {
  const parsed = disabled
    ? null
    : parseSizingReport(report, caseState, binding);

  if (!parsed) {
    return (
      <section className="device-sizing-results">
        <h3>Saved sizing calculation</h3>
        <p className="device-sizing-results-note">
          No saved sizing numbers are shown. The saved report is missing, does
          not match the current case, geometry capture and operator inputs, or
          review is disabled.
        </p>
      </section>
    );
  }

  if (!parsed.numbers_available) {
    return (
      <section className="device-sizing-results">
        <h3>Saved sizing calculation</h3>
        <p className="device-sizing-results-note">
          Saved sizing numbers are hidden because the saved geometry, inputs or
          result is stale, not saved, or not computed (geometry:{" "}
          {parsed.geometry_status}; inputs: {parsed.inputs_status}; result:{" "}
          {parsed.result_status}).
        </p>
      </section>
    );
  }

  const wording =
    (parsed.pipeline_status && STATUS_WORDING[parsed.pipeline_status]) ||
    (parsed.web_status && STATUS_WORDING[parsed.web_status]) ||
    "Historical calculation status is not recognized; numbers are hidden.";

  return (
    <section className="device-sizing-results">
      <h3>Saved sizing calculation</h3>
      <dl>
        {parsed.pipeline_metrics.map((entry) => (
          <div key={entry.label}>
            <dt>{entry.label}</dt>
            <dd>{formatMm(entry.value_mm)}</dd>
          </div>
        ))}
        {parsed.web_metrics.map((entry) => (
          <div key={entry.label}>
            <dt>{entry.label}</dt>
            <dd>{formatMm(entry.value_mm)}</dd>
          </div>
        ))}
      </dl>
      {parsed.missing_inputs.length > 0 && (
        <p className="device-sizing-results-note">
          Missing independent inputs:{" "}
          {parsed.missing_inputs
            .map((name) => name.replaceAll("_", " "))
            .join(", ")}
          .
        </p>
      )}
      <p className="device-sizing-results-note">{wording}</p>
      <details>
        <summary>Historical sources</summary>
        {parsed.pipeline_source && (
          <p className="device-sizing-results-note">
            Historical source: {parsed.pipeline_source}.
          </p>
        )}
        {parsed.web_source && parsed.web_approximate && (
          <p className="device-sizing-results-note">
            Approximate WEB sizing source: {parsed.web_source}.
          </p>
        )}
      </details>
      <p className="device-sizing-results-note">
        Operator-reported inputs, historical rules only. No device is selected
        and no clinical compatibility is established.
      </p>
      <p className="device-sizing-results-trace">
        Input revision {parsed.input_revision}; result {parsed.result_id}.
      </p>
    </section>
  );
}
