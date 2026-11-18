// @vitest-environment node
/** Holds the vessel evidence filter to a fixture that its Python copy
 * (scripts/research/pose_initializer/evidence.py) is tested against too.
 * The frames are generated here; the fixture stores them and every level
 * this filter returns for them.
 *
 * Regenerate after an intentional change to the filter with:
 *   WRITE_FIXTURES=1 npx vitest run src/vesselEvidenceFixture.test.ts */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VESSEL_EVIDENCE_LIMITS, vesselEvidence } from "./vesselEvidence2d";
import type { Polarity } from "./vesselness2d";

const FIXTURE = fileURLToPath(
  new URL("./__fixtures__/vessel-evidence-levels.json", import.meta.url),
);

type Line = { from: [number, number]; to: [number, number]; bend: number };
type Spec = {
  name: string;
  width: number;
  height: number;
  polarity: Polarity;
  seed: number;
  lines: (Line & { sigma: number; depth: number })[];
};
const SPECS: Spec[] = [
  {
    name: "dark lines of three widths",
    width: 96,
    height: 72,
    polarity: "dark",
    seed: 7,
    lines: [
      { from: [6, 10], to: [90, 60], bend: 9, sigma: 1.3, depth: 70 },
      { from: [20, 66], to: [70, 6], bend: -6, sigma: 2.4, depth: 90 },
      { from: [48, 4], to: [52, 68], bend: 12, sigma: 4, depth: 110 },
      { from: [4, 40], to: [92, 30], bend: 3, sigma: 0.9, depth: 35 },
    ],
  },
  {
    name: "bright lines on a taller frame",
    width: 64,
    height: 88,
    polarity: "bright",
    seed: 19,
    lines: [
      { from: [8, 6], to: [56, 80], bend: -7, sigma: 1.6, depth: 80 },
      { from: [56, 10], to: [10, 70], bend: 5, sigma: 3, depth: 100 },
      { from: [30, 4], to: [34, 84], bend: -10, sigma: 1.1, depth: 45 },
    ],
  },
];

function frame(spec: Spec): Uint8Array {
  let state = spec.seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const gray = new Uint8Array(spec.width * spec.height);
  for (let y = 0; y < spec.height; y++)
    for (let x = 0; x < spec.width; x++) {
      let dip = 0;
      for (const line of spec.lines) {
        // Distance to a bent line, sampled along it.
        let nearest = Infinity;
        for (let k = 0; k <= 64; k++) {
          const t = k / 64,
            bow = line.bend * Math.sin(Math.PI * t),
            dx = line.to[0] - line.from[0],
            dy = line.to[1] - line.from[1],
            length = Math.hypot(dx, dy),
            px = line.from[0] + t * dx - (bow * dy) / length,
            py = line.from[1] + t * dy + (bow * dx) / length;
          nearest = Math.min(nearest, Math.hypot(x - px, y - py));
        }
        dip +=
          line.depth *
          Math.exp((-nearest * nearest) / (2 * line.sigma * line.sigma));
      }
      const background = 150 + 0.3 * x - 0.2 * y + 10 * (random() - 0.5),
        value =
          spec.polarity === "dark" ? background - dip : 255 - background + dip;
      gray[y * spec.width + x] = Math.max(0, Math.min(255, Math.round(value)));
    }
  return gray;
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const floats = (text: string) => {
  const bytes = Buffer.from(text, "base64");
  return new Float32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
};

function computed() {
  return SPECS.map((spec) => {
    const gray = frame(spec),
      evidence = vesselEvidence(gray, spec.width, spec.height, spec.polarity);
    return {
      name: spec.name,
      width: spec.width,
      height: spec.height,
      polarity: spec.polarity,
      gray: base64(gray),
      strong_px: evidence.strong.length,
      levels: evidence.levels.map((level) =>
        base64(new Uint8Array(level.buffer, level.byteOffset, level.byteLength)),
      ),
    };
  });
}

describe("vessel evidence fixture", () => {
  it("is what the filter returns for the stored frames", () => {
    const frames = computed();
    if (process.env.WRITE_FIXTURES === "1")
      writeFileSync(
        FIXTURE,
        JSON.stringify(
          {
            about:
              "Generated frames and every level of vesselEvidence2d.ts for them. Float32, little-endian, row-major, base64. Written by vesselEvidenceFixture.test.ts.",
            blur_px: VESSEL_EVIDENCE_LIMITS.blur_px,
            frames,
          },
          null,
          1,
        ) + "\n",
      );
    const stored = JSON.parse(readFileSync(FIXTURE, "utf8"));
    expect(stored.blur_px).toEqual([...VESSEL_EVIDENCE_LIMITS.blur_px]);
    expect(stored.frames).toHaveLength(frames.length);
    for (const [index, now] of frames.entries()) {
      const then = stored.frames[index];
      expect(then.gray).toBe(now.gray);
      expect([then.width, then.height, then.polarity]).toEqual([
        now.width,
        now.height,
        now.polarity,
      ]);
      expect(then.strong_px).toBe(now.strong_px);
      // The frames are worth comparing: each holds real lines.
      expect(now.strong_px).toBeGreaterThan(150);
      for (const [level, text] of now.levels.entries()) {
        const a = floats(text),
          b = floats(then.levels[level]);
        expect(b).toHaveLength(a.length);
        let worst = 0;
        for (let k = 0; k < a.length; k++)
          worst = Math.max(worst, Math.abs(a[k] - b[k]));
        expect(worst).toBeLessThan(1e-6);
      }
    }
  });
});
