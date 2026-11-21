// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  nearestTube,
  renderFrame,
  TREE,
  type Tube,
} from "./__fixtures__/angioPhantom";
import { phantom, pivot, SIDE, truth, VIEW } from "./__fixtures__/overlayCase";
import { contrastArrival, type ArrivalInput } from "./contrastArrival";
import { placedSamples } from "./framePlacement";
import type { Vec3 } from "./obliqueSlice";
import { vesselSegments } from "./vesselSegments";

const size = { width: SIDE, height: SIDE },
  segments = vesselSegments(phantom.mask, phantom.shape, phantom.affine),
  { pixels } = placedSamples(VIEW, pivot, truth, segments.points, size),
  picture = (tree: Tube[], seed: number) =>
    renderFrame(VIEW, pivot, truth, {
      ...size,
      polarity: "dark",
      noise: 12,
      seed,
      tree,
      contrast_of: TREE,
    }),
  /** The tube nine in ten samples of a segment lie in, or -1. */
  tubeOf = segments.segments.map((segment, index) => {
    const tubes = [0, 0, 0, 0];
    segments.labels.forEach((label, k) => {
      if (label === index)
        tubes[
          nearestTube(
            Array.from(segments.points.subarray(3 * k, 3 * k + 3)) as Vec3,
          )
        ]++;
    });
    return tubes.findIndex((n) => n >= 0.9 * segment.sample_count);
  }),
  /** Segments with no sample within 6 mm of where the trunk divides: there
   * the trunk and its branches fill the same pixels. */
  clear = segments.segments.map((_, index) =>
    segments.labels.every(
      (label, k) =>
        label !== index ||
        Math.hypot(
          segments.points[3 * k],
          segments.points[3 * k + 1] - 2,
          segments.points[3 * k + 2] - 10,
        ) > 6,
    ),
  ),
  // Contrast reaches the trunk, then its two branches, then the branch of
  // a branch.
  run = (trees: Tube[][], first = 10): ArrivalInput => ({
    segments,
    pixels,
    ...size,
    polarity: "dark",
    frames: trees.map((tree, i) => ({
      index: first + 4 * i,
      gray: picture(tree, 20 + i),
    })),
  }),
  FILLING = [[], [TREE[0]], TREE.slice(0, 3), TREE, TREE];

describe("contrast arrival per segment", () => {
  it("puts the segments in the order contrast was drawn to reach them", () => {
    const found = contrastArrival(run(FILLING)),
      window = [
        [10, 14],
        [14, 18],
        [14, 18],
        [18, 22],
      ];
    let checked = 0;
    found.forEach((one, index) => {
      if (tubeOf[index] < 0) return;
      checked++;
      expect(one.state).toBe("arrives");
      expect(one.arrival).toBeGreaterThan(window[tubeOf[index]][0]);
      expect(one.arrival).toBeLessThan(window[tubeOf[index]][1]);
      expect(one.filling).toHaveLength(5);
      expect(one.peak).toBe(Math.max(...one.filling));
    });
    expect(checked).toBeGreaterThan(6);
    expect(new Set(tubeOf.filter((tube) => tube >= 0)).size).toBe(4);
  });

  it("reads a bright vessel as it reads a dark one", () => {
    const dark = run(FILLING),
      bright = contrastArrival({
        ...dark,
        polarity: "bright",
        frames: dark.frames.map((frame) => ({
          ...frame,
          gray: frame.gray.map((value) => 255 - value),
        })),
      });
    contrastArrival(dark).forEach((one, index) => {
      expect(bright[index].state).toBe(one.state);
      expect(bright[index].arrival).toBeCloseTo(one.arrival!, 9);
    });
  });

  it("says which segments were filled from the first frame, did not change, or lie outside the field", () => {
    // The trunk is full at first and empties; two branches stay full; the
    // last never fills.
    const found = contrastArrival(
      run([TREE.slice(0, 3), TREE.slice(0, 3), TREE.slice(1, 3)], 40),
    );
    let checked = 0;
    found.forEach((one, index) => {
      if (!clear[index]) return;
      if (tubeOf[index] === 0) {
        expect(one.state).toBe("filled_from_first");
        expect(one.arrival).toBe(40);
        checked++;
      }
      if (tubeOf[index] === 2 || tubeOf[index] === 3) {
        expect(one.state).toBe("no_change");
        expect(one.arrival).toBeNull();
        expect(one.peak).toBeLessThan(6);
        checked++;
      }
    });
    expect(checked).toBeGreaterThan(5);
    const away = contrastArrival({
      ...run(FILLING),
      pixels: pixels.map((value) => value + 2 * SIDE),
    });
    for (const one of away)
      expect(one).toEqual({
        state: "outside_field",
        arrival: null,
        peak: 0,
        filling: [0, 0, 0, 0, 0],
      });
  });

  it("refuses frames that are not a run", () => {
    const input = run(FILLING);
    expect(() =>
      contrastArrival({ ...input, frames: input.frames.slice(0, 2) }),
    ).toThrow("Contrast arrival needs three to eight frames of a run");
    expect(() =>
      contrastArrival({
        ...input,
        frames: [...input.frames, ...input.frames].map((frame, i) => ({
          ...frame,
          index: i,
        })),
      }),
    ).toThrow("Contrast arrival needs three to eight frames of a run");
    expect(() =>
      contrastArrival({ ...input, frames: [...input.frames].reverse() }),
    ).toThrow("Frames of a run must be one size and in order");
    expect(() =>
      contrastArrival({
        ...input,
        frames: input.frames.map((frame, i) =>
          i === 2 ? { ...frame, gray: frame.gray.subarray(1) } : frame,
        ),
      }),
    ).toThrow("Frames of a run must be one size and in order");
    expect(() =>
      contrastArrival({ ...input, pixels: pixels.subarray(2) }),
    ).toThrow("Invalid vessel segments");
  });
});
