// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  renderFrame,
  TREE,
  treeMask,
  type Tube,
} from "./__fixtures__/angioPhantom";
import {
  gray,
  phantom,
  pivot,
  SIDE,
  truth,
  VIEW,
} from "./__fixtures__/overlayCase";
import { axisDiameters, axisDiameterSteps } from "./axisDiameter";
import { compareDiameters } from "./diameterComparison";
import { FRAME_DIAMETER_LIMITS, frameDiameters } from "./frameDiameter";
import { placedSamples } from "./framePlacement";
import type { Vec3 } from "./obliqueSlice";
import { vesselSegments, type VesselSegments } from "./vesselSegments";

const size = { width: SIDE, height: SIDE },
  IDENTITY = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ],
  segments = vesselSegments(phantom.mask, phantom.shape, phantom.affine),
  maskMm = axisDiameters(phantom.mask, phantom.shape, phantom.affine, segments),
  placed = placedSamples(VIEW, pivot, truth, segments.points, size),
  frameMm = frameDiameters(
    { ...size, gray, polarity: "dark" },
    placed,
    segments,
  );

function toTube(p: number[], a: Vec3, b: Vec3): number {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
    ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]],
    t = Math.max(
      0,
      Math.min(
        1,
        (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) /
          (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2),
      ),
    );
  return Math.hypot(ap[0] - t * ab[0], ap[1] - t * ab[1], ap[2] - t * ab[2]);
}
/** The diameter of the phantom's tube a sample lies in. */
function drawn(tree: Tube[], set: VesselSegments, k: number): number {
  const p = Array.from(set.points.subarray(3 * k, 3 * k + 3));
  let best = { off: Infinity, radius: NaN };
  for (const { path, radius } of tree)
    for (let i = 1; i < path.length; i++) {
      const off = toTube(p, path[i - 1], path[i]);
      if (off < best.off) best = { off, radius };
    }
  return 2 * best.radius;
}

/** One straight vessel of 4 mm with 12 mm of it drawn at 2 mm. */
const along = (s: number): Vec3 => {
    const d = [8, 6, 60].map((x) => x / Math.hypot(8, 6, 60));
    return [d[0] * s, d[1] * s, d[2] * s];
  },
  NARROWED: Tube[] = [
    { path: [along(-30), along(-6)], radius: 2 },
    { path: [along(-6), along(6)], radius: 1 },
    { path: [along(6), along(30)], radius: 2 },
  ];

describe("diameters at the axis samples of the 3D mask", () => {
  it("gives each tube of the phantom its diameter", () => {
    const { segments: per } = compareDiameters(segments, maskMm, frameMm);
    expect(per.length).toBeGreaterThan(8);
    per.forEach((one, index) => {
      const k = segments.labels.indexOf(index) + 2;
      expect(Math.abs(one.mask_mm! - drawn(TREE, segments, k))).toBeLessThan(
        0.6,
      );
    });
  });

  it("runs in steps to the same result and refuses what it cannot use", () => {
    const steps = axisDiameterSteps(
      phantom.mask,
      phantom.shape,
      phantom.affine,
      segments,
    );
    let next = steps.next(),
      yields = 0;
    while (!next.done) {
      yields++;
      next = steps.next();
    }
    expect(yields).toBeGreaterThan(0);
    expect(next.value).toEqual(maskMm);
    expect(() =>
      axisDiameters(
        phantom.mask.subarray(1),
        phantom.shape,
        phantom.affine,
        segments,
      ),
    ).toThrow("Invalid vessel mask");
    expect(() =>
      axisDiameters(phantom.mask, phantom.shape, phantom.affine, {
        ...segments,
        labels: segments.labels.subarray(1),
      }),
    ).toThrow("Invalid vessel segments");
    expect(() =>
      axisDiameters(
        phantom.mask,
        phantom.shape,
        // Two axes of the grid along one line.
        phantom.affine.map((row, i) =>
          i < 3 ? [row[0], row[0], row[2], row[3]] : row,
        ),
        segments,
      ),
    ).toThrow("Sheared mask grids are not supported");
  });

  it("does not depend on where the grid lies", () => {
    const moved = phantom.affine.map((row, i) => [
        ...row.slice(0, 3),
        row[3] + [7, -3, 11, 0][i],
      ]),
      there = vesselSegments(phantom.mask, phantom.shape, moved);
    expect(axisDiameters(phantom.mask, phantom.shape, moved, there)).toEqual(
      maskMm,
    );
  });
});

describe("diameters in a frame", () => {
  it("gives each tube of the phantom its diameter", () => {
    const { segments: per } = compareDiameters(segments, maskMm, frameMm);
    per.forEach((one, index) => {
      const k = segments.labels.indexOf(index) + 2;
      expect(one.frame_samples).toBeGreaterThanOrEqual(3);
      expect(Math.abs(one.frame_mm! - drawn(TREE, segments, k))).toBeLessThan(
        0.6,
      );
    });
  });

  it("reads a bright vessel as it reads a dark one", () => {
    const bright = frameDiameters(
      { ...size, gray: gray.map((value) => 255 - value), polarity: "bright" },
      placed,
      segments,
    );
    let measured = 0;
    for (let k = 0; k < bright.length; k++) {
      expect(Number.isNaN(bright[k])).toBe(Number.isNaN(frameMm[k]));
      if (Number.isNaN(bright[k])) continue;
      measured++;
      expect(bright[k]).toBeCloseTo(frameMm[k], 3);
    }
    expect(measured).toBeGreaterThan(50);
  });

  it("measures nothing where no vessel shows", () => {
    const flat = frameDiameters(
      {
        ...size,
        gray: new Uint8Array(SIDE * SIDE).fill(128),
        polarity: "dark",
      },
      placed,
      segments,
    );
    expect(flat.every(Number.isNaN)).toBe(true);
  });

  it("does not measure a sample another vessel lies over, or one at the frame's edge", () => {
    // Samples of two runs that project within reach of each other.
    const run = (k: number) => segments.segments[segments.labels[k]].run,
      mm = (a: number, b: number) =>
        Math.hypot(
          placed.pixels[2 * a] - placed.pixels[2 * b],
          placed.pixels[2 * a + 1] - placed.pixels[2 * b + 1],
        ) * placed.mm_per_px[a];
    let covered = 0;
    for (let a = 0; a < segments.labels.length; a++)
      for (let b = 0; b < segments.labels.length; b++)
        if (run(a) !== run(b) && mm(a, b) <= FRAME_DIAMETER_LIMITS.clear_mm) {
          expect(frameMm[a]).toBeNaN();
          covered++;
          break;
        }
    expect(covered).toBeGreaterThan(5);
    // The same frame cut to its middle: samples near its edge have no
    // whole profile.
    const cut = 150,
      from = (SIDE - cut) / 2,
      small = new Uint8Array(cut * cut);
    for (let y = 0; y < cut; y++)
      for (let x = 0; x < cut; x++)
        small[y * cut + x] = gray[(y + from) * SIDE + x + from];
    const shifted = {
        pixels: placed.pixels.map((value) => value - from),
        mm_per_px: placed.mm_per_px,
      },
      inner = frameDiameters(
        { width: cut, height: cut, gray: small, polarity: "dark" },
        shifted,
        segments,
      ),
      reach = FRAME_DIAMETER_LIMITS.half_window_mm / 0.42;
    let same = 0;
    for (let k = 0; k < inner.length; k++) {
      const x = shifted.pixels[2 * k],
        y = shifted.pixels[2 * k + 1];
      if (x < 0 || y < 0 || x > cut || y > cut) expect(inner[k]).toBeNaN();
      else if (
        Math.min(x, y, cut - x, cut - y) > reach + 1 &&
        Number.isFinite(frameMm[k])
      ) {
        expect(inner[k]).toBeCloseTo(frameMm[k], 3);
        same++;
      }
    }
    expect(same).toBeGreaterThan(20);
  });

  it("refuses a frame or samples that do not fit", () => {
    expect(() =>
      frameDiameters(
        { ...size, gray: gray.subarray(1), polarity: "dark" },
        placed,
        segments,
      ),
    ).toThrow("Invalid frame");
    expect(() =>
      frameDiameters(
        { ...size, gray, polarity: "dark" },
        { ...placed, mm_per_px: placed.mm_per_px.subarray(1) },
        segments,
      ),
    ).toThrow("Invalid vessel segments");
  });
});

describe("the narrowest place of a run", () => {
  const grid = treeMask(0.5, NARROWED),
    set = vesselSegments(grid.mask, grid.shape, grid.affine),
    inMask = axisDiameters(grid.mask, grid.shape, grid.affine, set),
    picture = renderFrame(VIEW, [0, 0, 0], IDENTITY, {
      ...size,
      polarity: "dark",
      noise: 12,
      seed: 3,
      tree: NARROWED,
    }),
    inFrame = frameDiameters(
      { ...size, gray: picture, polarity: "dark" },
      placedSamples(VIEW, [0, 0, 0], IDENTITY, set.points, size),
      set,
    ),
    place = (k: number) =>
      Array.from(set.points.subarray(3 * k, 3 * k + 3)) as Vec3;

  it("is found in the mask and in the frame, at the same place", () => {
    const { runs } = compareDiameters(set, inMask, inFrame);
    expect(runs).toHaveLength(1);
    const [{ mask, frame, samples }] = runs;
    expect(samples).toBe(set.labels.length);
    for (const found of [mask!, frame!]) {
      expect(Math.abs(found.reference_mm - 4)).toBeLessThan(0.6);
      expect(Math.abs(found.narrowest_mm - 2)).toBeLessThan(0.6);
      expect(found.percent).toBeCloseTo(
        100 * (1 - found.narrowest_mm / found.reference_mm),
        9,
      );
      expect(found.percent).toBeGreaterThan(35);
      // Inside the narrowed stretch, which is 6 mm to each side of the
      // origin.
      expect(Math.hypot(...place(found.sample))).toBeLessThan(6);
    }
  });

  it("is not given for a run measured at too few samples", () => {
    const few = inFrame.map((value, k) => (k % 4 ? NaN : value)),
      { runs, segments: per } = compareDiameters(set, inMask, few);
    expect(runs[0].frame).toBeNull();
    expect(runs[0].mask).not.toBeNull();
    // A segment with fewer than three measured samples has no diameter.
    const none = compareDiameters(
      set,
      inMask,
      inFrame.map((value, k) => (set.labels[k] === 0 && k > 1 ? NaN : value)),
    ).segments[0];
    expect(none.frame_mm).toBeNull();
    expect(none.frame_samples).toBeLessThan(3);
    expect(per[0].mask_mm).not.toBeNull();
    expect(() => compareDiameters(set, inMask.subarray(1), inFrame)).toThrow(
      "Diameters do not match the vessel segments",
    );
  });
});
