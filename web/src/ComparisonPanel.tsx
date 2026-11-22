/** Comparison of a saved 2D-to-3D proposal's frames with the accepted vessel
 * mask: vessel diameter per segment from the mask and from each frame, the
 * narrowest place of each vessel run, the frame at which contrast reaches
 * each segment, a place marked in a frame carried to the 3D model, and a
 * planned device against the marked ends of the deployed one. Everything is
 * computed here from the frames, the mask and the saved pose; nothing is
 * saved. Pixels are read, verified and drawn; they are never sent. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, MEASUREMENTS_NOT_CURRENT, RevisionConflictError } from "./api";
import { carryPoint, type CarriedPoint, type FrameMark } from "./carryPoint";
import type { ViewNumbers } from "./carmGeometry";
import {
  createComparisonJob,
  type ComparisonJob,
  type ComparisonResult,
  type PlaneComparison,
} from "./comparisonJob";
import type { Narrowest } from "./diameterComparison";
import { compareDevice, liesOnPath } from "./deviceComparison";
import {
  parseDeviceScenarios,
  type DeviceScenarioEntry,
} from "./deviceScenarios";
import { DEVICE_CATALOG } from "./devices/analysis";
import type { Vec3 } from "./obliqueSlice";
import {
  decodeVesselMask,
  FRAME_INTEGRITY_FAILURE,
  isBiplane,
  loadFrameBundle,
  loadVerifiedFrame,
  type SavedRegistration,
  type VerifiedFrame,
} from "./projectionFrames";
import { projectRegistered } from "./projectionRegistration";
import {
  loadSegmentationMask,
  SEGMENTATION_INTEGRITY_FAILURE,
  type SegmentationEntry,
} from "./segmentation";
import { stable, type Identity } from "./territoryWorkflow";

export const COMPARISON_REQUEST_TIMEOUT_MS = 30_000;
const SLICE_MS = 12,
  HIDDEN_SLICE_MS = 800,
  /** Times the saved device plans are asked for before a refusal stands. */
  DEVICE_PLAN_READS = 2,
  /** The wait before they are asked for again, for a change of several
   * steps under way at the first read to be over. */
  DEVICE_PLAN_WAIT_MS = 250;

type Props = {
  identity: Identity;
  binding: Pick<Identity, "case_id" | "image_sha256" | "reference_revision">;
  /** The parsed saved registration of this case revision. */
  registration: SavedRegistration;
  /** The accepted vessel mask, or null. */
  mask: SegmentationEntry | null;
  grid: { shape: readonly [number, number, number]; affine: number[][] } | null;
  /** The studio is busy; nothing here may start. */
  disabled: boolean;
  /** Called with true while a request of this panel is open. */
  onRequests?: (open: boolean) => void;
  /** Called with true while the comparison is being computed. */
  onComputing?: (computing: boolean) => void;
};
type Computed = {
  key: string;
  frames: VerifiedFrame[];
  views: ViewNumbers[];
  isocenter: Vec3;
  matrix: number[][];
  result: ComparisonResult;
  /** Saved planned devices that lie along a vessel. */
  devices: DeviceScenarioEntry[];
  /** The saved device plans could not be read. */
  devices_unread: boolean;
};
type Outcome = Computed | { key: string; failure: string };
/** What a click in a frame marks. */
type Marking = "place" | "end_1" | "end_2";
const MARKINGS: Record<Marking, { word: string; color: string }> = {
  place: { word: "A place", color: "rgba(255, 214, 0, 0.95)" },
  end_1: { word: "Device end 1", color: "rgba(224, 64, 251, 0.95)" },
  end_2: { word: "Device end 2", color: "rgba(255, 145, 0, 0.95)" },
};
type Marks = Record<Marking, FrameMark[]>;
const NO_MARKS: Marks = { place: [], end_1: [], end_2: [] };
/** The stored frames are not the ones the proposal was confirmed on. */
const NOT_THE_CONFIRMED = "not the confirmed frames";

/** The frame pixel under a pointer on a canvas shown at any size. */
export function framePixel(
  box: { left: number; top: number; width: number; height: number },
  frame: { width: number; height: number },
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  if (!(box.width > 0 && box.height > 0)) return null;
  const x = ((clientX - box.left) * frame.width) / box.width,
    y = ((clientY - box.top) * frame.height) / box.height;
  return x >= 0 && y >= 0 && x <= frame.width && y <= frame.height
    ? { x, y }
    : null;
}

/** Runs with a narrowest place in the mask or in a frame, the largest
 * narrowing first. */
export function narrowestRows(
  planes: Pick<PlaneComparison, "diameters">[],
): { run: number; mask: Narrowest | null; frames: (Narrowest | null)[] }[] {
  const most = (row: {
    mask: Narrowest | null;
    frames: (Narrowest | null)[];
  }) =>
    Math.max(
      row.mask?.percent ?? 0,
      ...row.frames.map((one) => one?.percent ?? 0),
    );
  return planes[0].diameters.runs
    .map((run, r) => ({
      run: run.run,
      mask: run.mask,
      frames: planes.map((plane) => plane.diameters.runs[r].frame),
    }))
    .filter((row) => row.mask || row.frames.some(Boolean))
    .sort((a, b) => most(b) - most(a));
}

const mm = (value: number | null | undefined) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? "–"
    : value.toFixed(1);

/** One frame with the vessel axis over it: cyan where the vessel was
 * measured in the frame, orange elsewhere; the marks and the points they were
 * carried to. A click marks; so does Enter at a cursor the arrow keys move
 * from the frame's middle, by a pixel or with Shift by ten. */
function ComparisonCanvas({
  frame,
  plane,
  computed,
  marks,
  carried,
  label,
  onMark,
}: {
  frame: VerifiedFrame;
  plane: number;
  computed: Computed;
  marks: Marks;
  carried: Record<Marking, CarriedPoint | null>;
  label: string;
  onMark: (x: number, y: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null),
    // The frame's picture is built once and drawn again under every change
    // of the cursor and the marks.
    picture = useRef<{ of: VerifiedFrame; image: ImageData } | null>(null),
    [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    const { width, height, gray } = frame;
    if (picture.current?.of !== frame) {
      const image = context.createImageData(width, height);
      for (let i = 0, o = 0; i < gray.length; i++, o += 4) {
        image.data[o] = image.data[o + 1] = image.data[o + 2] = gray[i];
        image.data[o + 3] = 255;
      }
      picture.current = { of: frame, image };
    }
    context.putImageData(picture.current.image, 0, 0);
    const size = Math.max(1, Math.round(width / 256)),
      { placed, frame_mm } = computed.result.planes[plane];
    for (let k = 0; k < frame_mm.length; k++) {
      const x = placed.pixels[2 * k],
        y = placed.pixels[2 * k + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      context.fillStyle = Number.isFinite(frame_mm[k])
        ? "rgba(0, 229, 255, 0.9)"
        : "rgba(255, 167, 38, 0.9)";
      context.fillRect(x - size / 2, y - size / 2, size, size);
    }
    context.lineWidth = size;
    if (cursor) {
      context.strokeStyle = "rgba(255, 255, 255, 0.95)";
      context.beginPath();
      context.moveTo(cursor.x - 8 * size, cursor.y);
      context.lineTo(cursor.x + 8 * size, cursor.y);
      context.moveTo(cursor.x, cursor.y - 8 * size);
      context.lineTo(cursor.x, cursor.y + 8 * size);
      context.stroke();
    }
    for (const marking of Object.keys(MARKINGS) as Marking[]) {
      context.strokeStyle = context.fillStyle = MARKINGS[marking].color;
      const mark = marks[marking].find((one) => one.plane === plane);
      if (mark) {
        context.beginPath();
        context.arc(mark.x, mark.y, 5 * size, 0, 2 * Math.PI);
        context.stroke();
      }
      const point = carried[marking];
      if (!point) continue;
      const at = projectRegistered(
        computed.views[plane],
        computed.isocenter,
        computed.matrix,
        Float32Array.from(point.point),
        { width, height },
      );
      if (Number.isFinite(at[0]))
        context.fillRect(
          at[0] - 2 * size,
          at[1] - 2 * size,
          4 * size,
          4 * size,
        );
    }
  }, [frame, plane, computed, marks, carried, cursor]);
  return (
    <canvas
      ref={canvas}
      className="native-reformat-canvas angio-overlay-canvas"
      width={frame.width}
      height={frame.height}
      role="img"
      aria-label={`${label}. Arrow keys move a cursor, Enter marks.`}
      tabIndex={0}
      onBlur={() => setCursor(null)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 10 : 1,
          at = cursor ?? { x: frame.width / 2, y: frame.height / 2 },
          move = (
            {
              ArrowLeft: [-step, 0],
              ArrowRight: [step, 0],
              ArrowUp: [0, -step],
              ArrowDown: [0, step],
            } as Record<string, number[]>
          )[event.key];
        if (move) {
          event.preventDefault();
          setCursor({
            x: Math.min(frame.width, Math.max(0, at.x + move[0])),
            y: Math.min(frame.height, Math.max(0, at.y + move[1])),
          });
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setCursor(at);
          onMark(at.x, at.y);
        }
      }}
      onClick={(event) => {
        const at = framePixel(
          event.currentTarget.getBoundingClientRect(),
          frame,
          event.clientX,
          event.clientY,
        );
        if (at) onMark(at.x, at.y);
      }}
    />
  );
}

export default function ComparisonPanel({
  identity,
  binding,
  registration,
  mask,
  grid,
  disabled,
  onRequests,
  onComputing,
}: Props) {
  const saved = registration.current,
    key =
      saved.status === "current"
        ? stable({
            identity,
            revision: registration.registration_revision,
            registration: saved.registration_id,
            evidence: saved.evidence,
            mask: mask ? [mask.candidate_id, mask.mask_sha256] : null,
            grid,
          })
        : "";
  const live = useRef(key);
  live.current = key;
  const notify = useRef({ onRequests, onComputing });
  notify.current = { onRequests, onComputing };

  const [requests, setRequests] = useState(0),
    [run, setRun] = useState<{
      key: string;
      job: ComparisonJob;
      finish: (result: ComparisonResult) => Computed;
    } | null>(null),
    [outcome, setOutcome] = useState<Outcome | null>(null),
    [marking, setMarking] = useState<Marking>("place"),
    // Marks are of the result shown: a new comparison starts without any.
    [marks, setMarks] = useState<Marks>(NO_MARKS),
    [deviceId, setDeviceId] = useState("");
  // Requests are of one saved proposal: they are given up when it is
  // replaced, and when the panel goes.
  const controllers = useRef(new Set<AbortController>());
  useEffect(() => {
    const open = controllers.current;
    return () => {
      for (const controller of open) controller.abort();
    };
  }, [key]);

  const busy = requests > 0,
    active = run?.key === key ? run : null,
    shown = outcome?.key === key ? outcome : null,
    computed = shown && "result" in shown ? shown : null,
    ready =
      saved.status === "current" &&
      saved.evidence === "verified" &&
      !!mask &&
      mask.candidate_id === saved.inputs.mask_candidate_id &&
      mask.mask_sha256 === saved.inputs.mask_sha256 &&
      !!grid,
    idle = !disabled && !busy && !active,
    computing = !!active;
  useEffect(() => {
    notify.current.onRequests?.(busy);
  }, [busy]);
  useEffect(() => {
    notify.current.onComputing?.(computing);
  }, [computing]);
  useEffect(
    () => () => {
      notify.current.onRequests?.(false);
      notify.current.onComputing?.(false);
    },
    [],
  );
  useEffect(() => {
    if (run && !active) setRun(null);
  }, [run, active]);
  useEffect(() => {
    if (!active || disabled) return;
    let timer: ReturnType<typeof setTimeout>;
    const slice = () => {
      const deadline =
        performance.now() + (document.hidden ? HIDDEN_SLICE_MS : SLICE_MS);
      try {
        if (!active.job.advance(() => performance.now() >= deadline)) {
          timer = setTimeout(slice, 0);
          return;
        }
        const found = active.finish(active.job.result());
        setRun(null);
        setOutcome(found);
      } catch (error) {
        setRun(null);
        setOutcome({
          key: active.key,
          failure:
            error instanceof Error ? error.message : "Computation failed",
        });
      }
    };
    timer = setTimeout(slice, 0);
    return () => clearTimeout(timer);
  }, [active, disabled]);

  const compute = useCallback(async () => {
    if (saved.status !== "current" || !mask || !grid || !key) return;
    const inputs = saved.inputs,
      owned = key,
      controller = new AbortController(),
      { signal } = controller;
    let late = false;
    const deadline = setTimeout(() => {
      late = true;
      controller.abort();
    }, COMPARISON_REQUEST_TIMEOUT_MS);
    controllers.current.add(controller);
    setRequests((count) => count + 1);
    setOutcome(null);
    setMarks(NO_MARKS);
    try {
      const bundle = await loadFrameBundle(inputs.frame_source_id, signal);
      if (bundle.manifest_revision !== inputs.frame_manifest_revision)
        throw new Error(NOT_THE_CONFIRMED);
      // One frame, or one from each plane; each is checked against the
      // record. The other frames of a plane are its run.
      const named = isBiplane(inputs) ? inputs.planes : [inputs],
        frames: VerifiedFrame[] = [],
        runs: { index: number; gray: Uint8Array }[][] = [];
      for (const entry of named) {
        const listed =
            bundle.planes.find((plane) => plane.plane === entry.plane)
              ?.frames ?? [],
          series: VerifiedFrame[] = [];
        for (const { index } of [...listed].sort((a, b) => a.index - b.index))
          series.push(
            await loadVerifiedFrame(bundle, entry.plane, index, signal),
          );
        const one = series.find((frame) => frame.index === entry.frame_index);
        if (!one || one.sha256 !== entry.frame_sha256)
          throw new Error(NOT_THE_CONFIRMED);
        frames.push(one);
        runs.push(series.map(({ index, gray }) => ({ index, gray })));
      }
      const stored = await loadSegmentationMask(mask, binding, signal);
      // Saved planned devices are optional: a case may have none. The server
      // answers 409 for a case without current measurements, which has no
      // plans, and says so; any other 409 is a source it could not read as
      // one, which is asked for once more before the plans count as unread.
      let devices: DeviceScenarioEntry[] = [],
        unread = false;
      for (let read = 0; read < DEVICE_PLAN_READS; read++) {
        try {
          const raw = await api<Record<string, unknown>>(
              `/cases/${encodeURIComponent(identity.case_id)}/device-scenarios`,
              undefined,
              "GET",
              signal,
            ),
            envelope = parseDeviceScenarios(raw, {
              ...identity,
              geometry_result_id: String(raw?.geometry_result_id),
              catalog_version: String(raw?.catalog_version),
            });
          if (envelope.current.status === "current")
            devices = envelope.current.scenarios.filter(
              (scenario) =>
                DEVICE_CATALOG.devices.find(
                  (device) => device.id === scenario.placement.deviceId,
                )?.category === "flow-diverter" &&
                liesOnPath(scenario.placement),
            );
          unread = false;
          break;
        } catch (error) {
          if (signal.aborted) throw new Error("aborted");
          const conflict = error instanceof RevisionConflictError;
          // Each read stands for itself: the last one decides.
          unread = !(conflict && error.reason === MEASUREMENTS_NOT_CURRENT);
          if (!conflict || !unread) break;
          // A request given up during the wait ends at the next read.
          if (read + 1 < DEVICE_PLAN_READS)
            await new Promise((resolve) =>
              setTimeout(resolve, DEVICE_PLAN_WAIT_MS),
            );
        }
      }
      // Everything is fetched; decoding a large mask is local work.
      clearTimeout(deadline);
      const voxels = await decodeVesselMask(stored, grid.shape, grid.affine);
      if (signal.aborted || live.current !== owned) return;
      const job = createComparisonJob({
        mask: voxels,
        shape: grid.shape,
        affine: grid.affine,
        matrix: inputs.volume_to_carm_ras,
        isocenter: inputs.isocenter,
        planes: named.map((entry, k) => ({
          frame: frames[k],
          view: entry.view,
          polarity: entry.polarity,
          run: runs[k],
        })),
      });
      setRun({
        key: owned,
        job,
        finish: (result) => ({
          key: owned,
          frames,
          views: named.map((entry) => entry.view),
          isocenter: inputs.isocenter,
          matrix: inputs.volume_to_carm_ras,
          result,
          devices,
          devices_unread: unread,
        }),
      });
    } catch (error) {
      // Stored bytes that fail their digest, and frames that are no longer
      // the confirmed ones, are not an availability problem.
      const why = error instanceof Error ? error.message : "";
      if (live.current === owned)
        setOutcome({
          key: owned,
          failure: late
            ? `Reading the frames and vessel mask of the saved proposal took longer than ${COMPARISON_REQUEST_TIMEOUT_MS / 1000} seconds. Retry`
            : why === FRAME_INTEGRITY_FAILURE ||
                why === SEGMENTATION_INTEGRITY_FAILURE
              ? "A frame or the vessel mask of the saved proposal failed its integrity check and is not used"
              : why === NOT_THE_CONFIRMED
                ? "The stored frames are not the ones this proposal was confirmed on. Save a new proposal to compare"
                : "The frames and vessel mask of the saved proposal could not be read. Check their availability, then retry",
        });
    } finally {
      clearTimeout(deadline);
      controllers.current.delete(controller);
      setRequests((count) => count - 1);
    }
  }, [saved, mask, grid, key, binding, identity]);

  const carried = useMemo(() => {
    const out: Record<Marking, CarriedPoint | null> = {
      place: null,
      end_1: null,
      end_2: null,
    };
    if (!computed) return out;
    for (const name of Object.keys(out) as Marking[])
      if (marks[name].length)
        out[name] = carryPoint(
          {
            segments: computed.result.segments,
            isocenter: computed.isocenter,
            matrix: computed.matrix,
            planes: computed.frames.map((frame, k) => ({
              view: computed.views[k],
              frame: { width: frame.width, height: frame.height },
            })),
          },
          marks[name],
        );
    return out;
  }, [computed, marks]);

  if (saved.status !== "current") return null;
  const planned =
      computed?.devices.find((device) => device.id === deviceId) ??
      computed?.devices[0],
    device =
      planned && carried.end_1 && carried.end_2
        ? compareDevice(planned.placement, [
            carried.end_1.point,
            carried.end_2.point,
          ])
        : null,
    narrowed = computed ? narrowestRows(computed.result.planes) : [];
  return (
    <fieldset aria-labelledby="comparison-title">
      <legend id="comparison-title">2D and 3D comparison</legend>
      <p className="carm-note">
        Measures the vessels of the saved proposal twice, in the 3D mask and in
        each frame: diameter per segment, the narrowest place of each vessel
        run, and the frame at which contrast reaches each segment. Click a
        vessel in a frame to carry that place to the 3D model.
      </p>
      <div className="native-actions">
        <button
          type="button"
          disabled={!idle || !ready}
          onClick={() => void compute()}
        >
          {computed ? "Compare again" : "Compare 2D and 3D"}
        </button>
      </div>
      {computing && <p role="status">Comparing…</p>}
      {shown && "failure" in shown && <p role="alert">{shown.failure}.</p>}
      {computed && (
        <>
          <figure className="native-render-figure angio-overlay-figure">
            <div
              className={
                computed.frames.length > 1 ? "angio-overlay-pair" : undefined
              }
            >
              {computed.frames.map((frame, k) => (
                <ComparisonCanvas
                  key={frame.plane}
                  frame={frame}
                  plane={k}
                  computed={computed}
                  marks={marks}
                  carried={carried}
                  label={`Admitted frame ${frame.index}, plane ${frame.plane}, with the vessel axis and marks`}
                  onMark={(x, y) =>
                    setMarks({
                      ...marks,
                      [marking]: [
                        ...marks[marking].filter((one) => one.plane !== k),
                        { plane: k, x, y },
                      ],
                    })
                  }
                />
              ))}
            </div>
            <figcaption>
              Vessel axis under the saved proposal. Cyan: measured in the frame.
              Orange: another vessel lies over it, or no vessel shows.
            </figcaption>
          </figure>
          <div
            className="native-actions"
            role="radiogroup"
            aria-label="A click marks"
          >
            {(Object.keys(MARKINGS) as Marking[]).map((name) => (
              <label key={name}>
                <input
                  type="radio"
                  name="comparison-marking"
                  checked={marking === name}
                  onChange={() => setMarking(name)}
                />
                {MARKINGS[name].word}
              </label>
            ))}
            <button
              type="button"
              disabled={!Object.values(marks).some((list) => list.length)}
              onClick={() => setMarks(NO_MARKS)}
            >
              Clear marks
            </button>
          </div>
          {marks.place.length > 0 && (
            <p role="status" aria-label="Carried place">
              {carried.place
                ? `Segment ${carried.place.segment + 1}, at R ${carried.place.point[0].toFixed(1)}, A ${carried.place.point[1].toFixed(1)}, S ${carried.place.point[2].toFixed(1)} mm, ${Math.max(...carried.place.off_mm).toFixed(1)} mm from the mark.${
                    carried.place.crossings
                      ? ` ${carried.place.crossings} other ${carried.place.crossings === 1 ? "vessel lies" : "vessels lie"} under the mark${computed.frames.length > 1 && marks.place.length < 2 ? "; mark the same place in the other plane to tell them apart" : ""}.`
                      : ""
                  }`
                : "No vessel of the 3D model lies under the mark."}
            </p>
          )}
          {computed.devices_unread && (
            <p className="carm-note" role="status" aria-label="Planned devices">
              The saved device plans could not be read, so no planned device is
              compared.
            </p>
          )}
          {computed.devices.length > 0 && (
            <>
              <label>
                Planned device{" "}
                <select
                  value={planned?.id ?? ""}
                  onChange={(event) => setDeviceId(event.target.value)}
                >
                  {computed.devices.map((one) => (
                    <option key={one.id} value={one.id}>
                      {one.name}
                    </option>
                  ))}
                </select>
              </label>
              {device ? (
                <table
                  className="carm-table"
                  aria-label="Planned and deployed device"
                >
                  <tbody>
                    <tr>
                      <th scope="row">Planned length (mm)</th>
                      <td>{mm(device.planned_length_mm)}</td>
                    </tr>
                    <tr>
                      <th scope="row">Length between the marked ends (mm)</th>
                      <td>{mm(device.deployed_length_mm)}</td>
                    </tr>
                    {device.ends.map((end, k) => (
                      <tr key={k}>
                        <th scope="row">
                          {k ? "Far end" : "Near end"} against the plan, along
                          the vessel (mm)
                        </th>
                        <td>
                          {end.shift_mm >= 0 ? "+" : "−"}
                          {Math.abs(end.shift_mm).toFixed(1)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p role="status">
                  Mark the two ends of the deployed device in a frame.
                </p>
              )}
            </>
          )}
          {narrowed.length > 0 && (
            <table className="carm-table" aria-label="Narrowest places">
              <caption>Narrowest place of each vessel run</caption>
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">3D mask (mm, of run)</th>
                  {computed.frames.map((frame) => (
                    <th scope="col" key={frame.plane}>
                      Plane {frame.plane} (mm, of run)
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {narrowed.map((row) => (
                  <tr key={row.run}>
                    <th scope="row">{row.run + 1}</th>
                    {[row.mask, ...row.frames].map((one, k) => (
                      <td key={k}>
                        {one
                          ? `${one.narrowest_mm.toFixed(1)} of ${one.reference_mm.toFixed(1)} (${one.percent.toFixed(0)}% narrower)`
                          : "–"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <details>
            <summary>
              Segments ({computed.result.segments.segments.length})
            </summary>
            <table className="carm-table" aria-label="Segment comparison">
              <thead>
                <tr>
                  <th scope="col">Segment</th>
                  <th scope="col">Length (mm)</th>
                  <th scope="col">3D diameter (mm)</th>
                  {computed.frames.map((frame) => (
                    <th scope="col" key={`diameter-${frame.plane}`}>
                      Plane {frame.plane} diameter (mm)
                    </th>
                  ))}
                  {computed.frames.map(
                    (frame, k) =>
                      computed.result.planes[k].arrival && (
                        <th scope="col" key={`arrival-${frame.plane}`}>
                          Plane {frame.plane} contrast arrives (frame)
                        </th>
                      ),
                  )}
                </tr>
              </thead>
              <tbody>
                {computed.result.segments.segments.map((segment) => (
                  <tr key={segment.index}>
                    <th scope="row">{segment.index + 1}</th>
                    <td>{segment.length_mm.toFixed(1)}</td>
                    <td>
                      {mm(
                        computed.result.planes[0].diameters.segments[
                          segment.index
                        ].mask_mm,
                      )}
                    </td>
                    {computed.result.planes.map((plane, k) => (
                      <td key={`diameter-${k}`}>
                        {mm(plane.diameters.segments[segment.index].frame_mm)}
                      </td>
                    ))}
                    {computed.result.planes.map((plane, k) => {
                      const one = plane.arrival?.[segment.index];
                      return (
                        one && (
                          <td key={`arrival-${k}`}>
                            {one.state === "arrives"
                              ? one.arrival!.toFixed(1)
                              : one.state === "filled_from_first"
                                ? "from the first"
                                : one.state === "no_change"
                                  ? "no change"
                                  : "outside"}
                          </td>
                        )
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </fieldset>
  );
}
