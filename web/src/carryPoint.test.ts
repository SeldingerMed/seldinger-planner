// @vitest-environment node
import { describe, expect, it } from "vitest";
import { phantom, pivot, SIDE, truth, VIEW } from "./__fixtures__/overlayCase";
import { viewFrame, type ViewNumbers } from "./carmGeometry";
import { CARRY_POINT_LIMITS, carryPoint, type CarryInput } from "./carryPoint";
import { placedSamples } from "./framePlacement";
import type { Vec3 } from "./obliqueSlice";
import { projectRegistered } from "./projectionRegistration";
import { vesselSegments, type VesselSegments } from "./vesselSegments";

const size = { width: SIDE, height: SIDE },
  LATERAL: ViewNumbers = { ...VIEW, primary_deg: 90 },
  segments = vesselSegments(phantom.mask, phantom.shape, phantom.affine),
  one: CarryInput = {
    segments,
    isocenter: pivot,
    matrix: truth,
    planes: [{ view: VIEW, frame: size }],
  },
  two: CarryInput = {
    ...one,
    planes: [
      { view: VIEW, frame: size },
      { view: LATERAL, frame: size },
    ],
  },
  seen = (view: ViewNumbers, k: number) => {
    const at = projectRegistered(
      view,
      pivot,
      truth,
      segments.points.subarray(3 * k, 3 * k + 3),
      size,
    );
    return { x: at[0], y: at[1] };
  },
  sample = (k: number) =>
    Array.from(segments.points.subarray(3 * k, 3 * k + 3)) as Vec3,
  apart = (a: Vec3, b: Vec3) =>
    Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Two straight vessels of two runs that cross in the frontal frame, the
 * second 20 mm nearer the detector. */
function crossed(): { segments: VesselSegments; input: CarryInput } {
  const { u, v, d } = viewFrame(0, 0),
    points: number[] = [],
    labels: number[] = [];
  for (let s = -15; s <= 15; s++) {
    points.push(...u.map((value) => value * s));
    labels.push(0);
  }
  for (let s = -15; s <= 15; s++) {
    points.push(...v.map((value, i) => value * s + d[i] * 20));
    labels.push(1);
  }
  const built: VesselSegments = {
    segments: [0, 1].map((index) => ({
      index,
      length_mm: 30,
      mean_radius_mm: 1.5,
      sample_count: 31,
      run: index,
    })),
    points: Float32Array.from(points),
    labels: Int32Array.from(labels),
    unassigned_fraction: 0,
    pooling: 1,
  };
  return {
    segments: built,
    input: {
      segments: built,
      isocenter: [0, 0, 0],
      matrix: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
      planes: [
        { view: VIEW, frame: size },
        { view: LATERAL, frame: size },
      ],
    },
  };
}

describe("samples placed in a frame", () => {
  it("gives the pixels of the registration and the size of a pixel at each sample", () => {
    const placed = placedSamples(VIEW, pivot, truth, segments.points, size);
    expect(placed.pixels).toEqual(
      projectRegistered(VIEW, pivot, truth, segments.points, size),
    );
    // 0.6 mm detector pixels, seen at 800 of 1200 mm at the isocenter.
    const pitch = VIEW.detector_width_mm / SIDE;
    for (let k = 0; k < placed.mm_per_px.length; k += 37) {
      expect(placed.mm_per_px[k]).toBeGreaterThan(pitch * 0.6);
      expect(placed.mm_per_px[k]).toBeLessThan(pitch * 0.74);
    }
    const middle = placedSamples(
      VIEW,
      [0, 0, 0],
      crossed().input.matrix,
      Float32Array.from([0, 0, 0, ...viewFrame(0, 0).d.map((x) => x * 100)]),
      size,
    );
    expect(middle.mm_per_px[0]).toBeCloseTo((pitch * 800) / 1200, 6);
    // A point 100 mm nearer the detector is magnified less.
    expect(middle.mm_per_px[1]).toBeCloseTo((pitch * 900) / 1200, 6);
  });

  it("marks a point that cannot be projected, and refuses detector pixels that are not square", () => {
    const behind = viewFrame(0, 0).d.map((x) => x * -900),
      placed = placedSamples(
        VIEW,
        [0, 0, 0],
        crossed().input.matrix,
        Float32Array.from(behind),
        size,
      );
    expect(placed.pixels[0]).toBeNaN();
    expect(placed.mm_per_px[0]).toBeNaN();
    expect(() =>
      placedSamples(VIEW, pivot, truth, segments.points, {
        width: SIDE,
        height: SIDE + 20,
      }),
    ).toThrow("Detector pixels must be square");
  });
});

describe("a mark in a frame carried to the 3D vessel axis", () => {
  it("returns the axis sample under a mark in one plane", () => {
    for (const k of [5, 40, Math.floor(segments.labels.length / 2)]) {
      const found = carryPoint(one, [{ plane: 0, ...seen(VIEW, k) }])!;
      // Another sample can lie under the same pixel only at another depth.
      expect(found.off_mm).toHaveLength(1);
      expect(found.off_mm[0]).toBeLessThan(0.05);
      const again = seen(VIEW, found.sample);
      expect(
        Math.hypot(again.x - seen(VIEW, k).x, again.y - seen(VIEW, k).y),
      ).toBeLessThan(0.2);
      expect(found.point).toEqual(sample(found.sample));
      expect(found.segment).toBe(segments.labels[found.sample]);
    }
  });

  it("returns the sample both marks agree on with two planes", () => {
    for (const k of [5, 40, 77, segments.labels.length - 3]) {
      const found = carryPoint(two, [
        { plane: 0, ...seen(VIEW, k) },
        { plane: 1, ...seen(LATERAL, k) },
      ])!;
      // Two runs that meet share a sample's place; the place is what counts.
      expect(found.point).toEqual(sample(k));
      expect(found.off_mm).toEqual([0, 0]);
      expect(found.crossings).toBe(0);
    }
    // Marks a millimeter and a half off in each plane still find it.
    const k = 40,
      a = seen(VIEW, k),
      b = seen(LATERAL, k),
      near = carryPoint(two, [
        { plane: 0, x: a.x + 2, y: a.y - 2 },
        { plane: 1, x: b.x - 2, y: b.y + 2 },
      ])!;
    expect(apart(near.point, sample(k))).toBeLessThan(2.5);
    for (const mm of near.off_mm)
      expect(mm).toBeLessThan(CARRY_POINT_LIMITS.reach_mm);
    expect(Math.max(...near.off_mm)).toBeGreaterThan(0);
  });

  it("gives no point for a mark with no vessel within reach", () => {
    expect(carryPoint(one, [{ plane: 0, x: 4, y: 4 }])).toBeNull();
    // In reach in one plane and not in the other.
    const k = 40;
    expect(
      carryPoint(two, [
        { plane: 0, ...seen(VIEW, k) },
        { plane: 1, x: 4, y: 4 },
      ]),
    ).toBeNull();
    // 3 mm is the reach: 2.8 mm off is carried and 3.3 mm off is not.
    const { input } = crossed(),
      end = { x: SIDE / 2 + 15 / 0.4, y: SIDE / 2 };
    const single = { ...input, planes: [input.planes[0]] };
    expect(
      carryPoint(single, [{ plane: 0, x: end.x + 2.8 / 0.4, y: end.y }]),
    ).not.toBeNull();
    expect(
      carryPoint(single, [{ plane: 0, x: end.x + 3.3 / 0.4, y: end.y }]),
    ).toBeNull();
  });

  it("counts the other vessels under a mark in one plane, and a second plane tells them apart", () => {
    const { input, segments: built } = crossed(),
      single = { ...input, planes: [input.planes[0]] },
      middle = { plane: 0, x: SIDE / 2, y: SIDE / 2 },
      under = carryPoint(single, [middle])!;
    expect(under.crossings).toBe(1);
    // Away from the crossing only one vessel is under the mark.
    expect(
      carryPoint(single, [{ plane: 0, x: SIDE / 2 + 25, y: SIDE / 2 }])!
        .crossings,
    ).toBe(0);
    // The lateral frame sees the two 20 mm apart.
    for (const run of [0, 1]) {
      const k = run * 31 + 15,
        at = projectRegistered(
          LATERAL,
          [0, 0, 0],
          input.matrix,
          built.points.subarray(3 * k, 3 * k + 3),
          size,
        ),
        found = carryPoint(input, [middle, { plane: 1, x: at[0], y: at[1] }])!;
      expect(found.sample).toBe(k);
      expect(found.segment).toBe(run);
    }
  });

  it("refuses marks it cannot use", () => {
    const mark = { plane: 0, ...seen(VIEW, 5) };
    expect(() => carryPoint(one, [])).toThrow("One mark per plane");
    expect(() => carryPoint(two, [mark, mark])).toThrow("One mark per plane");
    expect(() => carryPoint(one, [{ ...mark, plane: 1 }])).toThrow(
      "One mark per plane",
    );
    expect(() => carryPoint(one, [{ ...mark, x: NaN }])).toThrow(
      "A mark lies outside its frame",
    );
    for (const outside of [
      { x: SIDE + 1 },
      { y: SIDE + 1 },
      { x: -1 },
      { y: -1 },
    ])
      expect(() => carryPoint(one, [{ ...mark, ...outside }])).toThrow(
        "A mark lies outside its frame",
      );
    expect(() => carryPoint({ ...one, planes: [] }, [mark])).toThrow(
      "One or two planes are required",
    );
    expect(() =>
      carryPoint(
        {
          ...one,
          segments: { ...segments, labels: segments.labels.subarray(1) },
        },
        [mark],
      ),
    ).toThrow("Invalid vessel segments");
  });
});
