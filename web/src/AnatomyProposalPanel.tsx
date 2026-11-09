import { useEffect, useRef, useState } from "react";

import { api, RevisionConflictError, WorkspaceRequestError } from "./api";
import {
  parseAnatomyProposal,
  type AnatomyProposalBinding,
  type AnatomyProposalEnvelope,
  type Vec3,
} from "./anatomyProposal";

export type AnatomyProposalPanelProps = {
  binding: AnatomyProposalBinding;
  eligible: boolean;
  disabled?: boolean;
  targetRas: Vec3 | null;
  onApply: (envelope: AnatomyProposalEnvelope) => void;
  onBusy?: (busy: boolean) => void;
  onConflict?: () => void;
};

const GENERIC_ERROR =
  "Anatomy proposal request failed. Check the connection and try again.";

function sanitizeError(error: unknown): string {
  if (error instanceof RevisionConflictError) return error.message;
  if (error instanceof WorkspaceRequestError) return error.message;
  if (
    error instanceof Error &&
    error.message.startsWith("Anatomy proposal rejected: ")
  ) {
    return error.message;
  }
  if (
    error instanceof Error &&
    error.message ===
      "The server response did not match the anatomy proposal contract."
  ) {
    return error.message;
  }
  return GENERIC_ERROR;
}

/**
 * Read-only anatomy geometry proposal panel. It only ever issues one
 * read-only POST (`/cases/:id/anatomy-proposal`) and hands the parsed
 * envelope to the parent via an explicit "Apply as editable draft"
 * button. It never saves, computes, or confirms geometry itself.
 */
export default function AnatomyProposalPanel({
  binding,
  eligible,
  disabled = false,
  targetRas,
  onApply,
  onBusy,
  onConflict,
}: AnatomyProposalPanelProps) {
  const [envelope, setEnvelope] = useState<AnatomyProposalEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [requesting, setRequesting] = useState(false);

  // Epoch invalidation: any change to source/eligibility/target identity
  // invalidates in-flight responses. The parent busy lock (disabled) is
  // deliberately NOT part of the epoch — our own onBusy(true) feedback
  // must never cancel our own request.
  const epochRef = useRef(0);
  const prevGateRef = useRef<string | null>(null);
  // The exact onBusy captured when the request started; released even if
  // props change or the component unmounts mid-flight.
  const busyOwnerRef = useRef<((busy: boolean) => void) | null>(null);
  useEffect(() => () => {
    epochRef.current += 1;
    const owner = busyOwnerRef.current;
    busyOwnerRef.current = null;
    owner?.(false);
  }, []);

  const gateKey = `${binding.case_id}|${binding.image_sha256}|${binding.artifact_version}|${binding.reference_revision}|${eligible}|${JSON.stringify(targetRas)}`;
  if (prevGateRef.current === null) {
    prevGateRef.current = gateKey;
  } else if (prevGateRef.current !== gateKey) {
    // Synchronous reset on gate change: hide stale proposal/error and
    // drop any conflict lock tied to the previous identity.
    prevGateRef.current = gateKey;
    epochRef.current += 1;
    setEnvelope(null);
    setError(null);
    setConflict(false);
  }

  const busy = requesting;
  const locked = !eligible || disabled || busy || conflict;

  function releaseBusy() {
    const owner = busyOwnerRef.current;
    busyOwnerRef.current = null;
    owner?.(false);
    setRequesting(false);
  }

  async function propose() {
    if (locked) return;
    const epoch = epochRef.current;
    const owner = onBusy ?? null;
    busyOwnerRef.current = owner;
    setRequesting(true);
    setEnvelope(null);
    setError(null);
    try {
      owner?.(true);
      const raw = await api<unknown>(
        `/cases/${encodeURIComponent(binding.case_id)}/anatomy-proposal`,
        {
          artifact_version: binding.artifact_version,
          reference_revision: binding.reference_revision,
          target_ras: targetRas,
        },
      );
      if (epochRef.current !== epoch) return; // superseded; drop late response
      let parsed: AnatomyProposalEnvelope;
      try {
        parsed = parseAnatomyProposal(raw, binding);
        if (parsed.proposal.diagnostics.target_component_selected !== (targetRas !== null)) {
          throw new Error("Contradictory target selection");
        }
      } catch {
        throw new Error(
          "The server response did not match the anatomy proposal contract.",
        );
      }
      setEnvelope(parsed);
      setError(null);
    } catch (err) {
      if (epochRef.current !== epoch) return;
      if (err instanceof RevisionConflictError) {
        setEnvelope(null);
        setError(null);
        setConflict(true);
        onConflict?.();
      } else {
        setError(sanitizeError(err));
      }
    } finally {
      releaseBusy();
    }
  }

  function clearProposal() {
    setEnvelope(null);
    setError(null);
    setConflict(false);
  }

  function apply() {
    if (!envelope || locked) return;
    // Hand off a clone; the parent draft must never alias panel state.
    onApply(structuredClone(envelope));
  }

  const showApply = envelope !== null && !disabled && eligible && !busy;

  return (
    <section aria-label="Anatomy proposal">
      <h3>Anatomy geometry proposal</h3>
      <p>
        Requests a source-backed geometry proposal from the accepted anatomy
        masks for the current target. Nothing is saved automatically.
      </p>
      <button
        type="button"
        onClick={() => void propose()}
        disabled={locked}
      >
        {busy ? "Requesting proposal…" : "Propose geometry from accepted anatomy"}
      </button>
      {(envelope !== null || busy) && (
        <div role="status">
          {envelope !== null && (
          <>
            Proposal ready. Review the diagnostics, then apply it as an
            editable draft.
            <dl>
              <dt>Proposal identity</dt>
              <dd>{envelope.proposal_id.slice(0, 12)}…</dd>
              <dt>Aneurysm component voxels</dt>
              <dd>{envelope.proposal.diagnostics.aneurysm_component_voxels}</dd>
              <dt>Interface voxels</dt>
              <dd>{envelope.proposal.diagnostics.interface_voxel_count}</dd>
              <dt>Neck plane RMS residual (mm)</dt>
              <dd>{envelope.proposal.diagnostics.neck_plane_rms_residual_mm}</dd>
              <dt>Parent path length (mm)</dt>
              <dd>{envelope.proposal.diagnostics.parent_length_mm}</dd>
            </dl>
          </>
        )}
          {busy && "Requesting proposal…"}
        </div>
      )}
      {error !== null && (
        <div role="alert">
          {error}
          <button type="button" onClick={clearProposal}>
            Clear proposal
          </button>
        </div>
      )}
      {conflict && (
        <div role="alert">
          The case changed while the proposal was requested. No writes
          occurred. Clear the proposal to continue.
          <button type="button" onClick={clearProposal}>
            Clear proposal
          </button>
        </div>
      )}
      {showApply && (
        <button type="button" onClick={apply}>
          Apply as editable draft
        </button>
      )}
    </section>
  );
}
