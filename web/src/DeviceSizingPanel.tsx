import { useEffect, useRef, useState } from "react";
import { api, type CaseState } from "./api";
import type { MorphometryBinding } from "./MorphometryInputs";
import DeviceSizingResults, { parseSizingReport } from "./DeviceSizingResults";

type Props = {
  caseState: CaseState;
  binding: MorphometryBinding | null;
  disabled?: boolean;
  onBusy?: (busy: boolean) => void;
  onCalculated?: () => void;
  onConflict?: () => void;
};
type Raw = Record<string, any>;
function requestFor(
  raw: unknown,
  caseState: CaseState,
  binding: MorphometryBinding | null,
) {
  const parsed = parseSizingReport(raw, caseState, binding);
  if (
    !parsed ||
    parsed.geometry_status !== "current" ||
    parsed.inputs_status !== "current"
  )
    return null;
  const r = raw as Raw;
  return {
    artifact_version: r.artifact_version,
    reference_revision: r.reference_revision,
    geometry_result_id: r.geometry_result_id,
    input_revision: r.inputs.input_revision,
    inputs_sha256: r.inputs.inputs_sha256,
    catalog_version: r.catalog_version,
    calculation_version: r.calculation_version,
  };
}
export default function DeviceSizingPanel({
  caseState,
  binding,
  disabled = false,
  onBusy,
  onCalculated,
  onConflict,
}: Props) {
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
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const epoch = useRef(0);
  const callbacks = useRef({ onBusy, onCalculated, onConflict });
  callbacks.current = { onBusy, onCalculated, onConflict };
  const [state, setState] = useState<{
    scope: string | null;
    raw: unknown;
    phase: string;
    error: string;
  }>({ scope: null, raw: null, phase: "idle", error: "" });
  const [calculating, setCalculating] = useState(false),
    [lockedScope, setLockedScope] = useState<string | null>(null),
    [readTrigger, setReadTrigger] = useState(0);
  useEffect(() => {
    epoch.current++;
    setCalculating(false);
    return () => {
      epoch.current++;
    };
  }, [scope]);
  // Read cancellation may follow disabled feedback; mutation identity never does.
  useEffect(() => {
    if (!scope || disabled) return;
    let canceled = false;
    setState({ scope, raw: null, phase: "loading", error: "" });
    api<unknown>(
      `/cases/${encodeURIComponent(caseState.case_id)}/device-sizing`,
    )
      .then((raw) => {
        if (canceled || scopeRef.current !== scope) return;
        if (!parseSizingReport(raw, caseState, binding))
          throw Error("Mismatched sizing report");
        setState({ scope, raw, phase: "ready", error: "" });
      })
      .catch(() => {
        if (!canceled && scopeRef.current === scope)
          setState({
            scope,
            raw: null,
            phase: "error",
            error:
              "Saved sizing report is unavailable. Reload calculation to retry the read.",
          });
      });
    return () => {
      canceled = true;
    };
  }, [scope, disabled, readTrigger]);
  const matches = Boolean(scope && state.scope === scope),
    locked = Boolean(scope && lockedScope === scope);
  const body =
    matches && state.phase === "ready"
      ? requestFor(state.raw, caseState, binding)
      : null;
  async function calculate() {
    if (!scope || !body || disabled || calculating || locked) return;
    const ownEpoch = epoch.current,
      busyOwner = callbacks.current.onBusy;
    const oldId = (state.raw as Raw).current.result_id;
    setCalculating(true);
    busyOwner?.(true);
    try {
      const raw = await api<unknown>(
        `/cases/${encodeURIComponent(caseState.case_id)}/device-sizing`,
        body,
      );
      if (epoch.current !== ownEpoch || scopeRef.current !== scope) return;
      const parsed = parseSizingReport(raw, caseState, binding),
        r = raw as Raw;
      if (
        !parsed ||
        r.current.status !== "current" ||
        r.current.result_id === oldId ||
        JSON.stringify(requestFor(raw, caseState, binding)) !==
          JSON.stringify(body)
      )
        throw Error("Unconfirmed calculation");
      setState({ scope, raw, phase: "ready", error: "" });
      callbacks.current.onCalculated?.();
    } catch {
      if (epoch.current !== ownEpoch || scopeRef.current !== scope) return;
      setLockedScope(scope);
      setState({
        scope,
        raw: null,
        phase: "error",
        error:
          "Calculation could not be confirmed. Reload saved state before retrying.",
      });
      callbacks.current.onConflict?.();
    } finally {
      if (epoch.current === ownEpoch && scopeRef.current === scope)
        setCalculating(false);
      busyOwner?.(false);
    }
  }
  return (
    <section className="device-sizing-panel">
      <button
        type="button"
        onClick={calculate}
        disabled={!body || disabled || calculating || locked}
      >
        Calculate saved inputs
      </button>
      {!locked && (
        <button
          type="button"
          onClick={() => setReadTrigger((n) => n + 1)}
          disabled={disabled || calculating}
        >
          Reload calculation
        </button>
      )}
      {matches && state.error && <p role="alert">{state.error}</p>}
      {locked && (
        <p>Calculation is locked until the case is explicitly reloaded.</p>
      )}
      <DeviceSizingResults
        caseState={caseState}
        binding={binding}
        report={
          matches && state.phase === "ready" && !locked ? state.raw : null
        }
        disabled={disabled || calculating}
      />
    </section>
  );
}
