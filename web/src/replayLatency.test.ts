import { describe, expect, it } from "vitest";
import { createLatencyLog, REPLAY_LATENCY_METHOD } from "./replayLatency";

describe("latency of the overlay on a replayed recording", () => {
  it("has no figures before a frame is drawn", () => {
    expect(createLatencyLog().summary()).toEqual({
      method: REPLAY_LATENCY_METHOD,
      frames_presented: 0,
      frames_drawn: 0,
      frames_not_drawn: 0,
      latency_ms: null,
      work_ms: null,
    });
  });

  it("gives the median, the 95th percentile and the worst of the frames drawn", () => {
    const log = createLatencyLog();
    // Twenty frames, each presented at 100 k and drawn 1 to 20 ms later,
    // out of order; the work took half the time.
    const late = [
      7, 3, 20, 1, 12, 9, 15, 5, 18, 2, 11, 14, 4, 17, 8, 19, 6, 13, 10, 16,
    ];
    late.forEach((ms, k) =>
      log.add({
        presented_ms: 100 * k,
        drawn_ms: 100 * k + ms,
        work_ms: ms / 2,
        presented_frames: 40 + k,
      }),
    );
    expect(log.summary()).toEqual({
      method: REPLAY_LATENCY_METHOD,
      frames_presented: 20,
      frames_drawn: 20,
      frames_not_drawn: 0,
      // Nearest rank: the 10th and the 19th of 20.
      latency_ms: { median: 10, p95: 19, worst: 20 },
      work_ms: { median: 5, p95: 9.5, worst: 10 },
    });
  });

  it("counts the frames the browser presented between two that were drawn", () => {
    const log = createLatencyLog();
    for (const presented_frames of [10, 11, 14, 15, 19])
      log.add({
        presented_ms: 0,
        drawn_ms: 4,
        work_ms: 1,
        presented_frames,
      });
    const found = log.summary();
    expect(found.frames_presented).toBe(10);
    expect(found.frames_drawn).toBe(5);
    expect(found.frames_not_drawn).toBe(5);
    expect(found.latency_ms).toEqual({ median: 4, p95: 4, worst: 4 });
  });

  it("starts again when cleared, and keeps one figure for one frame", () => {
    const log = createLatencyLog();
    log.add({ presented_ms: 0, drawn_ms: 9, work_ms: 2, presented_frames: 3 });
    log.clear();
    expect(log.summary().frames_drawn).toBe(0);
    log.add({ presented_ms: 5, drawn_ms: 8, work_ms: 2, presented_frames: 90 });
    expect(log.summary()).toMatchObject({
      frames_presented: 1,
      frames_drawn: 1,
      latency_ms: { median: 3, p95: 3, worst: 3 },
    });
  });

  it("refuses a time that is not a number, and a frame drawn before it was presented", () => {
    const log = createLatencyLog(),
      good = { presented_ms: 0, drawn_ms: 4, work_ms: 1, presented_frames: 1 };
    for (const bad of [
      { presented_ms: NaN },
      { drawn_ms: Infinity },
      { work_ms: -1 },
      { drawn_ms: -1 },
      { presented_frames: 1.5 },
    ])
      expect(() => log.add({ ...good, ...bad })).toThrow(
        "Invalid frame timing",
      );
    expect(log.summary().frames_drawn).toBe(0);
  });
});
