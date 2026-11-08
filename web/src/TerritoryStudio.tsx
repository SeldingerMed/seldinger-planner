import { useEffect, useRef, useState } from "react";
import "./territory.css";
import type { NVImage } from "@niivue/niivue";
import { api, WorkspaceRequestError, type CaseState } from "./api";
import type { Vec3 } from "./obliqueSlice";
import TerritorySectionEditor, { type Section } from "./TerritorySectionEditor";
import TerritoryPathEditor, {
  type PathProfiles,
  type Profile,
} from "./TerritoryPathEditor";
import {
  parseWorkflow,
  pathIndexError,
  stable,
  record,
  type Workflow,
  type WorkflowMode,
  type Data,
  type Identity,
} from "./territoryWorkflow";
const modes: Record<WorkflowMode, string> = {
  tavr: "Structural heart / TAVR",
  coronary_pci: "Coronary PCI",
  aortic_peripheral: "Aortic / peripheral",
};
const emptySection = (): Section => ({
  origin: [0, 0, 0],
  normal: [0, 0, 1],
  contour: [],
});
function emptyInputs(mode: WorkflowMode): Data {
  if (mode === "tavr")
    return { annulus: emptySection(), left_ostium: null, right_ostium: null };
  if (mode === "coronary_pci")
    return {
      path: [],
      profiles: [],
      lesion_start: null,
      lesion_end: null,
      proximal_reference: null,
      distal_reference: null,
      bifurcation: null,
    };
  return {
    path: [],
    profiles: [],
    suprarenal_index: null,
    neck_start: null,
    neck_end: null,
    sac_index: null,
    left_access: null,
    right_access: null,
  };
}
type Props = {
  caseState: Pick<
    CaseState,
    "case_id" | "image_sha256" | "artifact_version" | "spatial_units"
  >;
  binding: {
    case_id: string;
    image_sha256: string;
    reference_revision: string;
  };
  volume: NVImage | null;
  cursor: Vec3 | null;
  disabled?: boolean;
  onBusy?: (busy: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
};
type Snapshot = {
  key: string;
  workflow: Workflow;
  inputs: Data;
  dirty: boolean;
  locked: boolean;
  error: string;
};
const labels: Record<string, string> = {
  area_mm2: "Annular area (mm²)",
  perimeter_mm: "Annular perimeter (mm)",
  area_derived_diameter_mm: "Area-equivalent diameter (mm)",
  perimeter_derived_diameter_mm: "Perimeter-equivalent diameter (mm)",
  min_diameter_mm: "Minimum Feret diameter (mm)",
  max_diameter_mm: "Maximum Feret diameter (mm)",
  left_coronary_height_mm: "Left coronary height (mm)",
  right_coronary_height_mm: "Right coronary height (mm)",
  lesion_length_mm: "Lesion path length (mm)",
  proximal_reference_diameter_mm: "Proximal reference diameter (mm)",
  distal_reference_diameter_mm: "Distal reference diameter (mm)",
  reference_taper_mm_per_mm: "Reference taper (mm/mm)",
  sampled_minimum_diameter_mm: "Sampled minimum diameter (mm)",
  minimum_station: "Minimum at path index",
  diameter_narrowing_pct: "Diameter narrowing (%)",
  bifurcation_angle_deg: "Daughter-vessel angle (°)",
  neck_length_mm: "Neck path length (mm)",
  alpha_deg: "Suprarenal-to-neck angle (°)",
  beta_deg: "Neck-to-sac angle (°)",
  thrombus_burden_pct: "Traced thrombus burden (%)",
  calcification_burden_pct: "Traced calcification burden (%)",
  sampled_maximum_diameter_mm: "Sampled maximum diameter (mm)",
  maximum_station: "Maximum at path index",
  length_mm: "Access path length (mm)",
};
function Metrics({ result }: { result: Data }) {
  return (
    <dl className="territory-metrics">
      {Object.entries(labels)
        .filter(([key]) => key in result)
        .map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd data-testid={`metric-${key}`}>
              {typeof result[key] === "number"
                ? (result[key] as number).toFixed(3)
                : "Not annotated"}
            </dd>
          </div>
        ))}
    </dl>
  );
}
function Profiles({ rows }: { rows: unknown }) {
  if (!Array.isArray(rows)) return null;
  return (
    <div className="territory-table">
      <table>
        <caption>Traced physical sections</caption>
        <thead>
          <tr>
            {[
              "Index",
              "Distance (mm)",
              "Area (mm²)",
              "Min / max Feret (mm)",
              "Outer / thrombus / calcium (mm²)",
            ].map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.filter(record).map((row) => (
            <tr key={String(row.station)}>
              <td>{String(row.station)}</td>
              <td>{Number(row.distance_mm).toFixed(2)}</td>
              <td>{Number(row.area_mm2).toFixed(2)}</td>
              <td>
                {Number(row.min_diameter_mm).toFixed(2)} /{" "}
                {Number(row.max_diameter_mm).toFixed(2)}
              </td>
              <td>
                {[
                  "outer_area_mm2",
                  "thrombus_area_mm2",
                  "calcification_area_mm2",
                ]
                  .map((k) =>
                    typeof row[k] === "number"
                      ? (row[k] as number).toFixed(2)
                      : "unknown",
                  )
                  .join(" / ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export default function TerritoryStudio({
  caseState,
  binding,
  volume,
  cursor,
  disabled = false,
  onBusy,
  onDirtyChange,
}: Props) {
  const [mode, setMode] = useState<WorkflowMode>("tavr");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [saving, setSaving] = useState(false);
  const epoch = useRef(0),
    writeLock = useRef(false);
  const callbacks = useRef({ onBusy, onDirtyChange });
  callbacks.current = { onBusy, onDirtyChange };
  const identity: Identity = {
    case_id: caseState.case_id,
    image_sha256: caseState.image_sha256,
    artifact_version: caseState.artifact_version,
    reference_revision: binding.reference_revision,
  };
  const key = stable({ ...identity, mode });
  const eligible =
    caseState.spatial_units === "mm" &&
    binding.case_id === caseState.case_id &&
    binding.image_sha256 === caseState.image_sha256 &&
    /^[a-f0-9]{64}$/.test(binding.reference_revision) &&
    volume !== null;
  const live = useRef("");
  live.current = eligible ? key : "";
  const route = `/cases/${encodeURIComponent(caseState.case_id)}/territory-workflows/${mode}`;
  useEffect(() => {
    const ticket = ++epoch.current;
    setSnapshot(null);
    setLoadError("");
    callbacks.current.onDirtyChange?.(false);
    if (eligible) {
      void api<unknown>(route)
        .then((raw) => {
          const workflow = parseWorkflow(raw, identity, mode);
          if (live.current !== key || epoch.current !== ticket) return;
          setSnapshot({
            key,
            workflow,
            inputs:
              workflow.current.status === "current"
                ? workflow.current.inputs
                : emptyInputs(mode),
            dirty: false,
            locked: false,
            error: "",
          });
        })
        .catch(() => {
          if (live.current === key && epoch.current === ticket)
            setLoadError(
              "Saved workflow could not be loaded. Reload before editing.",
            );
        });
    }
    return () => {
      if (epoch.current === ticket) epoch.current++;
    };
    // Transient parent busy/disabled feedback is deliberately not request identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, eligible, reload]);
  const current = snapshot?.key === key && eligible ? snapshot : null;
  const blocked = disabled || saving || !current || current.locked;
  const inputs = current?.inputs ?? emptyInputs(mode);
  function edit(changes: Data) {
    if (blocked || writeLock.current) return;
    setSnapshot((old) =>
      old && old.key === key
        ? {
            ...old,
            inputs: { ...old.inputs, ...changes },
            dirty: true,
            error: "",
          }
        : old,
    );
    callbacks.current.onDirtyChange?.(true);
  }
  function pointButton(label: string, field: string, container?: string) {
    const data =
      container && record(inputs[container])
        ? (inputs[container] as Data)
        : inputs;
    const point = data[field];
    return (
      <div className="point-row" key={field}>
        <button
          disabled={blocked || !cursor}
          onClick={() => {
            if (cursor)
              edit(
                container
                  ? { [container]: { ...data, [field]: [...cursor] } }
                  : { [field]: [...cursor] },
              );
          }}
        >
          Set {label}
        </button>
        <span>
          {Array.isArray(point)
            ? point.map((x) => Number(x).toFixed(2)).join(" / ")
            : "Not marked"}
        </span>
      </div>
    );
  }
  const path = Array.isArray(inputs.path) ? (inputs.path as Vec3[]) : [];
  const profiles = Array.isArray(inputs.profiles)
    ? (inputs.profiles as Profile[])
    : [];
  const indexKeys =
    mode === "coronary_pci"
      ? ["proximal_reference", "lesion_start", "lesion_end", "distal_reference"]
      : ["suprarenal_index", "neck_start", "neck_end", "sac_index"];
  const indexError =
    mode === "tavr" ? "" : pathIndexError(mode, inputs, path.length);
  const required =
    mode === "tavr"
      ? Array.isArray(inputs.left_ostium) &&
        Array.isArray(inputs.right_ostium) &&
        (inputs.annulus as Section).contour.length >= 3
      : path.length >= 2 && profiles.length > 0 && !indexError;
  async function save() {
    if (blocked || writeLock.current || !current || !required) return;
    const ticket = epoch.current,
      capturedKey = key,
      submitted = structuredClone(current.inputs),
      prior = current.workflow;
    const busyOwner = callbacks.current.onBusy;
    writeLock.current = true;
    setSaving(true);
    busyOwner?.(true);
    try {
      const raw = await api<unknown>(
        route,
        {
          artifact_version: identity.artifact_version,
          reference_revision: identity.reference_revision,
          workflow_revision: prior.workflow_revision,
          inputs: submitted,
        },
        "PUT",
      );
      const workflow = parseWorkflow(raw, identity, mode);
      if (
        workflow.workflow_revision !== prior.workflow_revision + 1 ||
        workflow.current.status !== "current" ||
        stable(workflow.current.inputs) !== stable(submitted) ||
        (prior.current.status !== "not_computed" &&
          workflow.current.result_id === prior.current.result_id)
      )
        throw new Error("Unconfirmed workflow acknowledgement");
      if (live.current !== capturedKey || epoch.current !== ticket) return;
      setSnapshot({
        key: capturedKey,
        workflow,
        inputs: workflow.current.inputs,
        dirty: false,
        locked: false,
        error: "",
      });
      callbacks.current.onDirtyChange?.(false);
    } catch (error) {
      if (live.current !== capturedKey || epoch.current !== ticket) return;
      const rejected =
        error instanceof WorkspaceRequestError &&
        (error.status === 422 || error.status === 413);
      setSnapshot((old) =>
        old?.key === capturedKey
          ? {
              ...old,
              //413/422 are guaranteed to precede the ledger write.409 is NOT:
              // a post-store snapshot/acknowledgement race can return409.
              locked: !rejected,
              error: rejected
                ? "Annotations were rejected; nothing was stored. Correct the draft and save again."
                : "Save could not be confirmed. It may have been stored. Reload saved workflow before retrying.",
            }
          : old,
      );
    } finally {
      writeLock.current = false;
      setSaving(false);
      busyOwner?.(false);
    }
  }
  const result =
    !disabled &&
    !saving &&
    current &&
    !current.dirty &&
    !current.locked &&
    current.workflow.current.status === "current"
      ? current.workflow.current.result
      : null;
  return (
    <section
      id="territory-workflows"
      className="planning-section territory-studio"
    >
      <h3>Territory planning</h3>
      <div
        role="group"
        aria-label="Territory workflow"
        className="territory-modes"
      >
        {(Object.entries(modes) as [WorkflowMode, string][]).map(
          ([value, label]) => (
            <button
              key={value}
              aria-pressed={mode === value}
              disabled={
                disabled || saving || !!current?.dirty || !!current?.locked
              }
              onClick={() => setMode(value)}
            >
              {label}
            </button>
          ),
        )}
      </div>
      <p className="muted small">
        Operator-traced geometry in physical RAS millimeters. Each workflow
        saves its own annotations and measurements. Contours allow up to 128
        points each; the separate workflow-wide budget is 8192 annotated
        positions, including section origins, across all paths and tissue
        regions. A one-megabyte request limit also applies.
      </p>
      {!eligible && (
        <p>
          Load a calibrated, server-linked native volume to edit this workflow.
        </p>
      )}
      {loadError && <p role="alert">{loadError}</p>}
      {eligible && !current && !loadError && (
        <p role="status">Loading saved workflow…</p>
      )}
      {current && (
        <>
          {current.error && <p role="alert">{current.error}</p>}
          {current.workflow.current.status === "stale" && (
            <p>
              Saved measurements belong to an earlier source or calculation
              version. Re-enter annotations on the current image.
            </p>
          )}
          {mode === "tavr" ? (
            <>
              <p className="muted small">
                Trace the annular ring on the displayed plane. Orient the normal
                toward the aorta; ostial heights are signed along that normal.
              </p>
              <TerritorySectionEditor
                key={`${key}:${current.workflow.workflow_revision}`}
                value={inputs.annulus as Section}
                onChange={(annulus) => edit({ annulus })}
                volume={volume}
                cursor={cursor}
                disabled={blocked}
                label="Annular section"
              />
              {pointButton("left coronary ostium", "left_ostium")}
              {pointButton("right coronary ostium", "right_ostium")}
            </>
          ) : (
            <>
              <TerritoryPathEditor
                key={`${key}:${current.workflow.workflow_revision}`}
                label="Main vessel"
                value={{ path, profiles }}
                onChange={(value: PathProfiles) => edit(value)}
                volume={volume}
                cursor={cursor}
                disabled={blocked}
              />
              <div className="territory-indices">
                {indexKeys.map((field) => (
                  <label key={field}>
                    {field.replaceAll("_", " ")}
                    <select
                      aria-label={field.replaceAll("_", " ")}
                      disabled={blocked}
                      value={
                        typeof inputs[field] === "number"
                          ? String(inputs[field])
                          : ""
                      }
                      onChange={(e) =>
                        edit({
                          [field]:
                            e.target.value === ""
                              ? null
                              : Number(e.target.value),
                        })
                      }
                    >
                      <option value="">Choose path index</option>
                      {path.map((p, i) => (
                        <option key={i} value={i}>
                          {i}: {p.map((v) => v.toFixed(1)).join(" / ")}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              {indexError && <p role="status">{indexError}</p>}
              {mode === "coronary_pci" ? (
                <>
                  <p className="muted small">
                    Reference taper and diameter narrowing use area-equivalent
                    diameters. The minimum is over the traced lesion profiles.
                  </p>
                  <label>
                    <input
                      type="checkbox"
                      checked={inputs.bifurcation !== null}
                      disabled={blocked}
                      onChange={(e) =>
                        edit({
                          bifurcation: e.target.checked
                            ? {
                                carina: null,
                                daughter_a: null,
                                daughter_b: null,
                              }
                            : null,
                        })
                      }
                    />
                    Measure a bifurcation
                  </label>
                  {inputs.bifurcation !== null && (
                    <>
                      {pointButton("carina", "carina", "bifurcation")}
                      {pointButton("daughter A", "daughter_a", "bifurcation")}
                      {pointButton("daughter B", "daughter_b", "bifurcation")}
                    </>
                  )}
                </>
              ) : (
                <>
                  <p className="muted small">
                    Angles use the declared suprarenal, neck and sac axis
                    segments. Burdens integrate traced class areas and
                    outer-wall areas over the neck. Unannotated tissue remains
                    unknown. Access minima are sampled minimum Feret diameters.
                  </p>
                  {(["left_access", "right_access"] as const).map((field) => (
                    <div key={field}>
                      <label>
                        <input
                          type="checkbox"
                          checked={inputs[field] !== null}
                          disabled={blocked}
                          onChange={(e) =>
                            edit({
                              [field]: e.target.checked
                                ? { path: [], profiles: [] }
                                : null,
                            })
                          }
                        />
                        {field === "left_access"
                          ? "Left iliac access"
                          : "Right iliac access"}
                      </label>
                      {record(inputs[field]) && (
                        <TerritoryPathEditor
                          key={`${key}:${field}:${current.workflow.workflow_revision}`}
                          label={
                            field === "left_access"
                              ? "Left access"
                              : "Right access"
                          }
                          value={inputs[field] as PathProfiles}
                          onChange={(value) => edit({ [field]: value })}
                          volume={volume}
                          cursor={cursor}
                          disabled={blocked}
                        />
                      )}
                    </div>
                  ))}
                </>
              )}
            </>
          )}
          <button
            disabled={blocked || !required || !current.dirty}
            onClick={() => void save()}
          >
            {saving ? "Saving workflow…" : "Save and calculate"}
          </button>
          {current.dirty && (
            <p role="status">
              Unsaved annotations. Saved measurements are hidden until this
              draft is calculated.
            </p>
          )}
          {result && (
            <>
              <h4>Saved measurements</h4>
              <Metrics result={result} />
              <Profiles rows={result.profiles} />
              {(["left_access", "right_access"] as const).map((k) =>
                record(result[k]) ? (
                  <div key={k}>
                    <h4>
                      {k === "left_access" ? "Left access" : "Right access"}
                    </h4>
                    <Metrics result={result[k] as Data} />
                    <Profiles rows={(result[k] as Data).profiles} />
                  </div>
                ) : null,
              )}
              <p className="muted small">
                Workflow revision {current.workflow.workflow_revision} ·
                operator traced · source{" "}
                {identity.reference_revision.slice(0, 12)}
              </p>
            </>
          )}
        </>
      )}
      <button
        disabled={saving || disabled || !eligible}
        onClick={() => setReload((value) => value + 1)}
      >
        Discard draft and reload saved workflow
      </button>
    </section>
  );
}
