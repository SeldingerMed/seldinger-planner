import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import "./workflow.css";

export type WorkflowIdentity = {
  case_id: string;
  image_sha256: string;
  artifact_version: string;
  reference_revision: string;
};
type Props = {
  identity: WorkflowIdentity | null;
  imported: boolean;
  dirty: boolean;
  busy: boolean;
  conflict: boolean;
  refreshKey: string;
  onImport: () => void;
  onScenarios: () => void;
};
type Snapshot = {
  anatomy: boolean;
  geometry: boolean;
  alternatives: "unavailable" | "not_computed" | "stale" | "current";
  count: number;
  scene: "not_confirmed" | "stale" | "current";
  markdown: string;
};
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const hex = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const token = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(v);
const keys = (v: Record<string, unknown>, names: string[]) =>
  Object.keys(v).length === names.length &&
  names.every((k) => Object.hasOwn(v, k));
const identityKeys = [
  "case_id",
  "image_sha256",
  "artifact_version",
  "reference_revision",
];
function matches(v: Record<string, unknown>, identity: WorkflowIdentity) {
  return identityKeys.every(
    (k) => v[k] === identity[k as keyof WorkflowIdentity],
  );
}

export function parseWorkflowBrief(
  raw: unknown,
  identity: WorkflowIdentity,
): Snapshot {
  const invalid = () => {
    throw new Error(
      "Saved workflow evidence is inconsistent; reload saved state.",
    );
  };
  if (
    !record(raw) ||
    !matches(raw, identity) ||
    !record(raw.planning) ||
    !matches(raw.planning, identity)
  )
    return invalid();
  const plan = raw.planning;
  if (
    !keys(plan, [
      ...identityKeys,
      "segmentation_summary",
      "morphometry_summary",
      "device_sizing_summary",
      "territory_summary",
      "evidence_boundary",
    ])
  )
    return invalid();
  const segments = plan.segmentation_summary;
  if (
    !Array.isArray(segments) ||
    segments.length > 2 ||
    !segments.every(
      (s) =>
        record(s) &&
        keys(s, [
          "candidate_id",
          "role",
          "producer",
          "mask_sha256",
          "segmentation_revision",
        ]) &&
        typeof s.candidate_id === "string" &&
        /^[A-Za-z0-9_-]{1,80}$/.test(s.candidate_id) &&
        hex(s.mask_sha256) &&
        typeof s.producer === "string" &&
        Number.isSafeInteger(s.segmentation_revision) &&
        (s.segmentation_revision as number) > 0 &&
        ["vessel", "aneurysm"].includes(String(s.role)),
    )
  )
    return invalid();
  const roles = new Set(segments.map((s) => s.role));
  if (roles.size !== segments.length) return invalid();
  const anatomy = roles.has("vessel") && roles.has("aneurysm");
  const geometry = plan.morphometry_summary;
  if (
    geometry !== null &&
    (!record(geometry) ||
      !(
        typeof geometry.result_id === "string" &&
        /^[A-Za-z0-9_-]{1,100}$/.test(geometry.result_id)
      ) ||
      geometry.spatial_units !== "mm" ||
      !anatomy)
  )
    return invalid();
  const alternatives = raw.device_scenarios;
  if (
    !record(alternatives) ||
    !["unavailable", "not_computed", "stale", "current"].includes(
      String(alternatives.status),
    )
  )
    return invalid();
  if (
    alternatives.status !== "unavailable" &&
    (!matches(alternatives, identity) ||
      !record(geometry) ||
      alternatives.geometry_result_id !== geometry.result_id ||
      !hex(alternatives.catalog_version) ||
      !Number.isSafeInteger(alternatives.scenario_revision) ||
      (alternatives.scenario_revision as number) < 0)
  )
    return invalid();
  let count = 0;
  if (alternatives.status === "current") {
    if (
      !token(alternatives.set_id) ||
      !hex(alternatives.scenarios_sha256) ||
      !Array.isArray(alternatives.scenarios) ||
      alternatives.scenarios.length > 12 ||
      (alternatives.scenario_revision as number) < 1 ||
      !record(alternatives.dependencies) ||
      alternatives.dependencies.case_id !== identity.case_id ||
      alternatives.dependencies.image_sha256 !== identity.image_sha256 ||
      alternatives.dependencies.artifact_version !==
        identity.artifact_version ||
      alternatives.dependencies.source_revision !==
        identity.reference_revision ||
      !hex(alternatives.dependencies.operator_sha256) ||
      !record(alternatives.dependencies.masks)
    )
      return invalid();
    const masks = alternatives.dependencies.masks;
    if (
      !record(masks) ||
      !keys(masks, ["vessel", "aneurysm"]) ||
      !segments.every((s) => {
        const mask = masks[s.role];
        return (
          record(mask) &&
          keys(mask, [
            "candidate_id",
            "mask_sha256",
            "segmentation_revision",
          ]) &&
          ["candidate_id", "mask_sha256", "segmentation_revision"].every(
            (k) => mask[k] === s[k],
          )
        );
      })
    )
      return invalid();
    if (
      !alternatives.scenarios.every(
        (row) =>
          record(row) &&
          keys(row, ["id", "name", "placement", "path_point_count"]) &&
          typeof row.id === "string" &&
          /^[A-Za-z0-9_-]{8,80}$/.test(row.id) &&
          typeof row.name === "string" &&
          row.name.length > 0 &&
          row.name.length <= 120 &&
          record(row.placement) &&
          Number.isSafeInteger(row.path_point_count) &&
          (row.path_point_count as number) >= 2 &&
          (row.path_point_count as number) <= 64,
      )
    )
      return invalid();
    count = alternatives.scenarios.length;
  } else if (Object.hasOwn(alternatives, "scenarios")) return invalid();
  const scene = raw.scene;
  if (
    !record(scene) ||
    !["not_confirmed", "stale", "current"].includes(String(scene.status)) ||
    !Number.isSafeInteger(scene.scene_revision) ||
    (scene.scene_revision as number) < 0
  )
    return invalid();
  if (
    scene.status === "current" &&
    (!token(scene.scene_id) || !hex(scene.input_sha256))
  )
    return invalid();
  if (
    typeof raw.markdown !== "string" ||
    raw.markdown.length > 100000 ||
    !raw.markdown.startsWith("# Local planning brief\n")
  )
    return invalid();
  return {
    anatomy,
    geometry: geometry !== null,
    alternatives: alternatives.status as Snapshot["alternatives"],
    count,
    scene: scene.status as Snapshot["scene"],
    markdown: raw.markdown,
  };
}

export default function WorkflowGuide({
  identity,
  imported,
  dirty,
  busy,
  conflict,
  refreshKey,
  onImport,
  onScenarios,
}: Props) {
  const scope = identity
    ? identityKeys.map((k) => identity[k as keyof WorkflowIdentity]).join(":")
    : "";
  const [epoch, setEpoch] = useState(0);
  const request = `${scope}:${refreshKey}:${epoch}`;
  const latest = useRef({ request, blocked: dirty || busy || conflict });
  latest.current = { request, blocked: dirty || busy || conflict };
  const [state, setState] = useState<{
    request: string;
    data: Snapshot | null;
    error: string;
  }>({ request: "", data: null, error: "" });
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const current = state.request === request ? state.data : null;
  const error = state.request === request ? state.error : "";
  const loading = !!identity && !current && !error;
  useEffect(() => {
    let live = true;
    setExporting(false);
    setExportError("");
    setState({ request, data: null, error: "" });
    if (identity)
      void api<unknown>(
        `/cases/${encodeURIComponent(identity.case_id)}/local-brief`,
      )
        .then((raw) => {
          const data = parseWorkflowBrief(raw, identity);
          if (live) setState({ request, data, error: "" });
        })
        .catch(() => {
          if (live)
            setState({
              request,
              data: null,
              error:
                "Saved workflow evidence is unavailable. Refresh workflow or reload saved state.",
            });
        });
    return () => {
      live = false;
    };
  }, [request]);
  async function download() {
    if (!identity || !current?.geometry || latest.current.blocked || exporting)
      return;
    const captured = request;
    setExporting(true);
    setExportError("");
    try {
      const raw = await api<unknown>(
        `/cases/${encodeURIComponent(identity.case_id)}/local-brief`,
      );
      const fresh = parseWorkflowBrief(raw, identity);
      if (
        latest.current.request !== captured ||
        latest.current.blocked ||
        !fresh.geometry
      )
        throw new Error();
      const url = URL.createObjectURL(
        new Blob([fresh.markdown + "\n"], {
          type: "text/markdown;charset=utf-8",
        }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "planning-brief.md";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      if (latest.current.request === captured)
        setExportError(
          "Brief export could not be confirmed. Refresh workflow or reload saved state.",
        );
    } finally {
      if (latest.current.request === captured) setExporting(false);
    }
  }
  return (
    <nav className="workflow-guide" aria-label="Planning workflow">
      <div className="eyebrow">PLANNING WORKFLOW</div>
      <ol>
        <li>
          <button disabled={busy || dirty || conflict} onClick={onImport}>
            1 Import CTA
          </button>
          <small>
            {identity
              ? "Source verified"
              : imported
                ? "Calibrated source required"
                : "Choose a volume"}
          </small>
        </li>
        <li>
          <a href="#model-segmentation">2 Anatomy</a>
          <small>
            {current?.anatomy
              ? "Vessel and sac accepted"
              : "Review and accept anatomy"}
          </small>
        </li>
        <li>
          <a href="#mask-geometry">3 Measurements</a>
          <small>
            {current?.geometry
              ? "Measurements current"
              : "Save inputs and compute geometry"}
          </small>
        </li>
        <li>
          <button
            onClick={onScenarios}
            disabled={!current?.geometry || busy || dirty || conflict}
          >
            4 Device scenarios
          </button>
          <small>
            {current?.alternatives === "current"
              ? `${current.count} saved alternatives`
              : current?.alternatives === "stale"
                ? "Saved alternatives stale"
                : "No current saved alternatives"}
          </small>
        </li>
        <li>
          <button
            aria-label="Download planning brief"
            disabled={
              !current?.geometry || busy || dirty || conflict || exporting
            }
            onClick={() => void download()}
          >
            5 Export brief
          </button>
          <small>Current saved evidence only</small>
        </li>
      </ol>
      <p className="muted small" role="status">
        {conflict
          ? "Saved state changed. Reload saved state before continuing."
          : dirty
            ? "Unsaved edits. Save or discard them before changing source, opening scenarios or exporting."
            : busy
              ? "Operation in progress."
              : loading
                ? "Reading saved workflow evidence…"
                : error ||
                  (current?.scene === "stale"
                    ? "Reformat scene stale. Confirm a new scene before using its views."
                    : current?.scene === "current"
                      ? "Reformat scene confirmed."
                      : "Reformat path requires explicit confirmation before use.")}
      </p>
      {exportError && <p role="alert">{exportError}</p>}
      <button
        disabled={
          !identity || loading || busy || dirty || conflict || exporting
        }
        onClick={() => setEpoch((e) => e + 1)}
      >
        Refresh workflow
      </button>
    </nav>
  );
}
