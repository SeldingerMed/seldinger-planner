import { lazy, Suspense, useCallback, useState, useRef } from "react";
import {
  api,
  restoreOrCreateCase,
  RevisionConflictError,
  type CaseState,
} from "./api";
import AneurysmWorksheet from "./AneurysmWorksheet";
import SegmentationPanel from "./SegmentationPanel";
import MorphometryResults from "./MorphometryResults";
import MorphometryInputs from "./MorphometryInputs";
import DeviceReference from "./DeviceReference";
import DeviceSizingInputs from "./DeviceSizingInputs";
import DeviceSizingPanel from "./DeviceSizingPanel";
import type { SegmentationEntry } from "./segmentation";
import type { AneurysmPlan } from "./planning";
import type { Point3 } from "./geometry";
import type { VolumeInfo, NativeVolume } from "./Viewer";
import {
  loadCalibratedVolume,
  findCaseImageSource,
  type CalibratedSourceMetadata,
  type CaseImageSource,
} from "./calibratedSource";
import {
  findCaseReference,
  loadReferenceVolume,
  type CaseReference,
  type ReferenceMetadata,
} from "./reference";
const Viewer = lazy(() => import("./Viewer"));
const coordinate = (p: Point3 | null) =>
  p ? p.map((v) => v.toFixed(1)).join(" / ") : "Select a location in the scan";
export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [nativeVolume, setNativeVolume] = useState<NativeVolume | null>(null);
  const [digest, setDigest] = useState("");
  const [caseState, setCase] = useState<CaseState | null>(null);
  const [segmentation, setSegmentation] = useState<SegmentationEntry | null>(
    null,
  );
  const activeIdentity = useRef("");
  activeIdentity.current = caseState
    ? `${caseState.case_id}:${caseState.image_sha256}`
    : "";
  const [mode, setMode] = useState("linked");
  const [windowRange, setWindow] = useState<[number, number]>([0, 600]);
  const [location, setLocation] = useState<Point3 | null>(null);
  const [focus, setFocus] = useState<Point3 | null>(null);
  const [pointA, setA] = useState<Point3 | null>(null);
  const [pointB, setB] = useState<Point3 | null>(null);
  const [label, setLabel] = useState("Point-to-point distance");
  const [notes, setNotes] = useState("");
  const [planDirty, setPlanDirty] = useState(false);
  const [geometryInputsDirty, setGeometryDirty] = useState(false);
  const [deviceDirty, setDeviceDirty] = useState(false);
  const [deviceEpoch, setDeviceEpoch] = useState(0);
  const geometryDirty = geometryInputsDirty || deviceDirty;
  const [geometryEpoch, setGeometryEpoch] = useState(0);
  const [source, setSource] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [workspaceBusy, setBusy] = useState(false);
  const [geometryBusy, setGeometryBusy] = useState(false);
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [deviceCalculationBusy, setDeviceCalculationBusy] = useState(false);
  const busy =
    workspaceBusy || geometryBusy || deviceBusy || deviceCalculationBusy;
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [reloadEpoch, setReloadEpoch] = useState(0);
  const [requestedReference, setRequestedReference] =
    useState<ReferenceMetadata | null>(null);
  const [reference, setReference] = useState<CaseReference | null>(null);
  const [requestedCalibrated, setRequestedCalibrated] =
    useState<CalibratedSourceMetadata | null>(null);
  const [calibratedSource, setCalibratedSource] =
    useState<CaseImageSource | null>(null);
  const [showReference, setShowReference] = useState(true);
  const [referenceStatus, setReferenceStatus] = useState<
    "off" | "loading" | "ready" | "error"
  >("off");
  const [question, setQuestion] = useState(
    "Summarize the measured anatomy, distinguish what remains unknown, and list the information needed to compare treatment options.",
  );
  const [answer, setAnswer] = useState<{
    answer: string;
    tool_names: string[];
    artifact_version: string;
    sources?: {
      id: string;
      title: string;
      url: string;
      population: string;
      section: string;
    }[];
  } | null>(null);
  const planEdited = useCallback((dirty: boolean) => {
    setPlanDirty(dirty);
    if (dirty) setAnswer(null);
  }, []);
  const geometryEdited = useCallback((dirty: boolean) => {
    setGeometryDirty(dirty);
    if (dirty) {
      setAnswer(null);
      setConfirmed(false);
    }
  }, []);
  const deviceEdited = useCallback((dirty: boolean) => {
    setDeviceDirty(dirty);
    if (dirty) {
      setAnswer(null);
      setConfirmed(false);
    }
  }, []);
  function failVolume(message: string) {
    setNativeVolume(null);
    setSegmentation(null);
    setReference(null);
    setRequestedReference(null);
    setRequestedCalibrated(null);
    setCalibratedSource(null);
    setConflict(false);
    setPlanDirty(false);
    setGeometryDirty(false);
    setDeviceDirty(false);
    setFile(null);
    setDigest("");
    setCase(null);
    setNotes("");
    setA(null);
    setB(null);
    setLocation(null);
    setFocus(null);
    setConfirmed(false);
    setAnswer(null);
    setSource("");
    setBusy(false);
    setError(message);
  }
  async function acceptFile(
    next: File,
    sourceURL = caseState ? "" : source,
    requested: ReferenceMetadata | null = null,
    calibrated: CalibratedSourceMetadata | null = null,
  ) {
    if (!/\.nii(\.gz)?$/i.test(next.name) || next.size > 200 * 1024 * 1024) {
      setError("Choose a NIfTI .nii or .nii.gz file smaller than 200 MB.");
      return;
    }
    setBusy(true);
    setError("");
    setCase(null);
    setNativeVolume(null);
    setSegmentation(null);
    setA(null);
    setB(null);
    setLocation(null);
    setFocus(null);
    setConfirmed(false);
    setSource(sourceURL);
    setReference(null);
    setRequestedReference(requested);
    setRequestedCalibrated(calibrated);
    setCalibratedSource(null);
    setShowReference(true);
    setReferenceStatus("off");
    setMode("linked");
    setAnswer(null);
    setNotes("");
    setPlanDirty(false);
    setGeometryDirty(false);
    setDeviceDirty(false);
    setConflict(false);
    try {
      const bytes = await crypto.subtle.digest(
        "SHA-256",
        await next.arrayBuffer(),
      );
      setDigest(
        Array.from(new Uint8Array(bytes))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(""),
      );
      setFile(next);
    } catch {
      failVolume("Could not read the selected volume.");
    }
  }
  async function loaded(info: VolumeInfo) {
    try {
      const matchesCalibrated = (
        geometry: Pick<
          CaseState,
          "dimensions" | "spacing_mm" | "spatial_units"
        >,
      ) =>
        !requestedCalibrated ||
        (geometry.spatial_units === "mm" &&
          geometry.dimensions.length === 3 &&
          geometry.spacing_mm.length === 3 &&
          geometry.dimensions.every(
            (v, i) => v === requestedCalibrated.dimensions[i],
          ) &&
          geometry.spacing_mm.every(
            (v, i) =>
              Number.isFinite(v) &&
              Math.abs(v - requestedCalibrated.spacing_mm[i]) < 1e-6,
          ));
      if (!matchesCalibrated(info))
        throw new Error(
          "Loaded geometry does not match the calibrated source.",
        );
      const result = await restoreOrCreateCase({
        title:
          requestedCalibrated?.case_label ||
          requestedReference?.case_label ||
          file?.name.replace(/\.nii(\.gz)?$/i, "").slice(0, 100) ||
          "CTA workspace",
        image_sha256: digest,
        source_url: source || null,
        ...info,
      });
      if (requestedReference && result.spatial_units !== "unknown")
        throw new Error(
          "Saved reference unit declaration does not match the source.",
        );
      if (requestedCalibrated) {
        if (!matchesCalibrated(result))
          throw new Error(
            "Saved case geometry does not match the calibrated source.",
          );
        const verified = await findCaseImageSource(result.case_id, digest);
        if (
          !verified ||
          verified.reference_revision !== requestedCalibrated.reference_revision
        )
          throw new Error(
            "Calibrated source revision could not be verified for this case.",
          );
        setCalibratedSource(verified);
      }
      setCase(result);
      setNotes(result.notes);
      setSource(result.source_url || "");
      if (requestedReference) {
        const verified = await findCaseReference(result.case_id, digest);
        setReference(verified);
        if (verified) setFocus([...verified.focus_ras]);
      }
    } catch (e) {
      reportRequestError(e);
    } finally {
      setBusy(false);
    }
  }
  async function segmentationAccepted(version: string) {
    if (!caseState) return;
    const selected = caseState;
    const identity = `${selected.case_id}:${selected.image_sha256}`;
    try {
      const latest = await api<CaseState>(`/cases/${selected.case_id}`);
      if (activeIdentity.current !== identity) return;
      if (
        latest.case_id !== selected.case_id ||
        latest.image_sha256 !== selected.image_sha256 ||
        latest.artifact_version !== version
      )
        throw new RevisionConflictError();
      setCase(latest);
      setConfirmed(false);
      setAnswer(null);
      setA(null);
      setB(null);
    } catch (error) {
      if (activeIdentity.current === identity) reportRequestError(error);
    }
  }
  function reportRequestError(e: unknown) {
    setError(e instanceof Error ? e.message : "Workspace request failed.");
    if (e instanceof RevisionConflictError) {
      setConflict(true);
      setAnswer(null);
    }
  }
  async function reloadSavedCase() {
    if (!caseState || busy) return;
    setBusy(true);
    setError("");
    try {
      const latest = await api<CaseState>(`/cases/${caseState.case_id}`);
      if (
        latest.case_id !== caseState.case_id ||
        latest.image_sha256 !== digest
      )
        throw new Error("Saved case identity does not match the loaded image.");
      setCase(latest);
      setNotes(latest.notes);
      if (requestedReference)
        setReference(await findCaseReference(latest.case_id, digest));
      if (requestedCalibrated) {
        const verified = await findCaseImageSource(latest.case_id, digest);
        if (
          !verified ||
          verified.reference_revision !== requestedCalibrated.reference_revision
        )
          throw new Error("Calibrated source revision changed.");
        setCalibratedSource(verified);
      }
      setReloadEpoch((value) => value + 1);
      setA(null);
      setB(null);
      setFocus(null);
      setPlanDirty(false);
      setGeometryDirty(false);
      setDeviceDirty(false);
      setConfirmed(false);
      setAnswer(null);
      setConflict(false);
    } catch (e) {
      reportRequestError(e);
    } finally {
      setBusy(false);
    }
  }
  async function openReference() {
    setBusy(true);
    setError("");
    try {
      const loaded = await loadReferenceVolume();
      await acceptFile(
        loaded.file,
        loaded.metadata.source_url,
        loaded.metadata,
      );
    } catch (e) {
      reportRequestError(e);
      setBusy(false);
    }
  }
  async function openCalibrated() {
    setBusy(true);
    setError("");
    try {
      const loaded = await loadCalibratedVolume(
        "zenodo-case006-planning-context",
      );
      await acceptFile(
        loaded.file,
        loaded.metadata.source_url,
        null,
        loaded.metadata,
      );
    } catch (error) {
      reportRequestError(error);
      setBusy(false);
    }
  }
  async function saveMeasurement() {
    if (
      !caseState ||
      geometryDirty ||
      busy ||
      conflict ||
      caseState.spatial_units !== "mm" ||
      !pointA ||
      !pointB
    )
      return;
    setBusy(true);
    setError("");
    try {
      setCase(
        await api<CaseState>(`/cases/${caseState.case_id}/measurements`, {
          artifact_version: caseState.artifact_version,
          label,
          point_a_mm: pointA,
          point_b_mm: pointB,
        }),
      );
      setA(null);
      setB(null);
      setAnswer(null);
    } catch (e) {
      reportRequestError(e);
    } finally {
      setBusy(false);
    }
  }
  async function saveNotes() {
    if (!caseState || conflict || geometryDirty || busy) return;
    setBusy(true);
    setError("");
    try {
      setCase(
        await api<CaseState>(
          `/cases/${caseState.case_id}/notes`,
          { artifact_version: caseState.artifact_version, notes },
          "PATCH",
        ),
      );
      setAnswer(null);
    } catch (e) {
      reportRequestError(e);
    } finally {
      setBusy(false);
    }
  }
  async function saveAneurysmPlan(plan: AneurysmPlan) {
    if (!caseState || conflict || geometryDirty || busy) return;
    setBusy(true);
    setError("");
    try {
      setCase(
        await api<CaseState>(
          `/cases/${caseState.case_id}/aneurysm-plan`,
          {
            artifact_version: caseState.artifact_version,
            plan,
          },
          "PATCH",
        ),
      );
      setAnswer(null);
    } catch (e) {
      reportRequestError(e);
    } finally {
      setBusy(false);
    }
  }
  async function askMuse() {
    if (
      !caseState ||
      conflict ||
      !confirmed ||
      planDirty ||
      geometryDirty ||
      busy ||
      notes !== caseState.notes
    )
      return;
    setBusy(true);
    setError("");
    try {
      setAnswer(
        await api(`/cases/${caseState.case_id}/agent`, {
          artifact_version: caseState.artifact_version,
          question,
          public_data_confirmed: confirmed,
        }),
      );
    } catch (e) {
      reportRequestError(e);
    } finally {
      setBusy(false);
    }
  }
  async function publicSample() {
    setBusy(true);
    setError("");
    try {
      const meta = await api<{ source_url: string; filename: string }>(
        "/sample",
      );
      const response = await fetch("/api/sample-volume");
      if (!response.ok) throw new Error();
      await acceptFile(
        new File([await response.blob()], meta.filename),
        meta.source_url,
      );
    } catch {
      setBusy(false);
      setError(
        "Public sample is not installed. Open an authorized local NIfTI volume instead.",
      );
    }
  }
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-mark">
          S<span>/</span>
        </div>
        <div className="brand">
          <h1>Seldinger Planner</h1>
          <span>NEUROVASCULAR WORKSPACE</span>
        </div>
        <span className="build-tag">RESEARCH BUILD / 01</span>
        <div className="top-actions">
          <button onClick={openCalibrated} disabled={busy || geometryDirty}>
            Open calibrated CTA
          </button>
          <button onClick={openReference} disabled={busy || geometryDirty}>
            Open reference CTA
          </button>
          <button onClick={publicSample} disabled={busy || geometryDirty}>
            Open public CTA
          </button>
          <label className="file-button">
            Open volume
            <input
              aria-label="Open CTA volume"
              type="file"
              accept=".nii,.nii.gz"
              disabled={busy || geometryDirty}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void acceptFile(f);
              }}
            />
          </label>
        </div>
      </header>
      <div className="workspace-grid">
        <aside className="case-rail">
          <div className="eyebrow">01 / CASE</div>
          <h2>{caseState?.title || "A new perspective"}</h2>
          <p className="muted">
            CTA-first planning. Image-linked evidence. One coherent workspace.
          </p>
          <div className="case-meta">
            <span className="status-dot" />
            {caseState
              ? "Workspace connected"
              : busy
                ? "Opening volume"
                : "Local workspace"}
          </div>
          <label className="field-label">
            Public source URL
            <input
              aria-label="Public source URL"
              value={source}
              type="url"
              placeholder="https://original-dataset.org/case"
              disabled={!!caseState || busy}
              onChange={(e) => setSource(e.target.value)}
            />
          </label>
          {calibratedSource && (
            <section className="reference-card">
              <strong>Calibrated public CTA context</strong>
              <small>DICOM-derived mm geometry · image only</small>
              <small>
                Reference-informed crop; annotation registration remains
                unvalidated.
              </small>
            </section>
          )}
          {reference && (
            <section className="reference-card">
              <strong>Curated dataset reference</strong>
              <small>Candidate alignment · source units unspecified</small>
              <small className="reference-legend">
                Coral: aneurysm · Teal: artery + aneurysm
              </small>
              <label>
                <input
                  type="checkbox"
                  aria-label="Show curated references"
                  checked={showReference}
                  onChange={(e) => {
                    setShowReference(e.target.checked);
                    if (!e.target.checked && mode === "reference")
                      setMode("volume");
                  }}
                />
                Show references
              </label>
              <button
                onClick={() => setFocus([...reference.focus_ras])}
                disabled={busy}
              >
                Focus reference target
              </button>
              <small aria-live="polite">References {referenceStatus}</small>
            </section>
          )}
          {caseState && (
            <dl>
              <dt>Image grid</dt>
              <dd>{caseState.dimensions.join(" × ")}</dd>
              <dt>Voxel spacing</dt>
              <dd>
                {caseState.spacing_mm.map((v) => v.toFixed(3)).join(" × ")}{" "}
                {caseState.spatial_units === "mm"
                  ? "mm"
                  : "(units unspecified)"}
              </dd>
              <dt>Workspace revision</dt>
              <dd>v{caseState.artifact_version}</dd>
              <dt>Image fingerprint</dt>
              <dd className="mono">{caseState.image_sha256.slice(0, 16)}…</dd>
            </dl>
          )}
          <div className="section-rule" />
          <div className="eyebrow">DISPLAY</div>
          <div className="preset-stack">
            {[
              ["CTA", "0", "600"],
              ["Soft tissue", "0", "100"],
              ["Bone", "200", "1800"],
            ].map(([name, min, max]) => (
              <button
                key={name}
                className={
                  windowRange[0] === +min && windowRange[1] === +max
                    ? "selected"
                    : ""
                }
                onClick={() => setWindow([+min, +max])}
              >
                {name}
                <span>
                  {min}–{max}
                </span>
              </button>
            ))}
          </div>
          {source === "https://doi.org/10.6084/m9.figshare.26965450.v1" && (
            <p className="method-note">
              Source: Song et al., CMHA (2024).{" "}
              <a
                href="https://creativecommons.org/licenses/by/4.0/"
                target="_blank"
                rel="noreferrer"
              >
                CC BY 4.0
              </a>
              . Public sample is a source-intensity-preserving crop.
            </p>
          )}
          <div className="rail-note">
            Volumes render in this browser. Local inference reads the installed
            public source. Muse receives planning metadata, not images.
          </div>
        </aside>
        <section className="imaging-panel">
          <div className="imaging-toolbar">
            <div>
              <span className="eyebrow">02 / ANATOMY</span>
              <span className="scan-label">
                {file?.name || "No volume loaded"}
              </span>
            </div>
            <nav aria-label="Viewer layout">
              {reference && (
                <button
                  className={mode === "reference" ? "active" : ""}
                  onClick={() => setMode("reference")}
                  disabled={!showReference || referenceStatus !== "ready"}
                >
                  Reference 3D
                </button>
              )}
              {[
                ["linked", "Linked"],
                ["axial", "Axial"],
                ["coronal", "Coronal"],
                ["sagittal", "Sagittal"],
                ["volume", "3D"],
              ].map(([id, name]) => (
                <button
                  key={id}
                  className={mode === id ? "active" : ""}
                  onClick={() => setMode(id)}
                >
                  {name}
                </button>
              ))}
            </nav>
          </div>
          {error && (
            <div className="error-banner" role="alert">
              {error}
              {conflict && (
                <button onClick={reloadSavedCase} disabled={busy}>
                  Reload saved state (discard edits)
                </button>
              )}
            </div>
          )}
          <div className="canvas-wrap">
            {file ? (
              <Suspense
                fallback={
                  <div className="empty-view">Preparing imaging engine…</div>
                }
              >
                <Viewer
                  key={digest}
                  file={file}
                  mode={mode}
                  windowRange={windowRange}
                  focus={focus}
                  onLocation={setLocation}
                  onLoaded={loaded}
                  onNativeVolume={setNativeVolume}
                  onError={failVolume}
                  reference={showReference ? reference : null}
                  segmentation={segmentation}
                  segmentationBinding={
                    caseState && (calibratedSource || reference)
                      ? {
                          case_id: caseState.case_id,
                          image_sha256: caseState.image_sha256,
                          reference_revision: (calibratedSource || reference)!
                            .reference_revision,
                        }
                      : null
                  }
                  onSegmentationError={setError}
                  onReferenceStatus={setReferenceStatus}
                  onReferenceError={(message) => {
                    setError(message);
                    setMode("linked");
                  }}
                />
              </Suspense>
            ) : (
              <div className="empty-view">
                <div className="crosshair-art">
                  <i />
                  <b />
                </div>
                <div className="eyebrow">START WITH THE ANATOMY</div>
                <h2>Your scan. A clear plan.</h2>
                <p>
                  Open an authorized CTA volume to explore linked
                  <br />
                  2D slices and a 3D reconstruction.
                </p>
                <button onClick={publicSample}>
                  Open public CTA <span>↗</span>
                </button>
                <small>
                  NIfTI · physical-space coordinates · browser-local rendering
                </small>
              </div>
            )}
            {busy && (
              <div className="progress-pill" role="status">
                Working…
              </div>
            )}
          </div>
          <footer className="viewer-footer">
            <span className="mono">
              RAS {caseState?.spatial_units === "mm" ? "mm" : "source units"}
              &nbsp; {coordinate(location)}
            </span>
            <span>
              Click to locate · Scroll through slices · Drag to rotate 3D
            </span>
          </footer>
        </section>
        <aside className="planning-panel">
          <div className="eyebrow">03 / PLANNING</div>
          <h2>Aneurysm planning.</h2>
          <nav className="planning-nav" aria-label="Planning sections">
            <a href="#mask-geometry">Geometry</a>
            <a href="#device-reference">Devices</a>
            <a href="#aneurysm-plan">Plan</a>
            <a href="#model-segmentation">Models</a>
            <a href="#manual-evidence">Evidence</a>
            <a href="#muse-discussion">Muse ↗</a>
          </nav>
          {caseState && calibratedSource && (
            <section id="mask-geometry" className="planning-section">
              <MorphometryResults
                key={geometryEpoch}
                caseState={caseState}
                binding={calibratedSource}
                nativeVolume={
                  nativeVolume?.file === file &&
                  digest === caseState.image_sha256
                    ? nativeVolume.image
                    : null
                }
                windowRange={windowRange}
                disabled={
                  busy ||
                  conflict ||
                  geometryDirty ||
                  planDirty ||
                  notes !== caseState.notes
                }
                onFocus={setFocus}
              />
              <details className="geometry-editor">
                <summary>Set geometry landmarks</summary>
                <MorphometryInputs
                  key={`${caseState.case_id}:${reloadEpoch}`}
                  caseState={caseState}
                  binding={calibratedSource}
                  location={location}
                  disabled={
                    busy ||
                    conflict ||
                    deviceDirty ||
                    planDirty ||
                    notes !== caseState.notes
                  }
                  onRevision={segmentationAccepted}
                  onComputed={() => {
                    setGeometryEpoch((value) => value + 1);
                    setAnswer(null);
                  }}
                  onDirtyChange={geometryEdited}
                  onBusy={setGeometryBusy}
                  onError={reportRequestError}
                  onFocus={setFocus}
                />
              </details>
            </section>
          )}
          {caseState && calibratedSource && (
            <section id="device-reference" className="planning-section">
              <DeviceReference
                key={`${geometryEpoch}:${deviceEpoch}`}
                caseState={caseState}
                binding={calibratedSource}
                disabled={
                  busy ||
                  conflict ||
                  geometryDirty ||
                  planDirty ||
                  notes !== caseState.notes
                }
              />
              <details className="geometry-editor">
                <summary>Enter independent sizing values</summary>
                <DeviceSizingInputs
                  key={`${caseState.case_id}:${reloadEpoch}:${geometryEpoch}`}
                  caseState={caseState}
                  binding={calibratedSource}
                  disabled={
                    busy ||
                    conflict ||
                    geometryInputsDirty ||
                    planDirty ||
                    notes !== caseState.notes
                  }
                  onDirty={deviceEdited}
                  onBusy={setDeviceBusy}
                  onSaved={() => {
                    setDeviceEpoch((value) => value + 1);
                    setAnswer(null);
                    setConfirmed(false);
                  }}
                  onConflict={(message) => {
                    setError(message);
                    setConflict(true);
                    setAnswer(null);
                  }}
                />
              </details>
              <DeviceSizingPanel
                key={`${caseState.case_id}:${reloadEpoch}:${geometryEpoch}:${deviceEpoch}`}
                caseState={caseState}
                binding={calibratedSource}
                disabled={
                  workspaceBusy ||
                  geometryBusy ||
                  deviceBusy ||
                  conflict ||
                  geometryDirty ||
                  planDirty ||
                  notes !== caseState.notes
                }
                onBusy={setDeviceCalculationBusy}
                onCalculated={() => {
                  setAnswer(null);
                  setConfirmed(false);
                }}
                onConflict={() => {
                  setError(
                    "Sizing calculation could not be confirmed. Reload saved state before retrying.",
                  );
                  setConflict(true);
                  setAnswer(null);
                }}
              />
            </section>
          )}
          {caseState ? (
            <AneurysmWorksheet
              key={`${caseState.case_id}:${reloadEpoch}`}
              caseId={caseState.case_id}
              plan={caseState.aneurysm_plan ?? null}
              measurements={caseState.measurements}
              spatialUnits={caseState.spatial_units}
              location={location}
              disabled={busy || conflict || geometryDirty}
              onSave={saveAneurysmPlan}
              onFocus={setFocus}
              onDirtyChange={planEdited}
            />
          ) : (
            <section className="planning-section" id="aneurysm-plan">
              <p className="muted small">
                Open a volume to mark the target and build a case plan.
              </p>
            </section>
          )}
          {caseState && (
            <SegmentationPanel
              key={caseState.case_id}
              caseState={caseState}
              reference={calibratedSource || reference}
              location={location}
              windowRange={windowRange}
              disabled={
                busy ||
                conflict ||
                geometryDirty ||
                planDirty ||
                notes !== caseState.notes
              }
              onOverlay={setSegmentation}
              onAccepted={segmentationAccepted}
              onError={reportRequestError}
            />
          )}
          <section className="planning-section" id="manual-evidence">
            <h3>
              Measurements <span>{caseState?.measurements.length || 0}</span>
            </h3>
            <p className="muted small">
              Select endpoints in the linked scan. Distances use physical RAS
              coordinates.
            </p>
            <div className="point-row">
              <button
                disabled={
                  !location ||
                  !caseState ||
                  caseState.spatial_units !== "mm" ||
                  geometryDirty ||
                  busy ||
                  conflict
                }
                onClick={() => setA(location && [...location])}
              >
                Set point A
              </button>
              <button
                disabled={
                  !location ||
                  !caseState ||
                  caseState.spatial_units !== "mm" ||
                  geometryDirty ||
                  busy ||
                  conflict
                }
                onClick={() => setB(location && [...location])}
              >
                Set point B
              </button>
            </div>
            {(pointA || pointB) && (
              <div className="point-readout mono">
                A {coordinate(pointA)}
                <br />B {coordinate(pointB)}
              </div>
            )}
            <div className="measurement-form">
              <input
                aria-label="Measurement label"
                value={label}
                maxLength={80}
                onChange={(e) => setLabel(e.target.value)}
              />
              <button
                disabled={
                  !pointA ||
                  !pointB ||
                  !caseState ||
                  caseState.spatial_units !== "mm" ||
                  geometryDirty ||
                  busy ||
                  conflict
                }
                onClick={saveMeasurement}
              >
                Save
              </button>
            </div>
            {caseState?.spatial_units === "unknown" && (
              <p className="method-note">
                Spatial units are not declared in this source. Millimeter
                measurements are disabled.
              </p>
            )}
            <div className="measurement-list">
              {caseState?.measurements.map((m, index) => (
                <button
                  key={m.measurement_id}
                  onClick={() => setFocus([...m.point_a_mm])}
                >
                  <span className="measure-index">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span>
                    {m.label}
                    <small>Point-to-point / RAS</small>
                  </span>
                  <strong>
                    {m.distance_mm.toFixed(2)}
                    <small>mm</small>
                  </strong>
                </button>
              ))}
            </div>
            <small className="method-note">
              Point-to-point distance is not an orthogonal vessel diameter or
              validated device-sizing measurement.
            </small>
          </section>
          <section className="planning-section">
            <h3>Case notes</h3>
            <textarea
              aria-label="Case planning notes"
              disabled={geometryDirty || busy}
              value={notes}
              maxLength={8000}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Lesion location, questions, options to discuss, missing clinical context…"
            />
            <div className="section-actions">
              <button
                onClick={saveNotes}
                disabled={
                  !caseState ||
                  busy ||
                  conflict ||
                  geometryDirty ||
                  notes === caseState.notes
                }
              >
                Save notes
              </button>
              {caseState && (
                <a
                  href={`/api/cases/${caseState.case_id}/brief`}
                  download="planning-brief.md"
                >
                  Export brief ↗
                </a>
              )}
            </div>
          </section>
          <section
            className="planning-section muse-section"
            id="muse-discussion"
          >
            <h3>
              <span className="muse-spark">✳</span> Muse{" "}
              <small>SPARK OPEN / BASETEN</small>
            </h3>
            <textarea
              aria-label="Question for Muse"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              maxLength={4000}
            />
            <label className="confirm-label">
              <input
                type="checkbox"
                aria-label="Public or synthetic data only"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              This case and my notes contain only public or synthetic data.
            </label>
            <button
              aria-label="Ask Muse"
              className="primary"
              disabled={
                !caseState ||
                !confirmed ||
                busy ||
                conflict ||
                !question.trim() ||
                geometryDirty ||
                planDirty ||
                notes !== caseState.notes
              }
              onClick={askMuse}
            >
              Ask Muse <span>↗</span>
            </button>
            {(planDirty || notes !== caseState?.notes) && caseState && (
              <small className="method-note">
                Save the worksheet and notes before asking Muse.
              </small>
            )}
            {answer && (
              <div className="agent-answer">
                <div className="eyebrow">
                  CASE STATE v{answer.artifact_version} ·{" "}
                  {answer.tool_names.join(" → ")}
                </div>
                <p>{answer.answer}</p>
                {!!answer.sources?.length && (
                  <div className="source-receipt">
                    <h4>Sources read</h4>
                    {answer.sources.map((source) => (
                      <div key={source.id}>
                        <a href={source.url} target="_blank" rel="noreferrer">
                          {source.title}
                        </a>
                        <small>
                          {source.population} · {source.section}
                        </small>
                      </div>
                    ))}
                    <small>
                      Selected historical sources, not a complete or live
                      guideline review.
                    </small>
                  </div>
                )}
              </div>
            )}
          </section>
        </aside>
      </div>
      <footer className="app-footer">
        <span>SELDINGER / PREOPERATIVE INTELLIGENCE</span>
        <span>
          Research prototype. Measurements and model output require independent
          review.
        </span>
      </footer>
    </div>
  );
}
