import { describe, expect, it } from "vitest";
import {
  applyRigid,
  renderFrame,
  rigid,
  treeMask,
  TREE,
  type Tube,
} from "./__fixtures__/angioPhantom";
import vectors from "./__fixtures__/registration-projection-vectors.json";
import { camera, type ViewNumbers } from "./carmGeometry";
import { centroid, medialPoints } from "./maskPoints";
import type { Vec3 } from "./obliqueSlice";
import {
  createProjectionRegistrationJob,
  PROJECTION_REGISTRATION_LIMITS as LIMITS,
  projectRegistered,
  proposeProjectionRegistration,
  type ProjectionRegistrationInput,
} from "./projectionRegistration";
import { vesselTarget } from "./vesselness2d";

const AP: ViewNumbers = {
  primary_deg: 0,
  secondary_deg: 0,
  source_detector_mm: 1200,
  source_isocenter_mm: 800,
  detector_width_mm: 180,
  detector_height_mm: 180,
};
const identity = rigid([0, 0, 0], [0, 0, 0]);
const dot = (a: readonly number[], b: readonly number[]) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

type Options = {
  px?: number;
  spacing?: number;
  polarity?: "dark" | "bright";
  noise?: number;
  /** View the frame was really acquired with, when the entered one is wrong. */
  trueView?: ViewNumbers;
  frameTree?: Tube[];
  maskTree?: Tube[];
  fit?: boolean;
};
const masks = new Map<string, ReturnType<typeof medialPoints>>();
function setup(view: ViewNumbers, degrees: Vec3, shift: Vec3, o: Options = {}) {
  const key = `${o.spacing ?? 1}/${(o.maskTree ?? TREE).length}`;
  if (!masks.has(key)) {
    const { mask, shape, affine } = treeMask(
      o.spacing ?? 1,
      o.maskTree ?? TREE,
    );
    masks.set(key, medialPoints(mask, shape, affine));
  }
  const points = masks.get(key)!.points,
    isocenter = centroid(points),
    truth = rigid(degrees, shift, isocenter),
    frame = { width: o.px ?? 300, height: o.px ?? 300 },
    polarity = o.polarity ?? "dark",
    trueView = o.trueView ?? view;
  const gray = renderFrame(trueView, isocenter, truth, {
    ...frame,
    polarity,
    noise: o.noise ?? 12,
    seed: 7,
    tree: o.frameTree,
  });
  const target = vesselTarget(gray, frame.width, frame.height, polarity);
  const input: ProjectionRegistrationInput = {
    points,
    view,
    isocenter,
    frame,
    target,
    start: identity,
    fit_detector_scale: o.fit ?? false,
  };
  return { input, truth, trueView, isocenter, frame, points };
}
/** Errors of a proposal against the pose the frame was rendered at. */
function errors(
  s: ReturnType<typeof setup>,
  proposal: ReturnType<typeof proposeProjectionRegistration>,
) {
  const a = projectRegistered(
      proposal.view,
      s.isocenter,
      proposal.matrix,
      s.points,
      s.frame,
    ),
    b = projectRegistered(s.trueView, s.isocenter, s.truth, s.points, s.frame);
  let sum = 0;
  for (let k = 0; k < a.length; k += 2)
    sum += Math.hypot(a[k] - b[k], a[k + 1] - b[k + 1]);
  const pitch =
    ((s.trueView.detector_width_mm / s.frame.width) *
      s.trueView.source_isocenter_mm) /
    s.trueView.source_detector_mm;
  const cam = camera(s.input.view, s.isocenter),
    moved = applyRigid(proposal.matrix, s.isocenter),
    wanted = applyRigid(s.truth, s.isocenter),
    offset = moved.map((value, i) => value - wanted[i]);
  // Residual rotation E = P T^t and its angle about the viewing axis.
  const e = [0, 1, 2].map((i) =>
    [0, 1, 2].map((j) =>
      dot(proposal.matrix[i].slice(0, 3), s.truth[j].slice(0, 3)),
    ),
  );
  const along = (axis: readonly number[], other: readonly number[]) =>
    dot(
      axis,
      [0, 1, 2].map((i) => dot(e[i], other)),
    );
  return {
    /** Mean distance between where the proposal and the truth put each
     * vessel point on the detector, in millimeters at the isocenter. */
    projected_mm: (sum / (a.length / 2)) * pitch,
    in_plane_deg:
      (Math.abs(Math.atan2(along(cam.v, cam.u), along(cam.u, cam.u))) * 180) /
      Math.PI,
    rotation_deg:
      (Math.acos(
        Math.max(-1, Math.min(1, (e[0][0] + e[1][1] + e[2][2] - 1) / 2)),
      ) *
        180) /
      Math.PI,
    depth_mm: dot(offset, cam.d),
  };
}

describe("projectRegistered", () => {
  it("matches the independently derived pixel vectors", () => {
    expect(vectors.cases.length).toBe(5);
    for (const c of vectors.cases) {
      const pixels = projectRegistered(
        c.view,
        c.isocenter as Vec3,
        c.matrix,
        new Float32Array(c.points.flat()),
        c.frame,
      );
      c.pixels.forEach(([x, y], k) => {
        expect(Math.abs(pixels[2 * k] - x)).toBeLessThan(2e-3);
        expect(Math.abs(pixels[2 * k + 1] - y)).toBeLessThan(2e-3);
      });
    }
  });

  it("puts image right at patient left and image up at the head for 0/0", () => {
    const frame = { width: 200, height: 200 },
      points = new Float32Array([0, 0, 0, -10, 0, 0, 0, 0, 10]),
      px = projectRegistered(AP, [0, 0, 0], identity, points, frame);
    expect([px[0], px[1]]).toEqual([100, 100]);
    expect(px[2]).toBeGreaterThan(100); // patient left (-x) is image right
    expect(px[5]).toBeLessThan(100); // superior (+z) is up, a smaller row
    // A registration that shifts the volume moves its projection with it.
    const moved = projectRegistered(
      AP,
      [0, 0, 0],
      rigid([0, 0, 0], [-10, 0, 0]),
      points,
      frame,
    );
    expect(moved[0]).toBeCloseTo(px[2], 4);
  });

  it("returns NaN for points it cannot project, and rejects bad input", () => {
    const frame = { width: 100, height: 100 },
      points = new Float32Array([0, -900, 0, 0, 500, 0, 0, 0, 0]),
      px = projectRegistered(AP, [0, 0, 0], identity, points, frame);
    expect([...px.slice(0, 4)].every(Number.isNaN)).toBe(true);
    expect([px[4], px[5]]).toEqual([50, 50]);
    const scaled = identity.map((row) => [...row]);
    scaled[0][0] = 1.01;
    expect(() =>
      projectRegistered(AP, [0, 0, 0], scaled, points, frame),
    ).toThrow();
    expect(() =>
      projectRegistered(AP, [0, 0, 0], identity, points, {
        width: 0,
        height: 10,
      }),
    ).toThrow("Invalid frame size");
    expect(() =>
      projectRegistered(
        { ...AP, source_detector_mm: 100 },
        [0, 0, 0],
        identity,
        points,
        frame,
      ),
    ).toThrow();
  });
});

const CASES: [string, ViewNumbers, Vec3, Vec3, Options?][] = [
  ["AP, turn about the viewing axis", AP, [0, 10, 0], [8, 0, 6]],
  ["AP, turn about the image-up axis", AP, [0, 0, 10], [8, 0, 6]],
  ["AP, mixed", AP, [4, -5, 7], [6, -7, 4]],
  ["AP, turn about image-right and depth", AP, [7, 0, 0], [5, 10, -5]],
  ["lateral", { ...AP, primary_deg: 90 }, [5, 6, -6], [-6, 6, 5]],
  [
    "LAO 30 CRA 20",
    { ...AP, primary_deg: 30, secondary_deg: 20 },
    [-6, 5, 6],
    [5, 5, -7],
  ],
  [
    "RAO 40 CAU 25",
    { ...AP, primary_deg: -40, secondary_deg: -25 },
    [6, 6, 5],
    [-6, -6, -5],
  ],
  ["bright vessels", AP, [4, -5, 7], [6, -7, 4], { polarity: "bright" }],
  ["heavy noise", AP, [4, -5, 7], [6, -7, 4], { noise: 40 }],
  [
    "0.5 mm mask, 1024 px frame",
    AP,
    [4, -5, 7],
    [6, -7, 4],
    { spacing: 0.5, px: 1024 },
  ],
  ["14 mm and 14 degrees off", AP, [8, -8, 8], [10, -10, 0]],
];
const extra: Tube = {
  path: [
    [-20, -10, -20],
    [-25, 10, 5],
    [-15, 20, 25],
  ],
  radius: 2,
};
const WRONG: ViewNumbers = {
  ...AP,
  detector_width_mm: 150,
  detector_height_mm: 150,
};

describe("projection registration proposal", () => {
  // The synthetic known-pose gate. One plane does not determine depth and
  // determines out-of-plane turns only weakly, so those two are bounded by
  // the search range here and reported, not gated.
  it.each(CASES)(
    "recovers a known pose: %s",
    (_name, view, degrees, shift, o) => {
      const s = setup(view, degrees, shift, o),
        proposal = proposeProjectionRegistration(s.input),
        e = errors(s, proposal);
      expect(e.projected_mm).toBeLessThan(1);
      expect(e.in_plane_deg).toBeLessThan(1);
      expect(Math.abs(e.depth_mm)).toBeLessThan(LIMITS.depth_mm);
      expect(proposal.start_score.mean_distance_mm).toBeGreaterThan(3);
      expect(proposal.score.mean_distance_mm).toBeLessThan(1);
      expect(proposal.score.matched_fraction).toBeGreaterThan(0.85);
      expect(proposal.score.in_field_fraction).toBe(1);
      expect(proposal.detector_scale).toBe(1);
      expect(proposal.view).toEqual(view);
      expect(proposal.method).toBe("centerline_distance_compass_v1");
      expect(proposal.point_count).toBe(s.points.length / 3);
      expect(proposal.evaluations).toBeLessThanOrEqual(LIMITS.max_evaluations);
      expect(proposal.translation_mm).toBeGreaterThan(4);
      expect(proposal.rotation_deg).toBeGreaterThan(3);
    },
  );

  it("leaves a pose that already matches where it is", () => {
    const s = setup(AP, [0, 0, 0], [0, 0, 0]),
      proposal = proposeProjectionRegistration(s.input),
      e = errors(s, proposal);
    expect(e.projected_mm).toBeLessThan(0.3);
    expect(Math.abs(e.depth_mm)).toBeLessThan(3);
    expect(proposal.start_score.mean_distance_mm).toBeLessThan(0.6);
    expect(proposal.score.mean_distance_mm).toBeLessThanOrEqual(
      proposal.start_score.mean_distance_mm + 1e-9,
    );
  });

  it("composes onto a starting matrix that is not the identity", () => {
    const s = setup(AP, [4, -5, 7], [6, -7, 4]),
      start = rigid([3, -4, 5], [4, -5, 3], s.isocenter),
      proposal = proposeProjectionRegistration({ ...s.input, start }),
      e = errors(s, proposal);
    expect(e.projected_mm).toBeLessThan(1);
    expect(e.in_plane_deg).toBeLessThan(1);
    // A closer start means a smaller reported move.
    expect(proposal.translation_mm).toBeLessThan(8);
    expect(proposal.rotation_deg).toBeLessThan(6);
  });

  it("tolerates vessels present on one side only, and reports them", () => {
    const base = proposeProjectionRegistration(
      setup(AP, [4, -5, 7], [6, -7, 4]).input,
    );
    const more2d = setup(AP, [4, -5, 7], [6, -7, 4], {
        frameTree: [...TREE, extra],
      }),
      p2 = proposeProjectionRegistration(more2d.input);
    expect(errors(more2d, p2).projected_mm).toBeLessThan(1);
    expect(base.score.uncovered_fraction).toBeLessThan(0.05);
    expect(p2.score.uncovered_fraction).toBeGreaterThan(0.15);

    const more3d = setup(AP, [4, -5, 7], [6, -7, 4], {
        maskTree: [...TREE, extra],
      }),
      p3 = proposeProjectionRegistration(more3d.input);
    expect(errors(more3d, p3).projected_mm).toBeLessThan(1);
    expect(base.score.matched_fraction).toBeGreaterThan(0.95);
    expect(p3.score.matched_fraction).toBeLessThan(0.8);
    expect(p3.score.mean_distance_mm).toBeGreaterThan(1.5);

    const less2d = setup(AP, [4, -5, 7], [6, -7, 4], {
        frameTree: TREE.slice(0, 3),
      }),
      p4 = proposeProjectionRegistration(less2d.input);
    expect(errors(less2d, p4).projected_mm).toBeLessThan(1);
  });

  it("fits the detector scale of an uncalibrated plane only when asked", () => {
    // The frame was acquired 180 mm wide; 150 mm was entered.
    const fixed = setup(WRONG, [4, -5, 7], [6, -7, 4], { trueView: AP }),
      unfit = proposeProjectionRegistration(fixed.input);
    expect(unfit.detector_scale).toBe(1);
    expect(errors(fixed, unfit).projected_mm).toBeGreaterThan(1);

    const free = setup(WRONG, [4, -5, 7], [6, -7, 4], {
        trueView: AP,
        fit: true,
      }),
      fit = proposeProjectionRegistration(free.input);
    expect(Math.abs(fit.detector_scale - 1.2)).toBeLessThan(0.03);
    expect(fit.view.detector_width_mm).toBeCloseTo(150 * fit.detector_scale, 9);
    expect(fit.view.detector_height_mm).toBeCloseTo(
      150 * fit.detector_scale,
      9,
    );
    expect(errors(free, fit).projected_mm).toBeLessThan(1);
    // Depth is not searched while the scale is (the two are one freedom),
    // so the 7 mm of depth in the true pose stays as depth error.
    expect(errors(free, fit).depth_mm).toBeCloseTo(7, 3);

    const right = setup(AP, [4, -5, 7], [6, -7, 4], { fit: true }),
      same = proposeProjectionRegistration(right.input);
    expect(Math.abs(same.detector_scale - 1)).toBeLessThan(0.03);
    expect(errors(right, same).projected_mm).toBeLessThan(1);
  });

  it("stays inside its search range and shows a poor score beyond it", () => {
    const s = setup(AP, [0, 40, 0], [0, 0, 0]),
      proposal = proposeProjectionRegistration(s.input);
    // Three per-axis turns of at most 15 degrees compose to under 28.
    expect(proposal.rotation_deg).toBeLessThan(28);
    expect(errors(s, proposal).rotation_deg).toBeGreaterThan(14);
    expect(proposal.score.mean_distance_mm).toBeGreaterThan(0.6);
    expect(proposal.score.matched_fraction).toBeLessThan(0.95);

    const far = setup(AP, [0, 0, 0], [-75, 0, 0], {
      px: 600,
      trueView: {
        ...AP,
        detector_width_mm: 360,
        detector_height_mm: 360,
      },
    });
    const out = proposeProjectionRegistration({
      ...far.input,
      view: { ...AP, detector_width_mm: 360, detector_height_mm: 360 },
    });
    expect(out.translation_mm).toBeLessThanOrEqual(
      Math.hypot(LIMITS.in_plane_mm, LIMITS.in_plane_mm, LIMITS.depth_mm),
    );
    const moved = applyRigid(out.matrix, far.isocenter);
    expect(Math.abs(moved[0] - far.isocenter[0])).toBeLessThanOrEqual(
      LIMITS.in_plane_mm + 1e-6,
    );
  });

  it("returns a rigid matrix, the same one every time", () => {
    const s = setup(AP, [4, -5, 7], [6, -7, 4]),
      a = proposeProjectionRegistration(s.input),
      b = proposeProjectionRegistration(s.input),
      m = a.matrix;
    expect(b).toEqual(a);
    expect(m[3]).toEqual([0, 0, 0, 1]);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        expect(
          m[0][i] * m[0][j] + m[1][i] * m[1][j] + m[2][i] * m[2][j],
        ).toBeCloseTo(i === j ? 1 : 0, 8);
    const det =
      m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
      m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
      m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    expect(det).toBeCloseTo(1, 8);
    expect(
      Object.is(
        -0,
        m.flat().find((value) => Object.is(value, -0)),
      ),
    ).toBe(false);
  });

  it("runs in slices and equals the one-shot result", () => {
    const s = setup(AP, [4, -5, 7], [6, -7, 4]),
      job = createProjectionRegistrationJob(s.input);
    expect(() => job.result()).toThrow("Registration is not complete");
    let slices = 0,
      steps = 0;
    while (!job.advance(() => ++steps % 50 === 0)) slices++;
    expect(slices).toBeGreaterThan(20);
    expect(job.advance(() => true)).toBe(true);
    expect(job.result()).toEqual(proposeProjectionRegistration(s.input));
  });

  it("refuses when no pose in range keeps the vessels in the frame", () => {
    const s = setup(AP, [0, 0, 0], [0, 0, 0]);
    // The start puts the volume 300 mm to the side of a 120 mm field.
    const job = createProjectionRegistrationJob({
      ...s.input,
      start: rigid([0, 0, 0], [300, 0, 0]),
    });
    expect(() => job.advance(() => false)).toThrow("inside the frame");
    // The failure is kept, not replaced by a stale or partial result.
    expect(() => job.advance(() => false)).toThrow("inside the frame");
    expect(() => job.result()).toThrow("Registration is not complete");
  });

  it("rejects input it cannot register", () => {
    const s = setup(AP, [4, -5, 7], [6, -7, 4]),
      run = (change: Partial<ProjectionRegistrationInput>) => () =>
        proposeProjectionRegistration({ ...s.input, ...change });
    expect(
      run({ points: s.points.slice(0, 3 * (LIMITS.min_points - 1)) }),
    ).toThrow("Too few vessel points");
    expect(run({ points: s.points.slice(0, 91) })).toThrow(
      "Too few vessel points",
    );
    expect(
      run({ points: Array.from(s.points) as unknown as Float32Array }),
    ).toThrow("Too few vessel points");
    const nan = s.points.slice();
    nan[40] = Infinity;
    expect(run({ points: nan })).toThrow("Nonfinite vessel point");
    expect(run({ start: [[1, 0, 0, 0]] })).toThrow();
    const scaled = identity.map((row) => [...row]);
    scaled[1][1] = 1.1;
    expect(run({ start: scaled })).toThrow();
    expect(run({ isocenter: [0, NaN, 0] })).toThrow("Invalid isocenter");
    expect(run({ isocenter: [0, 0] as unknown as Vec3 })).toThrow(
      "Invalid isocenter",
    );
    expect(run({ view: { ...AP, detector_height_mm: 150 } })).toThrow(
      "Detector pixels must be square",
    );
    expect(run({ view: { ...AP, source_isocenter_mm: 1300 } })).toThrow();
    expect(run({ frame: { width: 300.5, height: 300 } })).toThrow(
      "Invalid frame size",
    );
    // A target computed for another frame size.
    expect(run({ frame: { width: 600, height: 600 } })).toThrow(
      "does not belong to this frame",
    );
    expect(
      run({ target: { ...s.input.target, distance: new Float32Array(10) } }),
    ).toThrow("does not belong to this frame");
    expect(run({ target: { ...s.input.target, scale: 2 } })).toThrow(
      "does not belong to this frame",
    );
  });
});
