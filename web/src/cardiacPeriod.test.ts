import { describe, expect, it } from "vitest";
import {
  CARDIAC_PERIOD,
  CARDIAC_PERIOD_METHOD,
  cardiacPeriod,
} from "./cardiacPeriod";
import type { CineFrame } from "./coronaryMotion";
import { CT_CINE, noise, renderCtCine } from "./__fixtures__/coronaryCtCine";
import { renderCine, CINE } from "./__fixtures__/coronaryCine";

describe("heart period from the cine itself", () => {
  const cine = renderCtCine();

  it("reads the period and the quiet frames of each beat", () => {
    const found = cardiacPeriod(cine.frames);
    expect(found.method).toBe(CARDIAC_PERIOD_METHOD);
    if (found.status !== "read") throw new Error(found.reason);
    expect(Math.abs(found.period_ms - CT_CINE.period_ms)).toBeLessThan(
      0.04 * CT_CINE.period_ms,
    );
    // One quiet frame per beat, each in the diastasis of its beat.
    expect(found.quiet_frames.length).toBeGreaterThanOrEqual(3);
    for (const k of found.quiet_frames) {
      const phase = cine.phases[k];
      expect(phase).toBeGreaterThan(0.5);
      expect(phase).toBeLessThan(0.92);
    }
    const gaps = found.quiet_frames
      .slice(1)
      .map((k, i) => (k - found.quiet_frames[i]) * CT_CINE.frame_ms);
    for (const g of gaps)
      expect(Math.abs(g - CT_CINE.period_ms)).toBeLessThan(0.25 * CT_CINE.period_ms);
  });

  it("reads the period of the first synthetic cine", () => {
    const { frames } = renderCine();
    const found = cardiacPeriod(frames);
    if (found.status !== "read") throw new Error(found.reason);
    expect(Math.abs(found.period_ms - CINE.period_ms)).toBeLessThan(40);
  });

  it("does not read a period where nothing beats", () => {
    const still = renderCtCine({ still: true });
    const found = cardiacPeriod(still.frames);
    expect(found.status).toBe("not_read");
    if (found.status === "not_read") expect(found.reason).toBe("no_rhythm");
  });

  it("does not read a period from noise", () => {
    const random = noise(3);
    const frames: CineFrame[] = Array.from({ length: 60 }, (_, k) => ({
      width: 64,
      height: 64,
      time_ms: k * 66.7,
      pixels: Uint8Array.from({ length: 64 * 64 }, () =>
        Math.round(100 + 50 * random()),
      ),
    }));
    expect(cardiacPeriod(frames).status).toBe("not_read");
  });

  it("does not force a period on a cine shorter than two beats", () => {
    const short = renderCtCine({ frames: 20 });
    const found = cardiacPeriod(short.frames);
    expect(found.status).toBe("not_read");
    // 20 frames hold 1.5 beats: periods past 2.5 in the cine are not
    // looked for, and nothing shorter repeats.
    if (found.status === "not_read") expect(found.reason).toBe("no_rhythm");
    const tiny = cardiacPeriod(short.frames.slice(0, 8));
    expect(tiny.status === "not_read" && tiny.reason).toBe("too_short");
  });

  it("refuses frame times that do not rise or are uneven", () => {
    const frames = cine.frames.map((f) => ({ ...f }));
    frames[10] = { ...frames[10], time_ms: frames[9].time_ms };
    expect(() => cardiacPeriod(frames)).toThrow(/Cine frame times must rise/);
    const uneven = cine.frames.map((f, k) => ({
      ...f,
      time_ms: k < 30 ? k * 66.7 : 2000 + (k - 30) * 20,
    }));
    const found = cardiacPeriod(uneven);
    expect(found.status).toBe("not_read");
    if (found.status === "not_read") expect(found.reason).toBe("uneven_times");
  });

  it("keeps its search inside the heart's range", () => {
    expect(CARDIAC_PERIOD.period_ms).toEqual([333, 1500]);
  });
});
