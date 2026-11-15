/** Vessel-presence report on a saved 2D-to-3D proposal: which unnamed
 * segments of the accepted vessel mask have a vessel under them in each
 * frame the proposal was confirmed on. The report is computed here from the
 * frames, the mask and the saved pose, reviewed, and saved only on
 * confirmation. A saved report is recomputed when it is read back, and is
 * shown as reproduced only when the recomputation agrees. Pixels are read,
 * verified and drawn; they are never sent. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, RevisionConflictError, WorkspaceRequestError } from "./api";
import type { ViewNumbers } from "./carmGeometry";
import type { Vec3 } from "./obliqueSlice";
import {
  decodeVesselMask,
  isBiplane,
  loadFrameBundle,
  loadVerifiedFrame,
  type SavedRegistration,
  type VerifiedFrame,
} from "./projectionFrames";
import { projectRegistered } from "./projectionRegistration";
import {
  parseSavedPresence,
  reportDifference,
  reportInputs,
  summarizeReport,
  type PlaneSummary,
  type PresenceReportInputs,
  type SavedPresence,
} from "./presenceReport";
import { loadSegmentationMask, type SegmentationEntry } from "./segmentation";
import { stable, type Identity } from "./territoryWorkflow";
import {
  PRESENCE_CLASSES,
  VESSEL_PRESENCE_LIMITS as LIMITS,
  type PlanePresence,
  type PresenceClass,
} from "./vesselPresence";
import {
  createPresenceJob,
  type PresenceJob,
  type PresenceJobResult,
} from "./vesselPresenceJob";
import type { VesselSegments } from "./vesselSegments";

export const PRESENCE_REQUEST_TIMEOUT_MS = 30_000;
const SLICE_MS = 12,
  HIDDEN_SLICE_MS = 800;
export const CLASS_WORDS: Record<PresenceClass, string> = {
  supported: "2D support",
  no_2d_support: "No 2D support",
  outside_field: "Outside the field",
  indeterminate: "Indeterminate",
};
/** Marker colors on the frame. A segment outside the field has no samples
 * to draw there. */
const CLASS_COLORS: Record<PresenceClass, string> = {
  supported: "rgba(0, 230, 118, 0.9)",
  no_2d_support: "rgba(255, 82, 82, 0.95)",
  outside_field: "rgba(158, 158, 158, 0.9)",
  indeterminate: "rgba(255, 214, 0, 0.9)",
};

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
  /** Called with true while a request of this panel is open. The workspace
   * is locked for that time, as for any other request. */
  onRequests?: (open: boolean) => void;
  /** Called with true while the report is being computed. Nothing is
   * requested or saved in that time. */
  onComputing?: (computing: boolean) => void;
};
type Computed = {
  key: string;
  frames: VerifiedFrame[];
  views: ViewNumbers[];
  isocenter: Vec3;
  matrix: number[][];
  result: PresenceJobResult;
  inputs: PresenceReportInputs;
};
type Outcome = Computed | { key: string; failure: string };

/** One verified frame with each segment's axis samples drawn in the color
 * of the segment's class, and the 2D vessel pieces no segment is near. */
function PresenceCanvas({
  frame,
  view,
  isocenter,
  matrix,
  segments,
  plane,
  target,
  label,
}: {
  frame: VerifiedFrame;
  view: ViewNumbers;
  isocenter: Vec3;
  matrix: number[][];
  segments: VesselSegments;
  plane: PlanePresence;
  target: { width: number; scale: number };
  label: string;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    const { width, height, gray } = frame,
      image = context.createImageData(width, height);
    for (let i = 0, o = 0; i < gray.length; i++, o += 4) {
      image.data[o] = image.data[o + 1] = image.data[o + 2] = gray[i];
      image.data[o + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    const size = Math.max(1, Math.round(width / 256));
    try {
      // Unmatched 2D pieces, from the working grid back to frame pixels.
      context.fillStyle = "rgba(224, 64, 251, 0.95)";
      const block = Math.max(size, Math.ceil(target.scale));
      for (const piece of plane.unmatched)
        for (const pixel of piece.pixels)
          context.fillRect(
            (pixel % target.width) * target.scale,
            Math.floor(pixel / target.width) * target.scale,
            block,
            block,
          );
      const pixels = projectRegistered(
        view,
        isocenter,
        matrix,
        segments.points,
        { width, height },
      );
      for (let k = 0; k < segments.labels.length; k++) {
        const x = pixels[2 * k],
          y = pixels[2 * k + 1];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        context.fillStyle =
          CLASS_COLORS[plane.segments[segments.labels[k]].class];
        context.fillRect(x - size / 2, y - size / 2, size, size);
      }
    } catch (error) {
      console.warn("Vessel presence drawing failed", error);
    }
  }, [frame, view, isocenter, matrix, segments, plane, target]);
  return (
    <canvas
      ref={canvas}
      className="native-reformat-canvas angio-overlay-canvas"
      width={frame.width}
      height={frame.height}
      role="img"
      aria-label={label}
    />
  );
}

function SummaryTable({ summary }: { summary: PlaneSummary }) {
  return (
    <table
      className="carm-table"
      aria-label={`Vessel presence in plane ${summary.plane}`}
    >
      <thead>
        <tr>
          <th scope="col">Class</th>
          <th scope="col">Segments</th>
          <th scope="col">Length (mm)</th>
        </tr>
      </thead>
      <tbody>
        {PRESENCE_CLASSES.map((name) => (
          <tr key={name}>
            <th scope="row">{CLASS_WORDS[name]}</th>
            <td>{summary.classes[name].count}</td>
            <td>{summary.classes[name].length_mm.toFixed(1)}</td>
          </tr>
        ))}
        <tr>
          <th scope="row">2D vessel pieces with no segment near</th>
          <td>{summary.unmatched_count}</td>
          <td>{summary.unmatched_length_mm.toFixed(1)}</td>
        </tr>
      </tbody>
    </table>
  );
}

export default function VesselPresencePanel({
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
          })
        : "";
  const live = useRef(key);
  live.current = key;
  const notify = useRef({ onRequests, onComputing });
  notify.current = { onRequests, onComputing };

  const [report, setReport] = useState<{
      key: string;
      saved: SavedPresence;
    } | null>(null),
    [loadFailed, setLoadFailed] = useState(""),
    [requests, setRequests] = useState(0),
    [run, setRun] = useState<{
      key: string;
      job: PresenceJob;
      finish: (result: PresenceJobResult) => Computed;
    } | null>(null),
    [outcome, setOutcome] = useState<Outcome | null>(null),
    [reviewedOutcome, setReviewedOutcome] = useState<Outcome | null>(null),
    [notice, setNotice] = useState("");
  const controllers = useRef(new Set<AbortController>());
  /** One request with a deadline. `release` is idempotent. */
  const begin = () => {
    const controller = new AbortController(),
      deadline = setTimeout(
        () => controller.abort(),
        PRESENCE_REQUEST_TIMEOUT_MS,
      );
    controllers.current.add(controller);
    setRequests((count) => count + 1);
    let released = false;
    return {
      signal: controller.signal,
      release: () => {
        if (released) return;
        released = true;
        clearTimeout(deadline);
        controllers.current.delete(controller);
        setRequests((count) => count - 1);
      },
    };
  };

  const load = useCallback(async () => {
    setReport(null);
    setLoadFailed("");
    setOutcome(null);
    setRun(null);
    setNotice("");
    if (!key) return;
    const owned = key,
      { release, signal } = begin();
    try {
      const answer = await api(
        `/cases/${identity.case_id}/vessel-presence`,
        undefined,
        "GET",
        signal,
      );
      if (signal.aborted || live.current !== owned) return;
      setReport({
        key: owned,
        saved: parseSavedPresence(answer, identity, registration),
      });
    } catch {
      if (live.current === owned)
        setLoadFailed(
          "The saved vessel presence report could not be loaded. Reload it before continuing.",
        );
    } finally {
      release();
    }
    // The key names everything the request depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    void load();
    const open = controllers.current;
    return () => {
      for (const controller of open) controller.abort();
    };
  }, [load]);

  const busy = requests > 0,
    active = run?.key === key ? run : null,
    current = report?.key === key ? report.saved : null,
    shown = outcome?.key === key ? outcome : null,
    computed = shown && "result" in shown ? shown : null,
    evidence = saved.status === "current" && saved.evidence === "verified",
    ready = !!key && !!current && evidence && !!mask && !!grid,
    idle = !disabled && !busy && !active;
  const computing = !!active;
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
      { release, signal } = begin();
    setOutcome(null);
    setNotice("");
    try {
      if (
        mask.candidate_id !== inputs.mask_candidate_id ||
        mask.mask_sha256 !== inputs.mask_sha256
      )
        throw new Error("mask");
      const bundle = await loadFrameBundle(inputs.frame_source_id, signal);
      if (bundle.manifest_revision !== inputs.frame_manifest_revision)
        throw new Error("revision");
      // One frame, or one from each plane; each is checked against the record.
      const named = isBiplane(inputs) ? inputs.planes : [inputs],
        frames: VerifiedFrame[] = [];
      for (const entry of named) {
        const one = await loadVerifiedFrame(
          bundle,
          entry.plane,
          entry.frame_index,
          signal,
        );
        if (one.sha256 !== entry.frame_sha256) throw new Error("frame");
        frames.push(one);
      }
      const voxels = await decodeVesselMask(
        await loadSegmentationMask(mask, binding, signal),
        grid.shape,
        grid.affine,
      );
      if (signal.aborted || live.current !== owned) return;
      const job = createPresenceJob({
        mask: voxels,
        shape: grid.shape,
        affine: grid.affine,
        matrix: inputs.volume_to_carm_ras,
        isocenter: inputs.isocenter,
        planes: named.map((entry, k) => ({
          frame: frames[k],
          view: entry.view,
          polarity: entry.polarity,
          sensitivity: entry.sensitivity,
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
          inputs: reportInputs(registration, result.segments, result.presence),
        }),
      });
    } catch {
      if (live.current === owned)
        setOutcome({
          key: owned,
          failure:
            "The saved proposal's frame or vessel mask is no longer available unchanged, so no report is computed",
        });
    } finally {
      release();
    }
    // The key names the registration; the mask and grid are named beside it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, mask, grid]);

  // A saved report is recomputed when it is read back, once.
  const rechecked = useRef("");
  const savedInputs =
    current?.current.status === "current" ? current.current.inputs : null;
  useEffect(() => {
    if (!ready || !savedInputs || !idle || shown) return;
    const once = stable({ key, report: current?.report_revision });
    if (rechecked.current === once) return;
    rechecked.current = once;
    void compute();
  }, [ready, savedInputs, idle, shown, key, current, compute]);

  const difference = useMemo(
    () =>
      savedInputs && computed
        ? reportDifference(savedInputs, computed.inputs)
        : null,
    [savedInputs, computed],
  );
  const reproduced = !!savedInputs && !!computed && difference === null,
    unsaved = !!current && !!computed && !reproduced,
    reviewed = !!shown && reviewedOutcome === shown;

  async function save() {
    if (!idle || !current || !computed || !unsaved || !reviewed) return;
    const owned = key,
      { release, signal } = begin();
    try {
      const answer = parseSavedPresence(
        await api(
          `/cases/${identity.case_id}/vessel-presence`,
          {
            artifact_version: identity.artifact_version,
            reference_revision: identity.reference_revision,
            report_revision: current.report_revision,
            inputs: computed.inputs,
          },
          "PUT",
          signal,
        ),
        identity,
        registration,
      );
      if (live.current !== owned) return;
      // The report just saved is the one on screen; it is not recomputed.
      rechecked.current = stable({ key, report: answer.report_revision });
      setReport({ key: owned, saved: answer });
      setNotice("");
    } catch (error) {
      if (live.current !== owned) return;
      const refused =
        error instanceof RevisionConflictError ||
        (error instanceof WorkspaceRequestError &&
          error.status >= 400 &&
          error.status < 500);
      if (!refused) {
        // No answer, a server failure, or an answer that could not be
        // read: the write may have happened. Nothing more is saved until
        // the report is read again.
        setReport(null);
        setOutcome(null);
        setLoadFailed(
          "Save acknowledgement was not received. The report may have been stored. Reload the saved report before continuing.",
        );
      } else
        setNotice(
          error instanceof RevisionConflictError
            ? "The case, the saved proposal or the saved report changed. Reload before saving."
            : "The report was not saved. The frame, mask or saved proposal may have changed; reload and try again.",
        );
    } finally {
      release();
    }
  }

  if (saved.status !== "current") return null;
  const table = computed
      ? summarizeReport(computed.inputs)
      : savedInputs
        ? summarizeReport(savedInputs)
        : null,
    listed = computed?.inputs ?? savedInputs;
  return (
    <fieldset aria-labelledby="vessel-presence-title">
      <legend id="vessel-presence-title">Vessel presence report</legend>
      <p className="carm-note">
        Cuts the accepted vessel mask into unnamed segments and reports, for
        each frame of the saved proposal, whether an extracted 2D vessel line
        lies within {LIMITS.support_mm} mm of the segment. It asserts no cause:
        a segment without 2D support may be occluded, unfilled, outside the
        injected territory or absent, or the proposal may be wrong. The report
        is only as good as the proposal it is computed with, and that proposal
        is not a validated registration. Segments that lie over another vessel
        in the frame are left indeterminate.
      </p>
      {loadFailed && <p role="alert">{loadFailed}</p>}
      {notice && <p role="alert">{notice}</p>}
      {loadFailed && (
        <button type="button" disabled={!idle} onClick={() => void load()}>
          Reload saved report
        </button>
      )}
      {current && (
        <p role="status" aria-label="Saved vessel presence report">
          {current.current.status === "current"
            ? `Saved operator-confirmed report, revision ${current.report_revision}, on proposal revision ${registration.registration_revision}. ${
                reproduced
                  ? "Computed here from the frames, the mask and the saved proposal: the counts agree with the saved report."
                  : computed
                    ? `Computed here from the frames, the mask and the saved proposal: the saved report was not reproduced, ${difference}. Its counts are not shown.`
                    : evidence
                      ? "Not yet recomputed here."
                      : "Its frames or vessel mask are no longer available unchanged, so it cannot be recomputed. The counts below are as saved."
              }`
            : current.current.status === "stale"
              ? "A report was confirmed for an earlier proposal or an earlier revision of this case. It is not shown or reused."
              : "No vessel presence report is saved for this proposal."}
        </p>
      )}
      {current && !evidence && (
        <p role="status">
          The saved proposal's frames or vessel mask are no longer available
          unchanged. A report cannot be computed.
        </p>
      )}
      {ready && !active && (
        <div className="native-actions">
          <button type="button" disabled={!idle} onClick={() => void compute()}>
            {computed ? "Recompute vessel presence" : "Compute vessel presence"}
          </button>
        </div>
      )}
      {active && (
        <>
          <p role="status" aria-label="Vessel presence status">
            Computing vessel presence… This waits while the tab is in the
            background.
          </p>
          <button type="button" onClick={() => setRun(null)}>
            Cancel vessel presence computation
          </button>
        </>
      )}
      {shown && "failure" in shown && (
        <p role="alert">
          Vessel presence was not computed: {shown.failure.replace(/\.$/, "")}.
        </p>
      )}
      {computed && computed.result.segments.pooling > 1 && (
        <p role="status">
          The vessel mask was coarsened {computed.result.segments.pooling} times
          per axis to fit the browser's memory bound.
        </p>
      )}
      {table && listed && (
        <>
          <p role="status" aria-label="Vessel presence summary">
            {unsaved ? "Unsaved report" : "Saved report"}:{" "}
            {listed.segments.length} unnamed segments,{" "}
            {listed.segments
              .reduce((sum, segment) => sum + segment.length_mm, 0)
              .toFixed(1)}{" "}
            mm in all. {(100 * listed.unassigned_fraction).toFixed(1)}% of the
            mask's volume is in no segment.
          </p>
          {computed && (
            <figure className="native-render-figure angio-overlay-figure">
              <div
                className={
                  computed.frames.length > 1 ? "angio-overlay-pair" : undefined
                }
              >
                {computed.frames.map((frame, k) => (
                  <PresenceCanvas
                    key={frame.plane}
                    frame={frame}
                    view={computed.views[k]}
                    isocenter={computed.isocenter}
                    matrix={computed.matrix}
                    segments={computed.result.segments}
                    plane={computed.result.presence.planes[k]}
                    target={computed.result.targets[k]}
                    label={`Admitted frame ${frame.index}, plane ${frame.plane}, with vessel segments colored by presence class`}
                  />
                ))}
              </div>
              <figcaption>
                Segment axes projected under the saved proposal. Green: 2D
                support. Red: no 2D support. Yellow: indeterminate. Magenta: 2D
                vessel lines at least {LIMITS.min_piece_mm} mm long with no
                segment within {LIMITS.support_mm} mm, which can include
                catheters and bone edges. Not a validated registration.
              </figcaption>
            </figure>
          )}
          {table.map((summary) => (
            <SummaryTable key={summary.plane} summary={summary} />
          ))}
          <details>
            <summary>Segments</summary>
            <table className="carm-table" aria-label="Vessel segments">
              <thead>
                <tr>
                  <th scope="col">Segment</th>
                  <th scope="col">Length (mm)</th>
                  <th scope="col">Mean radius (mm)</th>
                  {listed.planes.map((plane) => (
                    <th scope="col" key={plane.plane}>
                      Plane {plane.plane}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {listed.segments.map((segment, index) => (
                  <tr key={index}>
                    <th scope="row">{index}</th>
                    <td>{segment.length_mm.toFixed(1)}</td>
                    <td>{segment.mean_radius_mm.toFixed(1)}</td>
                    {listed.planes.map((plane) => (
                      <td key={plane.plane}>
                        {CLASS_WORDS[plane.segments[index].presence]} (
                        {plane.segments[index].supported} of{" "}
                        {plane.segments[index].clear} judged samples)
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
      {unsaved && (
        <fieldset disabled={!idle}>
          <legend>Confirm report</legend>
          <label>
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(e) =>
                setReviewedOutcome(e.target.checked ? shown : null)
              }
            />{" "}
            I reviewed the classes against the frames and confirm this report as
            an unvalidated working record
          </label>
          <div className="native-actions">
            <button
              type="button"
              disabled={!reviewed}
              onClick={() => void save()}
            >
              Save confirmed report
            </button>
          </div>
        </fieldset>
      )}
    </fieldset>
  );
}
