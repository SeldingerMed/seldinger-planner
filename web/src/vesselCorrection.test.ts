import { describe, expect, it } from "vitest";
import {
  breathe,
  correctBranches,
  CORRECTION_METHOD,
  projector,
  proposeCorrection,
  straighten,
  type Branch,
} from "./vesselCorrection";

/** A synthetic aorta and two tortuous iliac arteries, scan millimeters,
 * bifurcation at the origin. Known truth for the tests; not anatomy. */
const BRANCHES: Branch[] = [
  {
    name: "aorta",
    path_ras: Array.from({ length: 41 }, (_, i) => [
      4 * Math.sin(i / 9),
      30 + 3 * Math.cos(i / 7),
      5 * i,
    ]),
  },
  ...(["right_iliac", "left_iliac"] as const).map((name) => {
    const side = name === "right_iliac" ? -1 : 1;
    return {
      name,
      path_ras: Array.from({ length: 31 }, (_, i) => [
        side * (1.2 * i + 14 * Math.sin(i / 4.5)),
        30 + 6 * Math.sin(i / 6),
        -5 * i,
      ]),
    };
  }),
];
const VIEW = {
  primary_deg: 0,
  secondary_deg: 0,
  source_detector_mm: 1140,
  source_isocenter_mm: 745,
  detector_width_mm: 400,
  detector_height_mm: 400,
};
const IDENTITY = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];
const SIZE = { width: 800, height: 800 };
const ISO = [0, 30, 0];
const BREATHING = { anchor_s: 0, full_s: 200 };
const TRUTH = {
  straighten: { right_iliac: 0.7, left_iliac: 0 },
  shift_mm: 15,
};
const to = projector(IDENTITY, VIEW, ISO, SIZE);

function noise(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) >>> 0;
    return (s / 2 ** 32 - 0.5) * 1.0;
  };
}

/** Marks as an operator would place them on the frame of the true anatomy. */
function marks(truth = TRUTH, seed = 3) {
  const jitter = noise(seed);
  const real = correctBranches(BRANCHES, truth, BREATHING);
  const right = real.find((b) => b.name === "right_iliac")!.path_ras;
  const wire = [4, 9, 14, 19, 24].map((i) => {
    const [x, y] = to(right[i])!;
    return {
      branch: "right_iliac" as const,
      pixel: [x + jitter(), y + jitter()],
    };
  });
  const landmarks = [180, 120, 70].map((s) => {
    const ras = [4 * Math.sin(s / 45), 30, s];
    const [x, y] = to(breathe(ras, truth.shift_mm, BREATHING))!;
    return { ras, pixel: [x + jitter(), y + jitter()] };
  });
  return { wire, landmarks };
}

const fit = (m: ReturnType<typeof marks>) =>
  proposeCorrection({
    branches: BRANCHES,
    ...m,
    breathing: BREATHING,
    matrix: IDENTITY,
    view: VIEW,
    isocenter: ISO,
    size: SIZE,
  });

describe("wire and breathing correction", () => {
  it("straightens toward the chord and keeps the ends", () => {
    const path = BRANCHES[1].path_ras;
    const half = straighten(path, 0.5),
      full = straighten(path, 1);
    for (const [got, want] of [
      [half[0], path[0]],
      [half.at(-1)!, path.at(-1)!],
    ])
      got.forEach((v, i) => expect(v).toBeCloseTo(want[i], 12));
    // Fully straightened, every point lies on the chord.
    const [a, b] = [path[0], path.at(-1)!];
    for (const p of full) {
      const t = (p[2] - a[2]) / (b[2] - a[2]);
      expect(p[0]).toBeCloseTo(a[0] + t * (b[0] - a[0]), 9);
    }
    expect(() => straighten(path, 1.5)).toThrow("Invalid straightening");
  });

  it("moves points by breathing from the anchor up", () => {
    expect(breathe([1, 2, -10], 10, BREATHING)).toEqual([1, 2, -10]);
    expect(breathe([1, 2, 100], 10, BREATHING)[2]).toBeCloseTo(105, 9);
    expect(breathe([1, 2, 300], 10, BREATHING)[2]).toBeCloseTo(310, 9);
  });

  it("recovers a known straightening and shift and brings held-out points in", () => {
    const found = fit(marks());
    expect(found.method).toBe(CORRECTION_METHOD);
    expect(found.status).toBe("proposed");
    expect(found.params.straighten.right_iliac).toBeGreaterThan(0.6);
    expect(found.params.straighten.right_iliac).toBeLessThan(0.8);
    // No wire marks on the left: it is not touched.
    expect(found.params.straighten.left_iliac).toBe(0);
    expect(found.params.shift_mm).toBeGreaterThan(13);
    expect(found.params.shift_mm).toBeLessThan(17);
    expect(found.corrected_rms_px).toBeLessThan(0.3 * found.rigid_rms_px);
    // Points that were not marked, on the true anatomy, in 3D.
    const real = correctBranches(BRANCHES, TRUTH, BREATHING),
      model = correctBranches(BRANCHES, found.params, BREATHING),
      rigid = BRANCHES;
    const off = (a: Branch[]) => {
      const d: number[] = [];
      for (const [k, branch] of a.entries())
        if (branch.name !== "left_iliac")
          for (const i of [2, 7, 12, 17, 22, 27])
            d.push(
              Math.hypot(
                ...[0, 1, 2].map(
                  (j) => branch.path_ras[i][j] - real[k].path_ras[i][j],
                ),
              ),
            );
      return Math.max(...d);
    };
    expect(off(rigid)).toBeGreaterThan(8);
    expect(off(model)).toBeLessThan(1.5);
  });

  it("lets the rigid line-up stand when the marks fit it", () => {
    const found = fit(
      marks({ straighten: { right_iliac: 0, left_iliac: 0 }, shift_mm: 0 }),
    );
    expect(found.status).toBe("rigid_stands");
    expect(found.reason).toBe("no_gain");
    expect(found.params.shift_mm).toBe(0);
  });

  it("needs two marks of a kind before it fits that kind", () => {
    const { wire, landmarks } = marks();
    const found = fit({
      wire: wire.slice(0, 1),
      landmarks: landmarks.slice(0, 1),
    });
    expect(found.status).toBe("rigid_stands");
    expect(found.reason).toBe("too_few_marks");
  });
});
