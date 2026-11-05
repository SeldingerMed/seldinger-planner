import { useEffect, useRef, useState } from "react";
import { api, type CaseState } from "./api";
import type { MorphometryBinding } from "./MorphometryInputs";
import "./device-reference.css";

/**
 * Read-only device reference tracer. GET /device-catalog and
 * /cases/{id}/device-checks only — no writes, no client-side sizing.
 * All numbers rendered come verbatim from validated response envelopes.
 */

type ParentSection = {
  min_diameter_mm: number;
  max_diameter_mm: number;
  equivalent_diameter_mm: number;
  area_mm2: number;
  comparison: string;
};

type CatalogRow = {
  device_id: string;
  labeled_diameter_mm: number;
  self_expanded_diameter_mm: number;
  labeled_lengths_mm: number[];
};

type DeviceCatalog = {
  version_basis: string;
  clinical_suitability_established: boolean;
  device_checks_version: string;
  catalog_version: string;
  validated_sizing: boolean;
  pipeline: {
    catalog_scope: string;
    clinical_suitability_established: boolean;
    rows: CatalogRow[];
    source: { revision: string; url: string; scope?: string };
  };
  web: {
    catalog_status: string;
    required_inputs: string[];
    rows: unknown[];
    source: { revision: string; url: string };
  };
};

type DeviceChecks = {
  case_id: string;
  image_sha256: string;
  reference_revision: string;
  artifact_version: string;
  catalog_version: string;
  device_checks_version: string;
  geometry_status: string;
  status: string;
  clinical_suitability_established: boolean;
  validated_sizing: boolean;
  missing_dimensions: Record<string, { status: string; reason: string }>;
  dependencies: {
    geometry_result_id: string;
    catalog_version: string;
    device_checks_version: string;
    geometry: {
      case_id: string;
      image_sha256: string;
      source_revision: string;
      artifact_version: string;
      calculation_version: string;
    } | null;
  } | null;
  checks: {
    pipeline: {
      basis: string;
      parent_range_mm: number[];
      sizing_status: string;
      parent_sections: Record<string, ParentSection>;
    } | null;
    web: { sizing_status: string; catalog_rows_available: boolean } | null;
  } | null;
};

type Loaded = { catalog: DeviceCatalog; checks: DeviceChecks };

const RECOGNIZED_COMPARISONS = new Set([
  "within_historical_range",
  "outside_historical_range",
]);

const COMPARISON_LABELS: Record<string, string> = {
  within_historical_range: "within historical interval",
  outside_historical_range: "outside historical interval",
};

export type DeviceReferenceProps = {
  caseState: CaseState;
  binding: MorphometryBinding;
  disabled?: boolean;
};

function isPositiveFinite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

function validSection(s: ParentSection): boolean {
  return (
    isPositiveFinite(s.min_diameter_mm) &&
    isPositiveFinite(s.max_diameter_mm) &&
    isPositiveFinite(s.equivalent_diameter_mm) &&
    isPositiveFinite(s.area_mm2) &&
    s.max_diameter_mm >= s.min_diameter_mm &&
    typeof s.comparison === "string" &&
    RECOGNIZED_COMPARISONS.has(s.comparison)
  );
}

function validRow(r: CatalogRow): boolean {
  return (
    typeof r.device_id === "string" &&
    r.device_id.length > 0 &&
    isPositiveFinite(r.labeled_diameter_mm) &&
    isPositiveFinite(r.self_expanded_diameter_mm) &&
    Array.isArray(r.labeled_lengths_mm) &&
    r.labeled_lengths_mm.length > 0 &&
    r.labeled_lengths_mm.every((l) => isPositiveFinite(l))
  );
}

function validSource(
  s: { revision: string; url: string } | null | undefined,
): boolean {
  if (
    !s ||
    typeof s.revision !== "string" ||
    !s.revision ||
    typeof s.url !== "string"
  )
    return false;
  try {
    const u = new URL(s.url);
    return u.protocol === "https:" && u.hostname === "www.accessdata.fda.gov";
  } catch {
    return false;
  }
}

function validCatalog(c: DeviceCatalog): boolean {
  return (
    !!c &&
    typeof c.catalog_version === "string" &&
    /^[a-f0-9]{64}$/.test(c.catalog_version) &&
    c.version_basis === "canonical_catalog_and_rule_data_sha256" &&
    c.device_checks_version === "historical-label-range-checks-v1" &&
    c.clinical_suitability_established === false &&
    c.validated_sizing === false &&
    c.pipeline?.catalog_scope === "historical_source_only" &&
    c.pipeline.clinical_suitability_established === false &&
    Array.isArray(c.pipeline.rows) &&
    c.pipeline.rows.length > 0 &&
    c.pipeline.rows.length <= 64 &&
    validSource(c.pipeline.source) &&
    c.pipeline.rows.every(validRow) &&
    !!c.web &&
    Array.isArray(c.web.rows) &&
    c.web.rows.length === 0 &&
    c.web.catalog_status === "not_available" &&
    validSource(c.web.source)
  );
}

function scopeMatches(
  checks: DeviceChecks,
  b: MorphometryBinding,
  caseState: CaseState,
): boolean {
  return (
    checks.case_id === b.case_id &&
    checks.image_sha256 === b.image_sha256 &&
    checks.reference_revision === b.reference_revision &&
    checks.artifact_version === caseState.artifact_version
  );
}

function validChecks(
  checks: DeviceChecks,
  b: MorphometryBinding,
  caseState: CaseState,
  catalog: DeviceCatalog,
): boolean {
  if (
    !checks ||
    !scopeMatches(checks, b, caseState) ||
    checks.clinical_suitability_established !== false ||
    checks.validated_sizing !== false ||
    checks.catalog_version !== catalog.catalog_version ||
    checks.device_checks_version !== catalog.device_checks_version
  ) {
    return false;
  }
  // Stale / not_computed producers carry no numeric case data.
  const missing = checks.missing_dimensions;
  if (
    !missing ||
    Object.keys(missing).sort().join(",") !==
      "average_sac_diameter,dome_diameter,neck_coverage_length,smallest_sac_height" ||
    !Object.values(missing).every(
      (d) =>
        d &&
        d.status === "missing" &&
        typeof d.reason === "string" &&
        d.reason.trim().length > 0,
    )
  )
    return false;
  if (checks.checks === null && checks.dependencies === null)
    return (
      ["stale", "not_computed"].includes(checks.status) &&
      checks.geometry_status === checks.status
    );
  if (
    checks.geometry_status !== "current" ||
    checks.status !== "partial_inputs"
  ) {
    return false;
  }
  const deps = checks.dependencies;
  if (
    !deps ||
    deps.device_checks_version !== catalog.device_checks_version ||
    deps.catalog_version !== catalog.catalog_version ||
    typeof deps.geometry_result_id !== "string" ||
    deps.geometry_result_id.length === 0 ||
    !deps.geometry
  ) {
    return false;
  }
  const geo = deps.geometry;
  if (
    geo.case_id !== b.case_id ||
    geo.image_sha256 !== b.image_sha256 ||
    geo.source_revision !== b.reference_revision ||
    geo.artifact_version !== caseState.artifact_version ||
    geo.calculation_version !== "native-mask-operator-plane-v1"
  ) {
    return false;
  }
  const checksData = checks.checks;
  if (!checksData?.pipeline || !checksData.web) return false;
  if (
    checksData.pipeline.sizing_status !== "missing_inputs" ||
    checksData.web.sizing_status !== "missing_inputs" ||
    checksData.web.catalog_rows_available !== false
  )
    return false;
  const p = checksData.pipeline;
  if (p.basis !== "operator_path_normal_mask_feret_extrema") return false;
  if (
    !Array.isArray(p.parent_range_mm) ||
    !p.parent_range_mm.every(isPositiveFinite) ||
    p.parent_range_mm.length !== 2 ||
    p.parent_range_mm[1] < p.parent_range_mm[0]
  ) {
    return false;
  }
  const sections = Object.values(p.parent_sections ?? {});
  return (
    Object.keys(p.parent_sections ?? {})
      .sort()
      .join(",") === "distal_parent,proximal_parent" &&
    sections.every(validSection)
  );
}

function fmt(n: number): string {
  return String(Number(n.toFixed(3)));
}

export default function DeviceReference({
  caseState,
  binding,
  disabled,
}: DeviceReferenceProps) {
  const scope = `${binding.case_id}|${binding.image_sha256}|${binding.reference_revision}|${caseState.artifact_version}`;
  const [shownScope, setShownScope] = useState(scope);
  const [stored, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);
  const epoch = useRef(0);

  // Hide old-scope data synchronously (during render, before effects).
  if (shownScope !== scope) {
    setShownScope(scope);
    setData(null);
    setFailed(false);
  }

  const eligible =
    !disabled &&
    caseState.spatial_units === "mm" &&
    !!binding.case_id &&
    binding.case_id === caseState.case_id &&
    binding.image_sha256 === caseState.image_sha256;

  useEffect(() => {
    if (!eligible) {
      setData(null);
      setFailed(false);
      return;
    }
    setData(null);
    setFailed(false);
    const myEpoch = ++epoch.current;
    let alive = true;
    const discard = () => {
      if (epoch.current !== myEpoch) return true;
      if (!alive) return true;
      return false;
    };
    (async () => {
      try {
        const catalog = await api<DeviceCatalog>("/device-catalog");
        const checks = await api<DeviceChecks>(
          `/cases/${encodeURIComponent(binding.case_id)}/device-checks`,
        );
        if (discard()) return;
        if (
          !validCatalog(catalog) ||
          !validChecks(checks, binding, caseState, catalog)
        ) {
          setFailed(true);
          return;
        }
        if (
          checks.checks !== null &&
          (catalog.catalog_version !== checks.catalog_version ||
            catalog.catalog_version !== depsCatalogVersion(checks))
        ) {
          setFailed(true);
          return;
        }
        setData({ catalog, checks });
      } catch {
        if (discard()) return;
        setFailed(true);
      }
    })();
    return () => {
      alive = false;
      epoch.current++;
    };
  }, [scope, eligible]);

  const data = eligible && !failed && shownScope === scope ? stored : null;
  let statusLine: string;
  if (!eligible || failed) {
    statusLine = "Unavailable";
  } else if (!data) {
    statusLine = "Loading…";
  } else if (data.checks.checks === null) {
    statusLine = data.checks.status === "stale" ? "Stale" : "Awaiting geometry";
  } else {
    statusLine = "";
  }
  const hasCurrent = !!data && data.checks.checks !== null;
  const missing = hasCurrent ? (data!.checks.missing_dimensions ?? {}) : {};

  return (
    <section className="device-reference" data-testid="device-reference">
      <h3>Device reference</h3>
      {statusLine ? (
        <p className="device-reference-status" data-testid="dr-status">
          {statusLine}
        </p>
      ) : null}
      {hasCurrent ? (
        <p className="device-reference-badge" data-testid="dr-badge">
          Missing sizing inputs
        </p>
      ) : null}
      <p className="device-reference-disclaimer">
        Mask-section extrema against historical label ranges, not clinical
        eligibility or a device recommendation.
      </p>
      {hasCurrent && data!.checks.checks!.pipeline ? (
        <dl className="device-reference-sections">
          {Object.entries(data!.checks.checks!.pipeline.parent_sections).map(
            ([name, s]) => (
              <div key={name} className="device-reference-section">
                <dt>{name.replace(/_/g, " ")}</dt>
                <dd>
                  {fmt(s.min_diameter_mm)}–{fmt(s.max_diameter_mm)} mm (Feret
                  extrema; historical interval{" "}
                  {fmt(data!.checks.checks!.pipeline!.parent_range_mm[0])}–
                  {fmt(data!.checks.checks!.pipeline!.parent_range_mm[1])} mm
                  from the historical label).{" "}
                  {COMPARISON_LABELS[s.comparison] ?? s.comparison}.
                </dd>
              </div>
            ),
          )}
        </dl>
      ) : null}
      {hasCurrent && Object.keys(missing).length > 0 ? (
        <details className="device-reference-missing">
          <summary>
            Required sizing inputs: {Object.keys(missing).length} missing
          </summary>
          <ul>
            {Object.entries(missing).map(([name, m]) => (
              <li key={name}>
                <strong>{name.replace(/_/g, " ")}</strong>: {m.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {data && validCatalog(data.catalog) ? (
        <>
          <p className="device-reference-source">
            Historical FDA label data · geometric checks only ·{" "}
            <a href={data.catalog.pipeline.source.url}>
              {data.catalog.pipeline.source.revision}
            </a>
            {data.catalog.web.source ? (
              <>
                {" · "}
                <a href={data.catalog.web.source.url}>
                  {data.catalog.web.source.revision}
                </a>
              </>
            ) : null}
          </p>
          <button
            type="button"
            className="device-reference-toggle"
            onClick={() => setTableOpen((v) => !v)}
          >
            Historical Pipeline size rows
          </button>
          {tableOpen ? (
            <table className="device-reference-table">
              <thead>
                <tr>
                  <th>Internal ID</th>
                  <th>Labeled diameter (mm)</th>
                  <th>Self-expanded diameter (mm)</th>
                  <th>Labeled lengths (mm)</th>
                </tr>
              </thead>
              <tbody>
                {data.catalog.pipeline.rows.map((r) => (
                  <tr key={r.device_id}>
                    <td>{r.device_id}</td>
                    <td>{fmt(r.labeled_diameter_mm)}</td>
                    <td>{fmt(r.self_expanded_diameter_mm)}</td>
                    <td>{r.labeled_lengths_mm.map(fmt).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <p className="device-reference-notes">
            Internal identifiers are not manufacturer SKUs. The WEB catalog is
            unavailable and target calculation requires missing independent
            inputs.
          </p>
        </>
      ) : null}
    </section>
  );
}

function depsCatalogVersion(checks: DeviceChecks): string | null {
  return checks.dependencies ? checks.dependencies.catalog_version : null;
}
