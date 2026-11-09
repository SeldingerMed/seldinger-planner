// Source-bound controlled saved-scenario sync panel. Rows are owned by the
// parent; this component performs the authoritative GET/PUT round trips,
// echoes loaded rows back as independent clones, snapshots a baseline for
// dirty comparison, and locks repeat writes on conflict or ambiguous
// acknowledgements until an explicit reload. It never persists locally and
// infers no clinical validity.
import { useEffect, useRef, useState } from "react";

import { api, RevisionConflictError, WorkspaceRequestError } from "./api";
import {
  parseDeviceScenarios,
  type DeviceScenarioBinding,
  type DeviceScenarioEntry,
} from "./deviceScenarios";

export type DeviceScenarioSyncProps = {
  binding: DeviceScenarioBinding;
  eligible: boolean;
  disabled?: boolean;
  rows: DeviceScenarioEntry[];
  onRowsChange: (rows: DeviceScenarioEntry[]) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onReadyChange?: (ready: boolean) => void;
  onBusy?: (busy: boolean) => void;
  onConflict?: () => void;
};

type LockReason = "read" | "ambiguous" | "failed" | null;

type SyncState = {
  key: string;
  loading: boolean;
  /** Known authoritative scenario revision; null until a read succeeds. */
  revision: number | null;
  /** JSON baseline of the last authoritative scenario rows ([] for a fresh draft). */
  baseline: string | null;
  /** Last confirmed saved rows, retained only as an edit-comparison baseline. */
  savedBaseline: string | null;
  lock: LockReason;
  status: string | null;
  error: string | null;
};

function bindingKey(binding: DeviceScenarioBinding): string {
  return JSON.stringify([
    binding.case_id, binding.image_sha256, binding.artifact_version,
    binding.reference_revision, binding.geometry_result_id, binding.catalog_version,
  ]);
}

function rowsJson(rows: DeviceScenarioEntry[]): string {
  return JSON.stringify(rows, (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
}

function cloneRows(rows: DeviceScenarioEntry[]): DeviceScenarioEntry[] {
  return JSON.parse(JSON.stringify(rows)) as DeviceScenarioEntry[];
}

function initialState(key: string): SyncState {
  return {
    key,
    loading: false,
    revision: null,
    baseline: null,
    savedBaseline: null,
    lock: null,
    status: null,
    error: null,
  };
}

const READ_ERROR =
  "The saved scenario set could not be read. Reload to review it before editing.";
const AMBIGUOUS_ERROR =
  "The save result was not confirmed. Reload to review the saved scenario set before writing again.";
const FAILED_ERROR =
  "The save request failed. Reload to review the saved scenario set before writing again.";

export default function DeviceScenarioSync({
  binding,
  eligible,
  disabled = false,
  rows,
  onRowsChange,
  onDirtyChange,
  onReadyChange,
  onBusy,
  onConflict,
}: DeviceScenarioSyncProps) {
  // Synchronous epoch reset on any binding or genuine eligibility change:
  // stale counts, status, and errors are hidden from the very next render.
  const epochRef = useRef(0);
  const gateRef = useRef<string | null>(null);
  const [sync, setSync] = useState<SyncState>(() => initialState(""));
  const [requesting, setRequesting] = useState(false);

  const gateKey = `${bindingKey(binding)}|${eligible}`;
  if (gateRef.current === null) {
    gateRef.current = gateKey;
  } else if (gateRef.current !== gateKey) {
    gateRef.current = gateKey;
    epochRef.current += 1;
    setSync(initialState(gateKey));
    setRequesting(false);
  }

  // The exact onBusy captured when a request started; released exactly
  // once even when the epoch changes or the component unmounts mid-flight.
  const busyReleaseRef = useRef<(() => void) | null>(null);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // Keep the latest parent callbacks so the mount-time read effect and
  // late responses never invoke a stale closure.
  const echoRef = useRef(onRowsChange);
  echoRef.current = onRowsChange;
  const dirtyCbRef = useRef(onDirtyChange);
  dirtyCbRef.current = onDirtyChange;
  const busyCbRef = useRef(onBusy);
  busyCbRef.current = onBusy;
  const conflictCbRef = useRef(onConflict);
  conflictCbRef.current = onConflict;

  const readyCallback = useRef(onReadyChange);
  readyCallback.current = onReadyChange;
  const ready = eligible && !requesting && sync.lock === null && sync.revision !== null;
  useEffect(() => { readyCallback.current?.(ready); }, [ready]);
  useEffect(() => {
    const owner = readyCallback.current;
    return () => owner?.(false);
  }, []);

  const dirty = sync.baseline !== null && rowsJson(rows) !== sync.baseline;
  const prevDirtyRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (dirtyCbRef.current && prevDirtyRef.current !== dirty) {
      prevDirtyRef.current = dirty;
      dirtyCbRef.current(dirty);
    }
  }, [dirty]);

  const readRef = useRef<(kind: "initial" | "reload") => void>(() => {});
  readRef.current = runRead;

  // One authoritative GET per binding/eligibility epoch; none if ineligible.
  useEffect(() => {
    if (eligible) readRef.current("initial");
    return () => releaseBusy();
  }, [gateKey]);

  useEffect(() => () => {
    epochRef.current += 1;
    releaseBusy();
  }, []);

  const patch = (changes: Partial<SyncState>) =>
    setSync((prev) => ({ ...prev, ...changes }));

  function releaseBusy() { busyReleaseRef.current?.(); }

  function ownBusy() {
    const owner = busyCbRef.current;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      owner?.(false);
      if (busyReleaseRef.current === release) {
        busyReleaseRef.current = null;
        setRequesting(false);
      }
    };
    busyReleaseRef.current = release;
    setRequesting(true);
    owner?.(true);
    return release;
  }

  // Authoritative read: echoes saved rows (independent clones) back to the
  // parent, snapshots the baseline, and keeps the opaque revision. On any
  // failure the whole panel locks until an explicit reload.
  async function runRead(kind: "initial" | "reload") {
    if (!eligible || requesting || busyReleaseRef.current) return;
    const epoch = epochRef.current;
    const release = ownBusy();
    patch(kind === "reload" ? { loading: true, error: null } : { error: null });
    try {
      const raw = await api<unknown>(
        `/cases/${encodeURIComponent(binding.case_id)}/device-scenarios`,
      );
      if (epochRef.current !== epoch) return; // superseded by a newer source
      const envelope = parseDeviceScenarios(raw, binding);
      const base: Partial<SyncState> = {
        loading: false,
        revision: envelope.scenario_revision,
        lock: null,
        error: null,
      };
      if (envelope.current.status === "current") {
        const saved = cloneRows(envelope.current.scenarios);
        base.baseline = rowsJson(saved);
        base.savedBaseline = base.baseline;
        base.status = `Saved revision ${envelope.scenario_revision}: ${saved.length} scenario(s).`;
        // Independent clone: the parent draft must never alias panel state.
        echoRef.current(saved);
      } else if (envelope.current.status === "not_computed") {
        // No saved set yet: keep any editable fresh draft, empty baseline.
        base.baseline = "[]";
        base.savedBaseline = null;
        base.status = "No saved scenario set yet. Your draft can be saved as revision 1.";
      } else {
        // Keep the last confirmed rows only for dirty comparison, never as
        // current saved evidence. Reading staleness alone is not an edit.
        base.baseline = sync.savedBaseline ?? "[]";
        base.status = `Saved set is stale (${envelope.current.stale_reasons[0]}). Review and save to replace it as revision ${envelope.scenario_revision + 1}.`;
      }
      patch(base);
    } catch {
      if (epochRef.current !== epoch) return;
      patch({
        loading: false,
        revision: null,
        baseline: null,
        lock: "read",
        status: null,
        error: READ_ERROR,
      });
      conflictCbRef.current?.();
    } finally {
      release();
    }
  }

  // Explicit confirmation write. The full acknowledgement envelope is
  // parsed and verified against the exact sent snapshot before anything
  // is reported as saved. Any mismatch is ambiguous: lock until reload,
  // never claiming rollback.
  async function save() {
    if (!eligible || requesting || busyReleaseRef.current || disabled || sync.lock !== null || sync.revision === null)
      return;
    const epoch = epochRef.current;
    const sentRevision = sync.revision;
    const sentRows = cloneRows(rowsRef.current);
    const sentJson = rowsJson(sentRows);
    const body = {
      image_sha256: binding.image_sha256,
      artifact_version: binding.artifact_version,
      reference_revision: binding.reference_revision,
      geometry_result_id: binding.geometry_result_id,
      catalog_version: binding.catalog_version,
      confirmed: true as const,
      scenario_revision: sentRevision,
      scenarios: sentRows,
    };
    const release = ownBusy();
    try {
      const raw = await api<unknown>(
        `/cases/${encodeURIComponent(binding.case_id)}/device-scenarios`,
        body,
        "PUT",
      );
      if (epochRef.current !== epoch) return; // superseded source; drop ack
      let ackRevision: number;
      let ackRows: string;
      try {
        const envelope = parseDeviceScenarios(raw, binding);
        if (envelope.current.status !== "current") {
          throw new Error("ack not current");
        }
        ackRevision = envelope.scenario_revision;
        ackRows = rowsJson(envelope.current.scenarios);
      } catch {
        throw new Error("ambiguous");
      }
      if (ackRevision !== sentRevision + 1 || ackRows !== sentJson) {
        throw new Error("ambiguous");
      }
      const base: Partial<SyncState> = {
        revision: ackRevision,
        savedBaseline: ackRows,
        lock: null,
        error: null,
        status: `Saved revision ${ackRevision}: ${sentRows.length} scenario(s).`,
      };
      if (ackRows === rowsJson(rowsRef.current)) {
        base.baseline = sentJson;
      } else {
        // Newer parent edits landed while the PUT was in flight: adopt the
        // server baseline without overwriting those newer rows, and never
        // pretend the newer draft was saved.
        base.baseline = ackRows;
        base.status += " Newer unsaved edits are kept.";
      }
      patch(base);
    } catch (error) {
      if (epochRef.current !== epoch) return;
      if (error instanceof RevisionConflictError || (error instanceof Error && error.message === "ambiguous")) {
        patch({ lock: "ambiguous", status: null, error: AMBIGUOUS_ERROR });
        conflictCbRef.current?.();
      } else if (
        error instanceof WorkspaceRequestError &&
        (error.status === 413 || error.status === 422)
      ) {
        // Definitive rejection before persistence: the draft is preserved
        // so it can be corrected and retried.
        patch({ error: error.message });
      } else {
        patch({ lock: "failed", status: null, error: FAILED_ERROR });
      }
    } finally {
      release();
    }
  }

  if (!eligible) return null;

  const locked = requesting || disabled || sync.lock !== null || sync.revision === null;

  return (
    <section aria-label="Saved scenario set">
      <p>
        {rows.length} scenario(s) in this draft
        {sync.revision === null ? "" : `, saved revision ${sync.revision}`}
      </p>
      <p role="status">{sync.error === null ? (sync.status ?? "") : ""}</p>
      <p role="alert">{sync.error ?? ""}</p>
      <button type="button" onClick={save} disabled={locked}>
        Save scenario set
      </button>
      <button
        type="button"
        onClick={() => runRead("reload")}
        disabled={requesting || disabled}
      >
        Reload saved scenarios
      </button>
    </section>
  );
}
