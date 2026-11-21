import { describe, expect, it } from "vitest";
import { renderFrame, rigid } from "./__fixtures__/angioPhantom";
import type { ViewNumbers } from "./carmGeometry";
import {
  VESSEL_EVIDENCE_LIMITS as LIMITS,
  vesselEvidence,
  vesselEvidenceSteps,
} from "./vesselEvidence2d";

const AP: ViewNumbers = {
  primary_deg: 0,
  secondary_deg: 0,
  source_detector_mm: 1200,
  source_isocenter_mm: 800,
  detector_width_mm: 180,
  detector_height_mm: 180,
};
const identity = rigid([0, 0, 0], [0, 0, 0]);

/** A bright frame with vertical dark lines: [column, half width, depth]. */
function lines(
  side: number,
  marks: [number, number, number][],
  noise = 0,
): Uint8Array {
  const gray = new Uint8Array(side * side);
  let state = 5;
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      let value = 200;
      for (const [column, half, depth] of marks)
        value -= depth * Math.exp(-((x - column) ** 2) / (2 * half * half));
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      gray[y * side + x] = Math.max(
        0,
        Math.min(255, Math.round(value + noise * (state / 2 ** 32 - 0.5))),
      );
    }
  return gray;
}
const finest = (e: ReturnType<typeof vesselEvidence>) =>
  e.levels[e.levels.length - 1];
function columnMean(map: Float32Array, side: number, x: number) {
  let sum = 0;
  for (let y = 40; y < side - 40; y++) sum += map[y * side + x];
  return sum / (side - 80);
}

describe("vessel evidence", () => {
  it("is high on a line and near zero away from it", () => {
    const side = 200,
      e = vesselEvidence(lines(side, [[100, 2, 80]], 6), side, side, "dark");
    expect([e.width, e.height, e.scale]).toEqual([side, side, 1]);
    expect(e.levels.length).toBe(LIMITS.blur_px.length);
    for (const level of e.levels) expect(level.length).toBe(side * side);
    expect(columnMean(finest(e), side, 100)).toBeGreaterThan(0.8);
    expect(columnMean(finest(e), side, 60)).toBeLessThan(0.05);
    for (const value of finest(e)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("marks only the crest of a wide line", () => {
    // A line about 14 pixels wide: the evidence is its middle, not its width.
    const side = 200,
      e = vesselEvidence(lines(side, [[100, 6, 80]]), side, side, "dark"),
      map = finest(e);
    expect(columnMean(map, side, 100)).toBeGreaterThan(0.8);
    for (const x of [94, 96, 104, 106])
      expect(columnMean(map, side, x)).toBeLessThan(0.05);
  });

  it("keeps a faint line that is an eighth as deep as a strong one", () => {
    // The thresholded target of the older methods drops a line like this.
    const side = 240,
      gray = lines(
        side,
        [
          [70, 3, 120],
          [170, 1.5, 15],
        ],
        4,
      ),
      e = vesselEvidence(gray, side, side, "dark"),
      strong = columnMean(finest(e), side, 70),
      faint = columnMean(finest(e), side, 170);
    expect(strong).toBeGreaterThan(0.8);
    expect(faint).toBeGreaterThan(0.25);
    expect(faint).toBeLessThan(strong);
    expect(columnMean(finest(e), side, 120)).toBeLessThan(0.05);
  });

  it("spreads further at the wider levels", () => {
    const side = 200,
      e = vesselEvidence(lines(side, [[100, 2, 80]]), side, side, "dark");
    // Twelve pixels from the line: seen by the widest level only.
    expect(columnMean(e.levels[0], side, 112)).toBeGreaterThan(0.3);
    expect(columnMean(finest(e), side, 112)).toBeLessThan(0.01);
    // Each level is its own blur, so the line itself stays near 1 in all.
    for (const level of e.levels)
      expect(columnMean(level, side, 100)).toBeGreaterThan(0.8);
  });

  it("gives a step edge and a blob no evidence", () => {
    const side = 200,
      gray = lines(side, [[150, 2, 80]]);
    for (let y = 0; y < side; y++)
      for (let x = 0; x < 50; x++) gray[y * side + x] = 60;
    for (let y = 0; y < side; y++)
      for (let x = 60; x < 130; x++) {
        const r2 = (x - 95) ** 2 + (y - 100) ** 2;
        gray[y * side + x] = Math.round(200 - 120 * Math.exp(-r2 / 72));
      }
    const map = finest(vesselEvidence(gray, side, side, "dark"));
    expect(columnMean(map, side, 150)).toBeGreaterThan(0.8);
    expect(columnMean(map, side, 50)).toBeLessThan(0.05);
    expect(columnMean(map, side, 49)).toBeLessThan(0.05);
    expect(map[100 * side + 95]).toBeLessThan(0.05);
  });

  it("treats bright vessels as the mirror of dark ones", () => {
    const side = 200,
      dark = lines(side, [[100, 2, 80]], 6),
      bright = dark.map((value) => 255 - value);
    expect(vesselEvidence(bright, side, side, "bright").levels).toEqual(
      vesselEvidence(dark, side, side, "dark").levels,
    );
    // Read at the wrong polarity the line is a crest, not a dip.
    expect(() => vesselEvidence(dark, side, side, "bright")).toThrow(
      "No line-like vessels",
    );
  });

  it("follows the vessels of the phantom", () => {
    const side = 300,
      gray = renderFrame(AP, [0, 0, 0], identity, {
        width: side,
        height: side,
        polarity: "dark",
        noise: 12,
        seed: 7,
      }),
      e = vesselEvidence(gray, side, side, "dark"),
      map = finest(e);
    // Evidence concentrates where the frame is dark.
    let on = 0,
      onCount = 0,
      off = 0,
      offCount = 0;
    for (let k = 0; k < map.length; k++)
      if (gray[k] < 150) {
        on += map[k];
        onCount++;
      } else if (gray[k] > 180) {
        off += map[k];
        offCount++;
      }
    expect(onCount).toBeGreaterThan(1500);
    // Only the crest of each vessel carries evidence, so the mean over a
    // vessel's whole width is well under 1.
    expect(on / onCount).toBeGreaterThan(0.2);
    expect(off / offCount).toBeLessThan(0.08);
    expect(on / onCount).toBeGreaterThan((3 * off) / offCount);
    expect(e.strong.length).toBeGreaterThan(LIMITS.min_strong_px);
    for (const at of e.strong) expect(map[at]).toBeGreaterThanOrEqual(0.5);
  });

  it.each([0, 12])(
    "finds vessels that fill a small share of a large field, noise %i",
    (noise) => {
      // A 600 mm field: the vessels cover about a quarter of a percent of
      // the frame, as a selective injection in a wide field can.
      const side = 900,
        wide = { ...AP, detector_width_mm: 600, detector_height_mm: 600 },
        gray = renderFrame(wide, [0, 0, 0], identity, {
          width: side,
          height: side,
          polarity: "dark",
          noise,
          seed: 7,
        }),
        e = vesselEvidence(gray, side, side, "dark"),
        map = finest(e);
      let on = 0,
        onCount = 0,
        off = 0,
        offCount = 0;
      for (let y = 0; y < e.height; y++)
        for (let x = 0; x < e.width; x++) {
          const value = gray[y * e.scale * side + x * e.scale];
          if (value < 130) {
            on += map[y * e.width + x];
            onCount++;
          } else if (value > 180) {
            off += map[y * e.width + x];
            offCount++;
          }
        }
      expect(onCount).toBeGreaterThan(200);
      expect(on / onCount).toBeGreaterThan(0.2);
      expect(on / onCount).toBeGreaterThan((5 * off) / offCount);
    },
  );

  it("works on a block-averaged grid for a large frame", () => {
    const side = 1000,
      gray = lines(side, [[500, 6, 80]]),
      e = vesselEvidence(gray, side, side, "dark");
    expect([e.width, e.height, e.scale]).toEqual([500, 500, 2]);
    expect(columnMean(finest(e), 500, 250)).toBeGreaterThan(0.8);
    // A side that the block does not divide loses its trailing partial block.
    const odd = vesselEvidence(lines(769, [[300, 6, 80]]), 769, 769, "dark");
    expect([odd.width, odd.height, odd.scale]).toEqual([384, 384, 2]);
  });

  describe("with excluded pixels", () => {
    const side = 200,
      // A faint line at column 60 and one eight times as deep at 140.
      gray = lines(
        side,
        [
          [60, 2, 20],
          [140, 2, 160],
        ],
        4,
      ),
      band = (from: number, to: number) => {
        const mask = new Uint8Array(side * side);
        for (let y = 0; y < side; y++)
          for (let x = from; x <= to; x++) mask[y * side + x] = 1;
        return mask;
      };

    it("gives them no evidence and leaves the other lines theirs", () => {
      const plain = vesselEvidence(gray, side, side, "dark"),
        e = vesselEvidence(gray, side, side, "dark", band(134, 146));
      expect(columnMean(finest(plain), side, 140)).toBeGreaterThan(0.8);
      expect(columnMean(finest(e), side, 140)).toBe(0);
      // The line left in is no weaker for it: the deep line no longer sets
      // the scale.
      expect(columnMean(finest(e), side, 60)).toBeGreaterThanOrEqual(
        columnMean(finest(plain), side, 60),
      );
      expect(columnMean(finest(e), side, 60)).toBeGreaterThan(0.8);
    });

    it("changes nothing when no pixel is excluded", () => {
      expect(
        vesselEvidence(gray, side, side, "dark", new Uint8Array(side * side)),
      ).toEqual(vesselEvidence(gray, side, side, "dark"));
    });

    it("takes a working pixel out for one excluded frame pixel in its block", () => {
      const big = 1000,
        frame = lines(big, [[500, 6, 80]]),
        mask = new Uint8Array(big * big);
      // One pixel of each two-by-two block across the line and beside it.
      for (let y = 0; y < big; y += 2)
        for (let x = 480; x <= 520; x += 2) mask[(y + 1) * big + x + 1] = 1;
      const plain = vesselEvidence(frame, big, big, "dark"),
        other = lines(big, [
          [500, 6, 80],
          [200, 6, 80],
        ]),
        e = vesselEvidence(other, big, big, "dark", mask);
      expect(plain.scale).toBe(2);
      expect(columnMean(plain.levels[0], 500, 250)).toBeGreaterThan(0.8);
      expect(columnMean(finest(e), 500, 250)).toBe(0);
      expect(columnMean(finest(e), 500, 100)).toBeGreaterThan(0.8);
    });

    it("refuses a mask that is not the frame's, and a frame with nothing left", () => {
      expect(() =>
        vesselEvidence(gray, side, side, "dark", new Uint8Array(side)),
      ).toThrow("Excluded pixels do not match the frame");
      expect(() =>
        vesselEvidence(
          gray,
          side,
          side,
          "dark",
          Array.from(band(0, 0)) as unknown as Uint8Array,
        ),
      ).toThrow("Excluded pixels do not match the frame");
      expect(() =>
        vesselEvidence(gray, side, side, "dark", band(0, side - 1)),
      ).toThrow("No line-like vessels were found in this frame");
    });

    it("runs in steps to the same result", () => {
      const mask = band(134, 146),
        steps = vesselEvidenceSteps(gray, side, side, "dark", mask);
      let next = steps.next();
      while (!next.done) next = steps.next();
      expect(next.value).toEqual(
        vesselEvidence(gray, side, side, "dark", mask),
      );
    });
  });

  it("runs in steps to the same result", () => {
    const side = 200,
      gray = lines(side, [[100, 2, 80]], 6),
      steps = vesselEvidenceSteps(gray, side, side, "dark");
    let count = 0,
      next = steps.next();
    while (!next.done) {
      count++;
      next = steps.next();
    }
    // One step for the working copy, one per ridge scale, one per blur.
    expect(count).toBe(
      1 + LIMITS.ridge_scales_px.length + LIMITS.blur_px.length,
    );
    expect(next.value).toEqual(vesselEvidence(gray, side, side, "dark"));
  });

  it("rejects frames it cannot read", () => {
    const side = 200,
      gray = lines(side, [[100, 2, 80]]);
    expect(() => vesselEvidence(gray, 201, side, "dark")).toThrow(
      "Frame size is outside the supported range",
    );
    expect(() => vesselEvidence(gray.subarray(1), side, side, "dark")).toThrow(
      "Frame size is outside the supported range",
    );
    expect(() =>
      vesselEvidence(new Uint8Array(32 * 32), 32, 32, "dark"),
    ).toThrow("Frame size is outside the supported range");
    expect(() =>
      vesselEvidence(new Uint8Array(1025 * 64), 1025, 64, "dark"),
    ).toThrow("Frame size is outside the supported range");
    expect(() =>
      vesselEvidence(gray, side, side, "grey" as unknown as "dark"),
    ).toThrow("Invalid vessel polarity");
    expect(() =>
      vesselEvidence(new Uint8Array(side * side).fill(128), side, side, "dark"),
    ).toThrow("No line-like vessels were found in this frame at this polarity");
    // Faint noise alone is not evidence, however it ranks against itself.
    const noise = lines(side, [], 12);
    expect(() => vesselEvidence(noise, side, side, "dark")).toThrow(
      "No line-like vessels",
    );
  });
});
