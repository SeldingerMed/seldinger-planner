import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { CINE_BUNDLE_FORMAT, parseCineBundle } from "./cineBundle";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function header(change: Record<string, unknown> = {}) {
  return {
    format: CINE_BUNDLE_FORMAT,
    source_sha256: "a".repeat(64),
    frames: 3,
    rows: 2,
    columns: 4,
    times_ms: [0, 66.67, 133.34],
    timing: "frame_time",
    view: {
      primary_deg: -30.5,
      secondary_deg: 20.25,
      source_detector_mm: 1195,
      source_isocenter_mm: 765,
      detector_width_mm: 200,
      detector_height_mm: 200,
    },
    geometry: "fixed",
    transfer_syntax: "1.2.840.10008.1.2.4.70",
    window: "percentile_0.5_99.5_whole_cine",
    identifiers: "not_carried",
    ...change,
  };
}

function bundle(h: Record<string, unknown> = header(), body?: Uint8Array) {
  const frames = body ?? Uint8Array.from({ length: 24 }, (_, i) => i * 10);
  const text = new TextEncoder().encode(`${CINE_BUNDLE_FORMAT}\n${JSON.stringify(h)}\n`);
  const out = new Uint8Array(text.length + frames.length);
  out.set(text);
  out.set(frames, text.length);
  return out;
}

describe("the local cine bundle", () => {
  it("is read with its frames, times, view and digests", async () => {
    const bytes = bundle();
    const read = await parseCineBundle(bytes.buffer);
    expect(read.bundle_sha256).toBe(hex(sha256(bytes)));
    expect(read.source_sha256).toBe("a".repeat(64));
    expect(read.timing).toBe("frame_time");
    expect(read.geometry).toBe("fixed");
    expect(read.view?.primary_deg).toBe(-30.5);
    expect(read.frames.map((f) => f.time_ms)).toEqual([0, 66.67, 133.34]);
    expect(read.frames[1].pixels).toEqual(Uint8Array.from({ length: 8 }, (_, i) => (8 + i) * 10));
    expect(read.frames[0].width).toBe(4);
    expect(read.frames[0].height).toBe(2);
  });

  it("keeps a cine without recorded times, saying so", async () => {
    const read = await parseCineBundle(
      bundle(header({ times_ms: null, timing: "cine_rate" })).buffer,
    );
    expect(read.timing).toBe("cine_rate");
    expect(read.frames.map((f) => f.time_ms)).toEqual([NaN, NaN, NaN]);
  });

  it.each([
    ["another format", { format: "other" }],
    ["a short body", { frames: 4 }],
    ["times that go back", { times_ms: [0, 70, 60] }],
    ["times of the wrong count", { times_ms: [0, 70] }],
    ["an unknown key", { patient: "x" }],
    ["identifiers", { identifiers: "carried" }],
    ["a bad digest", { source_sha256: "A".repeat(64) }],
    ["half a view", { view: { primary_deg: 0 } }],
    ["an unknown timing", { timing: "guessed" }],
  ])("refuses %s", async (_, change) => {
    await expect(parseCineBundle(bundle(header(change)).buffer)).rejects.toThrow(
      "Not a cine bundle",
    );
  });

  it("refuses bytes that are not a bundle", async () => {
    await expect(parseCineBundle(new Uint8Array([1, 2, 3]).buffer)).rejects.toThrow(
      "Not a cine bundle",
    );
  });
});
