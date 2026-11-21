// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  nearestTube,
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
import {
  type AxisCuts,
  axisCuts,
  axisDiameters,
  axisDiameterSteps,
} from "./axisDiameter";
import { compareDiameters } from "./diameterComparison";
import {
  type CutsInFrame,
  FRAME_DIAMETER_LIMITS,
  frameDiameters,
} from "./frameDiameter";
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
  /** The mask's cuts with their centers placed in a frame. */
  seen = (
    cuts: AxisCuts,
    isocenter: Vec3,
    matrix: number[][],
  ): CutsInFrame => ({
    ...cuts,
    pixels: placedSamples(VIEW, isocenter, matrix, cuts.centers, size).pixels,
  }),
  segments = vesselSegments(phantom.mask, phantom.shape, phantom.affine),
  phantomCuts = axisCuts(phantom.mask, phantom.shape, phantom.affine, segments),
  maskMm = phantomCuts.mm,
  maskCuts = seen(phantomCuts, pivot, truth),
  placed = placedSamples(VIEW, pivot, truth, segments.points, size),
  frameMm = frameDiameters(
    { ...size, gray, polarity: "dark" },
    placed,
    segments,
    maskCuts,
  );

/** The diameter of the phantom's tube a sample lies in. */
const drawn = (tree: Tube[], set: VesselSegments, k: number) =>
  2 *
  tree[
    nearestTube(Array.from(set.points.subarray(3 * k, 3 * k + 3)) as Vec3, tree)
  ].radius;

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
    expect((next.value as AxisCuts).mm).toEqual(maskMm);
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

  it("counts only the mask that joins the sample, and measures nothing at a sample off the mask", () => {
    // Two vessels of 3 mm side by side along z, 1 mm apart.
    const pair: Tube[] = [
        {
          path: [
            [0, 0, -20],
            [0, 0, 20],
          ],
          radius: 1.5,
        },
        {
          path: [
            [4, 0, -20],
            [4, 0, 20],
          ],
          radius: 1.5,
        },
      ],
      two = treeMask(0.5, pair),
      /** Axis samples along z, moved off the first vessel's axis. */
      beside = (x: number, y: number): VesselSegments => ({
        segments: [
          {
            index: 0,
            length_mm: 20,
            mean_radius_mm: 1.5,
            sample_count: 21,
            run: 0,
          },
        ],
        points: Float32Array.from(
          Array.from({ length: 21 }, (_, k) => [x, y, k - 10]).flat(),
        ),
        labels: new Int32Array(21),
        unassigned_fraction: 0,
        pooling: 1,
      }),
      at = (x: number, y: number) =>
        axisDiameters(two.mask, two.shape, two.affine, beside(x, y))[10];
    // On the axis, off it inside the vessel, and just outside its wall.
    for (const [x, y] of [
      [0, 0],
      [-0.7, 0.6],
      [0, 1.9],
    ])
      expect(Math.abs(at(x, y) - 3)).toBeLessThan(0.35);
    // More than a millimeter from any mask.
    expect(at(0, 3.5)).toBeNaN();
    expect(at(2, 3)).toBeNaN();
  });

  it("measures the vessel a sample lies in where two run side by side and touch", () => {
    // A 4 mm and a 2.4 mm vessel along z, run into each other in the mask.
    const pair: Tube[] = [
        {
          path: [
            [0, 0, -20],
            [0, 0, 20],
          ],
          radius: 2,
        },
        {
          path: [
            [2.8, 0, -20],
            [2.8, 0, 20],
          ],
          radius: 1.2,
        },
      ],
      two = treeMask(0.5, pair),
      along = (x: number, y: number): VesselSegments => ({
        segments: [
          {
            index: 0,
            length_mm: 20,
            // As of a segment drawn through both.
            mean_radius_mm: 3,
            sample_count: 21,
            run: 0,
          },
        ],
        points: Float32Array.from(
          Array.from({ length: 21 }, (_, k) => [x, y, k - 10]).flat(),
        ),
        labels: new Int32Array(21),
        unassigned_fraction: 0,
        pooling: 1,
      }),
      at = (x: number, y: number) =>
        axisDiameters(two.mask, two.shape, two.affine, along(x, y))[10];
    // On the wide vessel's axis, and off it toward the other and away.
    for (const [x, y] of [
      [0, 0],
      [1.2, 0.3],
      [-1, -1],
    ])
      expect(Math.abs(at(x, y) - 4)).toBeLessThan(0.5);
    // In the narrow one.
    expect(Math.abs(at(3.2, 0.2) - 2.4)).toBeLessThan(0.5);
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
      maskCuts,
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
      maskCuts,
    );
    expect(flat.every(Number.isNaN)).toBe(true);
  });

  it("does not measure a sample at the frame's edge", () => {
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
        { ...maskCuts, pixels: maskCuts.pixels.map((value) => value - from) },
      ),
      reach = FRAME_DIAMETER_LIMITS.half_window_mm / 0.42;
    let same = 0;
    for (let k = 0; k < inner.length; k++) {
      const x = maskCuts.pixels[2 * k] - from,
        y = maskCuts.pixels[2 * k + 1] - from;
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

  it("measures a vessel through a much thinner one that lies over it, and not through one of its own size", () => {
    // A 5 mm vessel along z, and another across it nearer the source.
    const crossed = (radius: number) => {
        const tree: Tube[] = [
            {
              path: [
                [0, 0, -25],
                [0, 0, 25],
              ],
              radius: 2.5,
            },
            {
              path: [
                [-22, 14, 0],
                [22, 14, 0],
              ],
              radius,
            },
          ],
          grid = treeMask(0.5, tree),
          set = vesselSegments(grid.mask, grid.shape, grid.affine),
          cuts = axisCuts(grid.mask, grid.shape, grid.affine, set),
          inMask = cuts.mm,
          at = placedSamples(VIEW, [0, 0, 0], IDENTITY, set.points, size),
          inFrame = frameDiameters(
            {
              ...size,
              gray: renderFrame(VIEW, [0, 0, 0], IDENTITY, {
                ...size,
                polarity: "dark",
                noise: 12,
                seed: 9,
                tree,
              }),
              polarity: "dark",
            },
            at,
            set,
            seen(cuts, [0, 0, 0], IDENTITY),
          ),
          // Samples of the wide vessel within 2 mm of the crossing.
          near: number[] = [];
        for (let k = 0; k < set.labels.length; k++)
          if (
            Math.hypot(set.points[3 * k], set.points[3 * k + 1]) < 1 &&
            Math.abs(set.points[3 * k + 2]) <= 2
          )
            near.push(inFrame[k]);
        expect(near.length).toBeGreaterThanOrEqual(3);
        return {
          near,
          wide: compareDiameters(set, inMask, inFrame).segments.filter(
            (one) => one.mask_mm! > 4,
          ),
        };
      },
      thin = crossed(0.6),
      thick = crossed(2);
    expect(thin.near.every(Number.isFinite)).toBe(true);
    expect(thin.wide.length).toBeGreaterThan(1);
    for (const one of thin.wide)
      expect(Math.abs(one.frame_mm! - 5)).toBeLessThan(0.6);
    expect(thick.near.every(Number.isNaN)).toBe(true);
  });

  it("reads the profile where the mask's cut is centered, when that is given", () => {
    // Axis samples 2 mm beside a 5 mm vessel's middle, as from a coarse
    // grid.
    const tree: Tube[] = [
        {
          path: [
            [0, 0, -25],
            [0, 0, 25],
          ],
          radius: 2.5,
        },
      ],
      grid = treeMask(0.5, tree),
      // Two runs drawn along the one vessel, to either side of its middle.
      beside: VesselSegments = {
        segments: [0, 1].map((index) => ({
          index,
          length_mm: 40,
          mean_radius_mm: 2.5,
          sample_count: 41,
          run: index,
        })),
        points: Float32Array.from(
          [2, -1.5].flatMap((x) =>
            Array.from({ length: 41 }, (_, k) => [x, 0, k - 20]).flat(),
          ),
        ),
        labels: Int32Array.from({ length: 82 }, (_, k) => (k < 41 ? 0 : 1)),
        unassigned_fraction: 0,
        pooling: 1,
      },
      cuts = axisCuts(grid.mask, grid.shape, grid.affine, beside),
      picture = {
        ...size,
        gray: renderFrame(VIEW, [0, 0, 0], IDENTITY, {
          ...size,
          polarity: "dark",
          noise: 12,
          seed: 5,
          tree,
        }),
        polarity: "dark" as const,
      },
      at = placedSamples(VIEW, [0, 0, 0], IDENTITY, beside.points, size),
      centered = seen(cuts, [0, 0, 0], IDENTITY),
      found = frameDiameters(picture, at, beside, centered);
    for (const first of [0, 41])
      for (let k = first + 5; k < first + 36; k++) {
        expect(
          Math.hypot(cuts.centers[3 * k], cuts.centers[3 * k + 1]),
        ).toBeLessThan(0.75);
        // Inside the slab cut at the sample.
        expect(
          Math.abs(cuts.centers[3 * k + 2] - (k - first - 20)),
        ).toBeLessThanOrEqual(1);
        expect(Math.abs(found[k] - 5)).toBeLessThan(0.6);
      }
  });

  it("refuses a frame or samples that do not fit", () => {
    expect(() =>
      frameDiameters(
        { ...size, gray: gray.subarray(1), polarity: "dark" },
        placed,
        segments,
        maskCuts,
      ),
    ).toThrow("Invalid frame");
    expect(() =>
      frameDiameters(
        { ...size, gray, polarity: "dark" },
        { ...placed, mm_per_px: placed.mm_per_px.subarray(1) },
        segments,
        maskCuts,
      ),
    ).toThrow("Invalid vessel segments");
    for (const cuts of [
      { ...maskCuts, mm: maskMm.subarray(1) },
      { ...maskCuts, centers: maskCuts.centers.subarray(3) },
      { ...maskCuts, pixels: maskCuts.pixels.subarray(2) },
    ])
      expect(() =>
        frameDiameters(
          { ...size, gray, polarity: "dark" },
          placed,
          segments,
          cuts,
        ),
      ).toThrow("Invalid vessel segments");
  });
});

describe("the narrowest place of a run", () => {
  const grid = treeMask(0.5, NARROWED),
    set = vesselSegments(grid.mask, grid.shape, grid.affine),
    narrowedCuts = axisCuts(grid.mask, grid.shape, grid.affine, set),
    inMask = narrowedCuts.mm,
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
      seen(narrowedCuts, [0, 0, 0], IDENTITY),
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
