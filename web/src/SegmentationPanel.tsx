import { useEffect, useRef, useState } from "react";
import "./segmentation.css";
import { api, type CaseState } from "./api";
import type { CaseReference } from "./reference";
import type { Point3 } from "./geometry";
import type { SegmentationEntry } from "./segmentation";
type Props = {
  caseState: CaseState;
  reference: CaseReference | null;
  location: Point3 | null;
  windowRange: [number, number];
  disabled: boolean;
  onOverlay: (entry: SegmentationEntry | null) => void;
  onAccepted: (version: string) => void;
  onError: (error: unknown) => void;
};
export default function SegmentationPanel(props: Props) {
  const { caseState, reference, location, windowRange, disabled } = props;
  const callbacks = useRef(props);
  callbacks.current = props;
  const epoch = useRef(0);
  const [running, setRunning] = useState(false);
  const [candidate, setCandidate] = useState<SegmentationEntry | null>(null);
  const [current, setCurrent] = useState<SegmentationEntry[]>([]);
  const [visible, setVisible] = useState(true);
  const [radius, setRadius] = useState(12);
  function bound(entry: SegmentationEntry) {
    if (
      entry.case_id !== caseState.case_id ||
      entry.image_sha256 !== caseState.image_sha256 ||
      entry.reference_revision !== reference?.reference_revision
    )
      throw new Error(
        "Segmentation belongs to another image or reference revision.",
      );
    return entry;
  }
  useEffect(() => {
    const ticket = ++epoch.current;
    setCandidate(null);
    setCurrent([]);
    setRunning(false);
    setVisible(true);
    callbacks.current.onOverlay(null);
    if (reference) {
      api<{
        current: {
          vessel: SegmentationEntry | null;
          aneurysm: SegmentationEntry | null;
        };
      }>(`/cases/${caseState.case_id}/segmentations`)
        .then((result) => {
          if (epoch.current !== ticket) return;
          const entries = [result.current.vessel, result.current.aneurysm]
            .filter((v): v is SegmentationEntry => v !== null)
            .map(bound);
          setCurrent(entries);
          callbacks.current.onOverlay(entries[0] ?? null);
        })
        .catch((error) => {
          if (epoch.current === ticket) callbacks.current.onError(error);
        });
    }
    return () => {
      epoch.current++;
    };
  }, [
    caseState.case_id,
    caseState.image_sha256,
    caseState.artifact_version,
    reference?.reference_revision,
  ]);
  async function run(kind: "vessel" | "sam2") {
    if (!reference || disabled || running || (kind === "sam2" && !location))
      return;
    const ticket = epoch.current;
    setRunning(true);
    try {
      const entry = bound(
        await api<SegmentationEntry>(
          `/cases/${caseState.case_id}/segmentations`,
          {
            artifact_version: caseState.artifact_version,
            reference_revision: reference.reference_revision,
            kind,
            role: kind === "vessel" ? "vessel" : "aneurysm",
            ...(kind === "sam2"
              ? {
                  point_ras: location,
                  radius_voxels: radius,
                  display_window: windowRange,
                }
              : {}),
          },
        ),
      );
      if (epoch.current !== ticket) return;
      setCandidate(entry);
      setVisible(true);
      callbacks.current.onOverlay(entry);
    } catch (error) {
      if (epoch.current === ticket) callbacks.current.onError(error);
    } finally {
      if (epoch.current === ticket) setRunning(false);
    }
  }
  async function decide(decision: "accept" | "reject") {
    if (!candidate || !reference || disabled || running) return;
    const ticket = epoch.current;
    setRunning(true);
    try {
      const entry = bound(
        await api<SegmentationEntry>(
          `/cases/${caseState.case_id}/segmentations/${candidate.candidate_id}/decision`,
          {
            artifact_version: caseState.artifact_version,
            reference_revision: reference.reference_revision,
            decision,
          },
        ),
      );
      if (epoch.current !== ticket) return;
      setCandidate(null);
      if (decision === "accept") {
        setCurrent((prev) => [
          ...prev.filter((v) => v.role !== entry.role),
          entry,
        ]);
        callbacks.current.onOverlay(entry);
        if (!entry.artifact_version)
          throw new Error("Acceptance did not return the new case revision.");
        callbacks.current.onAccepted(entry.artifact_version);
      } else callbacks.current.onOverlay(current[0] ?? null);
    } catch (error) {
      if (epoch.current === ticket) callbacks.current.onError(error);
    } finally {
      if (epoch.current === ticket) setRunning(false);
    }
  }
  const locked = disabled || running || !reference;
  return (
    <section
      className="planning-section segmentation-panel"
      id="model-segmentation"
    >
      <h3>Model evidence</h3>
      {!reference ? (
        <p className="muted small">
          Local inference currently supports the installed original public CTA.
        </p>
      ) : (
        <>
          <div className="point-row">
            <button disabled={locked} onClick={() => run("vessel")}>
              Run vessel model
            </button>
            <button disabled={locked || !location} onClick={() => run("sam2")}>
              SAM at crosshair
            </button>
          </div>
          <label className="small">
            SAM region radius (native pixels)
            <input
              aria-label="SAM region radius"
              type="number"
              min={2}
              max={40}
              value={radius}
              disabled={locked}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= 2 && n <= 40) setRadius(n);
              }}
            />
          </label>
          <p className="method-note">
            Vessel: trained binary model, not aneurysm detection. SAM:
            operator-prompted native axial slice, not a 3D sac segmentation.
          </p>
          {running && (
            <p role="status">
              Running local inference… The vessel model may take about a minute.
            </p>
          )}
          {candidate && (
            <div className="segmentation-candidate">
              <strong>Unaccepted preview</strong>
              <p className="small">
                {candidate.producer === "owned_vessel"
                  ? "Trained vessel candidate"
                  : "SAM single-slice candidate"}
              </p>
              <div className="point-row">
                <button disabled={locked} onClick={() => decide("accept")}>
                  Accept candidate
                </button>
                <button disabled={locked} onClick={() => decide("reject")}>
                  Reject candidate
                </button>
              </div>
            </div>
          )}
          {current.map((entry) => (
            <button
              key={entry.candidate_id}
              disabled={running}
              onClick={() => {
                setVisible(true);
                callbacks.current.onOverlay(entry);
              }}
            >
              Show accepted {entry.role}
            </button>
          ))}
          {(candidate || current.length > 0) && (
            <label className="model-toggle small">
              <input
                type="checkbox"
                checked={visible}
                onChange={(e) => {
                  setVisible(e.target.checked);
                  callbacks.current.onOverlay(
                    e.target.checked ? (candidate ?? current[0] ?? null) : null,
                  );
                }}
              />{" "}
              Show model overlay
            </label>
          )}
        </>
      )}
    </section>
  );
}
