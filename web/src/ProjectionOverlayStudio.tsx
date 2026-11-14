/** 2D-to-3D overlay studio: shows one admitted angiographic frame, or one
 * from each plane of a declared pair, proposes a rigid pose that lays the
 * accepted 3D vessel mask over it, and saves the pose only after the operator
 * reviews the overlay and confirms. Retrospective frames only. Pixels are
 * read, verified and drawn; they are never sent. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NVImage } from "@niivue/niivue";
import { api, RevisionConflictError, type CaseState } from "./api";
import {
  BIPLANE_REGISTRATION_LIMITS as PAIR_LIMITS,
  BIPLANE_REGISTRATION_METHOD,
  planeAngleDeg,
  planesFarEnough,
  type BiplaneRegistrationProposal,
} from "./biplaneRegistration";
import { angleLabel, validateView, type ViewNumbers } from "./carmGeometry";
import { createNativeSampler } from "./nativeSampling";
import type { Vec3 } from "./obliqueSlice";
import {
  decodeVesselMask,
  FRAME_SOURCE_ID,
  isBiplane,
  loadFrameBundle,
  loadVerifiedFrame,
  parseSavedRegistration,
  type BiplaneRegistrationInputs,
  type FrameBundle,
  type FramePlane,
  type PlaneLabel,
  type RegistrationInputs,
  type SavedInputs,
  type SavedRegistration,
  type VerifiedFrame,
} from "./projectionFrames";
import {
  createBiplaneOverlayJob,
  createOverlayJob,
  type OverlayJobResult,
} from "./projectionOverlayJob";
import {
  projectRegistered,
  PROJECTION_REGISTRATION_LIMITS as LIMITS,
  PROJECTION_REGISTRATION_METHOD,
} from "./projectionRegistration";
import { loadSegmentationMask, type SegmentationEntry } from "./segmentation";
import { stable, type Identity } from "./territoryWorkflow";
import type { Polarity, VesselTarget } from "./vesselness2d";
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
/** What the operator set for one plane. */
type PlaneSettings = {
  editor: Editor;
  entered: boolean;
  fitScale: boolean;
  polarity: Polarity;
  sensitivity: number;
};
/** One pose drawn over one frame from each plane of a pair. */
type PairOutcome = {
  frames: [VerifiedFrame, VerifiedFrame];
  /** The views the pose was scored or saved in. */
  views: [ViewNumbers, ViewNumbers];
  targets: [VesselTarget, VesselTarget] | null;
  points: Float32Array;
  isocenter: Vec3;
  pooling: number;
  matrix: number[][];
  /** Null when a saved record is redrawn. */
  proposal: BiplaneRegistrationProposal | null;
  /** What each plane's search was given, for the record. */
  searched: Pick<
    BiplaneRegistrationInputs["planes"][number],
    "geometry_source" | "fit_detector_scale" | "polarity" | "sensitivity"
  >[];
};
type Outcome = {
  scope: string;
  /** "saved" redraws a confirmed record; "proposal" is unsaved. */
  kind: "proposal" | "saved";
  result?: OverlayJobResult;
  matrix?: number[][];
  view?: ViewNumbers;
  pair?: PairOutcome;
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
/** Plane B starts as a lateral view: two planes at one angle cannot be fitted. */
const defaults = (label: PlaneLabel): PlaneSettings => ({
  editor: { ...DEFAULT_EDITOR, primary_deg: label === "b" ? "90" : "0" },
  entered: false,
  fitScale: true,
  polarity: "dark",
  sensitivity: 0.5,
});
/** The controls as one plane of a confirmed record was computed with. A
 * fitted view holds the entered field width times the fitted scale. */
function settingsOf(
  entry: Pick<
    RegistrationInputs,
    | "view"
    | "geometry_source"
    | "fit_detector_scale"
    | "detector_scale"
    | "polarity"
    | "sensitivity"
  >,
): PlaneSettings {
  const entered = entry.geometry_source === "operator_entered",
    text = (value: number) => String(Number(value.toFixed(6)));
  return {
    editor: {
      primary_deg: text(entry.view.primary_deg),
      secondary_deg: text(entry.view.secondary_deg),
      source_detector_mm: text(entry.view.source_detector_mm),
      source_isocenter_mm: text(entry.view.source_isocenter_mm),
      detector_width_mm: text(
        entry.view.detector_width_mm / entry.detector_scale,
      ),
    },
    entered,
    fitScale: entered ? entry.fit_detector_scale : true,
    polarity: entry.polarity,
    sensitivity: entry.sensitivity,
  };
}
const usesEntered = (plane: FramePlane, settings: PlaneSettings) =>
  settings.entered || !plane.geometry;
/** The view a plane's search starts from: the admitted acquisition geometry,
 * or numbers the operator entered. Pixels are square, so the field height
 * follows from the entered width and the frame's shape. */
function planeView(
  plane: FramePlane,
  settings: PlaneSettings,
): ViewNumbers | null {
  if (!usesEntered(plane, settings)) return plane.geometry;
  try {
    const numbers = Object.fromEntries(
      ENTERED.map((field) => {
        const text = settings.editor[field].trim();
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
}

const geometryWords = (source: "frame_manifest" | "operator_entered") =>
  source === "frame_manifest"
    ? "geometry from the admitted DICOM object"
    : "operator-entered geometry (assumed)";
/** The saved record in words. It is always labelled as unvalidated. */
function savedSummary(
  revision: number,
  inputs: SavedInputs,
  result: {
    rotation_deg: number;
    isocenter_shift_mm: number;
    plane_angle_deg: number | null;
  },
  evidence: "verified" | "unavailable",
): string {
  const moved = `turned ${result.rotation_deg.toFixed(1)}° and moved the isocenter ${result.isocenter_shift_mm.toFixed(1)} mm from the volume's own position`;
  if (isBiplane(inputs))
    return `Saved operator-confirmed two-plane proposal, revision ${revision}, not a validated registration: ${inputs.planes
      .map(
        (entry) =>
          `frame ${entry.frame_index} of plane ${entry.plane} with ${geometryWords(entry.geometry_source)}`,
      )
      .join(
        " and ",
      )} in ${inputs.frame_source_id}, central rays ${(result.plane_angle_deg ?? 0).toFixed(0)}° apart, one pose for both, ${moved}. The operator attested that both frames show the patient in the same position; that was not checked. Its frames and vessel mask are ${evidence === "verified" ? "installed and unchanged" : "no longer available unchanged"}.`;
  return `Saved operator-confirmed proposal, revision ${revision}, not a validated registration: frame ${inputs.frame_index} of plane ${inputs.plane} in ${inputs.frame_source_id}, ${geometryWords(inputs.geometry_source)}, ${moved}. Its frame and vessel mask are ${evidence === "verified" ? "installed and unchanged" : "no longer available unchanged"}.`;
}

/** One verified frame with, optionally, the lines extracted from it and the
 * vessel points projected under a pose. */
function OverlayCanvas({
  frame,
  target,
  overlay,
  label,
}: {
  frame: VerifiedFrame;
  target: VesselTarget | null;
  overlay: {
    points: Float32Array;
    isocenter: Vec3;
    matrix: number[][];
    view: ViewNumbers;
  } | null;
  label: string;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const { points, isocenter, matrix, view } = overlay ?? {};
  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    const { width, height, gray } = frame,
      image = context.createImageData(width, height);
    for (let i = 0, o = 0; i < gray.length; i++, o += 4) {
      image.data[o] = image.data[o + 1] = image.data[o + 2] = gray[i];
      image.data[o + 3] = 255;
    }
    if (target)
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
    if (!points || !isocenter || !matrix || !view) return;
    const size = Math.max(1, Math.round(width / 256));
    try {
      const pixels = projectRegistered(view, isocenter, matrix, points, {
        width,
        height,
      });
      context.fillStyle = "rgba(0, 229, 255, 0.85)";
      for (let k = 0; k < pixels.length; k += 2)
        if (Number.isFinite(pixels[k]) && Number.isFinite(pixels[k + 1]))
          context.fillRect(
            pixels[k] - size / 2,
            pixels[k + 1] - size / 2,
            size,
            size,
          );
    } catch (error) {
      console.warn("Overlay drawing failed", error);
    }
  }, [frame, target, points, isocenter, matrix, view]);
  return (
    <canvas
      ref={canvas}
      width={frame.width}
      height={frame.height}
      role="img"
      aria-label={label}
    />
  );
}

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
    [settings, setSettings] = useState<
      Partial<Record<PlaneLabel, PlaneSettings>>
    >({}),
    // The frame last opened on each plane, and whether both planes are fitted.
    [picks, setPicks] = useState<Partial<Record<PlaneLabel, number>>>({}),
    [paired, setPaired] = useState(false),
    [isocenter, setIsocenter] = useState<Vec3 | null>(null),
    [showTarget, setShowTarget] = useState(true),
    [showPoints, setShowPoints] = useState(true),
    [enlarged, setEnlarged] = useState(false),
    [run, setRun] = useState<{
      scope: string;
      kind: Outcome["kind"];
      job: { advance(expired: () => boolean): boolean };
      /** What the completed job found, as the rest of an outcome. */
      finish: () => Pick<Outcome, "result" | "matrix" | "view" | "pair">;
    } | null>(null),
    [outcome, setOutcome] = useState<Outcome | null>(null),
    [reviewedOutcome, setReviewedOutcome] = useState<Outcome | null>(null),
    [attestedOutcome, setAttestedOutcome] = useState<Outcome | null>(null),
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

  // Geometry, polarity and sensitivity belong to a plane. The controls edit
  // the plane that is open.
  const editing: PlaneLabel = selection?.plane ?? "single",
    chosen = (label: PlaneLabel) => settings[label] ?? defaults(label),
    { editor, entered, fitScale, polarity, sensitivity } = chosen(editing);
  const change = (patch: (now: PlaneSettings) => Partial<PlaneSettings>) =>
    setSettings((prior) => {
      const now = prior[editing] ?? defaults(editing);
      return { ...prior, [editing]: { ...now, ...patch(now) } };
    });
  const setEntered = (value: boolean) => change(() => ({ entered: value })),
    setFitScale = (value: boolean) => change(() => ({ fitScale: value })),
    setPolarity = (value: Polarity) => change(() => ({ polarity: value })),
    setSensitivity = (value: number) => change(() => ({ sensitivity: value })),
    setEditor = (next: (prior: Editor) => Editor) =>
      change((now) => ({ editor: next(now.editor) }));

  // An isocenter and entered geometry describe one case's source. They are
  // kept across revisions of that case and never carried to another source.
  const source = allowed
    ? stable([
        identity.case_id,
        identity.image_sha256,
        identity.reference_revision,
      ])
    : "";
  useEffect(() => {
    setIsocenter(null);
    setSettings({});
    setPicks({});
    setPaired(false);
  }, [source]);

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

  const manifestView = plane?.geometry ?? null,
    useEntered = entered || !manifestView;
  const view = useMemo(
    (): ViewNumbers | null =>
      plane
        ? planeView(plane, { ...defaults("single"), entered, editor })
        : null,
    [plane, entered, editor],
  );
  const fit = useEntered && fitScale;
  // Both planes of a declared pair, each with the frame last opened on it
  // and its own settings.
  const pairOn = paired && frames?.planes.length === 2;
  const pairSetup = useMemo(() => {
    if (!pairOn || !frames) return null;
    return frames.planes.map((record) => {
      const own = settings[record.plane] ?? defaults(record.plane),
        listed =
          record.frames.find((item) => item.index === picks[record.plane]) ??
          record.frames[0],
        byHand = usesEntered(record, own);
      return {
        plane: record.plane as "a" | "b",
        index: listed.index,
        sha256: listed.sha256,
        view: planeView(record, own),
        geometry_source: byHand
          ? ("operator_entered" as const)
          : ("frame_manifest" as const),
        fit_detector_scale: byHand && own.fitScale,
        polarity: own.polarity,
        sensitivity: own.sensitivity,
      };
    });
  }, [pairOn, frames, settings, picks]);
  const pairAngle =
      pairSetup?.[0].view && pairSetup[1].view
        ? planeAngleDeg(pairSetup[0].view, pairSetup[1].view)
        : null,
    // Two views this far apart cannot show one picture.
    pairDistinct = !!pairSetup && pairSetup[0].sha256 !== pairSetup[1].sha256,
    pairReady =
      pairAngle !== null && planesFarEnough(pairAngle) && pairDistinct;
  const singleScope =
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
  const pairScope =
    frames && pairSetup && pairReady && mask
      ? stable({
          key,
          source: frames.source_id,
          revision: frames.manifest_revision,
          mask: mask.mask_sha256,
          planes: pairSetup,
          isocenter,
        })
      : "";
  const scope = pairOn ? pairScope : singleScope;
  const savedInputs: SavedInputs | null =
    current?.saved.current.status === "current"
      ? current.saved.current.inputs
      : null;
  // A redraw of the saved record belongs to the frame it names, or to the
  // bundle its two frames come from, not to the search controls.
  const savedScope = (
    savedInputs && isBiplane(savedInputs)
      ? frames?.source_id === savedInputs.frame_source_id &&
        frames.manifest_revision === savedInputs.frame_manifest_revision
      : savedInputs &&
        shownFrame &&
        shownFrame.source_id === savedInputs.frame_source_id &&
        shownFrame.manifest_revision === savedInputs.frame_manifest_revision &&
        shownFrame.sha256 === savedInputs.frame_sha256
  )
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
        const found = active.finish();
        setRun(null);
        setOutcome({ scope: active.scope, kind: active.kind, ...found });
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
    pairProposal = shown?.kind === "proposal" ? shown.pair?.proposal : null,
    dirty = !!proposal || !!pairProposal || !!active,
    reviewed = !!shown && reviewedOutcome === shown,
    attested = !!shown && attestedOutcome === shown;
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
      setSettings((prior) =>
        Object.fromEntries(
          Object.entries(prior).map(([label, own]) => [
            label,
            { ...own, entered: false },
          ]),
        ),
      );
      setPicks({});
      setPaired(false);
      // The parsed manifest no longer owns a deadline. The frame fetch below
      // acquires its own lock and full deadline; release is idempotent.
      release();
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
    setPicks((prior) => ({ ...prior, [label]: index }));
    // A redrawn two-plane record shows its own frames, not the one opened.
    setOutcome((prior) =>
      prior?.pair && prior.kind === "saved" ? null : prior,
    );
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
  async function proposePair() {
    if (!editable || !frames || !pairSetup || !mask || !grid || !pairScope)
      return;
    const [a, b] = pairSetup;
    if (!a.view || !b.view) return;
    const views: [ViewNumbers, ViewNumbers] = [a.view, b.view],
      owned = key,
      started = pairScope,
      { release, signal } = begin();
    setOutcome(null);
    setNotice("");
    const loadedFrames: VerifiedFrame[] = [];
    let voxels: Uint8Array | null = null,
      failure = "A frame failed its integrity check and is not used",
      canceled = false;
    try {
      for (const item of pairSetup)
        loadedFrames.push(
          shownFrame?.plane === item.plane && shownFrame.index === item.index
            ? shownFrame
            : await loadVerifiedFrame(frames, item.plane, item.index, signal),
        );
      failure = "The vessel mask could not be read";
      voxels = await maskVoxels(mask, signal);
    } catch (error) {
      if (loadedFrames.length === 2 && error instanceof Error)
        failure = error.message;
    } finally {
      canceled = signal.aborted;
      release();
    }
    if (canceled || live.current !== owned) return;
    if (!voxels) {
      setOutcome({ scope: started, kind: "proposal", failure });
      return;
    }
    const pairFrames: [VerifiedFrame, VerifiedFrame] = [
        loadedFrames[0],
        loadedFrames[1],
      ],
      job = createBiplaneOverlayJob({
        mask: voxels,
        shape: grid.shape,
        affine: grid.affine,
        planes: [
          { ...a, frame: pairFrames[0], view: views[0] },
          { ...b, frame: pairFrames[1], view: views[1] },
        ],
        isocenter,
        search: true,
      });
    setRun({
      scope: started,
      kind: "proposal",
      job,
      finish: () => {
        const result = job.result(),
          found = result.proposal;
        if (!found) throw new Error("No proposal was computed");
        return {
          pair: {
            frames: pairFrames,
            views: [found.planes[0].view, found.planes[1].view],
            targets: result.targets,
            points: result.points,
            isocenter: result.isocenter,
            pooling: result.pooling,
            matrix: found.matrix,
            proposal: found,
            searched: pairSetup,
          },
        };
      },
    });
  }
  async function propose() {
    if (pairOn) return proposePair();
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
    const job = createOverlayJob({
      mask: voxels,
      shape: grid.shape,
      affine: grid.affine,
      frame: shownFrame,
      view,
      isocenter,
      search: { polarity, sensitivity, fit_detector_scale: fit },
    });
    setRun({
      scope: started,
      kind: "proposal",
      job,
      finish: () => {
        const result = job.result();
        return {
          result,
          matrix: result.proposal?.matrix,
          view: result.proposal?.view ?? view,
        };
      },
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
      // One frame, or one from each plane; each is checked against the record.
      const named = isBiplane(savedInputs) ? savedInputs.planes : [savedInputs],
        verified: VerifiedFrame[] = [];
      for (const entry of named) {
        const one = await loadVerifiedFrame(
          next,
          entry.plane,
          entry.frame_index,
          signal,
        );
        if (one.sha256 !== entry.frame_sha256) throw new Error("frame");
        verified.push(one);
      }
      const voxels = await maskVoxels(mask, signal);
      if (signal.aborted || live.current !== owned) return;
      const scope = stable({
          key,
          saved: current?.saved.registration_revision,
        }),
        common = {
          mask: voxels,
          shape: grid.shape,
          affine: grid.affine,
          isocenter: savedInputs.isocenter,
        };
      setSourceText(next.source_id);
      setBundle({ ...next, key: owned });
      setSelection({ plane: verified[0].plane, index: verified[0].index });
      setPicks(
        Object.fromEntries(verified.map((one) => [one.plane, one.index])),
      );
      setPaired(isBiplane(savedInputs));
      // The controls show what the record was computed with, not what was
      // last typed, so they cannot contradict the overlay beside them.
      setSettings(
        Object.fromEntries(
          named.map((entry) => [entry.plane, settingsOf(entry)]),
        ),
      );
      setIsocenter(savedInputs.isocenter);
      setFrame(verified[0]);
      if (isBiplane(savedInputs)) {
        const [a, b] = savedInputs.planes,
          job = createBiplaneOverlayJob({
            ...common,
            planes: [
              { ...a, frame: verified[0] },
              { ...b, frame: verified[1] },
            ],
            search: false,
          });
        setRun({
          scope,
          kind: "saved",
          job,
          finish: () => {
            const result = job.result();
            return {
              pair: {
                frames: [verified[0], verified[1]],
                views: [a.view, b.view],
                targets: null,
                points: result.points,
                isocenter: result.isocenter,
                pooling: result.pooling,
                matrix: savedInputs.volume_to_carm_ras,
                proposal: null,
                searched: [a, b],
              },
            };
          },
        });
        return;
      }
      const job = createOverlayJob({
        ...common,
        frame: verified[0],
        view: savedInputs.view,
        search: null,
      });
      setRun({
        scope,
        kind: "saved",
        job,
        finish: () => ({
          result: job.result(),
          matrix: savedInputs.volume_to_carm_ras,
          view: savedInputs.view,
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
    if (!editable || !current || !mask || !reviewed || !shown) return;
    const result = shown.result,
      pair = shown.pair;
    let inputs: SavedInputs,
      kept: Pick<Outcome, "result" | "matrix" | "view" | "pair">;
    if (pairProposal && pair) {
      // A two-plane record also needs the operator's word that both frames
      // show the patient in one position.
      if (!attested) return;
      inputs = {
        confirmed: true,
        same_position_attested: true,
        frame_source_id: pair.frames[0].source_id,
        frame_manifest_revision: pair.frames[0].manifest_revision,
        mask_candidate_id: mask.candidate_id,
        mask_sha256: mask.mask_sha256,
        isocenter: pair.isocenter,
        volume_to_carm_ras: pairProposal.matrix,
        method: BIPLANE_REGISTRATION_METHOD,
        planes: [0, 1].map((k) => ({
          plane: pair.frames[k].plane as "a" | "b",
          frame_index: pair.frames[k].index,
          frame_sha256: pair.frames[k].sha256,
          geometry_source: pair.searched[k].geometry_source,
          view: pairProposal.planes[k].view,
          fit_detector_scale: pair.searched[k].fit_detector_scale,
          detector_scale: pairProposal.planes[k].detector_scale,
          polarity: pair.searched[k].polarity,
          sensitivity: pair.searched[k].sensitivity,
          reported_score: pairProposal.planes[k].score,
          reported_start_score: pairProposal.planes[k].start_score,
        })) as BiplaneRegistrationInputs["planes"],
      };
      kept = { pair };
    } else if (proposal && result && shownFrame) {
      const single: RegistrationInputs = {
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
      inputs = single;
      kept = { result, matrix: proposal.matrix, view: proposal.view };
    } else return;
    const owned = key,
      { release, signal } = begin(true);
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
        ...kept,
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

  if (!allowed) return null;
  const saved = current?.saved.current;
  // With two planes, the controls say which plane they edit.
  const planeWords =
    frames?.planes.length === 2 ? `, plane ${editing.toUpperCase()}` : "";
  return (
    <section
      id="angio-overlay"
      className="native-reformat-studio carm-studio"
      aria-labelledby="angio-overlay-title"
    >
      <h2 id="angio-overlay-title">Angiogram overlay (2D-to-3D proposal)</h2>
      <p className="carm-note">
        Lays the accepted 3D vessel mask over one admitted, retrospective
        angiographic frame, or over one frame from each plane of a declared
        pair. The pose is a proposal for the operator to review, not a validated
        registration, and no accuracy is claimed. It is rigid. One plane does
        not determine depth along the beam; two planes are fitted with a single
        pose. A proposal can be wrong by many millimeters while its scores look
        no worse than a correct one's. It is not for live guidance.
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
              ? savedSummary(
                  current.saved.registration_revision,
                  saved.inputs,
                  saved.result,
                  saved.evidence,
                )
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
                              picks[next.plane] ?? next.frames[0].index,
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
                {frames.planes.length === 2 && (
                  <label>
                    <input
                      type="checkbox"
                      checked={paired}
                      onChange={(e) => setPaired(e.target.checked)}
                    />{" "}
                    Fit one pose to both planes
                  </label>
                )}
                {pairSetup && (
                  <>
                    <p role="status" aria-label="Two-plane selection">
                      Plane A frame {pairSetup[0].index} and plane B frame{" "}
                      {pairSetup[1].index}. Geometry, polarity and sensitivity
                      are set for each plane: choose a plane above to edit its
                      values.
                      {pairAngle !== null
                        ? ` The central rays are ${pairAngle.toFixed(0)}° apart.`
                        : ""}
                    </p>
                    {!pairDistinct && (
                      <p role="alert">
                        Both planes name identical pixels. One image was
                        admitted under both planes, so they cannot be fitted
                        together.
                      </p>
                    )}
                    {pairAngle !== null && !planesFarEnough(pairAngle) && (
                      <p role="alert">
                        A two-plane proposal needs central rays at least{" "}
                        {PAIR_LIMITS.min_plane_angle_deg}° apart. Closer planes
                        add too little to determine depth.
                      </p>
                    )}
                    {pairAngle === null && (
                      <p role="alert">
                        Geometry values of one plane are outside the supported
                        C-arm bounds.
                      </p>
                    )}
                  </>
                )}
              </>
            )}
          </fieldset>
          {plane && (
            <fieldset disabled={!editable}>
              <legend>Acquisition geometry{planeWords}</legend>
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
                    A fitted field size can be wrong by a wide margin. Enter a
                    measured field size where one is available. These values are
                    assumed, not read from the acquisition
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
              <legend>Proposal{planeWords && pairOn ? "" : planeWords}</legend>
              <div className="native-view-controls">
                <label>
                  {planeWords
                    ? `Vessels in plane ${editing.toUpperCase()}'s frame are`
                    : "Vessels in this frame are"}
                  <select
                    value={polarity}
                    onChange={(e) => setPolarity(e.target.value as Polarity)}
                  >
                    <option value="dark">darker than background</option>
                    <option value="bright">brighter than background</option>
                  </select>
                </label>
                <label>
                  2D vessel sensitivity{planeWords}
                  <input
                    type="range"
                    aria-valuetext={sensitivity.toFixed(2)}
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
                    disabled={
                      pairOn
                        ? !pairScope || !grid
                        : !shownFrame || !mask || !view || !grid
                    }
                    onClick={() => void propose()}
                  >
                    {pairOn ? "Propose two-plane overlay" : "Propose overlay"}
                  </button>
                </div>
              )}
              <p className="carm-note">
                {pairOn
                  ? `Fits one rigid pose to both frames at once, searching up to ${PAIR_LIMITS.translation_mm} mm along and ${PAIR_LIMITS.rotation_deg}° about each axis from the entered geometry. Both frames must show the patient in the same position: acquired together, or with no patient or table movement between them. Nothing here can check that.`
                  : `Searches up to ${LIMITS.in_plane_mm} mm in the image plane and ${LIMITS.rotation_deg}° about each axis from the entered geometry, matching projected 3D vessel points to lines found in the frame.`}{" "}
                Catheters, bone edges and vessels absent from either image can
                mislead it.
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
                : pairProposal
                  ? `Unsaved two-plane proposal: moved the vessel points ${pairProposal.translation_mm.toFixed(1)} mm and ${pairProposal.rotation_deg.toFixed(1)}° from the starting pose, with central rays ${pairProposal.plane_angle_deg.toFixed(0)}° apart. ${pairProposal.planes
                      .map(
                        (found, k) =>
                          `Plane ${"AB"[k]}: mean distance from projected 3D vessel points to extracted 2D centerlines ${found.score.mean_distance_mm.toFixed(1)} mm at the isocenter plane (starting pose ${found.start_score.mean_distance_mm.toFixed(1)} mm), ${percent(found.score.matched_fraction)} of points within ${LIMITS.match_mm} mm of a 2D centerline, ${percent(found.score.in_field_fraction)} inside the frame${shown?.pair?.searched[k].fit_detector_scale ? `, field size fitted at ${found.detector_scale.toFixed(2)} times the entered width` : ""}.`,
                      )
                      .join(
                        " ",
                      )} These compare automatically extracted line sets. They are not a registration accuracy, and a wrong pose can score as well as a right one. Review both overlays before confirming.`
                  : shown?.kind === "saved" && (shown.result || shown.pair)
                    ? `Showing the saved operator-confirmed ${shown.pair ? "two-plane " : ""}proposal. It is not a validated registration.`
                    : ""}
          </p>
          {((shown?.result ?? shown?.pair)?.pooling ?? 1) > 1 && (
            <p role="status">
              The vessel mask was coarsened{" "}
              {(shown?.result ?? shown?.pair)?.pooling} times per axis to fit
              the browser's memory bound.
            </p>
          )}
          {shown?.failure && (
            <p role="alert">Overlay computation failed: {shown.failure}.</p>
          )}
          {shown?.pair ? (
            <figure
              className={`native-render-figure angio-overlay-figure${enlarged ? " enlarged" : ""}`}
            >
              <div className="angio-overlay-pair">
                {shown.pair.frames.map((paneFrame, k) => (
                  <OverlayCanvas
                    key={paneFrame.plane}
                    frame={paneFrame}
                    target={
                      showTarget ? (shown.pair?.targets?.[k] ?? null) : null
                    }
                    overlay={
                      showPoints && shown.pair
                        ? {
                            points: shown.pair.points,
                            isocenter: shown.pair.isocenter,
                            matrix: shown.pair.matrix,
                            view: shown.pair.views[k],
                          }
                        : null
                    }
                    label={`Admitted frame ${paneFrame.index}, plane ${paneFrame.plane}${showPoints ? ", with projected 3D vessels" : ""}`}
                  />
                ))}
              </div>
              <figcaption>
                Retrospective admitted frames, plane A then plane B, each
                verified against its recorded SHA-256.
                {showPoints
                  ? ` Cyan: accepted 3D vessel mask projected under the ${shown.kind === "saved" ? "saved operator-confirmed" : "unsaved"} two-plane proposal, one pose for both frames.`
                  : ""}
                {shown.pair.targets && showTarget
                  ? " Amber: lines extracted from each frame, which can include catheters and bone edges."
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
                  <button
                    type="button"
                    aria-pressed={showPoints}
                    onClick={() => setShowPoints(!showPoints)}
                  >
                    {showPoints
                      ? "Hide projected 3D vessels"
                      : "Show projected 3D vessels"}
                  </button>
                </span>
              </figcaption>
            </figure>
          ) : (
            shownFrame && (
              <figure
                className={`native-render-figure angio-overlay-figure${enlarged ? " enlarged" : ""}`}
              >
                <OverlayCanvas
                  frame={shownFrame}
                  target={showTarget ? (shown?.result?.target ?? null) : null}
                  overlay={
                    showPoints && shown?.result && shown.matrix && shown.view
                      ? {
                          points: shown.result.points,
                          isocenter: shown.result.isocenter,
                          matrix: shown.matrix,
                          view: shown.view,
                        }
                      : null
                  }
                  label={`Admitted frame ${shownFrame.index}, plane ${shownFrame.plane}${shown?.result && showPoints ? ", with projected 3D vessels" : ""}`}
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
            )
          )}
          {(proposal || pairProposal) && (
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
                {pairProposal
                  ? "I reviewed both overlays and confirm this pose as an unvalidated working proposal"
                  : "I reviewed the overlay and confirm this pose as an unvalidated working proposal"}
              </label>
              {pairProposal && (
                <label>
                  <input
                    type="checkbox"
                    checked={attested}
                    onChange={(e) =>
                      setAttestedOutcome(e.target.checked ? shown : null)
                    }
                  />{" "}
                  Both frames show the patient in the same position: acquired
                  together, or with no patient or table movement between them
                </label>
              )}
              <div className="native-actions">
                <button
                  type="button"
                  disabled={!reviewed || (!!pairProposal && !attested)}
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
