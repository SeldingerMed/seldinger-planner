/** The aorta and iliac model over an abdominal X-ray frame, lined up on the
 * bone, confirmed by the operator and saved with the case.
 *
 * The model is the raw CTA inference's export for this very scan; the server
 * admits it only when it names this scan's SHA-256. The line-up is the
 * guarded bone line-up (./abdominalLineup.ts). Nothing is saved without the
 * operator's confirmation.
 *
 * Over the saved line-up the operator may mark a wire in an iliac artery and
 * scan points where they lie on the frame; one wire-and-breathing correction
 * is proposed from those marks (./vesselCorrection.ts) and drawn only once
 * confirmed. It is held for this view and not saved with the case. */
import { useEffect, useMemo, useRef, useState } from "react";
import type { NVImage } from "@niivue/niivue";
import type { CaseState } from "./api";
import {
  ABDOMINAL_LINEUP_METHOD,
  createAbdominalLineupJob,
  projectBranches,
  type AbdominalLineupProposal,
  type ModelBranch,
} from "./abdominalLineup";
import { BONE_LINEUP, boneSamples } from "./boneLineup";
import { angleLabel, validateView, type ViewNumbers } from "./carmGeometry";
import { createNativeSampler } from "./nativeSampling";
import {
  correctBranches,
  proposeCorrection,
  type Breathing,
  type CorrectionProposal,
  type Landmark,
  type WireMark,
} from "./vesselCorrection";
import type { Vec3 } from "./obliqueSlice";
import {
  FRAME_SOURCE_ID,
  loadFrameBundle,
  loadVerifiedFrame,
  type FrameBundle,
  type FramePlane,
  type VerifiedFrame,
} from "./projectionFrames";
import type { Identity } from "./territoryWorkflow";

type Props = {
  caseState: Pick<CaseState, "case_id" | "image_sha256" | "artifact_version">;
  binding: Pick<Identity, "reference_revision">;
  volume: NVImage | null;
  cursor: Vec3 | null;
  disabled?: boolean;
};

type ModelRecord = {
  model_revision: number;
  current:
    | { status: "not_confirmed" | "stale" }
    | {
        status: "current";
        body_sha256: string;
        body: {
          source_sha256: string;
          proposal: { branches: ModelBranch[] };
        };
      };
};
type SecondView =
  | { status: "not_given" }
  | {
      status: "set_aside";
      plane: string;
      frame_index: number;
      frame_sha256: string;
      reason: string;
    };
type UsedPlane = {
  plane: FramePlane["plane"];
  frame_index: number;
  frame_sha256: string;
  geometry_source: "frame_manifest" | "operator_entered";
  view: ViewNumbers;
  reported_score: number;
};
type LineupInputs = {
  confirmed: true;
  method: typeof ABDOMINAL_LINEUP_METHOD;
  engine_method: string;
  frame_source_id: string;
  frame_manifest_revision: string;
  planes: UsedPlane[];
  second_view: SecondView;
  depth: "not_determined_single_view" | "two_views";
  model_revision: number;
  model_sha256: string;
  bone_threshold_hu: number;
  reported_start_score: number;
  isocenter: Vec3;
  volume_to_carm_ras: number[][];
  same_position: boolean;
};
type LineupRecord = {
  registration_revision: number;
  current:
    | { status: "not_confirmed" | "stale" }
    | {
        status: "current";
        evidence: "verified" | "unavailable";
        inputs: LineupInputs;
        result: { rotation_deg: number; isocenter_shift_mm: number };
      };
};
/** One frame chosen for the line-up, with the view it is read in. */
type Chosen = {
  frame: VerifiedFrame;
  view: ViewNumbers;
  geometry_source: UsedPlane["geometry_source"];
};
type Drawn = {
  frames: Chosen[];
  matrix: number[][];
  isocenter: Vec3;
  kind: "proposal" | "saved";
  proposal: AbdominalLineupProposal | null;
};

const ENTERED_DEFAULT: ViewNumbers = {
  primary_deg: 0,
  secondary_deg: 0,
  source_detector_mm: 1140,
  source_isocenter_mm: 745,
  detector_width_mm: 306,
  detector_height_mm: 306,
};
const BRANCH_COLOR: Record<ModelBranch["name"], string> = {
  aorta: "rgba(255, 64, 64, 0.9)",
  right_iliac: "rgba(0, 200, 255, 0.9)",
  left_iliac: "rgba(255, 200, 0, 0.9)",
};
const MARK_COLOR = "rgba(0, 255, 120, 0.95)";
type MarkKind = WireMark["branch"] | "landmark";
const MARK_WORDS: Record<MarkKind, string> = {
  right_iliac: "Wire in the right iliac",
  left_iliac: "Wire in the left iliac",
  landmark: "The scan point at the cursor",
};
/** Breathing moves the aorta from nothing at its lowest point, where the
 * pelvis holds it, to the whole shift at its highest. */
function breathingOf(branches: readonly ModelBranch[]): Breathing | null {
  const s = branches
    .filter((b) => b.name === "aorta")
    .flatMap((b) => b.path_ras.map((p) => p[2]));
  if (s.length < 2) return null;
  const low = Math.min(...s),
    high = Math.max(...s);
  return high - low > 1 ? { anchor_s: low, full_s: high } : null;
}
type Correction = {
  wire: WireMark[];
  landmarks: Landmark[];
  kind: MarkKind;
  proposal: CorrectionProposal | null;
  confirmed: boolean;
};
const NO_CORRECTION: Correction = {
  wire: [],
  landmarks: [],
  kind: "right_iliac",
  proposal: null,
  confirmed: false,
};

const IDENTITY = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];
const REASON_WORDS: Record<string, string> = {
  bone_not_held: "it did not show the bone",
  moved_first_frame: "taking it would have moved the first frame off its bone",
  too_close: "its beam is too close to the first frame's to place depth",
};

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () =>
      reject(new Error("The model file could not be read."));
    reader.readAsText(file);
  });
}

async function send<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body ? "PUT" : "GET",
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    let detail = `Request failed (${response.status})`;
    try {
      const value = await response.json();
      if (typeof value?.detail === "string") detail = value.detail;
    } catch {
      // The status alone.
    }
    throw new Error(detail);
  }
  return response.json();
}

/** The saved or proposed line-up in words. One frame does not place depth. */
export function lineupWords(
  depth: LineupInputs["depth"],
  second: SecondView | { status: "set_aside"; reason: string },
): string {
  const depthWords =
    depth === "two_views"
      ? "Placed in 3D from two frames."
      : "Placed across the frame from one frame; depth along its beam is not determined.";
  const secondWords =
    second.status === "set_aside"
      ? ` The second frame was set aside: ${REASON_WORDS[second.reason] ?? second.reason}.`
      : "";
  return depthWords + secondWords;
}

function Overlay({
  chosen,
  branches,
  matrix,
  isocenter,
  label,
  marks = [],
  onPick,
}: {
  chosen: Chosen;
  branches: ModelBranch[];
  matrix: number[][];
  isocenter: Vec3;
  label: string;
  marks?: number[][];
  onPick?: (pixel: [number, number]) => void;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    const { width, height, gray } = chosen.frame,
      image = context.createImageData(width, height);
    for (let i = 0, o = 0; i < gray.length; i++, o += 4) {
      image.data[o] = image.data[o + 1] = image.data[o + 2] = gray[i];
      image.data[o + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    const lines = projectBranches(branches, matrix, chosen.view, isocenter, {
      width,
      height,
    });
    context.lineWidth = Math.max(1, width / 300);
    for (const line of lines) {
      context.strokeStyle = BRANCH_COLOR[line.name];
      // The lumen edge on each side of the centerline, and the centerline.
      context.beginPath();
      line.points.forEach(([x, y], i) =>
        i ? context.lineTo(x, y) : context.moveTo(x, y),
      );
      context.stroke();
    }
    context.fillStyle = MARK_COLOR;
    const side = Math.max(3, width / 150);
    for (const [x, y] of marks)
      context.fillRect(x - side / 2, y - side / 2, side, side);
  }, [chosen, branches, matrix, isocenter, marks]);
  return (
    <canvas
      ref={canvas}
      width={chosen.frame.width}
      height={chosen.frame.height}
      role="img"
      aria-label={label}
      style={{ maxWidth: "100%", cursor: onPick ? "crosshair" : undefined }}
      onClick={
        onPick
          ? (event) => {
              const box = event.currentTarget.getBoundingClientRect(),
                w = box.width || chosen.frame.width,
                h = box.height || chosen.frame.height;
              onPick([
                ((event.clientX - box.left) * chosen.frame.width) / w,
                ((event.clientY - box.top) * chosen.frame.height) / h,
              ]);
            }
          : undefined
      }
    />
  );
}

export default function AbdominalOverlayPanel({
  caseState,
  binding,
  volume,
  cursor,
  disabled = false,
}: Props) {
  const caseId = caseState.case_id;
  const [model, setModel] = useState<ModelRecord | null>(null);
  const [lineup, setLineup] = useState<LineupRecord | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [bundle, setBundle] = useState<FrameBundle | null>(null);
  const [firstKey, setFirstKey] = useState("");
  const [secondKey, setSecondKey] = useState("");
  const [entered, setEntered] = useState<ViewNumbers>(ENTERED_DEFAULT);
  const [secondEntered, setSecondEntered] = useState<ViewNumbers>({
    ...ENTERED_DEFAULT,
    primary_deg: 90,
  });
  const [samePosition, setSamePosition] = useState(false);
  const [busy, setBusy] = useState(false);
  const [drawn, setDrawn] = useState<Drawn | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [correction, setCorrection] = useState<Correction>(NO_CORRECTION);
  useEffect(() => setCorrection(NO_CORRECTION), [drawn]);

  const reload = async () => {
    const base = `/api/cases/${caseId}`;
    const [m, l] = await Promise.all([
      send<ModelRecord>(`${base}/aortoiliac-model`),
      send<LineupRecord>(`${base}/bone-lineup-registration`),
    ]);
    setModel(m);
    setLineup(l);
  };
  useEffect(() => {
    setDrawn(null);
    setReviewed(false);
    reload().catch((error) => setMessage(String(error.message ?? error)));
  }, [caseId, caseState.artifact_version, binding.reference_revision]);

  const current = model?.current.status === "current" ? model.current : null;
  const branches = current?.body.proposal.branches ?? null;
  const grid = useMemo(() => {
    try {
      return volume ? createNativeSampler(volume) : null;
    } catch {
      return null;
    }
  }, [volume]);
  const locked = disabled || busy;

  async function admitModel(file: File) {
    setBusy(true);
    setMessage(null);
    try {
      const value = JSON.parse(await readText(file));
      await send(`/api/cases/${caseId}/aortoiliac-model`, {
        artifact_version: caseState.artifact_version,
        reference_revision: binding.reference_revision,
        model_revision: model?.model_revision ?? 0,
        export: value,
      });
      await reload();
      setDrawn(null);
    } catch (error) {
      setMessage(
        error instanceof SyntaxError
          ? "The model file is not JSON."
          : String((error as Error).message ?? error),
      );
    } finally {
      setBusy(false);
    }
  }

  async function openFrames() {
    setMessage(null);
    if (!FRAME_SOURCE_ID.test(sourceId)) {
      setMessage("Enter the name of an admitted frame source.");
      return;
    }
    setBusy(true);
    try {
      const next = await loadFrameBundle(sourceId);
      setBundle(next);
      const first = next.planes[0];
      setFirstKey(`${first.plane}:${first.frames[0].index}`);
      setSecondKey("");
      setDrawn(null);
    } catch (error) {
      setMessage(String((error as Error).message ?? error));
    } finally {
      setBusy(false);
    }
  }

  const options = bundle
    ? bundle.planes.flatMap((plane) =>
        plane.frames.map((frame) => ({
          key: `${plane.plane}:${frame.index}`,
          label: `Plane ${plane.plane}, frame ${frame.index}${plane.geometry ? `, ${angleLabel(plane.geometry.primary_deg, plane.geometry.secondary_deg)}` : ""}`,
          plane,
        })),
      )
    : [];

  async function choose(key: string, fallback: ViewNumbers): Promise<Chosen> {
    const [label, index] = key.split(":");
    const plane = bundle?.planes.find((item) => item.plane === label);
    if (!bundle || !plane) throw new Error("Choose a frame");
    const frame = await loadVerifiedFrame(bundle, plane.plane, Number(index));
    return plane.geometry
      ? { frame, view: plane.geometry, geometry_source: "frame_manifest" }
      : {
          frame,
          view: validateView(fallback),
          geometry_source: "operator_entered",
        };
  }

  async function lineUp() {
    if (!grid || !volume || !branches) return;
    setBusy(true);
    setMessage(null);
    setReviewed(false);
    try {
      const chosen = [await choose(firstKey, entered)];
      if (secondKey) chosen.push(await choose(secondKey, secondEntered));
      // Plane a, then plane b; the engine itself starts from the frame
      // nearer the front.
      chosen.sort((x, y) => x.frame.plane.localeCompare(y.frame.plane));
      if (chosen.length === 2 && !samePosition)
        throw new Error(
          "Confirm that the patient did not move between the two frames.",
        );
      const data = Float32Array.from(
        grid.raw as ArrayLike<number>,
        (value) => value * grid.slope + grid.inter,
      );
      const samples = boneSamples({
        data,
        shape: grid.shape,
        affine: volume.getAffine(),
      });
      // The start: the scan as it lies, centered on the cursor.
      const isocenter: Vec3 = cursor
        ? [...cursor]
        : (volume
            .getAffine()
            .slice(0, 3)
            .map(
              (row) =>
                row[0] * ((grid.shape[0] - 1) / 2) +
                row[1] * ((grid.shape[1] - 1) / 2) +
                row[2] * ((grid.shape[2] - 1) / 2) +
                row[3],
            ) as Vec3);
      const job = createAbdominalLineupJob({
        samples,
        frames: chosen.map((item) => ({
          view: item.view,
          isocenter,
          pixels: item.frame.gray,
          width: item.frame.width,
          height: item.frame.height,
        })),
        start: IDENTITY,
      });
      // Short slices keep the page responsive.
      for (;;) {
        const until = performance.now() + 40;
        if (job.advance(() => performance.now() > until)) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const proposal = job.result();
      setDrawn({
        frames: proposal.used.map((k) => chosen[k]),
        matrix: proposal.matrix,
        isocenter,
        kind: "proposal",
        proposal,
      });
      // Kept for the record of a set-aside frame.
      setAside.current =
        proposal.second_view.status === "set_aside"
          ? chosen[proposal.second_view.frame]
          : null;
    } catch (error) {
      setMessage(String((error as Error).message ?? error));
    } finally {
      setBusy(false);
    }
  }
  const setAside = useRef<Chosen | null>(null);

  async function save() {
    if (!drawn?.proposal || !current || !bundle || !reviewed) return;
    const p = drawn.proposal;
    const aside = setAside.current;
    const two = p.depth === "two_views";
    const inputs: LineupInputs = {
      confirmed: true,
      method: ABDOMINAL_LINEUP_METHOD,
      engine_method: p.engine_method,
      frame_source_id: bundle.source_id,
      frame_manifest_revision: bundle.manifest_revision,
      planes: drawn.frames.map((item, k) => ({
        plane: item.frame.plane,
        frame_index: item.frame.index,
        frame_sha256: item.frame.sha256,
        geometry_source: item.geometry_source,
        view: item.view,
        reported_score: p.frame_scores[k],
      })),
      second_view:
        p.second_view.status === "set_aside" && aside
          ? {
              status: "set_aside",
              plane: aside.frame.plane,
              frame_index: aside.frame.index,
              frame_sha256: aside.frame.sha256,
              reason: p.second_view.reason,
            }
          : { status: "not_given" },
      depth: p.depth,
      model_revision: model?.model_revision ?? 0,
      model_sha256: current.body_sha256,
      bone_threshold_hu: BONE_LINEUP.threshold_hu,
      reported_start_score: p.start_score,
      isocenter: drawn.isocenter,
      volume_to_carm_ras: p.matrix,
      same_position: two && samePosition,
    };
    setBusy(true);
    setMessage(null);
    try {
      await send(`/api/cases/${caseId}/bone-lineup-registration`, {
        artifact_version: caseState.artifact_version,
        reference_revision: binding.reference_revision,
        registration_revision: lineup?.registration_revision ?? 0,
        inputs,
      });
      await reload();
      setDrawn({ ...drawn, kind: "saved" });
    } catch (error) {
      setMessage(String((error as Error).message ?? error));
    } finally {
      setBusy(false);
    }
  }

  async function showSaved() {
    if (lineup?.current.status !== "current" || !branches) return;
    const saved = lineup.current.inputs;
    setBusy(true);
    setMessage(null);
    try {
      const next = await loadFrameBundle(saved.frame_source_id);
      if (next.manifest_revision !== saved.frame_manifest_revision)
        throw new Error("The saved line-up's frames changed.");
      setBundle(next);
      setSourceId(next.source_id);
      const frames = await Promise.all(
        saved.planes.map(async (entry) => ({
          frame: await loadVerifiedFrame(next, entry.plane, entry.frame_index),
          view: entry.view,
          geometry_source: entry.geometry_source,
        })),
      );
      if (
        frames.some(
          (item, k) => item.frame.sha256 !== saved.planes[k].frame_sha256,
        )
      )
        throw new Error("The saved line-up's frames changed.");
      setDrawn({
        frames,
        matrix: saved.volume_to_carm_ras,
        isocenter: saved.isocenter,
        kind: "saved",
        proposal: null,
      });
    } catch (error) {
      setMessage(String((error as Error).message ?? error));
    } finally {
      setBusy(false);
    }
  }

  const saved = lineup?.current.status === "current" ? lineup.current : null;
  const numberField = (
    view: ViewNumbers,
    set: (view: ViewNumbers) => void,
    key: keyof ViewNumbers,
    label: string,
  ) => (
    <label key={key}>
      {label}
      <input
        type="number"
        value={view[key]}
        disabled={locked}
        onChange={(event) =>
          set({ ...view, [key]: Number(event.target.value) })
        }
      />
    </label>
  );
  // Two frames are the two planes of one biplane acquisition.
  const firstPlane = firstKey.split(":")[0];
  const secondAllowed = (key: string) => {
    const plane = key.split(":")[0];
    return (
      (firstPlane === "a" && plane === "b") ||
      (firstPlane === "b" && plane === "a")
    );
  };
  const geometryOf = (key: string) =>
    options.find((option) => option.key === key)?.plane.geometry ?? null;

  return (
    <section aria-label="Aorta and iliac overlay on bone" className="studio">
      <h2>Aorta and iliac overlay, lined up on bone</h2>
      <p role="status" aria-label="Aorta and iliac model">
        {current
          ? `Model from this scan (SHA-256 ${current.body.source_sha256.slice(0, 12)}), revision ${model?.model_revision}: ${current.body.proposal.branches.map((b) => b.name.replace("_", " ")).join(", ")}. A proposal to review.`
          : "No aorta and iliac model is loaded for this scan."}
      </p>
      <label>
        Model export (JSON)
        <input
          type="file"
          accept="application/json,.json"
          disabled={locked}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void admitModel(file);
          }}
        />
      </label>
      <p role="status" aria-label="Saved bone line-up">
        {saved
          ? `Saved operator-confirmed line-up, revision ${lineup?.registration_revision}: ${lineupWords(saved.inputs.depth, saved.inputs.second_view)} Moved ${saved.result.isocenter_shift_mm.toFixed(1)} mm and ${saved.result.rotation_deg.toFixed(1)}° from the scan as it lies. Its frames and model are ${saved.evidence === "verified" ? "installed and unchanged" : "no longer available unchanged"}.`
          : lineup?.current.status === "stale"
            ? "The saved line-up belongs to an earlier version of this case."
            : "No confirmed line-up is saved for this case."}
      </p>
      {saved?.evidence === "verified" && (
        <button
          type="button"
          disabled={locked || !branches}
          onClick={() => void showSaved()}
        >
          Show saved overlay
        </button>
      )}
      <fieldset disabled={locked || !current}>
        <legend>Frames</legend>
        <label>
          Frame source
          <input
            value={sourceId}
            onChange={(event) => setSourceId(event.target.value.trim())}
          />
        </label>
        <button type="button" onClick={() => void openFrames()}>
          Open frames
        </button>
        {bundle && (
          <>
            <label>
              First frame
              <select
                value={firstKey}
                onChange={(event) => {
                  setFirstKey(event.target.value);
                  setSecondKey("");
                }}
              >
                {options.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            {!geometryOf(firstKey) && (
              <div aria-label="First frame view">
                {numberField(
                  entered,
                  setEntered,
                  "primary_deg",
                  "Primary angle",
                )}
                {numberField(
                  entered,
                  setEntered,
                  "secondary_deg",
                  "Secondary angle",
                )}
                {numberField(
                  entered,
                  setEntered,
                  "source_detector_mm",
                  "Source to detector, mm",
                )}
                {numberField(
                  entered,
                  setEntered,
                  "source_isocenter_mm",
                  "Source to isocenter, mm",
                )}
                {numberField(
                  entered,
                  setEntered,
                  "detector_width_mm",
                  "Field width, mm",
                )}
                {numberField(
                  entered,
                  setEntered,
                  "detector_height_mm",
                  "Field height, mm",
                )}
              </div>
            )}
            <label>
              Second frame
              <select
                value={secondKey}
                onChange={(event) => setSecondKey(event.target.value)}
              >
                <option value="">None</option>
                {options
                  .filter((option) => secondAllowed(option.key))
                  .map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
              </select>
            </label>
            {secondKey && !geometryOf(secondKey) && (
              <div aria-label="Second frame view">
                {numberField(
                  secondEntered,
                  setSecondEntered,
                  "primary_deg",
                  "Primary angle",
                )}
                {numberField(
                  secondEntered,
                  setSecondEntered,
                  "secondary_deg",
                  "Secondary angle",
                )}
                {numberField(
                  secondEntered,
                  setSecondEntered,
                  "source_detector_mm",
                  "Source to detector, mm",
                )}
                {numberField(
                  secondEntered,
                  setSecondEntered,
                  "source_isocenter_mm",
                  "Source to isocenter, mm",
                )}
                {numberField(
                  secondEntered,
                  setSecondEntered,
                  "detector_width_mm",
                  "Field width, mm",
                )}
                {numberField(
                  secondEntered,
                  setSecondEntered,
                  "detector_height_mm",
                  "Field height, mm",
                )}
              </div>
            )}
            {secondKey && (
              <label>
                <input
                  type="checkbox"
                  checked={samePosition}
                  onChange={(event) => setSamePosition(event.target.checked)}
                />
                The patient did not move between the two frames
              </label>
            )}
            <button
              type="button"
              disabled={!grid || !branches || !firstKey}
              onClick={() => void lineUp()}
            >
              Line up on bone
            </button>
          </>
        )}
      </fieldset>
      {message && <p role="alert">{message}</p>}
      {drawn && branches && (
        <div aria-label="Overlay">
          {drawn.kind === "proposal" && drawn.proposal && (
            <p role="status" aria-label="Line-up proposal">
              {`Unsaved line-up: ${lineupWords(drawn.proposal.depth, drawn.proposal.second_view)} Bone agreement ${drawn.proposal.frame_scores.map((s) => s.toFixed(2)).join(" and ")}, from ${drawn.proposal.start_score.toFixed(2)} at the start. Review the overlay before confirming.`}
            </p>
          )}
          {drawn.frames.map((item, k) => {
            const marking = drawn.kind === "saved" && k === 0,
              shown =
                marking && correction.confirmed && correction.proposal
                  ? (correctBranches(
                      branches,
                      correction.proposal.params,
                      breathingOf(branches)!,
                    ) as ModelBranch[])
                  : branches;
            return (
              <Overlay
                key={k}
                chosen={item}
                branches={shown}
                matrix={drawn.matrix}
                isocenter={drawn.isocenter}
                label={`${drawn.kind === "saved" ? "Saved" : "Proposed"} overlay on plane ${item.frame.plane}, frame ${item.frame.index}${shown !== branches ? ", corrected for wire and breathing" : ""}`}
                marks={
                  marking
                    ? [
                        ...correction.wire.map((m) => m.pixel),
                        ...correction.landmarks.map((m) => m.pixel),
                      ]
                    : []
                }
                onPick={
                  marking && !correction.confirmed && !locked
                    ? (pixel) => {
                        if (correction.kind === "landmark") {
                          if (!cursor) {
                            setMessage(
                              "Set the cursor on the scan point first, then mark where it lies on the frame.",
                            );
                            return;
                          }
                          setCorrection({
                            ...correction,
                            landmarks: [
                              ...correction.landmarks,
                              { ras: [...cursor], pixel },
                            ],
                            proposal: null,
                          });
                        } else
                          setCorrection({
                            ...correction,
                            wire: [
                              ...correction.wire,
                              { branch: correction.kind, pixel },
                            ],
                            proposal: null,
                          });
                      }
                    : undefined
                }
              />
            );
          })}
          {drawn.kind === "saved" && breathingOf(branches) && (
            <CorrectionControls
              correction={correction}
              locked={locked}
              onChange={setCorrection}
              onPropose={() => {
                const first = drawn.frames[0];
                setCorrection({
                  ...correction,
                  proposal: proposeCorrection({
                    branches,
                    wire: correction.wire,
                    landmarks: correction.landmarks,
                    breathing: breathingOf(branches)!,
                    matrix: drawn.matrix,
                    view: first.view,
                    isocenter: drawn.isocenter,
                    size: {
                      width: first.frame.width,
                      height: first.frame.height,
                    },
                  }),
                });
              }}
            />
          )}
          {drawn.kind === "proposal" && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={reviewed}
                  disabled={locked}
                  onChange={(event) => setReviewed(event.target.checked)}
                />
                I reviewed the bone and the model on the frame
              </label>
              <button
                type="button"
                disabled={locked || !reviewed}
                onClick={() => void save()}
              >
                Confirm and save line-up
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

const STANDS_WORDS: Record<string, string> = {
  too_few_marks:
    "Too few marks: at least two of a kind are needed to fit anything.",
  no_gain:
    "The correction does not bring the marks enough nearer than the line-up alone.",
};

function CorrectionControls({
  correction,
  locked,
  onChange,
  onPropose,
}: {
  correction: Correction;
  locked: boolean;
  onChange: (next: Correction) => void;
  onPropose: () => void;
}) {
  const { proposal } = correction,
    marked = correction.wire.length + correction.landmarks.length;
  return (
    <fieldset aria-label="Wire and breathing correction">
      <legend>Wire and breathing</legend>
      {!correction.confirmed && (
        <>
          <p>Choose what you mark, then click it on the first frame above.</p>
          {(Object.keys(MARK_WORDS) as MarkKind[]).map((kind) => (
            <label key={kind}>
              <input
                type="radio"
                name="correction-mark"
                checked={correction.kind === kind}
                disabled={locked}
                onChange={() => onChange({ ...correction, kind })}
              />
              {MARK_WORDS[kind]}
            </label>
          ))}
          <p role="status" aria-label="Correction marks">
            {`${correction.wire.filter((m) => m.branch === "right_iliac").length} right iliac wire, ${correction.wire.filter((m) => m.branch === "left_iliac").length} left iliac wire, ${correction.landmarks.length} scan point marks.`}
          </p>
          <button
            type="button"
            disabled={locked || !marked}
            onClick={onPropose}
          >
            Propose correction
          </button>
          <button
            type="button"
            disabled={locked || !marked}
            onClick={() => onChange(NO_CORRECTION)}
          >
            Clear marks
          </button>
        </>
      )}
      {proposal && (
        <p role="status" aria-label="Correction proposal">
          {proposal.status === "proposed"
            ? `Marks ${proposal.rigid_rms_px.toFixed(1)} px from the line-up alone, ${proposal.corrected_rms_px.toFixed(1)} px corrected: right iliac straightened ${Math.round(100 * proposal.params.straighten.right_iliac)}%, left ${Math.round(100 * proposal.params.straighten.left_iliac)}%, breathing ${proposal.params.shift_mm.toFixed(1)} mm along the body.${correction.confirmed ? " Confirmed for this view; not saved with the case." : ""}`
            : `The line-up stands. ${STANDS_WORDS[proposal.reason ?? ""] ?? ""} Marks ${proposal.rigid_rms_px.toFixed(1)} px from the line-up.`}
        </p>
      )}
      {proposal?.status === "proposed" && !correction.confirmed && (
        <button
          type="button"
          disabled={locked}
          onClick={() => onChange({ ...correction, confirmed: true })}
        >
          Confirm correction
        </button>
      )}
      {correction.confirmed && (
        <button
          type="button"
          disabled={locked}
          onClick={() => onChange(NO_CORRECTION)}
        >
          Undo correction
        </button>
      )}
    </fieldset>
  );
}
