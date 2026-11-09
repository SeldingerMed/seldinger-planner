import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NVImage } from "@niivue/niivue";
import { api, WorkspaceRequestError, type CaseState } from "./api";
import { parseScene, type Scene, type SceneInputs } from "./reformatScene";
import {
  stable,
  record,
  parseWorkflow,
  type Identity,
} from "./territoryWorkflow";
import { parseAnatomyInputs } from "./anatomyProposal";
import { buildPathFrames } from "./curvedPlanar";
import { createNativeSampler } from "./nativeSampling";
import { validateRigid } from "./rigidFusion";
import { loadSecondarySource, type SecondaryVolume } from "./secondarySource";
import NativeReformatView, { type RenderReceipt } from "./NativeReformatView";
import type { ViewOptions } from "./nativeReformats";
import type { Vec3 } from "./obliqueSlice";
import "./reformats.css";
const identityMatrix = () => [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];
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
type Snapshot = {
  key: string;
  scene: Scene;
  path: Vec3[];
  sourceText: string;
  matrixText: string;
  dirty: boolean;
  locked: boolean;
  confirmed: boolean;
  error: string;
};
export default function ReformatStudio({
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
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState<
      (SecondaryVolume & { key: string }) | null
    >(null),
    [secondaryError, setSecondaryError] = useState("");
  const [pointText, setPointText] = useState<[string, string, string]>([
    "0",
    "0",
    "0",
  ]);
  const [localBusy, setLocalBusy] = useState(false);
  const busyCount = useRef(0),
    writePending = useRef(false),
    secondaryEpoch = useRef(0);
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
    setSnapshot(null);
    setLoadError("");
    setSelected(null);
    setSecondaryError("");
    const token = ++secondaryEpoch.current;
    try {
      const scene = parseScene(
        await api(`/cases/${identity.case_id}/reformat-scene`),
        identity,
      );
      if (live.current !== owned) return;
      const inputs =
        scene.current.status === "current" ? scene.current.inputs : null;
      setSnapshot({
        key: owned,
        scene,
        path: inputs ? inputs.path.map((p) => [...p] as Vec3) : [],
        sourceText: inputs?.secondary?.source_id ?? "",
        matrixText: JSON.stringify(
          inputs?.secondary?.secondary_to_primary_ras ?? identityMatrix(),
        ),
        dirty: false,
        locked: false,
        confirmed: false,
        error: "",
      });
      callbacks.current.onDirtyChange?.(false);
      setPointText(
        inputs
          ? (inputs.path.at(-1)!.map(String) as [string, string, string])
          : ["0", "0", "0"],
      );
      if (inputs?.secondary) {
        try {
          const result = await loadSecondarySource(
            inputs.secondary.source_id,
            inputs.secondary,
          );
          if (live.current === owned && token === secondaryEpoch.current)
            setSelected({ ...result, key: owned });
        } catch {
          if (live.current === owned && token === secondaryEpoch.current)
            setSecondaryError(
              "Registered secondary unavailable. Primary views remain available.",
            );
        }
      }
    } catch {
      if (live.current === owned) {
        callbacks.current.onDirtyChange?.(false);
        setLoadError("Saved scene could not be loaded. Reload before editing.");
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
      secondaryEpoch.current++;
    };
  }, [load]);
  const current = snapshot?.key === key ? snapshot : null;
  function edit(change: Partial<Snapshot>) {
    if (!current || current.locked || disabled || localBusy) return;
    setSnapshot({
      ...current,
      ...change,
      dirty: true,
      confirmed: false,
      error: "",
    });
    callbacks.current.onDirtyChange?.(true);
  }
  function notice(message: string) {
    setSnapshot((prior) =>
      prior?.key === key ? { ...prior, error: message } : prior,
    );
  }
  function append() {
    try {
      if (!current || !volume) return;
      const p = pointText.map((v) =>
        v.trim() === "" ? NaN : Number(v),
      ) as Vec3;
      if (
        !p.every((n) => Number.isFinite(n) && Math.abs(n) <= 1e6) ||
        createNativeSampler(volume).sample(p) === null
      )
        throw new Error("Point must be inside the verified RAS/mm image");
      if (current.path.length >= 128)
        throw new Error("Path is limited to 128 points");
      const path = [...current.path, p];
      if (path.length > 1) buildPathFrames(path, 2);
      edit({ path });
    } catch (error) {
      notice(error instanceof Error ? error.message : "Invalid path point");
    }
  }
  async function chooseSecondary() {
    if (!current || disabled || localBusy || current.locked) return;
    const owned = key,
      source = current.sourceText,
      token = ++secondaryEpoch.current,
      release = begin();
    setSelected(null);
    setSecondaryError("");
    try {
      const result = await loadSecondarySource(source);
      if (live.current === owned && token === secondaryEpoch.current)
        setSelected({ ...result, key: owned });
    } catch {
      if (live.current === owned && token === secondaryEpoch.current)
        setSecondaryError(
          "Secondary source could not be verified. Check its installed source ID.",
        );
    } finally {
      release();
    }
  }
  async function copySavedPath(mode: "neurovascular" | "coronary_pci" | "aortic_peripheral") {
    if (!current || disabled || localBusy || current.locked || !volume) return;
    const owned = key,
      release = begin();
    try {
      let path: Vec3[];
      if (mode === "neurovascular") {
        const envelope = await api<unknown>(`/cases/${identity.case_id}/morphometry`);
        if (!record(envelope) || stable(Object.keys(envelope).sort()) !== stable([
          "artifact_version", "case_id", "current", "image_sha256", "operator_inputs", "reference_revision",
        ])) throw new Error("Invalid geometry envelope");
        if (Object.entries(identity).some(([field, value]) => envelope[field] !== value))
          throw new Error("Geometry belongs to a different source revision");
        const geometry = envelope.current;
        if (!record(geometry) || geometry.status !== "current" || !record(geometry.result) ||
          !record(geometry.dependencies) || typeof geometry.result_id !== "string" ||
          !/^[A-Za-z0-9_-]{16,128}$/.test(geometry.result_id)) throw new Error("Current geometry required");
        const result = geometry.result, dependencies = geometry.dependencies;
        if (result.spatial_units !== "mm" || result.image_sha256 !== identity.image_sha256 ||
          result.reference_revision !== identity.reference_revision || dependencies.case_id !== identity.case_id ||
          dependencies.image_sha256 !== identity.image_sha256 || dependencies.artifact_version !== identity.artifact_version ||
          dependencies.source_revision !== identity.reference_revision || dependencies.calculation_version !== "native-mask-operator-plane-v1")
          throw new Error("Contradictory geometry source");
        path = parseAnatomyInputs(envelope.operator_inputs).parent_path.map((point) => [...point] as Vec3);
      } else {
        const workflow = parseWorkflow(
          await api(`/cases/${identity.case_id}/territory-workflows/${mode}`), identity, mode,
        );
        if (workflow.current.status !== "current" || !record(workflow.current.inputs) || !Array.isArray(workflow.current.inputs.path))
          throw new Error("No current saved path in this workflow");
        path = workflow.current.inputs.path.map((p) => [...(p as Vec3)] as Vec3);
      }
      if (live.current !== owned) return;
      buildPathFrames(path, 2);
      const sampler = createNativeSampler(volume);
      if (path.some((p) => sampler.sample(p) === null))
        throw new Error("Saved path is outside the loaded source");
      setSnapshot({
        ...current,
        path,
        dirty: true,
        confirmed: false,
        error: "",
      });
      callbacks.current.onDirtyChange?.(true);
    } catch {
      if (live.current === owned)
        notice(
          "A current source-bound saved path could not be copied. Save that workflow first.",
        );
    } finally {
      release();
    }
  }
  async function save() {
    if (
      !current ||
      current.locked ||
      disabled ||
      localBusy ||
      writePending.current ||
      !current.confirmed ||
      !current.dirty ||
      !volume
    )
      return;
    let inputs: SceneInputs;
    try {
      buildPathFrames(current.path, 2);
      const sampler = createNativeSampler(volume);
      if (current.path.some((p) => sampler.sample(p) === null))
        throw new Error("Path is outside the verified source");
      let secondary: SceneInputs["secondary"] = null;
      if (current.sourceText) {
        if (
          !selected ||
          selected.key !== key ||
          selected.metadata.source_id !== current.sourceText
        )
          throw new Error(
            "Load and verify the selected secondary before confirmation",
          );
        secondary = {
          source_id: selected.metadata.source_id,
          image_sha256: selected.metadata.image_sha256,
          reference_revision: selected.metadata.reference_revision,
          secondary_to_primary_ras: validateRigid(
            JSON.parse(current.matrixText),
          ),
        };
      }
      inputs = { confirmed: true, path: current.path, secondary };
    } catch (error) {
      notice(error instanceof Error ? error.message : "Invalid scene");
      return;
    }
    const owned = key,
      release = begin();
    writePending.current = true;
    setSnapshot({ ...current, locked: true, error: "" });
    try {
      const scene = parseScene(
        await api(
          `/cases/${identity.case_id}/reformat-scene`,
          {
            artifact_version: identity.artifact_version,
            reference_revision: identity.reference_revision,
            scene_revision: current.scene.scene_revision,
            inputs,
          },
          "PUT",
        ),
        identity,
      );
      if (live.current !== owned) return;
      if (
        scene.scene_revision !== current.scene.scene_revision + 1 ||
        scene.current.status !== "current" ||
        stable(scene.current.inputs) !== stable(inputs)
      )
        throw new Error(
          "Scene acknowledgement differs from the confirmed draft",
        );
      setSnapshot({
        ...current,
        scene,
        dirty: false,
        locked: false,
        error: "",
      });
      callbacks.current.onDirtyChange?.(false);
    } catch (error) {
      if (live.current === owned) {
        const definitive =
          error instanceof WorkspaceRequestError &&
          [413, 422].includes(error.status);
        setSnapshot({
          ...current,
          locked: !definitive,
          error: definitive
            ? "Scene was rejected before saving. Correct the editable draft."
            : "Scene save could not be confirmed. Reload saved scene before retrying.",
        });
      }
    } finally {
      writePending.current = false;
      release();
    }
  }
  const [span, setSpan] = useState(32),
    [roll, setRoll] = useState(0),
    [station, setStation] = useState(0),
    [threshold, setThreshold] = useState(150),
    [opacity, setOpacity] = useState(0.35),
    [secondaryLow, setSecondaryLow] = useState(0),
    [secondaryHigh, setSecondaryHigh] = useState(600),
    [playing, setPlaying] = useState(false);
  const options: ViewOptions = useMemo(
    () => ({
      span_mm: span,
      roll_degrees: roll,
      station_fraction: station,
      threshold,
      primary_window: [windowRange[0], windowRange[1]],
      secondary_window: [secondaryLow, secondaryHigh],
      opacity,
    }),
    [
      span,
      roll,
      station,
      threshold,
      windowRange[0],
      windowRange[1],
      secondaryLow,
      secondaryHigh,
      opacity,
    ],
  );
  const eligible =
    !!current &&
    !current.dirty &&
    !current.locked &&
    !disabled &&
    !localBusy &&
    !!volume &&
    current.scene.current.status === "current";
  useEffect(() => {
    if (!eligible) {
      setPlaying(false);
      return;
    }
    if (!playing) return;
    const timer = setInterval(
      () => setStation((x) => (x >= 0.985 ? 0 : x + 0.015)),
      250,
    );
    return () => clearInterval(timer);
  }, [playing, eligible]);
  const saved =
    current?.scene.current.status === "current" ? current.scene.current : null;
  const renderIdentity = `${key}:${current?.scene.scene_revision ?? ""}:${saved?.scene_id ?? ""}`;
  const moving = useMemo(() => {
    const s = saved?.inputs.secondary;
    if (
      !s ||
      !selected ||
      selected.key !== key ||
      selected.metadata.source_id !== s.source_id ||
      selected.metadata.image_sha256 !== s.image_sha256 ||
      selected.metadata.reference_revision !== s.reference_revision
    )
      return null;
    return { volume: selected.volume, transform: s.secondary_to_primary_ras };
  }, [saved, selected, key]);
  const [receipt, setReceipt] = useState<RenderReceipt | null>(null),
    [exporting, setExporting] = useState(false),
    [exportError, setExportError] = useState("");
  const receiptCurrent =
    eligible &&
    receipt?.identityKey === renderIdentity &&
    receipt.volume === volume &&
    receipt.secondaryVolume === (moving?.volume ?? null) &&
    receipt.optionsKey === stable(options) &&
    receipt.pathKey === stable(saved?.inputs.path)
      ? receipt
      : null;
  const latestReceipt = useRef(receiptCurrent);
  latestReceipt.current = receiptCurrent;
  async function download() {
    const captured = receiptCurrent;
    if (!captured || !saved || !current || exporting) return;
    setExporting(true);
    setExportError("");
    try {
      const response = await api<unknown>(
        `/cases/${identity.case_id}/local-brief`,
      );
      if (
        latestReceipt.current !== captured ||
        !record(response) ||
        !Object.entries(identity).every(([k, v]) => response[k] === v) ||
        !record(response.scene) ||
        response.scene.status !== "current" ||
        response.scene.scene_id !== saved.scene_id ||
        response.scene.scene_revision !== current.scene.scene_revision ||
        response.scene.input_sha256 !== saved.input_sha256 ||
        typeof response.markdown !== "string" ||
        response.markdown.length > 100000
      )
        throw new Error(
          "Brief or displayed scene changed; reload before exporting",
        );
      const provenance = {
        ...captured.provenance,
        fusion_status: moving
          ? "rendered"
          : saved.inputs.secondary
            ? "source_unavailable"
            : "not_selected",
        fusion_method: moving ? "operator_confirmed_rigid_ras" : "not_rendered",
      };
      const text =
        response.markdown +
        "\n## Local viewer settings\n\n" +
        Object.entries(provenance)
          .map(([k, v]) => `- ${k}: ${v ?? "unavailable"}`)
          .join("\n") +
        "\n";
      const url = URL.createObjectURL(
        new Blob([text], { type: "text/markdown;charset=utf-8" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "planning-brief.md";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setExportError(
        "Brief export could not be confirmed for this displayed scene. Reload and try again.",
      );
    } finally {
      setExporting(false);
    }
  }
  const blocked =
    disabled || localBusy || !current || current.locked || !volume;
  return (
    <section
      id="native-reformats"
      className="planning-section native-reformat-studio"
    >
      <header>
        <h2>Native reformat and fusion studio</h2>
        <button
          type="button"
          onClick={() => void load()}
          disabled={localBusy || !key}
        >
          Reload saved scene
        </button>
      </header>
      <p className="muted small">
        Confirm a physical RAS/mm path for curved reformats and first-person
        navigation. A secondary image requires an explicit rigid registration.
      </p>
      {loadError && <p role="alert">{loadError}</p>}
      {current && (
        <p>
          Scene revision {current.scene.scene_revision} ·{" "}
          {current.scene.current.status.replaceAll("_", " ")}
          {current.dirty ? " · unsaved draft" : ""}
        </p>
      )}
      {current?.error && <p role="alert">{current.error}</p>}
      <fieldset disabled={blocked}>
        <legend>Operator path and registration</legend>
        <div className="native-point-inputs">
          {["x", "y", "z"].map((axis, i) => (
            <label key={axis}>
              RAS {axis} (mm)
              <input
                aria-label={`Path RAS ${axis}`}
                inputMode="decimal"
                value={pointText[i]}
                onChange={(e) =>
                  setPointText(
                    pointText.map((v, j) => (j === i ? e.target.value : v)) as [
                      string,
                      string,
                      string,
                    ],
                  )
                }
              />
            </label>
          ))}
        </div>
        <div className="native-actions">
          <button
            type="button"
            disabled={!cursor}
            onClick={() =>
              cursor &&
              setPointText(cursor.map(String) as [string, string, string])
            }
          >
            Use viewer cursor
          </button>
          <button type="button" onClick={append}>
            Append path point
          </button>
          <button
            type="button"
            disabled={!current?.path.length}
            onClick={() => current && edit({ path: current.path.slice(0, -1) })}
          >
            Remove last point
          </button>
          <button
            type="button"
            disabled={!current?.path.length}
            onClick={() => edit({ path: [] })}
          >
            Clear path
          </button>
        </div>
        <div className="native-actions">
          <button
            type="button"
            onClick={() => void copySavedPath("coronary_pci")}
          >
            Copy saved coronary path
          </button>
          <button type="button" onClick={() => void copySavedPath("neurovascular")}>
            Copy saved neurovascular path
          </button>
          <button
            type="button"
            onClick={() => void copySavedPath("aortic_peripheral")}
          >
            Copy saved aortic path
          </button>
        </div>
        <ol aria-label="Physical path draft">
          {current?.path.map((p, i) => (
            <li key={i}>{p.map((n) => n.toFixed(3)).join(" / ")} mm</li>
          ))}
        </ol>
        <label>
          Optional installed secondary source ID
          <input
            aria-label="Secondary source ID"
            maxLength={64}
            value={current?.sourceText ?? ""}
            onChange={(e) => {
              secondaryEpoch.current++;
              setSelected(null);
              setSecondaryError("");
              edit({ sourceText: e.target.value });
            }}
          />
        </label>
        <button
          type="button"
          disabled={!current?.sourceText}
          onClick={() => void chooseSecondary()}
        >
          Load secondary
        </button>
        {current?.sourceText && (
          <label>
            Secondary RAS to primary RAS (4×4)
            <textarea
              aria-label="Secondary to primary rigid matrix"
              rows={4}
              value={current.matrixText}
              onChange={(e) => edit({ matrixText: e.target.value })}
            />
          </label>
        )}
        {selected?.key === key && (
          <p>Secondary image verified · {selected.metadata.source_id}</p>
        )}
        {secondaryError && <p role="status">{secondaryError}</p>}
        <label className="native-confirm">
          <input
            type="checkbox"
            checked={current?.confirmed ?? false}
            onChange={(e) =>
              // Confirmation preserves the dirty draft, unlike edit().
              !blocked &&
              current &&
              setSnapshot({
                ...current,
                confirmed: e.target.checked,
                error: "",
              })
            }
          />
          I confirm this path and any secondary-to-primary registration
        </label>
        <button
          type="button"
          disabled={
            !current?.dirty || !current.confirmed || current.path.length < 2
          }
          onClick={() => void save()}
        >
          Confirm and save scene
        </button>
      </fieldset>
      <div className="native-view-controls">
        {[
          {
            label: "Transverse span (mm)",
            value: span,
            min: 2,
            max: 100,
            step: 1,
            set: setSpan,
          },
          {
            label: "Frame roll (degrees)",
            value: roll,
            min: -180,
            max: 180,
            step: 1,
            set: setRoll,
          },
          {
            label: "Path station",
            value: station,
            min: 0,
            max: 1,
            step: 0.005,
            set: setStation,
          },
          {
            label: "Lumen boundary threshold",
            value: threshold,
            min: -1000,
            max: 2000,
            step: 1,
            set: setThreshold,
          },
          {
            label: "Secondary window low",
            value: secondaryLow,
            min: -1024,
            max: 4096,
            step: 1,
            set: setSecondaryLow,
          },
          {
            label: "Secondary window high",
            value: secondaryHigh,
            min: -1024,
            max: 4096,
            step: 1,
            set: setSecondaryHigh,
          },
          {
            label: "Secondary opacity",
            value: opacity,
            min: 0,
            max: 1,
            step: 0.05,
            set: setOpacity,
          },
        ].map((item) => (
          <label key={item.label}>
            {item.label}: {item.value}
            <input
              aria-label={item.label}
              type="range"
              min={item.min}
              max={item.max}
              step={item.step}
              value={item.value}
              disabled={!eligible}
              onChange={(e) => item.set(Number(e.target.value))}
            />
          </label>
        ))}
      </div>
      <div className="native-actions">
        <button
          type="button"
          disabled={!eligible}
          onClick={() => setPlaying((v) => !v)}
        >
          {playing ? "Pause flythrough" : "Play flythrough"}
        </button>
        <button
          type="button"
          disabled={!receiptCurrent || exporting || playing}
          onClick={() => void download()}
        >
          Export source-bound brief
        </button>
      </div>
      {exportError && <p role="alert">{exportError}</p>}
      <NativeReformatView
        identityKey={renderIdentity}
        volume={volume}
        path={saved ? (saved.inputs.path as Vec3[]) : null}
        options={options}
        secondary={moving}
        disabled={!eligible}
        onReceipt={setReceipt}
      />
    </section>
  );
}
