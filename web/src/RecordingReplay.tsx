/** Replay of a recording under a saved 2D-to-3D proposal: the browser
 * decodes a recording file the operator opens, and every frame it presents
 * is drawn with the proposal's vessel axis over it, turned with the C-arm
 * by the recording's frame table. The time from each frame's presentation
 * to its overlay being drawn is measured. The recording and the table are
 * read here; neither is sent. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ViewNumbers } from "./carmGeometry";
import type { Vec3 } from "./obliqueSlice";
import type { VerifiedFrame } from "./projectionFrames";
import {
  parseSidecar,
  SIDECAR_LAYOUT,
  SIDECAR_LIMITS,
  TABLE_TOO_LARGE,
  type RecordingSidecar,
} from "./recordingSidecar";
import { createLatencyLog, type LatencySummary } from "./replayLatency";
import {
  createReplayOverlay,
  frameAt,
  likeness,
  REPLAY_LIMITS,
  REPLAY_OVERLAY_METHOD,
  sourceRectangle,
  timeOf,
  type ReplayOverlay,
} from "./replayOverlay";

/** One plane of the saved proposal: its saved frame and view, and where the
 * admitted frame lies in the picture it was admitted from. */
export type ReplaySource = {
  frame: VerifiedFrame;
  view: ViewNumbers;
  /** x, y, width, height in the pixels of the source picture. */
  crop: number[];
  source: { rows: number; columns: number };
  redactions: number[][];
};
type Figures = {
  summary: LatencySummary;
  from_frame: number;
  to_frame: number;
};
/** Frames between two refreshes of the figures while the recording plays. */
const REFRESH_FRAMES = 30,
  AXIS_COLOR = "rgba(0, 229, 255, 0.9)",
  /** The media element's ready state from which it has a picture to show. */
  HAVE_CURRENT_DATA = 2,
  /** Times the recording is taken to the saved frame before that is given up. */
  SAVED_FRAME_SEEKS = 3;

const readText = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("The frame table cannot be read"));
    reader.readAsText(file);
  });

/** The angles as the angiography system shows them. */
export function angleText(primary_deg: number, secondary_deg: number) {
  const side = (value: number, plus: string, minus: string) =>
    value ? `${value > 0 ? plus : minus} ${Math.abs(value)}°` : "0°";
  return `${side(primary_deg, "LAO", "RAO")} / ${side(secondary_deg, "CRAN", "CAUD")}`;
}

export default function RecordingReplay({
  planes,
  isocenter,
  matrix,
  points,
  disabled,
}: {
  planes: ReplaySource[];
  isocenter: Vec3;
  matrix: number[][];
  /** Vessel axis points in volume millimeters. */
  points: Float32Array;
  disabled: boolean;
}) {
  const [choice, setChoice] = useState(0),
    [recording, setRecording] = useState<File | null>(null),
    [url, setUrl] = useState(""),
    [table, setTable] = useState<
      { sidecar: RecordingSidecar } | { failure: string } | null
    >(null),
    [seconds, setSeconds] = useState(0),
    [broken, setBroken] = useState(false),
    [checked, setChecked] = useState<{
      target: ReplayOverlay;
      like: number;
    } | null>(null),
    /** The proposal whose saved frame the recording could not be taken to. */
    [missed, setMissed] = useState<ReplayOverlay | null>(null),
    [playing, setPlaying] = useState(false),
    [axis, setAxis] = useState(true),
    [figures, setFigures] = useState<Figures | null>(null);
  const video = useRef<HTMLVideoElement | null>(null),
    canvas = useRef<HTMLCanvasElement | null>(null),
    status = useRef<HTMLParagraphElement | null>(null),
    slider = useRef<HTMLInputElement | null>(null),
    log = useRef(createLatencyLog()),
    played = useRef<{ from: number; to: number } | null>(null),
    shownAxis = useRef(axis),
    reading = useRef(0);
  shownAxis.current = axis;

  const plane = planes[Math.min(choice, planes.length - 1)],
    sidecar = table && "sidecar" in table ? table.sidecar : null,
    { width, height } = plane.frame;
  const placed = useMemo(() => {
    if (!sidecar) return null;
    try {
      return {
        overlay: createReplayOverlay(
          {
            view: plane.view,
            isocenter,
            matrix,
            points,
            size: { width, height },
            frame_index: plane.frame.index,
          },
          sidecar,
        ),
      };
    } catch (error) {
      return {
        failure: error instanceof Error ? error.message : "Replay failed",
      };
    }
  }, [sidecar, plane, isocenter, matrix, points, width, height]);
  const overlay = placed && "overlay" in placed ? placed.overlay : null,
    supported =
      typeof HTMLVideoElement !== "undefined" &&
      "requestVideoFrameCallback" in HTMLVideoElement.prototype,
    open = !!overlay && !!sidecar && seconds > 0 && !broken && supported,
    result = open && checked?.target === overlay ? checked : null,
    ready = !!result && result.like >= REPLAY_LIMITS.like;

  useEffect(() => {
    if (!recording) return;
    const made = URL.createObjectURL(recording);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [recording]);

  /** The admitted part of the picture the recording shows now, drawn at the
   * admitted frame's size with its redactions. */
  const picture = useCallback(
    (context: CanvasRenderingContext2D, from: HTMLVideoElement) => {
      const [x, y, w, h] = sourceRectangle(plane.crop, plane.source, {
          width: from.videoWidth,
          height: from.videoHeight,
        }),
        across = width / plane.crop[2],
        down = height / plane.crop[3];
      context.drawImage(from, x, y, w, h, 0, 0, width, height);
      context.fillStyle = "#000";
      for (const [rx, ry, rw, rh] of plane.redactions)
        context.fillRect(
          (rx - plane.crop[0]) * across,
          (ry - plane.crop[1]) * down,
          rw * across,
          rh * down,
        );
    },
    [plane, width, height],
  );

  const snapshot = useCallback(() => {
    const span = played.current;
    setFigures(
      span
        ? {
            summary: log.current.summary(),
            from_frame: span.from,
            to_frame: span.to,
          }
        : null,
    );
  }, []);

  /** Draws the frame shown at a media time with its overlay. With the
   * browser's report of the frame's presentation, and while the recording
   * plays, the frame is timed. */
  const paint = useCallback(
    (media_s: number, presented?: { at_ms: number; frames: number }) => {
      const start = performance.now(),
        from = video.current,
        context = canvas.current?.getContext("2d");
      if (!from || !context || !overlay || !sidecar) return;
      const frame = frameAt(media_s, seconds, sidecar.frames);
      picture(context, from);
      if (shownAxis.current) {
        const pixels = overlay.pixels(frame);
        if (pixels) {
          const side = Math.max(2, Math.round(width / 256)),
            half = side / 2;
          context.fillStyle = AXIS_COLOR;
          for (let i = 0; i < pixels.length; i += 2) {
            const x = pixels[i],
              y = pixels[i + 1];
            context.fillRect(x - half, y - half, side, side);
          }
        }
      }
      const done = performance.now();
      if (presented && !from.paused) {
        log.current.add({
          presented_ms: Math.min(presented.at_ms, done),
          drawn_ms: done,
          work_ms: done - start,
          presented_frames: presented.frames,
        });
        played.current = {
          from: played.current?.from ?? frame,
          to: frame,
        };
        if (log.current.drawn() % REFRESH_FRAMES === 0) snapshot();
      }
      if (status.current) {
        const p = sidecar.primary_deg[frame],
          s = sidecar.secondary_deg[frame],
          field = sidecar.field_cm[frame];
        status.current.textContent = [
          `Frame ${frame} of ${sidecar.frames}`,
          sidecar.kinds[sidecar.kind[frame]],
          Number.isNaN(p) ? "angles not read" : angleText(p, s),
          ...(Number.isNaN(field) ? [] : [`field ${field} cm`]),
          ...(frame === plane.frame.index ? ["the saved frame"] : []),
        ].join(" · ");
      }
      if (slider.current) slider.current.value = String(frame);
    },
    [overlay, sidecar, seconds, picture, width, height, plane, snapshot],
  );

  // The recording is checked against the saved frame first: it is taken to
  // that frame, and the picture there is compared with the admitted one.
  const lost = open && missed === overlay,
    checking = open && !result && !lost,
    seeks = useRef(0);
  /** Whether the recording is at the saved frame, or on its way to it. */
  const atSaved = useCallback(
    (from: HTMLVideoElement) =>
      !!sidecar &&
      Math.abs(
        from.currentTime - timeOf(plane.frame.index, seconds, sidecar.frames),
      ) <
        (0.25 * seconds) / sidecar.frames,
    [plane, seconds, sidecar],
  );
  const check = useCallback(() => {
    const from = video.current,
      context = canvas.current?.getContext("2d", { willReadFrequently: true });
    if (!from || !context || !overlay) return;
    picture(context, from);
    const { data } = context.getImageData(0, 0, width, height),
      seen = new Uint8Array(width * height);
    for (let i = 0; i < seen.length; i++)
      seen[i] = Math.round(
        0.299 * data[4 * i] + 0.587 * data[4 * i + 1] + 0.114 * data[4 * i + 2],
      );
    setChecked({ target: overlay, like: likeness(plane.frame.gray, seen) });
  }, [overlay, picture, plane, width, height]);
  /** One step of the check, taken when it starts and at every event of the
   * recording that can move it on. It ends in the picture checked or in the
   * recording said not to reach the saved frame; until then it waits for a
   * seek to end (`seeked`) or for the picture to come (`loadeddata`,
   * `canplay`). */
  const settle = useCallback(
    (started = false) => {
      const from = video.current;
      if (!checking || !from || !sidecar) return;
      if (started) {
        from.pause();
        seeks.current = 0;
      }
      if (atSaved(from)) {
        if (!from.seeking && from.readyState >= HAVE_CURRENT_DATA) check();
      } else if (started || !from.seeking) {
        // The end of a seek to another frame is not the saved frame's
        // picture: the recording is taken there again, a few times.
        if (seeks.current++ < SAVED_FRAME_SEEKS)
          from.currentTime = timeOf(plane.frame.index, seconds, sidecar.frames);
        else setMissed(overlay);
      }
    },
    [checking, plane, seconds, sidecar, overlay, atSaved, check],
  );
  useEffect(() => settle(true), [settle]);
  const onSeeked = () => {
    const from = video.current;
    if (!from) return;
    if (checking) settle();
    else if (ready) paint(from.currentTime);
  };

  // Every frame the browser presents is drawn, and asks for the next.
  useEffect(() => {
    const from = video.current;
    if (!ready || !from) return;
    paint(from.currentTime);
    let handle = 0;
    const next: VideoFrameRequestCallback = (_now, metadata) => {
      paint(metadata.mediaTime, {
        at_ms: metadata.presentationTime,
        frames: metadata.presentedFrames,
      });
      handle = from.requestVideoFrameCallback(next);
    };
    handle = from.requestVideoFrameCallback(next);
    return () => from.cancelVideoFrameCallback(handle);
  }, [ready, paint]);
  useEffect(() => {
    if (ready && video.current?.paused) paint(video.current.currentTime);
    // Only when the axis is shown or hidden.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [axis]);
  useEffect(() => {
    if (disabled) video.current?.pause();
  }, [disabled]);

  /** The figures are of one stretch of one plane's recording. */
  const forget = () => {
    log.current.clear();
    played.current = null;
    setFigures(null);
  };
  const stopped = () => {
      setPlaying(false);
      snapshot();
    },
    go = (frame: number) => {
      if (video.current && sidecar)
        video.current.currentTime = timeOf(frame, seconds, sidecar.frames);
    },
    save = () => {
      if (!figures || !sidecar) return;
      const href = URL.createObjectURL(
          new Blob(
            [
              JSON.stringify(
                {
                  ...figures.summary,
                  overlay_method: REPLAY_OVERLAY_METHOD,
                  frame_table_layout: SIDECAR_LAYOUT,
                  plane: plane.frame.plane,
                  saved_frame: {
                    source_id: plane.frame.source_id,
                    manifest_revision: plane.frame.manifest_revision,
                    index: plane.frame.index,
                    sha256: plane.frame.sha256,
                  },
                  recording: {
                    frames: sidecar.frames,
                    seconds,
                    frames_per_second: sidecar.frames / seconds,
                  },
                  frame_size: [width, height],
                  axis_points: points.length / 3,
                  played: {
                    from_frame: figures.from_frame,
                    to_frame: figures.to_frame,
                  },
                },
                null,
                2,
              ),
            ],
            { type: "application/json" },
          ),
        ),
        link = document.createElement("a");
      link.href = href;
      link.download = "replay-latency.json";
      link.click();
      URL.revokeObjectURL(href);
    },
    failure =
      table && "failure" in table
        ? table.failure
        : placed && "failure" in placed
          ? placed.failure
          : broken
            ? "The browser cannot play this recording"
            : lost
              ? "The recording could not be taken to the saved frame"
              : !supported && recording
                ? "This browser does not report the frames it presents"
                : null,
    ms = (value: number) => value.toFixed(1),
    measured = figures?.summary.latency_ms ? figures : null;

  return (
    <fieldset aria-labelledby="replay-title">
      <legend id="replay-title">Recording replay</legend>
      <p className="carm-note">
        Open the recording a saved frame was admitted from and its frame table.
        Every frame is drawn with the vessel axis of the saved proposal, turned
        with the C-arm as the table gives its angles.
      </p>
      {planes.length > 1 && (
        <div className="native-actions" role="radiogroup" aria-label="Plane">
          {planes.map((one, k) => (
            <label key={one.frame.plane}>
              <input
                type="radio"
                name="replay-plane"
                checked={k === choice}
                disabled={disabled}
                onChange={() => {
                  setChoice(k);
                  forget();
                }}
              />
              Plane {one.frame.plane.toUpperCase()}
            </label>
          ))}
        </div>
      )}
      <div className="native-actions">
        <label>
          Recording
          <input
            type="file"
            accept="video/*"
            disabled={disabled}
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              setRecording(file);
              setSeconds(0);
              setBroken(false);
              setChecked(null);
              setMissed(null);
              setPlaying(false);
              forget();
            }}
          />
        </label>
        <label>
          Frame table
          <input
            type="file"
            accept=".csv,text/csv"
            disabled={disabled}
            onChange={(event) => {
              const file = event.target.files?.[0],
                mine = ++reading.current;
              setTable(null);
              forget();
              if (!file) return;
              // A character takes at most three bytes, so a file of more
              // bytes than three times the limit is refused unread.
              (file.size > 3 * SIDECAR_LIMITS.max_chars
                ? Promise.reject(new Error(TABLE_TOO_LARGE))
                : readText(file)
              )
                .then((text) => ({ sidecar: parseSidecar(text) }))
                .catch((error: unknown) => ({
                  failure:
                    error instanceof Error
                      ? error.message
                      : "The frame table cannot be read",
                }))
                .then((next) => {
                  if (reading.current === mine) setTable(next);
                });
            }}
          />
        </label>
      </div>
      <video
        ref={video}
        src={url || undefined}
        muted
        playsInline
        preload="auto"
        className="replay-source"
        onLoadedMetadata={(event) => {
          const { duration, videoWidth, videoHeight } = event.currentTarget;
          // A file with a length and a picture; anything else cannot be
          // replayed.
          if (
            Number.isFinite(duration) &&
            duration > 0 &&
            videoWidth &&
            videoHeight
          )
            setSeconds(duration);
          else setBroken(true);
        }}
        onSeeked={onSeeked}
        onLoadedData={() => settle()}
        onCanPlay={() => settle()}
        onError={() => setBroken(true)}
        onPlay={() => setPlaying(true)}
        onPause={stopped}
        onEnded={stopped}
      />
      {failure && <p role="alert">{failure}.</p>}
      {result && !ready && (
        <p role="alert">
          Frame {plane.frame.index} of this recording is not the saved frame
          (likeness {result.like.toFixed(2)}, at least{" "}
          {REPLAY_LIMITS.like.toFixed(2)} is needed). Open the recording the
          frame was admitted from.
        </p>
      )}
      {checking && <p role="status">Checking the recording…</p>}
      <figure
        className="native-render-figure angio-overlay-figure"
        hidden={!open}
      >
        <canvas
          ref={canvas}
          width={width}
          height={height}
          className="native-reformat-canvas angio-overlay-canvas"
          role="img"
          aria-label="Recording frame with the vessel axis"
        />
        <figcaption>
          <span ref={status} role="status" aria-label="Replayed frame" />
        </figcaption>
      </figure>
      <div className="native-actions">
        <button
          type="button"
          disabled={disabled || !ready}
          onClick={() => {
            const from = video.current;
            if (!from) return;
            if (playing) from.pause();
            else {
              forget();
              // A recording the browser does not start stays stopped.
              from.play().catch(() => {});
            }
          }}
        >
          {playing ? "Pause" : "Play"}
        </button>
        <button
          type="button"
          disabled={disabled || !ready || playing}
          onClick={() => go(plane.frame.index)}
        >
          Go to the saved frame
        </button>
        <label>
          <input
            type="checkbox"
            checked={axis}
            disabled={disabled}
            onChange={(event) => setAxis(event.target.checked)}
          />
          Vessel axis
        </label>
        <label>
          Frame
          <input
            ref={slider}
            type="range"
            min={0}
            max={sidecar ? sidecar.frames - 1 : 0}
            step={1}
            defaultValue={0}
            disabled={disabled || !ready || playing}
            onChange={(event) => go(Number(event.target.value))}
          />
        </label>
      </div>
      {measured && (
        <>
          <table className="carm-table" aria-label="Overlay latency">
            <thead>
              <tr>
                <td />
                <th scope="col">Median</th>
                <th scope="col">95th percentile</th>
                <th scope="col">Worst</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Frame presented to overlay drawn (ms)</th>
                <td>{ms(measured.summary.latency_ms!.median)}</td>
                <td>{ms(measured.summary.latency_ms!.p95)}</td>
                <td>{ms(measured.summary.latency_ms!.worst)}</td>
              </tr>
              <tr>
                <th scope="row">Of that, placing and drawing (ms)</th>
                <td>{ms(measured.summary.work_ms!.median)}</td>
                <td>{ms(measured.summary.work_ms!.p95)}</td>
                <td>{ms(measured.summary.work_ms!.worst)}</td>
              </tr>
            </tbody>
          </table>
          <p role="status" aria-label="Frames drawn">
            {measured.summary.frames_drawn} of the{" "}
            {measured.summary.frames_presented} frames the browser presented
            were drawn, frames {measured.from_frame} to {measured.to_frame}.
          </p>
          <div className="native-actions">
            <button type="button" disabled={disabled} onClick={save}>
              Save latency figures
            </button>
          </div>
        </>
      )}
    </fieldset>
  );
}
