/** 2D-to-3D overlay studio: shows one admitted angiographic frame, proposes a
 * rigid pose that lays the accepted 3D vessel mask over it, and saves the
 * pose only after the operator reviews the overlay and confirms. Retrospective
 * frames only. Pixels are read, verified and drawn; they are never sent. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NVImage } from "@niivue/niivue";
import { api, RevisionConflictError, type CaseState } from "./api";
import { angleLabel, validateView, type ViewNumbers } from "./carmGeometry";
import { createNativeSampler } from "./nativeSampling";
import type { Vec3 } from "./obliqueSlice";
import {
  decodeVesselMask,
  FRAME_SOURCE_ID,
  loadFrameBundle,
  loadVerifiedFrame,
  parseSavedRegistration,
  type FrameBundle,
  type PlaneLabel,
  type RegistrationInputs,
  type SavedRegistration,
  type VerifiedFrame,
} from "./projectionFrames";
import {
  createOverlayJob,
  type OverlayJob,
  type OverlayJobResult,
} from "./projectionOverlayJob";
import {
  projectRegistered,
  PROJECTION_REGISTRATION_LIMITS as LIMITS,
  PROJECTION_REGISTRATION_METHOD,
} from "./projectionRegistration";
import { loadSegmentationMask, type SegmentationEntry } from "./segmentation";
import { stable, type Identity } from "./territoryWorkflow";
import type { Polarity } from "./vesselness2d";
import "./reformats.css";

type Props = {
  caseState: Pick<
    CaseState,
    "case_id" | "image_sha256" | "artifact_version" | "spatial_units"
  >;
  binding: Pick<Identity, "case_id" | "image_sha256" | "reference_revision">;
  volume: NVImage | null;
  cursor: Vec3 | null;
  disabled?: boolean;
  onBusy?: (busy: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
};
type Loaded = {
  key: string;
  saved: SavedRegistration;
  mask: SegmentationEntry | null;
};
type Editor = Record<(typeof ENTERED)[number], string>;
type Outcome = {
  scope: string;
  /** "saved" redraws a confirmed record; "proposal" is unsaved. */
  kind: "proposal" | "saved";
  result?: OverlayJobResult;
  matrix?: number[][];
  view?: ViewNumbers;
  failure?: string;
};
const ENTERED = [
  "primary_deg",
  "secondary_deg",
  "source_detector_mm",
  "source_isocenter_mm",
  "detector_width_mm",
] as const;
const LABELS: Record<(typeof ENTERED)[number], string> = {
  primary_deg: "Primary angle, LAO positive (degrees)",
  secondary_deg: "Secondary angle, cranial positive (degrees)",
  source_detector_mm: "Source to detector (mm)",
  source_isocenter_mm: "Source to isocenter (mm)",
  detector_width_mm: "Field width at the detector (mm)",
};
const DEFAULT_EDITOR: Editor = {
  primary_deg: "0",
  secondary_deg: "0",
  source_detector_mm: "1200",
  source_isocenter_mm: "750",
  detector_width_mm: "200",
};
const SLICE_MS = 12,
  HIDDEN_SLICE_MS = 800;
export const OVERLAY_REQUEST_TIMEOUT_MS = 30_000;
const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;

export default function ProjectionOverlayStudio({
  caseState,
  binding,
  volume,
  cursor,
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

  const [loaded, setLoaded] = useState<Loaded | null>(null),
    [loadError, setLoadError] = useState(""),
    [sourceText, setSourceText] = useState(""),
    [bundle, setBundle] = useState<(FrameBundle & { key: string }) | null>(
      null,
    ),
    [selection, setSelection] = useState<{
      plane: PlaneLabel;
      index: number;
    } | null>(null),
    [frame, setFrame] = useState<VerifiedFrame | null>(null),
    [notice, setNotice] = useState(""),
    [editor, setEditor] = useState<Editor>(DEFAULT_EDITOR),
    [entered, setEntered] = useState(false),
    [fitScale, setFitScale] = useState(true),
    [isocenter, setIsocenter] = useState<Vec3 | null>(null),
    [polarity, setPolarity] = useState<Polarity>("dark"),
    [sensitivity, setSensitivity] = useState(0.5),
    [showTarget, setShowTarget] = useState(true),
    [showPoints, setShowPoints] = useState(true),
    [enlarged, setEnlarged] = useState(false),
    [run, setRun] = useState<{
      scope: string;
      kind: Outcome["kind"];
      job: OverlayJob;
      matrix?: number[][];
      view: ViewNumbers;
    } | null>(null),
    [outcome, setOutcome] = useState<Outcome | null>(null),
    [reviewedOutcome, setReviewedOutcome] = useState<Outcome | null>(null),
    [localBusy, setLocalBusy] = useState(false),
    [requestFailed, setRequestFailed] = useState(false);
  // Each request releases the same callback it acquired, even after a case
  // switch. Cleanup is idempotent so late acknowledgements cannot relock it.
  const pending = useRef(
    new Map<
      () => void,
      { key: string; owner: Props["onBusy"]; controller: AbortController }
    >(),
  );
  const begin = (write = false) => {
    const owner = callbacks.current.onBusy;
    const owned = key;
    const controller = new AbortController();
    const deadline = setTimeout(
      () => controller.abort(),
      OVERLAY_REQUEST_TIMEOUT_MS,
    );
    const aborted = () => {
      if (live.current === owned) {
        setRequestFailed(true);
        setNotice(
          write
            ? "Save acknowledgement timed out. The proposal may have been stored. Reload saved proposal before continuing."
            : "The overlay request timed out. Reload saved proposal before continuing.",
        );
      }
      release();
    };
    const release = () => {
      if (!pending.current.delete(release)) return;
      clearTimeout(deadline);
      controller.signal.removeEventListener("abort", aborted);
      controller.abort();
      setLocalBusy(pending.current.size > 0);
      owner?.(
        [...pending.current.values()].some(
          (request) => request.owner === owner,
        ),
      );
    };
    pending.current.set(release, { key, owner, controller });
    controller.signal.addEventListener("abort", aborted, { once: true });
    setLocalBusy(true);
    owner?.(true);
    return { release, signal: controller.signal };
  };

  const load = useCallback(async () => {
    if (!key) return;
    const owned = key,
      { release, signal } = begin();
    setLoaded(null);
    setLoadError("");
    setRequestFailed(false);
    setBundle(null);
    setSelection(null);
    setFrame(null);
    setOutcome(null);
    setRun(null);
    setNotice("");
    try {
      const [registration, masks] = await Promise.all([
        api(
          `/cases/${identity.case_id}/projection-registration`,
          undefined,
          "GET",
          signal,
        ),
        api<{ current: { vessel: SegmentationEntry | null } }>(
          `/cases/${identity.case_id}/segmentations`,
          undefined,
          "GET",
          signal,
        ),
      ]);
      if (signal.aborted || live.current !== owned) return;
      setLoaded({
        key: owned,
        saved: parseSavedRegistration(registration, identity),
        mask: masks?.current?.vessel ?? null,
      });
    } catch {
      if (!signal.aborted && live.current === owned)
        setLoadError(
          "The saved 2D-to-3D proposal could not be loaded. Reload before continuing.",
        );
    } finally {
      release();
    }
  }, [key]);
  useEffect(() => {
    live.current = key;
    void load();
    return () => {
      live.current = "";
      for (const [release, request] of pending.current)
        if (request.key === key) {
          request.controller.abort();
          release();
        }
    };
  }, [load]);

  const current = loaded?.key === key ? loaded : null,
    frames = bundle?.key === key ? bundle : null,
    plane = frames?.planes.find((item) => item.plane === selection?.plane),
    shownFrame =
      frames &&
      frame &&
      frame.source_id === frames.source_id &&
      frame.manifest_revision === frames.manifest_revision &&
      frame.plane === selection?.plane &&
      frame.index === selection?.index
        ? frame
        : null;
  const editable =
    !!current && !disabled && !localBusy && !run && !requestFailed;
  const grid = useMemo(() => {
    try {
      return volume
        ? {
            shape: createNativeSampler(volume).shape,
            affine: volume.getAffine(),
          }
        : null;
    } catch {
      return null;
    }
  }, [volume]);
  const mask =
    current?.mask &&
    current.mask.status === "accepted" &&
    current.mask.role === "vessel"
      ? current.mask
      : null;

  // The view the search starts from: the admitted acquisition geometry, or
  // numbers the operator entered. Pixels are square, so the field height
  // follows from the entered width and the frame's shape.
  const manifestView = plane?.geometry ?? null,
    useEntered = entered || !manifestView;
  const view = useMemo((): ViewNumbers | null => {
    if (!plane) return null;
    if (!useEntered) return manifestView;
    try {
      const numbers = Object.fromEntries(
        ENTERED.map((field) => {
          const text = editor[field].trim();
          return [field, text === "" ? Number.NaN : Number(text)];
        }),
      ) as Record<(typeof ENTERED)[number], number>;
      return validateView({
        ...numbers,
        detector_height_mm:
          (numbers.detector_width_mm * plane.rows) / plane.columns,
      });
    } catch {
      return null;
    }
  }, [plane, useEntered, manifestView, editor]);
  const fit = useEntered && fitScale;
  const scope =
    shownFrame && mask && view
      ? stable({
          key,
          frame: shownFrame.sha256,
          revision: shownFrame.manifest_revision,
          mask: mask.mask_sha256,
          view,
          entered: useEntered,
          fit,
          isocenter,
          polarity,
          sensitivity,
        })
      : "";
  const savedInputs =
    current?.saved.current.status === "current"
      ? current.saved.current.inputs
      : null;
  // A redraw of the saved record belongs to the frame it names, not to the
  // search controls.
  const savedScope =
    savedInputs && shownFrame && shownFrame.sha256 === savedInputs.frame_sha256
      ? stable({ key, saved: current?.saved.registration_revision })
      : "";

  const active =
    !disabled && run && (run.scope === scope || run.scope === savedScope)
      ? run
      : null;
  useEffect(() => {
    if (run && !active) setRun(null);
  }, [run, active]);
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout>;
    const slice = () => {
      const deadline =
        performance.now() + (document.hidden ? HIDDEN_SLICE_MS : SLICE_MS);
      try {
        if (!active.job.advance(() => performance.now() >= deadline)) {
          timer = setTimeout(slice, 0);
          return;
        }
        const result = active.job.result();
        setRun(null);
        setOutcome({
          scope: active.scope,
          kind: active.kind,
          result,
          matrix: active.matrix ?? result.proposal?.matrix,
          view: result.proposal?.view ?? active.view,
        });
      } catch (error) {
        setRun(null);
        setOutcome({
          scope: active.scope,
          kind: active.kind,
          failure:
            error instanceof Error ? error.message : "Computation failed",
        });
      }
    };
    timer = setTimeout(slice, 0);
    return () => clearTimeout(timer);
  }, [active]);

  const shown =
      outcome && (outcome.scope === scope || outcome.scope === savedScope)
        ? outcome
        : null,
    proposal = shown?.kind === "proposal" ? shown.result?.proposal : null,
    dirty = !!proposal || !!active,
    reviewed = !!shown && reviewedOutcome === shown;
  // Dropped for good: an outcome describes the exact inputs it was computed
  // from, and restoring them later must not bring it back unreviewed.
  useEffect(() => {
    if (outcome && !shown) setOutcome(null);
  }, [outcome, shown]);
  useEffect(() => {
    callbacks.current.onDirtyChange?.(dirty);
  }, [dirty]);
  useEffect(
    () => () => {
      callbacks.current.onDirtyChange?.(false);
    },
    [],
  );

  async function openBundle() {
    const sourceId = sourceText.trim();
    if (!editable) return;
    if (!FRAME_SOURCE_ID.test(sourceId)) {
      setNotice("Enter the identifier the frames were admitted under.");
      return;
    }
    const owned = key,
      { release, signal } = begin();
    setNotice("");
    setBundle(null);
    setSelection(null);
    setFrame(null);
    try {
      const next = await loadFrameBundle(sourceId, signal);
      if (signal.aborted || live.current !== owned) return;
      setBundle({ ...next, key: owned });
      setEntered(false);
      await openFrame(
        next,
        next.planes[0].plane,
        next.planes[0].frames[0].index,
      );
    } catch {
      if (!signal.aborted && live.current === owned)
        setNotice(
          "These frames are not installed or failed their integrity checks.",
        );
    } finally {
      release();
    }
  }
  async function openFrame(
    from: FrameBundle,
    label: PlaneLabel,
    index: number,
  ) {
    const owned = key,
      { release, signal } = begin();
    setSelection({ plane: label, index });
    setFrame(null);
    setNotice("");
    try {
      const next = await loadVerifiedFrame(from, label, index, signal);
      if (!signal.aborted && live.current === owned) setFrame(next);
    } catch {
      if (!signal.aborted && live.current === owned)
        setNotice(
          "This frame failed its integrity check and is not displayed.",
        );
    } finally {
      release();
    }
  }
  async function maskVoxels(entry: SegmentationEntry, signal: AbortSignal) {
    if (!grid) throw new Error("The verified source volume is not loaded");
    return decodeVesselMask(
      await loadSegmentationMask(entry, binding, signal),
      grid.shape,
      grid.affine,
    );
  }
  async function propose() {
    if (!editable || !shownFrame || !mask || !view || !grid || !scope) return;
    const owned = key,
      started = scope,
      { release, signal } = begin();
    setOutcome(null);
    setNotice("");
    let voxels: Uint8Array | null = null,
      failure = "",
      canceled = false;
    try {
      voxels = await maskVoxels(mask, signal);
    } catch (error) {
      failure =
        error instanceof Error
          ? error.message
          : "The vessel mask could not be read";
    } finally {
      canceled = signal.aborted;
      // The sliced computation takes over the workspace editing lock below,
      // rather than feeding the request-busy flag back into its own identity.
      release();
    }
    if (canceled || live.current !== owned) return;
    if (!voxels) {
      setOutcome({ scope: started, kind: "proposal", failure });
      return;
    }
    setRun({
      scope: started,
      kind: "proposal",
      view,
      job: createOverlayJob({
        mask: voxels,
        shape: grid.shape,
        affine: grid.affine,
        frame: shownFrame,
        view,
        isocenter,
        search: { polarity, sensitivity, fit_detector_scale: fit },
      }),
    });
  }
  async function showSaved() {
    if (!editable || !savedInputs || !grid || !mask) return;
    const owned = key,
      { release, signal } = begin();
    setOutcome(null);
    setNotice("");
    try {
      if (
        mask.candidate_id !== savedInputs.mask_candidate_id ||
        mask.mask_sha256 !== savedInputs.mask_sha256
      )
        throw new Error("mask");
      const next = await loadFrameBundle(savedInputs.frame_source_id, signal);
      if (next.manifest_revision !== savedInputs.frame_manifest_revision)
        throw new Error("revision");
      const verified = await loadVerifiedFrame(
        next,
        savedInputs.plane,
        savedInputs.frame_index,
        signal,
      );
      if (verified.sha256 !== savedInputs.frame_sha256)
        throw new Error("frame");
      const voxels = await maskVoxels(mask, signal);
      if (signal.aborted || live.current !== owned) return;
      setSourceText(next.source_id);
      setBundle({ ...next, key: owned });
      setSelection({ plane: verified.plane, index: verified.index });
      setFrame(verified);
      setRun({
        scope: stable({ key, saved: current?.saved.registration_revision }),
        kind: "saved",
        matrix: savedInputs.volume_to_carm_ras,
        view: savedInputs.view,
        job: createOverlayJob({
          mask: voxels,
          shape: grid.shape,
          affine: grid.affine,
          frame: verified,
          view: savedInputs.view,
          isocenter: savedInputs.isocenter,
          search: null,
        }),
      });
    } catch {
      if (!signal.aborted && live.current === owned)
        setNotice(
          "The saved proposal's frame or vessel mask is no longer available unchanged, so its overlay is not shown.",
        );
    } finally {
      release();
    }
  }
  async function save() {
    if (!editable || !current || !proposal || !shownFrame || !mask || !reviewed)
      return;
    const result = shown?.result;
    if (!result) return;
    const owned = key,
      { release, signal } = begin(true);
    const inputs: RegistrationInputs = {
      confirmed: true,
      frame_source_id: shownFrame.source_id,
      frame_manifest_revision: shownFrame.manifest_revision,
      plane: shownFrame.plane,
      frame_index: shownFrame.index,
      frame_sha256: shownFrame.sha256,
      mask_candidate_id: mask.candidate_id,
      mask_sha256: mask.mask_sha256,
      geometry_source: useEntered ? "operator_entered" : "frame_manifest",
      view: proposal.view,
      fit_detector_scale: fit,
      detector_scale: proposal.detector_scale,
      isocenter: result.isocenter,
      volume_to_carm_ras: proposal.matrix,
      method: PROJECTION_REGISTRATION_METHOD,
      polarity,
      sensitivity,
      reported_score: proposal.score,
      reported_start_score: proposal.start_score,
    };
    try {
      const saved = parseSavedRegistration(
        await api(
          `/cases/${identity.case_id}/projection-registration`,
          {
            artifact_version: identity.artifact_version,
            reference_revision: identity.reference_revision,
            registration_revision: current.saved.registration_revision,
            inputs,
          },
          "PUT",
          signal,
        ),
        identity,
      );
      if (signal.aborted || live.current !== owned) return;
      setLoaded({ ...current, saved });
      setOutcome({
        scope: stable({ key, saved: saved.registration_revision }),
        kind: "saved",
        result,
        matrix: proposal.matrix,
        view: proposal.view,
      });
      setNotice("");
    } catch (error) {
      if (!signal.aborted && live.current === owned)
        setNotice(
          error instanceof RevisionConflictError
            ? "The case or the saved proposal changed. Reload before saving."
            : "The proposal was not saved. The frame, mask or source may have changed; reload and try again.",
        );
    } finally {
      release();
    }
  }

  const canvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context || !shownFrame) return;
    const { width, height, gray } = shownFrame,
      image = context.createImageData(width, height);
    for (let i = 0, o = 0; i < gray.length; i++, o += 4) {
      image.data[o] = image.data[o + 1] = image.data[o + 2] = gray[i];
      image.data[o + 3] = 255;
    }
    const result = shown?.result,
      target = result?.target;
    if (showTarget && target)
      for (const index of target.centerline) {
        const x = Math.min(
            width - 1,
            Math.round(((index % target.width) + 0.5) * target.scale),
          ),
          y = Math.min(
            height - 1,
            Math.round((Math.floor(index / target.width) + 0.5) * target.scale),
          ),
          o = 4 * (y * width + x);
        image.data[o] = 255;
        image.data[o + 1] = 200;
        image.data[o + 2] = 0;
      }
    context.putImageData(image, 0, 0);
    if (!result || !shown?.matrix || !shown.view || !showPoints) return;
    const size = Math.max(1, Math.round(width / 256));
    const draw = (matrix: number[][], drawn: ViewNumbers, color: string) => {
      const pixels = projectRegistered(
        drawn,
        result.isocenter,
        matrix,
        result.points,
        { width, height },
      );
      context.fillStyle = color;
      for (let k = 0; k < pixels.length; k += 2)
        if (Number.isFinite(pixels[k]) && Number.isFinite(pixels[k + 1]))
          context.fillRect(
            pixels[k] - size / 2,
            pixels[k + 1] - size / 2,
            size,
            size,
          );
    };
    try {
      draw(shown.matrix, shown.view, "rgba(0, 229, 255, 0.85)");
    } catch (error) {
      console.warn("Overlay drawing failed", error);
    }
  }, [shownFrame, shown, showTarget, showPoints]);

  if (!allowed) return null;
  const saved = current?.saved.current;
  return (
    <section
      id="angio-overlay"
      className="native-reformat-studio carm-studio"
      aria-labelledby="angio-overlay-title"
    >
      <h2 id="angio-overlay-title">Angiogram overlay (2D-to-3D proposal)</h2>
      <p className="carm-note">
        Lays the accepted 3D vessel mask over one admitted, retrospective
        angiographic frame. The pose is a proposal for the operator to review,
        not a validated registration, and no accuracy is claimed. It is rigid,
        uses one plane, and does not determine depth along the beam. It is not
        for live guidance.
      </p>
      {loadError && <p role="alert">{loadError}</p>}
      {notice && <p role="alert">{notice}</p>}
      {(loadError || requestFailed) && (
        <button
          type="button"
          disabled={localBusy || disabled}
          onClick={() => void load()}
        >
          Reload saved proposal
        </button>
      )}
      {current && (
        <>
          <p role="status" aria-label="Saved overlay proposal">
            {saved?.status === "current"
              ? `Saved operator-confirmed proposal, revision ${current.saved.registration_revision}, not a validated registration: frame ${saved.inputs.frame_index} of plane ${saved.inputs.plane} in ${saved.inputs.frame_source_id}, ${saved.inputs.geometry_source === "frame_manifest" ? "geometry from the admitted DICOM object" : "operator-entered geometry (assumed)"}, turned ${saved.result.rotation_deg.toFixed(1)}° and moved the isocenter ${saved.result.isocenter_shift_mm.toFixed(1)} mm from the volume's own position. Its frame and vessel mask are ${saved.evidence === "verified" ? "installed and unchanged" : "no longer available unchanged"}.`
              : saved?.status === "stale"
                ? "A proposal was confirmed for an earlier revision of this case. It is not shown or reused."
                : "No confirmed 2D-to-3D proposal is saved for this case revision."}
          </p>
          {saved?.status === "current" && saved.evidence === "verified" && (
            <div className="native-actions">
              <button
                type="button"
                disabled={!editable || !grid || !mask}
                onClick={() => void showSaved()}
              >
                Show saved overlay
              </button>
            </div>
          )}
          {!mask && (
            <p role="status">
              Accept a vessel segmentation for this source first. The overlay
              projects the accepted vessel mask.
            </p>
          )}
          {!grid && (
            <p role="status">
              Load the verified source volume to compute an overlay.
            </p>
          )}
          <fieldset disabled={!editable}>
            <legend>Admitted frames</legend>
            <div className="native-view-controls">
              <label>
                Frame bundle identifier
                <input
                  value={sourceText}
                  maxLength={64}
                  spellCheck={false}
                  onChange={(e) => setSourceText(e.target.value)}
                />
              </label>
            </div>
            <div className="native-actions">
              <button type="button" onClick={() => void openBundle()}>
                Open admitted frames
              </button>
            </div>
            <p className="carm-note">
              Frames are admitted on this computer with the frame admission
              command, which bounds, crops and redacts them. Each frame is
              checked against its recorded SHA-256 before it is drawn.
            </p>
            {frames && plane && selection && (
              <>
                <div className="native-view-controls">
                  {frames.planes.length > 1 && (
                    <label>
                      Plane
                      <select
                        value={selection.plane}
                        onChange={(e) => {
                          const next = frames.planes.find(
                            (item) => item.plane === e.target.value,
                          );
                          if (next)
                            void openFrame(
                              frames,
                              next.plane,
                              next.frames[0].index,
                            );
                        }}
                      >
                        {frames.planes.map((item) => (
                          <option key={item.plane} value={item.plane}>
                            {item.plane.toUpperCase()}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label>
                    Frame
                    <select
                      value={selection.index}
                      onChange={(e) =>
                        void openFrame(
                          frames,
                          selection.plane,
                          Number(e.target.value),
                        )
                      }
                    >
                      {plane.frames.map((item) => (
                        <option key={item.index} value={item.index}>
                          {item.index}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <p role="status" aria-label="Frame provenance">
                  {frames.scope} scope ·{" "}
                  {frames.method === "admitted_dicom_xa_frames"
                    ? "DICOM XA frames"
                    : "PNG frames"}{" "}
                  · {plane.columns} × {plane.rows} pixels ·{" "}
                  {plane.basis === "dicom_declared_no_burned_in_annotation"
                    ? "the DICOM object declares no burned-in annotation"
                    : "identifiers removed by an operator-attested crop or redaction"}
                  {frames.planes.length > 1
                    ? " · the two planes are linked by operator declaration only"
                    : ""}
                </p>
              </>
            )}
          </fieldset>
          {plane && (
            <fieldset disabled={!editable}>
              <legend>Acquisition geometry</legend>
              {manifestView && (
                <label>
                  <input
                    type="checkbox"
                    checked={useEntered}
                    onChange={(e) => setEntered(e.target.checked)}
                  />{" "}
                  Enter geometry by hand instead of using the admitted DICOM
                  values
                </label>
              )}
              {useEntered ? (
                <>
                  <div className="native-view-controls">
                    {ENTERED.map((field) => (
                      <label key={field}>
                        {LABELS[field]}
                        <input
                          inputMode="decimal"
                          value={editor[field]}
                          onChange={(e) =>
                            setEditor((prior) => ({
                              ...prior,
                              [field]: e.target.value,
                            }))
                          }
                        />
                      </label>
                    ))}
                  </div>
                  <label>
                    <input
                      type="checkbox"
                      checked={fitScale}
                      onChange={(e) => setFitScale(e.target.checked)}
                    />{" "}
                    Fit the field size ({LIMITS.detector_scale[0]} to{" "}
                    {LIMITS.detector_scale[1]} times the entered width)
                  </label>
                  <p className="carm-note">
                    These values are assumed, not read from the acquisition
                    {plane.cropped
                      ? ", and the frame was cropped, so its center need not be the central ray"
                      : ""}
                    . Angles follow the declared convention of the C-arm views
                    above, which is not vendor-verified.
                  </p>
                </>
              ) : (
                manifestView && (
                  <p role="status" aria-label="Admitted geometry">
                    {angleLabel(
                      manifestView.primary_deg,
                      manifestView.secondary_deg,
                    )}{" "}
                    · source to detector{" "}
                    {manifestView.source_detector_mm.toFixed(0)} mm · source to
                    patient {manifestView.source_isocenter_mm.toFixed(0)} mm ·
                    field {manifestView.detector_width_mm.toFixed(0)} ×{" "}
                    {manifestView.detector_height_mm.toFixed(0)} mm, from the
                    admitted DICOM object
                  </p>
                )
              )}
              {!view && (
                <p role="alert">
                  Geometry values are outside the supported C-arm bounds.
                </p>
              )}
              <div className="native-actions">
                <button
                  type="button"
                  disabled={!cursor}
                  onClick={() => cursor && setIsocenter([...cursor] as Vec3)}
                >
                  Set isocenter to crosshair
                </button>
                <button
                  type="button"
                  disabled={!isocenter}
                  onClick={() => setIsocenter(null)}
                >
                  Use the vessel centroid as isocenter
                </button>
              </div>
              <p role="status" aria-label="Overlay isocenter">
                Isocenter:{" "}
                {isocenter
                  ? `${isocenter.map((x) => x.toFixed(1)).join(", ")} mm (RAS)`
                  : "centroid of the vessel mask"}
              </p>
            </fieldset>
          )}
          {plane && (
            <fieldset disabled={!editable}>
              <legend>Proposal</legend>
              <div className="native-view-controls">
                <label>
                  Vessels in this frame are
                  <select
                    value={polarity}
                    onChange={(e) => setPolarity(e.target.value as Polarity)}
                  >
                    <option value="dark">darker than background</option>
                    <option value="bright">brighter than background</option>
                  </select>
                </label>
                <label>
                  2D vessel sensitivity
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={sensitivity}
                    onChange={(e) => setSensitivity(Number(e.target.value))}
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={showTarget}
                    onChange={(e) => setShowTarget(e.target.checked)}
                  />{" "}
                  Show extracted 2D centerlines
                </label>
              </div>
              {!active && (
                <div className="native-actions">
                  <button
                    type="button"
                    disabled={!shownFrame || !mask || !view || !grid}
                    onClick={() => void propose()}
                  >
                    Propose overlay
                  </button>
                </div>
              )}
              <p className="carm-note">
                Searches up to {LIMITS.in_plane_mm} mm in the image plane and{" "}
                {LIMITS.rotation_deg}° about each axis from the entered
                geometry, matching projected 3D vessel points to lines found in
                the frame. Catheters, bone edges and vessels absent from either
                image can mislead it.
              </p>
            </fieldset>
          )}
          {active && (
            <button type="button" onClick={() => setRun(null)}>
              Cancel overlay computation
            </button>
          )}
          <p role="status" aria-label="Overlay status">
            {active
              ? "Computing… This waits while the tab is in the background."
              : proposal
                ? `Unsaved proposal: moved the vessel points ${proposal.translation_mm.toFixed(1)} mm and ${proposal.rotation_deg.toFixed(1)}° from the starting pose${fit ? `, with the field size fitted at ${proposal.detector_scale.toFixed(2)} times the entered width` : ""}. Mean distance from projected 3D vessel points to extracted 2D centerlines ${proposal.score.mean_distance_mm.toFixed(1)} mm at the isocenter plane, capped at ${(LIMITS.truncation_mm * proposal.detector_scale).toFixed(1)} mm per point (starting pose ${proposal.start_score.mean_distance_mm.toFixed(1)} mm). ${percent(proposal.score.matched_fraction)} of points lie within ${LIMITS.match_mm} mm of a 2D centerline, ${percent(proposal.score.in_field_fraction)} project inside the frame, and ${percent(proposal.score.uncovered_fraction)} of 2D centerline samples have no projected point in their coarse 3-by-3-cell neighborhood (not a 2 mm distance test). These compare two automatically extracted line sets. They are not a registration accuracy. Review the overlay before confirming.`
                : shown?.kind === "saved" && shown.result
                  ? "Showing the saved operator-confirmed proposal. It is not a validated registration."
                  : ""}
          </p>
          {shown?.result && shown.result.pooling > 1 && (
            <p role="status">
              The vessel mask was coarsened {shown.result.pooling} times per
              axis to fit the browser's memory bound.
            </p>
          )}
          {shown?.failure && (
            <p role="alert">Overlay computation failed: {shown.failure}.</p>
          )}
          {shownFrame && (
            <figure
              className={`native-render-figure angio-overlay-figure${enlarged ? " enlarged" : ""}`}
            >
              <canvas
                ref={canvas}
                width={shownFrame.width}
                height={shownFrame.height}
                role="img"
                aria-label={`Admitted frame ${shownFrame.index}, plane ${shownFrame.plane}${shown?.result && showPoints ? ", with projected 3D vessels" : ""}`}
              />
              <figcaption>
                Retrospective admitted frame, verified against its recorded
                SHA-256.
                {shown?.result && showPoints
                  ? ` Cyan: accepted 3D vessel mask projected under the ${shown.kind === "saved" ? "saved operator-confirmed" : "unsaved"} proposal.`
                  : ""}
                {shown?.result?.target && showTarget
                  ? " Amber: lines extracted from the frame, which can include catheters and bone edges."
                  : ""}{" "}
                Not a validated registration.
                <span className="native-actions">
                  <button
                    type="button"
                    aria-pressed={enlarged}
                    onClick={() => setEnlarged(!enlarged)}
                  >
                    {enlarged ? "Close larger view" : "Larger view"}
                  </button>
                  {shown?.result && (
                    <button
                      type="button"
                      aria-pressed={showPoints}
                      onClick={() => setShowPoints(!showPoints)}
                    >
                      {showPoints
                        ? "Hide projected 3D vessels"
                        : "Show projected 3D vessels"}
                    </button>
                  )}
                </span>
              </figcaption>
            </figure>
          )}
          {proposal && (
            <fieldset disabled={!editable}>
              <legend>Confirm</legend>
              <label>
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) =>
                    setReviewedOutcome(e.target.checked ? shown : null)
                  }
                />{" "}
                I reviewed the overlay and confirm this pose as an unvalidated
                working proposal
              </label>
              <div className="native-actions">
                <button
                  type="button"
                  disabled={!reviewed}
                  onClick={() => void save()}
                >
                  Save confirmed proposal
                </button>
                <button type="button" onClick={() => setOutcome(null)}>
                  Discard proposal
                </button>
              </div>
            </fieldset>
          )}
        </>
      )}
    </section>
  );
}
