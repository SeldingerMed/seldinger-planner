/** Latency of the overlay on a replayed recording, as the browser reports
 * it: for each frame drawn, the time from the browser presenting the frame
 * to the frame and its overlay being drawn; and the frames the browser
 * presented that were not drawn. */

export const REPLAY_LATENCY_METHOD = "presentation_to_overlay_drawn_v1";

export type FrameTiming = {
  /** When the browser presented the frame, on the page's clock. */
  presented_ms: number;
  /** When the frame and its overlay were drawn. */
  drawn_ms: number;
  /** What reading the frame's angles, placing the axis and drawing took. */
  work_ms: number;
  /** The browser's count of frames presented so far, this one included. */
  presented_frames: number;
};
export type Spread = { median: number; p95: number; worst: number };
export type LatencySummary = {
  method: typeof REPLAY_LATENCY_METHOD;
  /** From the first frame drawn to the last. */
  frames_presented: number;
  frames_drawn: number;
  frames_not_drawn: number;
  latency_ms: Spread | null;
  work_ms: Spread | null;
};

/** Nearest rank: the smallest value with at least the share at or under it. */
function spread(values: number[]): Spread | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b),
    rank = (share: number) =>
      sorted[Math.max(1, Math.ceil(share * sorted.length)) - 1];
  return {
    median: rank(0.5),
    p95: rank(0.95),
    worst: sorted[sorted.length - 1],
  };
}

export function createLatencyLog() {
  let latency: number[] = [],
    work: number[] = [],
    first = 0,
    last = 0;
  return {
    add(timing: FrameTiming) {
      const late = timing.drawn_ms - timing.presented_ms;
      if (
        !Number.isFinite(late) ||
        late < 0 ||
        !Number.isFinite(timing.work_ms) ||
        timing.work_ms < 0 ||
        !Number.isInteger(timing.presented_frames)
      )
        throw new Error("Invalid frame timing");
      if (!latency.length) first = timing.presented_frames;
      last = timing.presented_frames;
      latency.push(late);
      work.push(timing.work_ms);
    },
    clear() {
      latency = [];
      work = [];
    },
    /** Frames drawn so far, at no cost: the figures sort every one of them. */
    drawn() {
      return latency.length;
    },
    summary(): LatencySummary {
      const presented = latency.length ? last - first + 1 : 0;
      return {
        method: REPLAY_LATENCY_METHOD,
        frames_presented: presented,
        frames_drawn: latency.length,
        frames_not_drawn: Math.max(0, presented - latency.length),
        latency_ms: spread(latency),
        work_ms: spread(work),
      };
    },
  };
}
export type LatencyLog = ReturnType<typeof createLatencyLog>;
