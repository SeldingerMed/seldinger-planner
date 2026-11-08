import { useEffect, useRef, useState } from "react";
import { api, RevisionConflictError, type CaseState } from "./api";
import type { Point3 } from "./geometry";
import "./morphometry.css";

export type MorphometryBinding = {
  case_id: string;
  image_sha256: string;
  reference_revision: string;
};

type Vec3 = [number, number, number];

type Inputs = {
  neck_origin: Vec3;
  neck_normal: Vec3;
  aneurysm_seed: Vec3;
  parent_path: Vec3[];
  proximal_index: number;
  distal_index: number;
};

type Draft = {
  neck_origin: Vec3 | null;
  neck_normal: Vec3 | null;
  aneurysm_seed: Vec3 | null;
  parent_path: Vec3[];
  proximal_index: number;
  distal_index: number;
};

type Envelope = {
  case_id: string;
  image_sha256: string;
  reference_revision: string;
  artifact_version: string;
  operator_inputs: unknown;
  current: { status: string };
};

const EMPTY_DRAFT: Draft = {
  neck_origin: null,
  neck_normal: null,
  aneurysm_seed: null,
  parent_path: [],
  proximal_index: 1,
  distal_index: 2,
};

function isFiniteTriple(v: unknown): v is Vec3 {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((x) => typeof x === "number" && Number.isFinite(x))
  );
}

function draftFromInputs(inputs: Inputs): Draft {
  return {
    neck_origin: [...inputs.neck_origin] as Vec3,
    neck_normal: [...inputs.neck_normal] as Vec3,
    aneurysm_seed: [...inputs.aneurysm_seed] as Vec3,
    parent_path: inputs.parent_path.map((p) => [...p] as Vec3),
    proximal_index: inputs.proximal_index,
    distal_index: inputs.distal_index,
  };
}

function draftIsEmpty(d: Draft): boolean {
  return (
    d.neck_origin === null &&
    d.neck_normal === null &&
    d.aneurysm_seed === null &&
    d.parent_path.length === 0
  );
}

function sameDraft(a: Draft, b: Draft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function matchesSavedInputs(echoed: Inputs, sent: Inputs): boolean {
  // The Python producer normalizes again; tolerate roundoff only in that unit vector.
  return (
    echoed.neck_normal.every(
      (v, i) => Math.abs(v - sent.neck_normal[i]) <= 1e-12,
    ) &&
    JSON.stringify({ ...echoed, neck_normal: null }) ===
      JSON.stringify({ ...sent, neck_normal: null })
  );
}

function validateInputs(raw: unknown): Inputs | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(",");
  if (
    keys !==
    "aneurysm_seed,distal_index,neck_normal,neck_origin,parent_path,proximal_index"
  )
    return null;
  if (!isFiniteTriple(v.neck_origin)) return null;
  if (!isFiniteTriple(v.aneurysm_seed)) return null;
  if (!isFiniteTriple(v.neck_normal)) return null;
  const n = v.neck_normal;
  const norm = Math.hypot(n[0], n[1], n[2]);
  if (!Number.isFinite(norm) || norm === 0) return null;
  const path = v.parent_path;
  if (
    !Array.isArray(path) ||
    path.length < 4 ||
    path.length > 32 ||
    !path.every(isFiniteTriple)
  )
    return null;
  const pi = v.proximal_index;
  const di = v.distal_index;
  if (
    typeof pi !== "number" ||
    typeof di !== "number" ||
    !Number.isInteger(pi) ||
    !Number.isInteger(di) ||
    pi === di ||
    !(pi > 0 && pi < path.length - 1) ||
    !(di > 0 && di < path.length - 1)
  )
    return null;
  return {
    neck_origin: v.neck_origin,
    neck_normal: n,
    aneurysm_seed: v.aneurysm_seed,
    parent_path: path as Vec3[],
    proximal_index: pi,
    distal_index: di,
  };
}

function validateDraft(d: Draft): string | null {
  if (
    d.neck_origin === null ||
    d.neck_normal === null ||
    d.aneurysm_seed === null
  )
    return "Capture the sac seed, neck origin and dome direction first.";
  if (d.parent_path.length < 4) return "Parent path needs at least 4 points.";
  const seen = new Set(d.parent_path.map((p) => p.join(",")));
  if (seen.size !== d.parent_path.length)
    return "Parent path contains duplicated station positions.";
  const last = d.parent_path.length - 1;
  for (const idx of [d.proximal_index, d.distal_index]) {
    if (!(idx > 0 && idx < last))
      return "Station indices must be interior parent path indices.";
    if (
      samePoint(d.parent_path[idx], d.parent_path[idx - 1]) ||
      samePoint(d.parent_path[idx], d.parent_path[idx + 1])
    )
      return "A station has a zero neighbor tangent.";
  }
  if (d.proximal_index === d.distal_index)
    return "Station indices must be distinct.";
  const norm = Math.hypot(...d.neck_normal);
  if (!Number.isFinite(norm) || norm === 0)
    return "Dome direction must be nonzero.";
  return null;
}

function samePoint(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
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
  if (typeof env.current !== "object" || env.current === null) return null;
  return env;
}

const HEX64 = /^[0-9a-f]{64}$/;

type Proposal = {
  path: Vec3[];
  proximal_index: number;
  distal_index: number;
  length_mm: number;
  start_ras: Vec3;
  end_ras: Vec3;
};

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function validateProposal(
  payload: unknown,
  caseState: CaseState,
  binding: MorphometryBinding,
  startRas: Vec3,
  endRas: Vec3,
  requestedMaxPoints: number,
): Proposal | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p.case_id !== binding.case_id) return null;
  if (p.image_sha256 !== binding.image_sha256) return null;
  if (p.reference_revision !== binding.reference_revision) return null;
  if (p.artifact_version !== caseState.artifact_version) return null;
  if (p.kind !== "centerline") return null;
  const cur = p.current;
  if (typeof cur !== "object" || cur === null) return null;
  const c = cur as Record<string, unknown>;
  if (c.status !== "current") return null;
  if (!nonEmptyString(c.result_id)) return null;
  const params = c.parameters;
  if (typeof params !== "object" || params === null) return null;
  const pr = params as Record<string, unknown>;
  if (
    !isFiniteTriple(pr.start_ras) ||
    !isFiniteTriple(pr.end_ras) ||
    pr.max_points !== requestedMaxPoints
  )
    return null;
  // The echoed anchors must match the requested (normalized) anchors.
  const close = (a: unknown, b: Vec3) =>
    isFiniteTriple(a) &&
    (a as Vec3).every((v, i) => Math.abs(v - b[i]) <= 1e-12);
  if (!close(pr.start_ras, startRas) || !close(pr.end_ras, endRas)) return null;
  const deps = c.dependencies;
  if (typeof deps !== "object" || deps === null) return null;
  const d = deps as Record<string, unknown>;
  if (d.case_id !== binding.case_id) return null;
  if (d.image_sha256 !== binding.image_sha256) return null;
  if (d.artifact_version !== caseState.artifact_version) return null;
  if (d.source_revision !== binding.reference_revision) return null;
  const masks = d.masks;
  if (typeof masks !== "object" || masks === null) return null;
  const vessel = (masks as Record<string, unknown>).vessel;
  if (typeof vessel !== "object" || vessel === null) return null;
  const vm = vessel as Record<string, unknown>;
  if (
    !nonEmptyString(vm.candidate_id) ||
    typeof vm.mask_sha256 !== "string" ||
    !HEX64.test(vm.mask_sha256) ||
    typeof vm.segmentation_revision !== "number" ||
    !Number.isSafeInteger(vm.segmentation_revision) ||
    vm.segmentation_revision < 1
  )
    return null;
  const res = c.result;
  if (typeof res !== "object" || res === null) return null;
  const r = res as Record<string, unknown>;
  if (typeof r.job_sha256 !== "string" || !HEX64.test(r.job_sha256))
    return null;
  if (r.method !== "native_skeleton_path_proposal") return null;
  if (r.clinical_validation !== false || r.device_calibrated !== false)
    return null;
  if (r.operator_confirmation_required !== true) return null;
  if (r.spatial_units !== "mm") return null;
  const path = r.path_ras;
  if (
    !Array.isArray(path) ||
    path.length < 4 ||
    path.length > requestedMaxPoints ||
    !path.every(isFiniteTriple)
  )
    return null;
  const seen = new Set(path.map((q) => (q as Vec3).join(",")));
  if (seen.size !== path.length) return null;
  const pi = r.proximal_index;
  const di = r.distal_index;
  if (
    typeof pi !== "number" ||
    typeof di !== "number" ||
    !Number.isInteger(pi) ||
    !Number.isInteger(di) ||
    pi === di ||
    !(pi > 0 && pi < path.length - 1) ||
    !(di > 0 && di < path.length - 1)
  )
    return null;
  if (
    typeof r.length_mm !== "number" ||
    !Number.isFinite(r.length_mm) ||
    r.length_mm <= 0
  )
    return null;
  if (r.point_count !== path.length) return null;
  if (
    typeof r.skeleton_voxel_count !== "number" ||
    !Number.isInteger(r.skeleton_voxel_count) ||
    r.skeleton_voxel_count <= 0
  )
    return null;
  const grid = r.grid_shape;
  if (
    !Array.isArray(grid) ||
    grid.length !== 3 ||
    !grid.every((g) => typeof g === "number" && Number.isInteger(g) && g > 0)
  )
    return null;
  return {
    path: path as Vec3[],
    proximal_index: pi,
    distal_index: di,
    length_mm: r.length_mm,
    start_ras: [...startRas],
    end_ras: [...endRas],
  };
}

function fmt(v: number): string {
  return v.toFixed(2);
}

function PointValue({
  label,
  point,
  onFocus,
}: {
  label: string;
  point: Vec3 | null;
  onFocus?: () => void;
}) {
  return (
    <div className="point-row">
      <span className="field-label">{label}</span>
      <span data-testid={`value-${label}`}>
        {point ? point.map(fmt).join(", ") : "not captured"}
      </span>
      {point && onFocus && (
        <button type="button" onClick={onFocus}>
          View {label}
        </button>
      )}
    </div>
  );
}

export default function MorphometryInputs({
  caseState,
  binding,
  location,
  disabled = false,
  onRevision,
  onComputed,
  onDirtyChange,
  onBusy,
  onError,
  onFocus,
}: {
  caseState: CaseState;
  binding: MorphometryBinding | null;
  location: Point3 | null;
  disabled?: boolean;
  onRevision: (version: string) => void;
  onComputed: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
  onError: (e: unknown) => void;
  onFocus?: (point: Point3) => void;
}) {
  const [state, setState] = useState<{
    phase: "idle" | "loading" | "error" | "ready";
    scope: string | null;
    saved: Inputs | null;
  }>({ phase: "idle", scope: null, saved: null });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const epochRef = useRef(0);

  const callbacks = {
    onRevision,
    onComputed,
    onDirtyChange,
    onBusy,
    onError,
    onFocus,
  };
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
    draft !== null &&
    !draftIsEmpty(draft) &&
    (state.saved === null || !sameDraft(draft, draftFromInputs(state.saved)));

  useEffect(() => {
    callbacksRef.current.onDirtyChange(dirty);
  }, [dirty]);

  useEffect(() => {
    if (!scope) {
      setState({ phase: "idle", scope: null, saved: null });
      setDraft(null);
      setNote("");
      setProposal(null);
      return;
    }
    const epoch = ++epochRef.current;
    setState({ phase: "loading", scope, saved: null });
    setDraft(null);
    setNote("");
    setProposal(null);
    const b = binding!;
    api<Envelope>(`/cases/${encodeURIComponent(b.case_id)}/morphometry`)
      .then((payload) => {
        if (epochRef.current !== epoch) return;
        const env = validateEnvelope(payload, caseState, b);
        if (!env) {
          setState({ phase: "error", scope, saved: null });
          callbacksRef.current.onError(
            new Error("Geometry input envelope did not match the case."),
          );
          return;
        }
        const saved = validateInputs(env.operator_inputs);
        setState({ phase: "ready", scope, saved });
        if (saved) setDraft(draftFromInputs(saved));
      })
      .catch((e) => {
        if (epochRef.current !== epoch) return;
        setState({ phase: "error", scope, saved: null });
        callbacksRef.current.onError(e);
      });
    return () => {
      epochRef.current++;
    };
    // caseState/binding identity is captured per scope string.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  const locked =
    disabled ||
    !scope ||
    state.scope !== scope ||
    state.phase !== "ready" ||
    busy;

  function capture(kind: "seed" | "origin" | "normal") {
    if (locked || !isFiniteTriple(location)) return;
    const base = draft ?? { ...EMPTY_DRAFT };
    if (kind === "seed") {
      setDraft({ ...base, aneurysm_seed: [...location] });
      return;
    }
    if (kind === "origin") {
      setDraft({ ...base, neck_origin: [...location], neck_normal: null });
      setNote("Neck origin captured; capture dome direction again.");
      return;
    }
    if (base.neck_origin === null) return;
    const v: Vec3 = [
      location[0] - base.neck_origin[0],
      location[1] - base.neck_origin[1],
      location[2] - base.neck_origin[2],
    ];
    const norm = Math.hypot(...v);
    if (!Number.isFinite(norm) || norm === 0) {
      setNote("Dome direction is zero at the neck origin.");
      return;
    }
    setNote("");
    setDraft({ ...base, neck_normal: [v[0] / norm, v[1] / norm, v[2] / norm] });
  }

  function addParentPoint() {
    if (locked || !isFiniteTriple(location)) return;
    const base = draft ?? { ...EMPTY_DRAFT };
    if (base.parent_path.length >= 32) {
      setNote("Parent path is limited to 32 points.");
      return;
    }
    setNote("");
    setDraft({ ...base, parent_path: [...base.parent_path, [...location]] });
  }

  function clearParentPath() {
    if (locked) return;
    setNote(
      "Parent path cleared; rebuild at least four points and reselect stations.",
    );
    setDraft((d) =>
      d ? { ...d, parent_path: [], proximal_index: 1, distal_index: 2 } : d,
    );
  }

  function handleSave() {
    if (locked || draft === null) return;
    const problem = validateDraft(draft);
    if (
      problem ||
      draft.neck_origin === null ||
      draft.neck_normal === null ||
      draft.aneurysm_seed === null
    ) {
      setNote(problem ?? "Incomplete inputs.");
      return;
    }
    const b = binding!;
    const inputs: Inputs = {
      neck_origin: draft.neck_origin,
      neck_normal: draft.neck_normal,
      aneurysm_seed: draft.aneurysm_seed,
      parent_path: draft.parent_path,
      proximal_index: draft.proximal_index,
      distal_index: draft.distal_index,
    };
    const epoch = ++epochRef.current;
    const releaseOwner = callbacksRef.current.onBusy;
    const unconfirmedSave = () => {
      setState((s) => ({ ...s, phase: "error" }));
      const error = new RevisionConflictError();
      error.message =
        "Geometry save could not be confirmed. Reload saved state before retrying.";
      callbacksRef.current.onError(error);
    };
    setBusy(true);
    releaseOwner(true);
    setNote("");
    api<Envelope>(
      `/cases/${encodeURIComponent(b.case_id)}/morphometry-inputs`,
      {
        artifact_version: caseState.artifact_version,
        reference_revision: b.reference_revision,
        inputs,
      },
      "PUT",
    )
      .then((payload) => {
        if (epochRef.current !== epoch) return;
        const echoed = validateInputs((payload as Envelope).operator_inputs);
        const ok =
          typeof payload === "object" &&
          payload !== null &&
          (payload as Envelope).case_id === b.case_id &&
          (payload as Envelope).image_sha256 === caseState.image_sha256 &&
          (payload as Envelope).reference_revision === b.reference_revision &&
          typeof (payload as Envelope).artifact_version === "string" &&
          (payload as Envelope).artifact_version.length > 0 &&
          echoed !== null &&
          matchesSavedInputs(echoed, inputs);
        if (!ok) {
          unconfirmedSave();
          return;
        }
        if (scopeRef.current === scope) {
          // Do not reuse the pre-save case version while the parent reloads the receipt's revision.
          setState((s) =>
            s.scope === scope ? { ...s, phase: "loading", saved: echoed } : s,
          );
          setDraft(draftFromInputs(echoed!));
        }
        callbacksRef.current.onRevision((payload as Envelope).artifact_version);
      })
      .catch(() => {
        if (epochRef.current === epoch) unconfirmedSave();
      })
      .finally(() => {
        setBusy(false);
        releaseOwner(false);
      });
  }

  function handleCompute() {
    if (locked || dirty || state.saved === null) return;
    const b = binding!;
    const epoch = ++epochRef.current;
    const releaseOwner = callbacksRef.current.onBusy;
    setBusy(true);
    releaseOwner(true);
    setNote("");
    api<Envelope>(
      `/cases/${encodeURIComponent(b.case_id)}/morphometry`,
      {
        artifact_version: caseState.artifact_version,
        reference_revision: b.reference_revision,
      },
      "POST",
    )
      .then((payload) => {
        if (epochRef.current !== epoch) return;
        const env = validateEnvelope(payload, caseState, b);
        if (!env || env.current.status !== "current") {
          callbacksRef.current.onError(
            new Error("Mask geometry result did not match the case."),
          );
          return;
        }
        callbacksRef.current.onComputed();
      })
      .catch((e) => {
        if (epochRef.current === epoch) callbacksRef.current.onError(e);
      })
      .finally(() => {
        setBusy(false);
        releaseOwner(false);
      });
  }

  function handlePropose() {
    if (locked || draft === null) return;
    const anchors = draft.parent_path;
    if (anchors.length < 2) return;
    const first = anchors[0];
    const last = anchors[anchors.length - 1];
    if (!isFiniteTriple(first) || !isFiniteTriple(last)) return;
    if (samePoint(first, last)) return;
    const b = binding!;
    const startRas: Vec3 = [...first];
    const endRas: Vec3 = [...last];
    const requestedMaxPoints = 32;
    const epoch = ++epochRef.current;
    const releaseOwner = callbacksRef.current.onBusy;
    setBusy(true);
    releaseOwner(true);
    setNote("");
    api<unknown>(
      `/cases/${encodeURIComponent(b.case_id)}/centerline-proposals`,
      {
        artifact_version: caseState.artifact_version,
        reference_revision: b.reference_revision,
        parameters: {
          start_ras: startRas,
          end_ras: endRas,
          max_points: requestedMaxPoints,
        },
      },
      "POST",
    )
      .then((payload) => {
        if (epochRef.current !== epoch) return;
        const p = validateProposal(
          payload, caseState, b, startRas, endRas, requestedMaxPoints,
        );
        if (!p) {
          callbacksRef.current.onError(
            new Error("Centerline proposal did not match the case."),
          );
          return;
        }
        setProposal(p);
        setNote(
          "Review the proposed parent path and stations before using it.",
        );
      })
      .catch((e) => {
        if (epochRef.current === epoch) callbacksRef.current.onError(e);
      })
      .finally(() => {
        // Release the exact busy owner captured at request start, even if
        // the response was superseded by a scope or anchor change.
        setBusy(false);
        releaseOwner(false);
      });
  }

  function useProposedPath() {
    if (locked || draft === null || proposal === null) return;
    setDraft({
      ...draft,
      parent_path: proposal.path.map((p) => [...p] as Vec3),
      proximal_index: proposal.proximal_index,
      distal_index: proposal.distal_index,
    });
    setProposal(null);
    setNote("");
  }

  const pathLen = draft?.parent_path.length ?? 0;
  const canCapture = !locked && location !== null;
  const canSave = !locked && dirty && draft !== null;
  const canCompute = !locked && !dirty && state.saved !== null;
  const anchorsEligible =
    draft !== null &&
    pathLen >= 2 &&
    isFiniteTriple(draft.parent_path[0]) &&
    isFiniteTriple(draft.parent_path[pathLen - 1]) &&
    !samePoint(draft.parent_path[0], draft.parent_path[pathLen - 1]);
  const canPropose = !locked && anchorsEligible;
  // A retained proposal is only offered while the draft still carries the
  // exact anchors the proposal was computed from.
  const proposalUsable =
    draft !== null &&
    proposal !== null &&
    pathLen >= 2 &&
    samePoint(draft.parent_path[0], proposal.start_ras) &&
    samePoint(draft.parent_path[pathLen - 1], proposal.end_ras);

  return (
    <section
      className="planning-section geometry-inputs"
      aria-label="Geometry landmarks"
    >
      <h3>Geometry landmarks</h3>
      <p className="field-label">
        Operator-defined neck plane and vessel path.
      </p>
      {scope && state.scope === scope && state.phase === "ready" ? (
        <>
          <PointValue
            label="sac seed"
            point={draft?.aneurysm_seed ?? null}
            onFocus={
              onFocus && draft?.aneurysm_seed
                ? () => onFocus([...draft.aneurysm_seed!])
                : undefined
            }
          />
          <PointValue
            label="neck origin"
            point={draft?.neck_origin ?? null}
            onFocus={
              onFocus && draft?.neck_origin
                ? () => onFocus([...draft.neck_origin!])
                : undefined
            }
          />
          <PointValue
            label="dome direction"
            point={draft?.neck_normal ?? null}
          />
          <div className="point-row">
            <span className="field-label">parent path</span>
            <span data-testid="parent-path-count">{pathLen} points</span>
          </div>
          {pathLen > 0 ? (
            <ol data-testid="parent-path-points">
              {draft!.parent_path.map((p, i) => (
                <li key={i}>{p.map(fmt).join(", ")}</li>
              ))}
            </ol>
          ) : null}
          {pathLen >= 4 ? (
            <>
              <p className="field-label">
                For mask geometry, choose parent stations outside the accepted
                sac mask. Proposal stations are geometric suggestions.
              </p>
              <label className="field-label">
                Proximal station
                <select
                  aria-label="Proximal station index"
                  value={draft!.proximal_index}
                  disabled={locked}
                  onChange={(e) =>
                    setDraft((d) =>
                      d ? { ...d, proximal_index: Number(e.target.value) } : d,
                    )
                  }
                >
                  {Array.from({ length: pathLen - 2 }, (_, i) => i + 1).map(
                    (i) => (
                      <option key={i} value={i}>
                        {i}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <label className="field-label">
                Distal station
                <select
                  aria-label="Distal station index"
                  value={draft!.distal_index}
                  disabled={locked}
                  onChange={(e) =>
                    setDraft((d) =>
                      d ? { ...d, distal_index: Number(e.target.value) } : d,
                    )
                  }
                >
                  {Array.from({ length: pathLen - 2 }, (_, i) => i + 1).map(
                    (i) => (
                      <option key={i} value={i}>
                        {i}
                      </option>
                    ),
                  )}
                </select>
              </label>
            </>
          ) : null}
          <div className="point-row">
            <button
              type="button"
              disabled={!canCapture}
              onClick={() => capture("seed")}
            >
              Set sac seed
            </button>
            <button
              type="button"
              disabled={!canCapture}
              onClick={() => capture("origin")}
            >
              Set neck origin
            </button>
            <button
              type="button"
              disabled={!canCapture || draft?.neck_origin === null}
              onClick={() => capture("normal")}
            >
              Set dome direction
            </button>
            <button
              type="button"
              disabled={!canCapture}
              onClick={addParentPoint}
            >
              Add parent point
            </button>
            <button
              type="button"
              disabled={locked || pathLen === 0}
              onClick={clearParentPath}
            >
              Clear parent path
            </button>
          </div>
          <div className="point-row">
            <button
              type="button"
              disabled={locked || !dirty}
              onClick={() => {
                setDraft(state.saved ? draftFromInputs(state.saved) : null);
                setNote("");
              }}
            >
              Discard geometry edits
            </button>
            <button type="button" disabled={!canSave} onClick={handleSave}>
              Save geometry inputs
            </button>
            <button
              type="button"
              disabled={!canCompute}
              onClick={handleCompute}
            >
              Compute mask geometry
            </button>
            <button
              type="button"
              disabled={!canPropose}
              onClick={handlePropose}
            >
              Propose centerline
            </button>
          </div>
          {proposalUsable && proposal ? (
            <div data-testid="centerline-proposal">
              <p className="field-label">
                Proposed parent path ({proposal.path.length} points,{" "}
                <span data-testid="proposal-length">
                  {proposal.length_mm.toFixed(2)} mm
                </span>
                ), proximal station{" "}
                <span data-testid="proposed-proximal-index">
                  {proposal.proximal_index}
                </span>{" "}
                and distal station{" "}
                <span data-testid="proposed-distal-index">
                  {proposal.distal_index}
                </span>
                . Confirm before it replaces the draft path.
              </p>
              <ol>
                {proposal.path.map((p, i) => (
                  <li key={i} data-testid="proposed-path-point">
                    {p.map(fmt).join(", ")}
                  </li>
                ))}
              </ol>
              <button type="button" disabled={locked} onClick={useProposedPath}>
                Use proposed parent path
              </button>
            </div>
          ) : null}
          {note ? (
            <p role="alert" className="field-label">
              {note}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
