import { useEffect, useRef, useState } from "react";
import { api, type CaseState } from "./api";
import type { MorphometryBinding } from "./MorphometryInputs";
import "./device-sizing-inputs.css";

// Operator-reported device sizing inputs: GET/edit/save vertical slice.
// No sizing math, no device recommendation, no compatibility claim.

const MEASUREMENT_KEYS = [
  "proximal_parent",
  "distal_parent",
  "neck_coverage_length",
  "average_sac_diameter",
  "smallest_sac_height",
  "dome_diameter",
] as const;

type MeasurementKey = (typeof MEASUREMENT_KEYS)[number];

const LABELS: Record<MeasurementKey, string> = {
  proximal_parent: "Proximal parent diameter (mm)",
  distal_parent: "Distal parent diameter (mm)",
  neck_coverage_length: "Neck coverage length (mm)",
  average_sac_diameter: "Average sac diameter (mm)",
  smallest_sac_height: "Smallest independent sac height (mm)",
  dome_diameter: "Dome diameter (mm)",
};

const HELP: Record<MeasurementKey, string> = {
  proximal_parent:
    "Operator-reported independent sizing diameter, not a mask-section extremum.",
  distal_parent:
    "Operator-reported independent sizing diameter, not a mask-section extremum.",
  neck_coverage_length:
    "Longitudinal neck extent BEFORE any historical margin is applied.",
  average_sac_diameter:
    "Operator-reported independent mean; not an existing single-plane maximum.",
  smallest_sac_height:
    "Smallest independent height dimension; not an existing single-plane maximum.",
  dome_diameter:
    "Operator-reported independent sizing diameter, not a mask-section extremum.",
};

type Measurements = Record<MeasurementKey, number | null>;
type Draft = Record<MeasurementKey, string>;

type Provenance = { kind: "operator_reported"; note: string };

type InputsEnvelope = {
  status: "current" | "not_saved" | "stale";
  input_revision: string | null;
  inputs_sha256: string | null;
  geometry_dependencies: Record<string, unknown> | null;
  measurements: Measurements | null;
  provenance: Provenance | null;
  inputs_version: string;
};

type Envelope = {
  case_id: string;
  image_sha256: string;
  reference_revision: string;
  artifact_version: string;
  geometry_status: string;
  inputs: InputsEnvelope;
  clinical_suitability_established: boolean;
  validated_sizing: boolean;
};

const EMPTY_DRAFT: Draft = {
  proximal_parent: "",
  distal_parent: "",
  neck_coverage_length: "",
  average_sac_diameter: "",
  smallest_sac_height: "",
  dome_diameter: "",
};

function validateMeasurements(v: unknown): Measurements | null {
  if (typeof v !== "object" || v === null) return null;
  if (
    Array.isArray(v) ||
    Object.keys(v).sort().join(",") !== [...MEASUREMENT_KEYS].sort().join(",")
  )
    return null;
  const out: Partial<Measurements> = {};
  for (const key of MEASUREMENT_KEYS) {
    const x = (v as Record<string, unknown>)[key];
    if (x === null) {
      out[key] = null;
      continue;
    }
    if (typeof x !== "number" || typeof x === "boolean") return null;
    if (!Number.isFinite(x)) return null;
    if (!(x > 0 && x <= 100)) return null;
    out[key] = x;
  }
  return out as Measurements;
}

function validateProvenance(v: unknown): Provenance | null {
  if (typeof v !== "object" || v === null) return null;
  const p = v as Record<string, unknown>;
  if (Object.keys(p).sort().join(",") !== "kind,note") return null;
  if (p.kind !== "operator_reported") return null;
  if (
    typeof p.note !== "string" ||
    p.note.trim().length === 0 ||
    p.note.length > 512
  )
    return null;
  return { kind: "operator_reported", note: p.note };
}

function isHex64(x: unknown): x is string {
  return typeof x === "string" && /^[0-9a-f]{64}$/.test(x);
}

function validateInputsEnvelope(raw: unknown): InputsEnvelope | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  const status = v.status;
  if (status !== "current" && status !== "not_saved" && status !== "stale")
    return null;
  if (v.inputs_version !== "operator-reported-device-inputs-v1") return null;
  const revision = v.input_revision;
  if (
    status === "current" &&
    (typeof revision !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(revision))
  )
    return null;
  if (status === "not_saved" && revision !== null) return null;
  if (
    status === "stale" &&
    (typeof revision !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(revision))
  )
    return null;
  const hash = v.inputs_sha256;
  if (status === "current" ? !isHex64(hash) : hash !== null) return null;
  if (status === "current") {
    const measurements = validateMeasurements(v.measurements);
    const provenance = validateProvenance(v.provenance);
    if (!measurements || !provenance) return null;
    if (
      typeof v.geometry_dependencies !== "object" ||
      v.geometry_dependencies === null ||
      Array.isArray(v.geometry_dependencies)
    )
      return null;
    return {
      status,
      input_revision: revision as string,
      inputs_sha256: hash as string,
      geometry_dependencies: v.geometry_dependencies as Record<string, unknown>,
      measurements,
      provenance,
      inputs_version: v.inputs_version,
    };
  }
  // not_saved / stale must not carry numeric input values.
  if (
    v.measurements !== null ||
    v.provenance !== null ||
    (v.geometry_dependencies !== null && v.geometry_dependencies !== undefined)
  )
    return null;
  return {
    status,
    input_revision: revision as string | null,
    inputs_sha256: null,
    geometry_dependencies: null,
    measurements: null,
    provenance: null,
    inputs_version: v.inputs_version,
  };
}

function validateEnvelope(
  payload: unknown,
  caseState: CaseState,
  binding: MorphometryBinding,
): Envelope | null {
  if (typeof payload !== "object" || payload === null) return null;
  const env = payload as Envelope;
  if (env.case_id !== binding.case_id) return null;
  if (env.image_sha256 !== binding.image_sha256) return null;
  if (env.reference_revision !== binding.reference_revision) return null;
  if (env.artifact_version !== caseState.artifact_version) return null;
  if (!["current", "stale", "not_computed"].includes(env.geometry_status))
    return null;
  if (env.clinical_suitability_established !== false) return null;
  if (env.validated_sizing !== false) return null;
  const inputs = validateInputsEnvelope(env.inputs);
  if (inputs === null) return null;
  if (inputs.status === "current") {
    const deps = inputs.geometry_dependencies!;
    if (
      deps.case_id !== binding.case_id ||
      deps.image_sha256 !== binding.image_sha256 ||
      deps.source_revision !== binding.reference_revision ||
      deps.artifact_version !== caseState.artifact_version ||
      deps.calculation_version !== "native-mask-operator-plane-v1" ||
      !isHex64(deps.operator_sha256)
    )
      return null;
  }
  return { ...env, inputs };
}

function draftFromMeasurements(m: Measurements): Draft {
  const out = { ...EMPTY_DRAFT };
  for (const key of MEASUREMENT_KEYS) {
    if (m[key] !== null) out[key] = String(m[key]);
  }
  return out;
}

function parseDraftValue(text: string): number | null | "invalid" {
  if (text.trim() === "") return null;
  if (!/^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text.trim()))
    return "invalid";
  const x = Number(text);
  if (!Number.isFinite(x) || typeof x === "boolean" || !(x > 0 && x <= 100))
    return "invalid";
  return x;
}

function draftFromMeasurementsDiffers(
  a: Draft,
  m: Measurements | null,
): boolean {
  for (const key of MEASUREMENT_KEYS) {
    const parsed = parseDraftValue(a[key]);
    const saved = m === null ? null : m[key];
    if (parsed === null && saved === null) continue;
    if (parsed === null || saved === null) return true;
    if (Number(parsed) !== Number(saved)) return true;
  }
  return false;
}

function sameMeasurements(a: Measurements, b: Measurements): boolean {
  return MEASUREMENT_KEYS.every((key) => a[key] === b[key]);
}

export default function DeviceSizingInputs({
  caseState,
  binding,
  disabled = false,
  onBusy,
  onDirty,
  onSaved,
  onConflict,
}: {
  caseState: CaseState;
  binding: MorphometryBinding | null;
  disabled?: boolean;
  onBusy?: (busy: boolean) => void;
  onDirty?: (dirty: boolean) => void;
  onSaved?: () => void;
  onConflict?: (message: string) => void;
}) {
  const [state, setState] = useState<{
    phase: "idle" | "loading" | "error" | "ready";
    scope: string | null;
    saved: InputsEnvelope | null;
  }>({ phase: "idle", scope: null, saved: null });
  const [draft, setDraft] = useState<Draft>({ ...EMPTY_DRAFT });
  const [draftNote, setDraftNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveLocked, setSaveLocked] = useState(false);
  const [geometryStatus, setGeometryStatus] = useState("not_computed");
  const [loadTrigger, setLoadTrigger] = useState(0);
  const epochRef = useRef(0);

  const callbacks = { onBusy, onDirty, onSaved, onConflict };
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const scope =
    binding &&
    caseState.spatial_units === "mm" &&
    binding.case_id === caseState.case_id &&
    binding.image_sha256 === caseState.image_sha256
      ? [
          binding.case_id,
          binding.image_sha256,
          binding.reference_revision,
          caseState.artifact_version,
        ].join(":")
      : null;
  const scopeRef = useRef<string | null>(null);
  scopeRef.current = scope;

  const dirty =
    state.scope === scope &&
    !!scope &&
    state.phase === "ready" &&
    state.saved !== null &&
    (draftFromMeasurementsDiffers(draft, state.saved.measurements) ||
      draftNote !== (state.saved.provenance?.note ?? ""));

  useEffect(() => {
    callbacksRef.current.onDirty?.(dirty);
  }, [dirty]);

  useEffect(() => {
    if (!scope) {
      epochRef.current++;
      setState({ phase: "idle", scope: null, saved: null });
      setDraft({ ...EMPTY_DRAFT });
      setDraftNote("");
      setSaveLocked(false);
      return;
    }
    const epoch = ++epochRef.current;
    if (disabled) {
      setState({ phase: "idle", scope, saved: null });
      return;
    }
    setState({ phase: "loading", scope, saved: null });
    setGeometryStatus("not_computed");
    setSaveLocked(false);
    setDraft({ ...EMPTY_DRAFT });
    setDraftNote("");
    const b = binding!;
    api<Envelope>(
      `/cases/${encodeURIComponent(b.case_id)}/device-sizing-inputs`,
    )
      .then((payload) => {
        if (epochRef.current !== epoch) return; // ignore late GET
        const env = validateEnvelope(payload, caseState, b);
        if (!env) {
          setState({ phase: "error", scope, saved: null });
          callbacksRef.current.onConflict?.(
            "Device sizing inputs envelope did not match the case.",
          );
          return;
        }
        const saved = validateInputsEnvelope(env.inputs)!;
        setGeometryStatus(env.geometry_status);
        setState({ phase: "ready", scope, saved });
        if (saved.status === "current") {
          setDraft(draftFromMeasurements(saved.measurements!));
          setDraftNote(saved.provenance!.note);
        }
      })
      .catch(() => {
        if (epochRef.current !== epoch) return;
        setState({ phase: "error", scope, saved: null });
      });
    return () => {
      epochRef.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, loadTrigger]);

  useEffect(() => {
    if (!disabled && scope && state.scope === scope && state.phase === "idle")
      setLoadTrigger((value) => value + 1);
  }, [disabled, scope, state.scope, state.phase]);

  const locked =
    disabled ||
    !scope ||
    state.scope !== scope ||
    state.phase !== "ready" ||
    busy;

  const geometryCurrent = geometryStatus === "current";

  function handleSave() {
    if (locked || saveLocked) return;
    // Defensive guards never replace operator provenance with validation text.
    if (state.saved === null || !geometryCurrent) return;
    const measurements: Partial<Measurements> = {};
    for (const key of MEASUREMENT_KEYS) {
      const parsed = parseDraftValue(draft[key]);
      if (parsed === "invalid") return;
      measurements[key] = parsed;
    }
    const note = draftNote;
    if (note.trim().length === 0 || note.length > 512) return;
    const b = binding!;
    const sent: Measurements = measurements as Measurements;
    const body = {
      artifact_version: caseState.artifact_version,
      reference_revision: b.reference_revision,
      expected_input_revision: state.saved.input_revision,
      measurements: sent,
      provenance: { kind: "operator_reported", note },
    };
    const epoch = ++epochRef.current;
    const busyOwner = callbacksRef.current.onBusy; // capture busy-owner for this mutation
    setBusy(true);
    busyOwner?.(true);
    api<Envelope>(
      `/cases/${encodeURIComponent(b.case_id)}/device-sizing-inputs`,
      body,
      "PUT",
    )
      .then((payload) => {
        if (epochRef.current !== epoch) return; // ignore late PUT
        const env = validateEnvelope(payload, caseState, b);
        const inputs = env ? validateInputsEnvelope(env.inputs) : null;
        const ok =
          env !== null &&
          env.geometry_status === "current" &&
          inputs !== null &&
          inputs.status === "current" &&
          inputs.input_revision !== null &&
          inputs.input_revision !== state.saved!.input_revision &&
          isHex64(inputs.inputs_sha256) &&
          inputs.measurements !== null &&
          sameMeasurements(inputs.measurements, sent) &&
          inputs.provenance !== null &&
          inputs.provenance.note === note;
        if (!ok) {
          // Unconfirmed PUT may represent a committed write: lock, never blind-retry.
          setSaveLocked(true);
          callbacksRef.current.onConflict?.(
            "Device sizing save could not be confirmed. Reload the case before editing again.",
          );
          return;
        }
        if (scopeRef.current === scope) {
          setGeometryStatus(env!.geometry_status);
          setState((s) =>
            s.scope === scope ? { ...s, phase: "ready", saved: inputs } : s,
          );
          setDraft(draftFromMeasurements(inputs!.measurements!));
          setDraftNote(note);
        }
        callbacksRef.current.onSaved?.();
      })
      .catch(() => {
        if (epochRef.current !== epoch) return;
        // 409 or 5xx: a write may already be committed. Lock and surface reload.
        setSaveLocked(true);
        callbacksRef.current.onConflict?.(
          "Device sizing save could not be confirmed. Reload the case before editing again.",
        );
      })
      .finally(() => {
        setBusy(false);
        busyOwner?.(false); // release the same busy owner even after source reset
      });
  }

  function handleDiscard() {
    if (locked || state.saved === null) return;
    setDraft(
      state.saved.measurements
        ? draftFromMeasurements(state.saved.measurements)
        : { ...EMPTY_DRAFT },
    );
    setDraftNote(state.saved.provenance?.note ?? "");
  }

  const validDraft =
    MEASUREMENT_KEYS.every(
      (key) => parseDraftValue(draft[key]) !== "invalid",
    ) &&
    draftNote.trim().length > 0 &&
    draftNote.length <= 512;
  const canSave =
    !locked && !saveLocked && dirty && geometryCurrent && validDraft;
  const inputs = state.saved;

  return (
    <section className="sizing-inputs" aria-label="Device sizing inputs">
      <h3>Device sizing inputs</h3>
      <p className="sizing-help">
        Operator-reported measurements entered by hand; not image-derived and
        not validated sizing. No device recommendation or compatibility claim is
        made here.
      </p>
      {scope && state.scope === scope && state.phase === "ready" && inputs ? (
        <>
          {inputs.status !== "current" || !geometryCurrent ? (
            <p role="alert" className="sizing-note">
              {!geometryCurrent
                ? "Compute mask geometry before entering sizing inputs."
                : inputs.status === "stale"
                  ? "Previous inputs are stale and hidden. Enter new operator-reported values."
                  : "No sizing inputs saved yet. Enter independent operator-reported values."}
            </p>
          ) : null}
          {MEASUREMENT_KEYS.map((key) => (
            <label key={key} className="sizing-field">
              <span>{LABELS[key]}</span>
              <input
                data-testid={`sizing-input-${key}`}
                type="text"
                inputMode="decimal"
                value={draft[key]}
                aria-invalid={parseDraftValue(draft[key]) === "invalid"}
                disabled={locked || saveLocked || !geometryCurrent}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, [key]: e.target.value }))
                }
              />
              <span className="sizing-help">{HELP[key]}</span>
            </label>
          ))}
          <label className="sizing-field">
            <span>Provenance note</span>
            <textarea
              data-testid="sizing-provenance-note"
              value={draftNote}
              disabled={locked || saveLocked || !geometryCurrent}
              maxLength={512}
              onChange={(e) => setDraftNote(e.target.value)}
            />
          </label>
          <div className="sizing-actions">
            <button
              type="button"
              data-testid="sizing-discard"
              disabled={locked || !dirty}
              onClick={handleDiscard}
            >
              Discard edits
            </button>
            <button
              type="button"
              data-testid="sizing-save"
              disabled={!canSave}
              onClick={handleSave}
            >
              Save sizing inputs
            </button>
          </div>
          {dirty && !geometryCurrent && inputs.status !== "current" ? (
            <p role="alert" className="sizing-note">
              Recompute mask geometry before saving sizing inputs.
            </p>
          ) : null}
          {saveLocked ? (
            <p role="alert" className="sizing-note">
              Save is locked until the case is reloaded.
            </p>
          ) : null}
        </>
      ) : state.phase === "loading" ? (
        <p className="sizing-help">Loading sizing inputs…</p>
      ) : state.phase === "error" ? (
        <p role="alert" className="sizing-note">
          Sizing inputs could not be loaded.
        </p>
      ) : null}
    </section>
  );
}
