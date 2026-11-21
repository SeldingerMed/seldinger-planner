// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  type FrameOptions,
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

/** Axis samples given by hand: one segment and one run per list of points. */
const axis = (runs: number[][][]): VesselSegments => ({
    segments: runs.map((points, index) => ({
      index,
      length_mm: points.length - 1,
      mean_radius_mm: 1,
      sample_count: points.length,
      run: index,
    })),
    points: Float32Array.from(runs.flat(2)),
    labels: Int32Array.from(
      runs.flatMap((points, index) => points.map(() => index)),
    ),
    unassigned_fraction: 0,
    pooling: 1,
  }),
  /** The mask's cuts and the frame's diameters at hand-given samples of a
   * tree drawn about the isocenter; the frame may be cut to a window. */
  measured = (
    tree: Tube[],
    set: VesselSegments,
    options: Partial<FrameOptions> = {},
    window = { x: 0, y: 0, width: SIDE, height: SIDE },
  ) => {
    const grid = treeMask(0.5, tree),
      cuts = axisCuts(grid.mask, grid.shape, grid.affine, set),
      whole = renderFrame(VIEW, [0, 0, 0], IDENTITY, {
        ...size,
        polarity: "dark",
        noise: 12,
        seed: 5,
        tree,
        ...options,
      }),
      cut = new Uint8Array(window.width * window.height),
      moved = (pixels: Float32Array) =>
        pixels.map((value, i) => value - (i % 2 ? window.y : window.x)),
      at = placedSamples(VIEW, [0, 0, 0], IDENTITY, set.points, size);
    for (let y = 0; y < window.height; y++)
      for (let x = 0; x < window.width; x++)
        cut[y * window.width + x] = whole[(y + window.y) * SIDE + x + window.x];
    return {
      cuts,
      found: frameDiameters(
        {
          width: window.width,
          height: window.height,
          gray: cut,
          polarity: "dark",
        },
        { pixels: moved(at.pixels), mm_per_px: at.mm_per_px },
        set,
        {
          ...cuts,
          pixels: moved(seen(cuts, [0, 0, 0], IDENTITY).pixels),
        },
      ),
    };
  },
  /** Samples a millimeter apart from one point to another. */
  line = (from: number[], to: number[]) => {
    const length = Math.round(
      Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]),
    );
    return Array.from({ length: length + 1 }, (_, k) =>
      from.map((value, i) => value + ((to[i] - value) * k) / length),
    );
  },
  middle = (values: Float32Array | number[]) => {
    const sorted = Array.from(values)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  };

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
    // And so where mask lies in the box of voxels searched about the
    // sample, at its corner.
    expect(at(1.95, 1.95)).toBeNaN();
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

  it("does not measure a sample the mask has no cut at", () => {
    const k = Array.from(frameMm).findIndex(
        (value, j) => j > 20 && Number.isFinite(value),
      ),
      found = frameDiameters(
        { ...size, gray, polarity: "dark" },
        placed,
        segments,
        { ...maskCuts, mm: maskCuts.mm.map((mm, j) => (j === k ? NaN : mm)) },
      );
    expect(k).toBeGreaterThan(20);
    expect(found[k]).toBeNaN();
    expect(found[k + 1]).toBeCloseTo(frameMm[k + 1], 5);
  });

  it("does not measure a vessel seen end-on", () => {
    // 8 mm of a 4 mm vessel along the beam, 20 mm beside the isocenter.
    const tree: Tube[] = [
        {
          path: [
            [20, -4, 0],
            [20, 4, 0],
          ],
          radius: 2,
        },
      ],
      { cuts, found } = measured(tree, axis([line([20, -4, 0], [20, 4, 0])]));
    expect(Math.abs(cuts.mm[4] - 4)).toBeLessThan(0.6);
    expect(found.every(Number.isNaN)).toBe(true);
  });

  it("does not measure a vessel that shows under 8 brightness levels deep", () => {
    const tree: Tube[] = [
        {
          path: [
            [0, 0, -25],
            [0, 0, 25],
          ],
          radius: 1.5,
        },
      ],
      set = axis([line([0, 0, -20], [0, 0, 20])]),
      full = measured(tree, set, { noise: 0 }).found,
      // Drawn at the contrast of a vessel twenty times as deep: under 6
      // levels.
      faint = measured(tree, set, {
        noise: 0,
        contrast_of: [{ path: tree[0].path, radius: 30 }],
      }).found;
    expect(Math.abs(middle(full) - 3)).toBeLessThan(0.6);
    expect(full.subarray(5, 36).every(Number.isFinite)).toBe(true);
    expect(faint.every(Number.isNaN)).toBe(true);
  });

  it("measures a vessel beside a short bend of its own run toward the beam", () => {
    // 20 mm along z, then 5 mm along the beam: in the frame the bend lies
    // within the clearing distance of the samples before it.
    const tree: Tube[] = [
        {
          path: [
            [0, 0, -20],
            [0, 0, 0],
          ],
          radius: 1.5,
        },
        {
          path: [
            [0, 0, 0],
            [0, 5, 0],
          ],
          radius: 1.5,
        },
      ],
      { found } = measured(
        tree,
        axis([
          [...line([0, 0, -20], [0, 0, 0]), ...line([0, 1, 0], [0, 5, 0])],
        ]),
      );
    // 3 mm before the bend.
    expect(Math.abs(found[17] - 3)).toBeLessThan(0.6);
  });

  it("does not measure a sample whose profile would leave the frame at any side", () => {
    // A 3 mm vessel up the frame and one across it, each in a window of
    // the frame 100 pixels wide: in its middle, then 5 pixels from a side.
    const up: Tube[] = [
        {
          path: [
            [0, 0, -25],
            [0, 0, 25],
          ],
          radius: 1.5,
        },
      ],
      across: Tube[] = [
        {
          path: [
            [-25, 0, 0],
            [25, 0, 0],
          ],
          radius: 1.5,
        },
      ],
      upAxis = axis([line([0, 0, -10], [0, 0, 10])]),
      acrossAxis = axis([line([-10, 0, 0], [10, 0, 0])]),
      at = (tree: Tube[], set: VesselSegments, x: number, y: number) =>
        measured(tree, set, {}, { x, y, width: 100, height: 100 }).found;
    expect(
      at(up, upAxis, 100, 100).subarray(2, 19).every(Number.isFinite),
    ).toBe(true);
    expect(
      at(across, acrossAxis, 100, 100).subarray(2, 19).every(Number.isFinite),
    ).toBe(true);
    for (const x of [145, 55])
      expect(at(up, upAxis, x, 100).every(Number.isNaN)).toBe(true);
    for (const y of [145, 55])
      expect(at(across, acrossAxis, 100, y).every(Number.isNaN)).toBe(true);
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
    // Axis samples 3 mm beside a 5 mm vessel's middle, just outside its
    // wall, as from a coarse grid; and samples on its middle.
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
      // Three runs drawn along the one vessel: to either side of its
      // middle, and on it.
      beside: VesselSegments = {
        segments: [0, 1, 2].map((index) => ({
          index,
          length_mm: 40,
          mean_radius_mm: 2.5,
          sample_count: 41,
          run: index,
        })),
        points: Float32Array.from(
          [3, -3, 0].flatMap((x) =>
            Array.from({ length: 41 }, (_, k) => [x, 0, k - 20]).flat(),
          ),
        ),
        labels: Int32Array.from({ length: 123 }, (_, k) => Math.floor(k / 41)),
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
    // Read beside the middle, the profile is half as deep where its width
    // is taken, and the vessel reads a quarter of a millimeter wider.
    const onAxis = middle(found.subarray(87, 118));
    for (const first of [0, 41])
      expect(
        Math.abs(middle(found.subarray(first + 5, first + 36)) - onAxis),
      ).toBeLessThan(0.1);
    for (const first of [0, 41, 82])
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
    // Nine samples in a row are too few, though each has its neighbors;
    // ten are enough.
    const from = Array.from(inFrame).findIndex(
        (_, k) => k > 4 && inFrame.subarray(k, k + 10).every(Number.isFinite),
      ),
      row = (length: number) =>
        compareDiameters(
          set,
          inMask,
          inFrame.map((value, k) =>
            k >= from && k < from + length ? value : NaN,
          ),
        ).runs[0].frame;
    expect(from).toBeGreaterThan(4);
    expect(row(9)).toBeNull();
    expect(row(10)).not.toBeNull();
    // A segment with fewer than three measured samples has no diameter,
    // in the frame or in the mask.
    const two = (values: Float32Array) => {
        let kept = 0;
        return values.map((value, k) =>
          set.labels[k] !== 0 || (Number.isFinite(value) && kept++ < 2)
            ? value
            : NaN,
        );
      },
      none = compareDiameters(set, two(inMask), two(inFrame)).segments[0];
    expect(none.frame_mm).toBeNull();
    expect(none.frame_samples).toBe(2);
    expect(none.mask_mm).toBeNull();
    expect(per[0].mask_mm).not.toBeNull();
    expect(() => compareDiameters(set, inMask.subarray(1), inFrame)).toThrow(
      "Diameters do not match the vessel segments",
    );
  });
});
