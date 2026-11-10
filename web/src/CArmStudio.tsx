import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NVImage } from "@niivue/niivue";
import { api, WorkspaceRequestError, type CaseState } from "./api";
import { stable, type Identity } from "./territoryWorkflow";
import { parseScene } from "./reformatScene";
import { createNativeSampler } from "./nativeSampling";
import {
  angleLabel,
  pathLength,
  PROPOSAL_LIMITS,
  proposeLowForeshorteningAngles,
  summarizeView,
  validateView,
  VIEW_LIMITS,
  type ViewNumbers,
  type ViewSummary,
} from "./carmGeometry";
import {
  MAX_VIEWS,
  parsePlan,
  parseProjectionSeries,
  planeToView,
  VIEW_NAME,
  type Plan,
  type PlanInputs,
  type PlanView,
  type ProjectionSeries,
} from "./projectionPlan";
import CArmProjectionView from "./CArmProjectionView";
import type { Vec3 } from "./obliqueSlice";
import "./reformats.css";

type Props = {
  caseState: Pick<
    CaseState,
    "case_id" | "image_sha256" | "artifact_version" | "spatial_units"
  >;
  binding: Pick<Identity, "case_id" | "image_sha256" | "reference_revision">;
  volume: NVImage | null;
  cursor: Vec3 | null;
  windowRange: [number, number];
  disabled?: boolean;
  onBusy?: (busy: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
};
type Draft = {
  key: string;
  plan: Plan;
  isocenter: Vec3 | null;
  path: Vec3[];
  views: PlanView[];
  dirty: boolean;
  locked: boolean;
  confirmed: boolean;
  error: string;
};
type Editor = { name: string } & Record<keyof ViewNumbers, string>;
const NUMBER_KEYS = Object.keys(VIEW_LIMITS) as (keyof ViewNumbers)[];
const DEFAULT_EDITOR: Editor = {
  name: "View 1",
  primary_deg: "0",
  secondary_deg: "0",
  source_detector_mm: "1200",
  source_isocenter_mm: "750",
  detector_width_mm: "200",
  detector_height_mm: "200",
};
const LABELS: Record<keyof ViewNumbers, string> = {
  primary_deg: "Primary angle, LAO positive (degrees)",
  secondary_deg: "Secondary angle, cranial positive (degrees)",
  source_detector_mm: "Source to detector (mm)",
  source_isocenter_mm: "Source to isocenter (mm)",
  detector_width_mm: "Detector width (mm)",
  detector_height_mm: "Detector height (mm)",
};
const format = (point: Vec3) => point.map((x) => x.toFixed(1)).join(", ");
const toEditor = (name: string, view: ViewNumbers): Editor => ({
  name,
  ...(Object.fromEntries(
    NUMBER_KEYS.map((key) => [key, String(view[key])]),
  ) as Record<keyof ViewNumbers, string>),
});
function parseEditor(editor: Editor): ViewNumbers {
  const view = {} as ViewNumbers;
  for (const key of NUMBER_KEYS) {
    const text = editor[key].trim();
    view[key] = text === "" ? Number.NaN : Number(text);
  }
  return validateView(view);
}

export default function CArmStudio({
  caseState,
  binding,
  volume,
  cursor,
  windowRange,
  disabled = false,
  onBusy,
  onDirtyChange,
}: Props) {
  const identity: Identity = {
    case_id: caseState.case_id,
    image_sha256: caseState.image_sha256,
    artifact_version: caseState.artifact_version,
    reference_revision: binding.reference_revision,
  };
  const allowed =
    caseState.spatial_units === "mm" &&
    binding.case_id === caseState.case_id &&
    binding.image_sha256 === caseState.image_sha256;
  const key = allowed ? stable(identity) : "";
  const live = useRef(key);
  live.current = key;
  const callbacks = useRef({ onBusy, onDirtyChange });
  callbacks.current = { onBusy, onDirtyChange };
  const [draft, setDraft] = useState<Draft | null>(null),
    [loadError, setLoadError] = useState(""),
    [editor, setEditor] = useState<Editor>(DEFAULT_EDITOR),
    [thresholdText, setThresholdText] = useState(() =>
      String(Math.round((windowRange[0] + windowRange[1]) / 2)),
    ),
    [seriesText, setSeriesText] = useState(""),
    [series, setSeries] = useState<(ProjectionSeries & { key: string }) | null>(
      null,
    ),
    [seriesError, setSeriesError] = useState(""),
    [localBusy, setLocalBusy] = useState(false);
  const busyCount = useRef(0),
    writePending = useRef(false);
  const begin = () => {
    const owner = callbacks.current.onBusy;
    busyCount.current++;
    setLocalBusy(true);
    owner?.(true);
    return () => {
      busyCount.current--;
      setLocalBusy(busyCount.current > 0);
      owner?.(busyCount.current > 0);
    };
  };
  const load = useCallback(async () => {
    if (!key) return;
    const owned = key,
      release = begin();
    setDraft(null);
    setLoadError("");
    setSeries(null);
    setSeriesError("");
    try {
      const plan = parsePlan(
        await api(`/cases/${identity.case_id}/projection-plan`),
        identity,
      );
      if (live.current !== owned) return;
      const inputs =
        plan.current.status === "current" ? plan.current.inputs : null;
      setDraft({
        key: owned,
        plan,
        isocenter: inputs ? ([...inputs.isocenter] as Vec3) : null,
        path: inputs ? inputs.target_path.map((p) => [...p] as Vec3) : [],
        views: inputs ? inputs.views.map((view) => ({ ...view })) : [],
        dirty: false,
        locked: false,
        confirmed: false,
        error: "",
      });
      setEditor(
        inputs
          ? toEditor(inputs.views[0].name, inputs.views[0])
          : DEFAULT_EDITOR,
      );
      callbacks.current.onDirtyChange?.(false);
    } catch {
      if (live.current === owned) {
        callbacks.current.onDirtyChange?.(false);
        setLoadError(
          "Saved C-arm views could not be loaded. Reload before editing.",
        );
      }
    } finally {
      release();
    }
  }, [key]);
  useEffect(() => {
    live.current = key;
    void load();
    return () => {
      live.current = "";
    };
  }, [load]);

  const current = draft?.key === key ? draft : null;
  const editable = !!current && !current.locked && !disabled && !localBusy;
  function edit(change: Partial<Draft>) {
    if (!current || !editable) return;
    setDraft({
      ...current,
      ...change,
      dirty: true,
      confirmed: false,
      error: "",
    });
    callbacks.current.onDirtyChange?.(true);
  }
  function notice(message: string) {
    setDraft((prior) =>
      prior?.key === key ? { ...prior, error: message } : prior,
    );
  }
  function inside(point: Vec3) {
    return !!volume && createNativeSampler(volume).sample(point) !== null;
  }
  function attempt(action: () => void, fallback: string) {
    try {
      action();
    } catch (error) {
      notice(error instanceof Error ? error.message : fallback);
    }
  }
  const appendCursor = () =>
    attempt(() => {
      if (!current || !cursor || !inside(cursor))
        throw new Error("Crosshair must be inside the verified RAS/mm image");
      if (current.path.length >= 128)
        throw new Error("Target path is limited to 128 points");
      const path = [...current.path, [...cursor] as Vec3];
      if (path.length > 1) pathLength(path);
      edit({ path });
    }, "Invalid target point");
  const isocenterFromCursor = () =>
    attempt(() => {
      if (!cursor || !inside(cursor))
        throw new Error("Crosshair must be inside the verified RAS/mm image");
      edit({ isocenter: [...cursor] as Vec3 });
    }, "Invalid isocenter");
  const isocenterFromPath = () =>
    attempt(() => {
      if (!current || current.path.length < 2)
        throw new Error("Add at least two target points first");
      const centroid = [0, 1, 2].map(
        (axis) =>
          current.path.reduce((sum, p) => sum + p[axis], 0) /
          current.path.length,
      ) as Vec3;
      if (!inside(centroid))
        throw new Error("Path centroid is outside the verified image");
      edit({ isocenter: centroid });
    }, "Invalid isocenter");
  async function copyReformatPath() {
    if (!current || !editable || !volume) return;
    const owned = key,
      release = begin();
    try {
      const scene = parseScene(
        await api(`/cases/${identity.case_id}/reformat-scene`),
        identity,
      );
      if (live.current !== owned) return;
      if (scene.current.status !== "current")
        throw new Error("No current saved reformat path");
      const path = scene.current.inputs.path.map((p) => [...p] as Vec3);
      pathLength(path);
      if (path.some((p) => !inside(p)))
        throw new Error("Saved path is outside the loaded source");
      setDraft({ ...current, path, dirty: true, confirmed: false, error: "" });
      callbacks.current.onDirtyChange?.(true);
    } catch {
      if (live.current === owned)
        notice(
          "A current saved reformat path could not be copied. Save a reformat scene first.",
        );
    } finally {
      release();
    }
  }

  const editorView = useMemo(() => {
    try {
      return parseEditor(editor);
    } catch {
      return null;
    }
  }, [editor]);
  const ready =
    !!current && current.isocenter !== null && current.path.length >= 2;
  const liveSummary: ViewSummary | null = useMemo(() => {
    if (!current || !ready || !editorView) return null;
    try {
      return summarizeView(editorView, current.isocenter!, current.path);
    } catch {
      return null;
    }
  }, [current?.isocenter, current?.path, editorView, ready]);
  const threshold = useMemo(() => {
    const value =
      thresholdText.trim() === "" ? Number.NaN : Number(thresholdText);
    return Number.isFinite(value) && Math.abs(value) <= 1e6 ? value : null;
  }, [thresholdText]);

  const propose = () =>
    attempt(() => {
      if (!current || current.path.length < 2)
        throw new Error("Add at least two target points first");
      const proposal = proposeLowForeshorteningAngles(current.path);
      setEditor((prior) => ({
        ...prior,
        primary_deg: String(proposal.primary_deg),
        secondary_deg: String(proposal.secondary_deg),
      }));
    }, "No view could be proposed");
  const storeView = () =>
    attempt(() => {
      if (!current || !ready)
        throw new Error("Set an isocenter and a target path first");
      const name = editor.name.trim();
      if (!VIEW_NAME.test(name))
        throw new Error(
          "View names use letters, digits, spaces, hyphens and underscores (40 at most)",
        );
      const view: PlanView = { name, ...parseEditor(editor) };
      summarizeView(view, current.isocenter!, current.path);
      const index = current.views.findIndex((v) => v.name === name);
      if (index < 0 && current.views.length >= MAX_VIEWS)
        throw new Error(`A plan holds at most ${MAX_VIEWS} views`);
      const views = [...current.views];
      if (index < 0) views.push(view);
      else views[index] = view;
      edit({ views });
    }, "Invalid C-arm view");

  async function loadSeries() {
    if (!current || !editable) return;
    const owned = key,
      source = seriesText.trim(),
      release = begin();
    setSeries(null);
    setSeriesError("");
    try {
      if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(source))
        throw new Error("Invalid source");
      const result = parseProjectionSeries(
        await api(`/projection-series/${source}`),
        source,
      );
      if (live.current === owned) setSeries({ ...result, key: owned });
    } catch {
      if (live.current === owned)
        setSeriesError(
          "Projection series geometry could not be verified. Check its installed source ID.",
        );
    } finally {
      release();
    }
  }

  async function save() {
    if (
      !current ||
      !editable ||
      writePending.current ||
      !current.confirmed ||
      !current.dirty ||
      !volume
    )
      return;
    let inputs: PlanInputs;
    try {
      if (!current.isocenter || current.path.length < 2)
        throw new Error("Set an isocenter and a target path first");
      if (current.views.length < 1)
        throw new Error("Add at least one view to the plan");
      if (!inside(current.isocenter) || current.path.some((p) => !inside(p)))
        throw new Error("Isocenter or target path is outside the source");
      for (const view of current.views)
        summarizeView(view, current.isocenter, current.path);
      inputs = {
        confirmed: true,
        isocenter: current.isocenter,
        target_path: current.path,
        views: current.views,
      };
    } catch (error) {
      notice(error instanceof Error ? error.message : "Invalid C-arm plan");
      return;
    }
    const owned = key,
      release = begin();
    writePending.current = true;
    setDraft({ ...current, locked: true, error: "" });
    try {
      const plan = parsePlan(
        await api(
          `/cases/${identity.case_id}/projection-plan`,
          {
            artifact_version: identity.artifact_version,
            reference_revision: identity.reference_revision,
            plan_revision: current.plan.plan_revision,
            inputs,
          },
          "PUT",
        ),
        identity,
      );
      if (live.current !== owned) return;
      if (
        plan.plan_revision !== current.plan.plan_revision + 1 ||
        plan.current.status !== "current" ||
        stable(plan.current.inputs) !== stable(inputs)
      )
        throw new Error("Acknowledgement differs from the confirmed draft");
      setDraft({ ...current, plan, dirty: false, locked: false, error: "" });
      callbacks.current.onDirtyChange?.(false);
    } catch (error) {
      if (live.current === owned) {
        const definitive =
          error instanceof WorkspaceRequestError &&
          [413, 422].includes(error.status);
        setDraft({
          ...current,
          locked: !definitive,
          error: definitive
            ? "C-arm views were rejected before saving. Correct the editable draft."
            : "C-arm view save could not be confirmed. Reload saved views before retrying.",
        });
      }
    } finally {
      writePending.current = false;
      release();
    }
  }

  if (!allowed)
    return (
      <section
        id="carm-views"
        className="native-reformat-studio carm-studio"
        aria-label="C-arm working views"
      >
        <h2>C-arm working views</h2>
        <p role="status">
          C-arm planning needs a verified millimeter source bound to this case.
        </p>
      </section>
    );
  const saved =
    current?.plan.current.status === "current" ? current.plan.current : null;
  const savedByName = new Map(
    (current && !current.dirty && saved ? saved.result.views : []).map(
      (view) => [view.name, view],
    ),
  );
  const draftSummaries = (current?.views ?? []).map((view) => {
    try {
      return current?.isocenter && current.path.length >= 2
        ? summarizeView(view, current.isocenter, current.path)
        : null;
    } catch {
      return null;
    }
  });
  const setNumber = (field: keyof ViewNumbers, value: string) =>
    setEditor((prior) => ({ ...prior, [field]: value }));
  return (
    <section
      id="carm-views"
      className="native-reformat-studio carm-studio"
      aria-label="C-arm working views"
    >
      <header>
        <h2>C-arm working views</h2>
        <span role="status">
          {current
            ? `Plan revision ${current.plan.plan_revision} · ${
                current.dirty
                  ? "unsaved draft"
                  : current.plan.current.status.replace("_", " ")
              }`
            : loadError
              ? "Unavailable"
              : "Loading saved views…"}
        </span>
        <button type="button" onClick={() => void load()} disabled={localBusy}>
          Reload saved views
        </button>
      </header>
      <p className="carm-note">
        Planning preview computed from this cross-sectional source. Angles
        follow a declared convention (primary positive toward LAO, secondary
        positive cranial) that has not been verified against an angiography
        system. Nothing here is registered to an acquired angiogram.
      </p>
      {loadError && <p role="alert">{loadError}</p>}
      {current && (
        <>
          {current.plan.current.status === "stale" && !current.dirty && (
            <p role="status">
              The saved views belong to an earlier case revision and are not
              shown. Confirm a new plan to replace them.
            </p>
          )}
          <fieldset disabled={!editable}>
            <legend>Target</legend>
            <p>
              Target path: {current.path.length} point
              {current.path.length === 1 ? "" : "s"}
              {current.path.length >= 2
                ? ` · ${pathLength(current.path).toFixed(1)} mm`
                : ""}
              {" · "}Isocenter:{" "}
              {current.isocenter
                ? `${format(current.isocenter)} mm (RAS)`
                : "not set"}
            </p>
            <div className="native-actions">
              <button type="button" onClick={appendCursor} disabled={!cursor}>
                Add crosshair to target path
              </button>
              <button
                type="button"
                onClick={() => edit({ path: current.path.slice(0, -1) })}
                disabled={current.path.length === 0}
              >
                Remove last target point
              </button>
              <button type="button" onClick={() => void copyReformatPath()}>
                Copy saved reformat path
              </button>
              <button
                type="button"
                onClick={isocenterFromCursor}
                disabled={!cursor}
              >
                Set isocenter to crosshair
              </button>
              <button
                type="button"
                onClick={isocenterFromPath}
                disabled={current.path.length < 2}
              >
                Set isocenter to path centroid
              </button>
            </div>
          </fieldset>
          <fieldset disabled={!editable}>
            <legend>View</legend>
            <div className="native-view-controls">
              <label>
                View name
                <input
                  value={editor.name}
                  maxLength={40}
                  onChange={(e) =>
                    setEditor((prior) => ({ ...prior, name: e.target.value }))
                  }
                />
              </label>
              {NUMBER_KEYS.map((field) => (
                <label key={field}>
                  {LABELS[field]}
                  <input
                    inputMode="decimal"
                    value={editor[field]}
                    onChange={(e) => setNumber(field, e.target.value)}
                  />
                  {(field === "primary_deg" || field === "secondary_deg") && (
                    <input
                      type="range"
                      aria-label={`${LABELS[field]} slider`}
                      min={VIEW_LIMITS[field][0]}
                      max={VIEW_LIMITS[field][1]}
                      step={1}
                      value={
                        Number.isFinite(Number(editor[field]))
                          ? Number(editor[field])
                          : 0
                      }
                      onChange={(e) => setNumber(field, e.target.value)}
                    />
                  )}
                </label>
              ))}
              <label>
                Projection threshold (source intensity units)
                <input
                  inputMode="decimal"
                  value={thresholdText}
                  onChange={(e) => setThresholdText(e.target.value)}
                />
              </label>
            </div>
            <div className="native-actions">
              <button
                type="button"
                onClick={propose}
                disabled={current.path.length < 2}
              >
                Propose low-foreshortening angles
              </button>
              <button type="button" onClick={storeView} disabled={!ready}>
                {current.views.some((v) => v.name === editor.name.trim())
                  ? "Update view in plan"
                  : "Add view to plan"}
              </button>
            </div>
            <p className="carm-note">
              The proposal searches whole degrees within ±
              {PROPOSAL_LIMITS.primary_deg} primary and ±
              {PROPOSAL_LIMITS.secondary_deg} secondary for the lowest
              central-ray foreshortening of the target path. It does not
              consider vessel overlap, table position or equipment collision.
            </p>
            {editorView ? (
              <p role="status" aria-label="Live view readout">
                {angleLabel(editorView.primary_deg, editorView.secondary_deg)}
                {liveSummary
                  ? ` · foreshortening ${liveSummary.foreshortening_percent.toFixed(1)}% · magnification ${liveSummary.magnification_at_isocenter.toFixed(2)} · target ${liveSummary.target_in_field ? "inside" : "outside"} the detector field`
                  : ready
                    ? " · target cannot be projected in this view"
                    : " · set an isocenter and a target path for measurements"}
              </p>
            ) : (
              <p role="alert">
                View values are outside the supported C-arm geometry bounds.
              </p>
            )}
            <CArmProjectionView
              identityKey={key}
              volume={volume}
              view={editorView}
              isocenter={current.isocenter}
              path={current.path}
              threshold={threshold}
              disabled={disabled}
            />
          </fieldset>
          <fieldset disabled={!editable}>
            <legend>Planned views</legend>
            {current.views.length === 0 ? (
              <p>No views in this plan yet.</p>
            ) : (
              <div
                className="carm-table-scroll"
                role="group"
                aria-label="Planned views table"
                tabIndex={0}
              >
                <table className="carm-table">
                  <thead>
                    <tr>
                      <th scope="col">View</th>
                      <th scope="col">Angles</th>
                      <th scope="col">SID / SOD (mm)</th>
                      <th scope="col">Foreshortening</th>
                      <th scope="col">In field</th>
                      <th scope="col">Source</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {current.views.map((view, index) => {
                      const authoritative = savedByName.get(view.name),
                        summary = authoritative ?? draftSummaries[index];
                      return (
                        <tr key={view.name}>
                          <th scope="row">{view.name}</th>
                          <td>
                            {angleLabel(view.primary_deg, view.secondary_deg)}
                          </td>
                          <td>
                            {view.source_detector_mm.toFixed(0)} /{" "}
                            {view.source_isocenter_mm.toFixed(0)}
                          </td>
                          <td>
                            {summary
                              ? `${summary.foreshortening_percent.toFixed(1)}%`
                              : "not projectable"}
                          </td>
                          <td>
                            {summary
                              ? summary.target_in_field
                                ? "yes"
                                : "no"
                              : ""}
                          </td>
                          <td>{authoritative ? "saved" : "draft"}</td>
                          <td>
                            <button
                              type="button"
                              aria-label={`Edit view ${view.name}`}
                              onClick={() =>
                                setEditor(toEditor(view.name, view))
                              }
                            >
                              Edit
                            </button>{" "}
                            <button
                              type="button"
                              aria-label={`Remove view ${view.name}`}
                              onClick={() =>
                                edit({
                                  views: current.views.filter(
                                    (_, i) => i !== index,
                                  ),
                                })
                              }
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <label className="native-confirm">
              <input
                type="checkbox"
                checked={current.confirmed}
                disabled={!current.dirty}
                onChange={(e) =>
                  setDraft({ ...current, confirmed: e.target.checked })
                }
              />
              I confirm this isocenter, target path and these C-arm views as
              planning geometry for this source.
            </label>
            <div className="native-actions">
              <button
                type="button"
                onClick={() => void save()}
                disabled={
                  !current.confirmed || !current.dirty || !volume || localBusy
                }
              >
                Confirm and save C-arm views
              </button>
            </div>
          </fieldset>
          {current.error && <p role="alert">{current.error}</p>}
          <fieldset disabled={!editable}>
            <legend>Acquired run geometry</legend>
            <p className="carm-note">
              Reads the acquisition geometry of an installed projection series.
              No angiographic frames are stored or displayed. Table position and
              patient registration are unknown, so copying a plane only reuses
              its angles, distances and field size.
            </p>
            <label>
              Installed projection source ID
              <input
                value={seriesText}
                onChange={(e) => setSeriesText(e.target.value)}
              />
            </label>
            <div className="native-actions">
              <button
                type="button"
                onClick={() => void loadSeries()}
                disabled={seriesText.trim() === ""}
              >
                Load run geometry
              </button>
            </div>
            {seriesError && <p role="alert">{seriesError}</p>}
            {series?.key === key && (
              <div
                className="carm-table-scroll"
                role="group"
                aria-label="Acquired run geometry table"
                tabIndex={0}
              >
                <table className="carm-table">
                  <caption>
                    {series.source_id} · {series.scope} ·{" "}
                    {series.biplane_linkage === "cross_referenced"
                      ? "biplane, cross-referenced"
                      : "single plane"}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Plane</th>
                      <th scope="col">Angles</th>
                      <th scope="col">SID / SOD (mm)</th>
                      <th scope="col">Frames</th>
                      <th scope="col">Calibration</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {series.planes.map((plane) => {
                      const view = planeToView(plane);
                      return (
                        <tr key={plane.plane}>
                          <th scope="row">{plane.plane.toUpperCase()}</th>
                          <td>
                            {plane.primary_angle_deg !== null &&
                            plane.secondary_angle_deg !== null
                              ? angleLabel(
                                  plane.primary_angle_deg,
                                  plane.secondary_angle_deg,
                                )
                              : "not recorded"}
                          </td>
                          <td>
                            {plane.source_detector_mm?.toFixed(0) ?? "?"} /{" "}
                            {plane.source_isocenter_mm?.toFixed(0) ?? "?"}
                          </td>
                          <td>{plane.frame_count}</td>
                          <td>
                            {plane.calibration.status === "calibrated"
                              ? "calibrated"
                              : `uncalibrated: ${plane.calibration.missing
                                  .map((term) => term.replace(/_/g, " "))
                                  .join(", ")}`}
                          </td>
                          <td>
                            <button
                              type="button"
                              aria-label={`Copy plane ${plane.plane.toUpperCase()} geometry to the view editor`}
                              disabled={view === null}
                              onClick={() =>
                                view &&
                                setEditor(
                                  toEditor(
                                    `Run ${plane.plane.toUpperCase()}`,
                                    view,
                                  ),
                                )
                              }
                            >
                              Copy to view editor
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </fieldset>
        </>
      )}
    </section>
  );
}
