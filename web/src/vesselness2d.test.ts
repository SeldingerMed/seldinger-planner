import { describe, expect, it } from "vitest";
import {
  vesselTarget,
  vesselTargetSteps,
  VESSEL_TARGET_LIMITS,
} from "./vesselness2d";

/** Bright background with one dark line of half-width `half` px along
 * `y = slope * x + offset`, plus optional extras painted afterwards. */
function lineFrame(
  width: number,
  height: number,
  { slope = 0.4, offset = 40, half = 2.2, depth = 90 } = {},
  paint?: (out: Uint8Array) => void,
) {
  const out = new Uint8Array(width * height);
  const norm = Math.hypot(slope, 1);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const distance = Math.abs(slope * x - y + offset) / norm;
      out[y * width + x] = Math.round(
        180 - depth * Math.exp(-(distance * distance) / (2 * half * half)),
      );
    }
  paint?.(out);
  return out;
}
const lineDistance = (x: number, y: number, slope = 0.4, offset = 40) =>
  Math.abs(slope * x - y + offset) / Math.hypot(slope, 1);

describe("vessel target", () => {
  it("marks the crest of a dark line and measures distance to it", () => {
    const width = 200,
      height = 160,
      target = vesselTarget(lineFrame(width, height), width, height, "dark");
    expect([target.width, target.height, target.scale]).toEqual([200, 160, 1]);
    expect(target.centerline.length).toBeGreaterThan(120);
    for (const at of target.centerline) {
      const x = at % width,
        y = (at - x) / width;
      expect(lineDistance(x, y)).toBeLessThan(1.5);
    }
    // 30 px from the line, well inside the frame.
    const x = 100,
      y = Math.round(0.4 * x + 40 + 30 * Math.hypot(0.4, 1));
    expect(target.distance[y * width + x]).toBeGreaterThan(28);
    expect(target.distance[y * width + x]).toBeLessThan(32);
    expect(Math.max(...target.distance)).toBeLessThanOrEqual(
      VESSEL_TARGET_LIMITS.max_distance_px,
    );
  });

  it("finds a bright line only at bright polarity", () => {
    const width = 160,
      height = 160,
      dark = lineFrame(width, height),
      bright = dark.map((value) => 255 - value);
    expect(
      vesselTarget(bright, width, height, "bright").centerline.length,
    ).toBe(vesselTarget(dark, width, height, "dark").centerline.length);
    expect(() => vesselTarget(bright, width, height, "dark")).toThrow(
      "No line-like vessels",
    );
  });

  it("ignores step edges such as a redaction box or a collimator", () => {
    const width = 200,
      height = 160;
    const boxed = lineFrame(width, height, {}, (out) => {
      for (let y = 10; y < 40; y++)
        for (let x = 120; x < 190; x++) out[y * width + x] = 0;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < 12; x++) out[y * width + x] = 0;
    });
    const target = vesselTarget(boxed, width, height, "dark");
    for (const at of target.centerline) {
      const x = at % width,
        y = (at - x) / width;
      expect(lineDistance(x, y)).toBeLessThan(1.5);
    }
    // Edges alone are not vessels.
    const edges = new Uint8Array(width * height).fill(180);
    for (let y = 30; y < 110; y++)
      for (let x = 50; x < 150; x++) edges[y * width + x] = 0;
    expect(() => vesselTarget(edges, width, height, "dark")).toThrow(
      "No line-like vessels",
    );
  });

  it("drops isolated specks and refuses a featureless frame", () => {
    const width = 128,
      height = 128,
      specks = new Uint8Array(width * height).fill(170);
    for (const [x, y] of [
      [20, 20],
      [60, 90],
      [100, 40],
    ])
      specks[y * width + x] = 20;
    expect(() => vesselTarget(specks, width, height, "dark")).toThrow(
      "No line-like vessels",
    );
    expect(() =>
      vesselTarget(
        new Uint8Array(width * height).fill(90),
        width,
        height,
        "dark",
      ),
    ).toThrow("No line-like vessels");
  });

  it("finds more of a faint line at higher sensitivity", () => {
    const width = 200,
      height = 160;
    const frame = lineFrame(width, height, {}, (out) => {
      // A second, much fainter line crossing the first.
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const distance = Math.abs(x + y - 230) / Math.SQRT2;
          out[y * width + x] -= Math.round(
            14 * Math.exp(-(distance * distance) / 8),
          );
        }
    });
    const low = vesselTarget(frame, width, height, "dark", 0),
      high = vesselTarget(frame, width, height, "dark", 1);
    expect(high.centerline.length).toBeGreaterThan(low.centerline.length + 40);
  });

  it("block-averages a large frame and keeps frame coordinates recoverable", () => {
    const width = 1024,
      height = 768;
    const target = vesselTarget(
      lineFrame(width, height, { half: 6, offset: 150 }),
      width,
      height,
      "dark",
    );
    expect([target.scale, target.width, target.height]).toEqual([3, 341, 256]);
    for (const at of target.centerline) {
      const x = ((at % target.width) + 0.5) * target.scale,
        y = (Math.floor(at / target.width) + 0.5) * target.scale;
      expect(lineDistance(x, y, 0.4, 150)).toBeLessThan(4.5);
    }
  });

  it("yields between stages and equals the one-shot result", () => {
    const width = 160,
      height = 128,
      frame = lineFrame(width, height),
      steps = vesselTargetSteps(frame, width, height, "dark", 0.5);
    let yields = 0,
      next = steps.next();
    while (!next.done) {
      yields++;
      next = steps.next();
    }
    expect(yields).toBeGreaterThanOrEqual(
      VESSEL_TARGET_LIMITS.scales_px.length + 1,
    );
    const once = vesselTarget(frame, width, height, "dark", 0.5);
    expect([...next.value.centerline]).toEqual([...once.centerline]);
  });

  it("rejects unsupported frames and settings", () => {
    const ok = new Uint8Array(64 * 64);
    for (const [gray, w, h] of [
      [new Uint8Array(63 * 64), 63, 64],
      [new Uint8Array(1025 * 64), 1025, 64],
      [new Uint8Array(10), 64, 64],
      [ok, 64.5, 64],
      [new Float32Array(64 * 64) as unknown as Uint8Array, 64, 64],
    ] as [Uint8Array, number, number][])
      expect(() => vesselTarget(gray, w, h, "dark")).toThrow(
        "Frame size is outside the supported range",
      );
    expect(() => vesselTarget(ok, 64, 64, "inverted" as "dark")).toThrow(
      "Invalid vessel polarity",
    );
    for (const sensitivity of [-0.1, 1.1, NaN])
      expect(() => vesselTarget(ok, 64, 64, "dark", sensitivity)).toThrow(
        "Invalid vessel sensitivity",
      );
  });
});
