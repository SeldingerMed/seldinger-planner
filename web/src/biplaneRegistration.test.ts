import { describe, expect, it } from "vitest";
import {
  applyRigid,
  renderFrame,
  rigid,
  treeMask,
  TREE,
  type Tube,
} from "./__fixtures__/angioPhantom";
import {
  BIPLANE_REGISTRATION_LIMITS as LIMITS,
  createBiplaneRegistrationJob,
  planeAngleDeg,
  planesFarEnough,
  proposeBiplaneRegistration,
  type BiplaneRegistrationInput,
  type BiplaneRegistrationProposal,
} from "./biplaneRegistration";
import { camera, type ViewNumbers } from "./carmGeometry";
import { centroid, medialPoints } from "./maskPoints";
import type { Vec3 } from "./obliqueSlice";
import { proposeProjectionRegistration } from "./projectionRegistration";
import { vesselTarget } from "./vesselness2d";

const AP: ViewNumbers = {
  primary_deg: 0,
  secondary_deg: 0,
  source_detector_mm: 1200,
  source_isocenter_mm: 800,
  detector_width_mm: 180,
  detector_height_mm: 180,
};
const LATERAL: ViewNumbers = { ...AP, primary_deg: 90 };
const LAO30: ViewNumbers = { ...AP, primary_deg: 30 };
const RAO30: ViewNumbers = { ...AP, primary_deg: -30 };
const identity = rigid([0, 0, 0], [0, 0, 0]);
const dot = (a: readonly number[], b: readonly number[]) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const extra: Tube = {
  path: [
    [-20, -10, -20],
    [-25, 10, 5],
    [-15, 20, 25],
  ],
  radius: 2,
};

type PlaneOptions = {
  px?: number;
  noise?: number;
  /** View the frame was really acquired with, when the entered one is wrong. */
  trueView?: ViewNumbers;
  frameTree?: Tube[];
  fit?: boolean;
};
type Options = { maskTree?: Tube[]; a?: PlaneOptions; b?: PlaneOptions };
const masks = new Map<number, Float32Array>();
function setup(
  views: [ViewNumbers, ViewNumbers],
  degrees: Vec3,
  shift: Vec3,
  o: Options = {},
) {
  const tree = o.maskTree ?? TREE;
  if (!masks.has(tree.length)) {
    const { mask, shape, affine } = treeMask(1, tree);
    masks.set(tree.length, medialPoints(mask, shape, affine).points);
  }
  const points = masks.get(tree.length)!,
    isocenter = centroid(points),
    truth = rigid(degrees, shift, isocenter);
  const plane = (view: ViewNumbers, p: PlaneOptions = {}, seed: number) => {
    const frame = { width: p.px ?? 300, height: p.px ?? 300 };
    const gray = renderFrame(p.trueView ?? view, isocenter, truth, {
      ...frame,
      polarity: "dark",
      noise: p.noise ?? 12,
      seed,
      tree: p.frameTree,
    });
    return {
      view,
      isocenter,
      frame,
      target: vesselTarget(gray, frame.width, frame.height, "dark"),
      fit_detector_scale: p.fit ?? false,
    };
  };
  const input: BiplaneRegistrationInput = {
    points,
    planes: [plane(views[0], o.a, 7), plane(views[1], o.b, 11)],
    start: identity,
  };
  return { input, truth, isocenter, points, views };
}
/** Errors of a proposal against the pose both frames were rendered at. */
function errors(s: ReturnType<typeof setup>, p: BiplaneRegistrationProposal) {
  let sum = 0;
  for (let k = 0; k < s.points.length; k += 3) {
    const x: Vec3 = [s.points[k], s.points[k + 1], s.points[k + 2]],
      a = applyRigid(p.matrix, x),
      b = applyRigid(s.truth, x);
    sum += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }
  const e = [0, 1, 2].map((i) =>
    [0, 1, 2].map((j) => dot(p.matrix[i].slice(0, 3), s.truth[j].slice(0, 3))),
  );
  const moved = applyRigid(p.matrix, s.isocenter),
    wanted = applyRigid(s.truth, s.isocenter),
    offset = moved.map((value, i) => value - wanted[i]);
  return {
    /** Mean distance between where the proposal and the truth put each
     * vessel point, in millimeters in three dimensions. */
    point_mm: sum / (s.points.length / 3),
    rotation_deg:
      (Math.acos(
        Math.max(-1, Math.min(1, (e[0][0] + e[1][1] + e[2][2] - 1) / 2)),
      ) *
        180) /
      Math.PI,
    /** Offset of the isocenter along each plane's own beam. */
    depth_mm: s.views.map((view) => dot(offset, camera(view, s.isocenter).d)),
  };
}

const CASES: [string, [ViewNumbers, ViewNumbers], Vec3, Vec3, Options?][] = [
  ["AP and lateral, mixed", [AP, LATERAL], [4, -5, 7], [6, -7, 4]],
  ["AP and lateral, turn about x", [AP, LATERAL], [7, 0, 0], [5, 10, -5]],
  ["AP and lateral, turn about y", [AP, LATERAL], [0, 10, 0], [8, 0, 6]],
  ["AP and lateral, turn about z", [AP, LATERAL], [0, 0, 10], [-6, 6, 5]],
  ["planes 60 degrees apart", [LAO30, RAO30], [4, -5, 7], [6, -7, 4]],
  [
    "planes 60 degrees apart, angulated",
    [
      { ...AP, primary_deg: 30, secondary_deg: 20 },
      { ...AP, primary_deg: -30, secondary_deg: -10 },
    ],
    [-6, 5, 6],
    [5, 5, -7],
  ],
  [
    "a vessel missing from one plane's frame",
    [AP, LATERAL],
    [4, -5, 7],
    [6, -7, 4],
    { b: { frameTree: TREE.slice(0, 3) } },
  ],
  [
    "heavy noise",
    [AP, LATERAL],
    [4, -5, 7],
    [6, -7, 4],
    { a: { noise: 40 }, b: { noise: 40 } },
  ],
  [
    "planes of different size and distances",
    [AP, { ...LATERAL, source_detector_mm: 1100, source_isocenter_mm: 760 }],
    [-5, 6, -6],
    [-6, 6, 5],
    { b: { px: 384 } },
  ],
  ["14 mm and 14 degrees off", [AP, LATERAL], [8, -8, 8], [10, -10, 0]],
];

describe("biplane registration proposal", () => {
  // The synthetic known-pose gate for two planes sharing one patient pose.
  // Unlike one plane, two planes determine depth and every rotation, so the
  // gate is on the pose in three dimensions.
  it.each(CASES)(
    "recovers a known pose from two planes: %s",
    (_name, views, degrees, shift, o) => {
      const s = setup(views, degrees, shift, o),
        proposal = proposeBiplaneRegistration(s.input),
        e = errors(s, proposal);
      expect(e.point_mm).toBeLessThan(1);
      expect(e.rotation_deg).toBeLessThan(1);
      for (const depth of e.depth_mm) expect(Math.abs(depth)).toBeLessThan(1);
      expect(proposal.method).toBe("centerline_distance_compass_biplane_v1");
      expect(proposal.point_count).toBe(s.points.length / 3);
      expect(proposal.evaluations).toBeLessThanOrEqual(LIMITS.max_evaluations);
      expect(proposal.translation_mm).toBeGreaterThan(4);
      expect(proposal.rotation_deg).toBeGreaterThan(3);
      proposal.planes.forEach((plane, k) => {
        expect(plane.start_score.mean_distance_mm).toBeGreaterThan(2);
        expect(plane.score.mean_distance_mm).toBeLessThan(
          plane.start_score.mean_distance_mm,
        );
        expect(plane.score.in_field_fraction).toBe(1);
        expect(plane.detector_scale).toBe(1);
        expect(plane.view).toEqual(views[k]);
      });
    },
  );

  it("holds the same gate on poses drawn after the method was fixed", () => {
    // Twelve poses from a fixed generator, each freedom within 10 mm or 10
    // degrees, on orthogonal planes and on planes 60 degrees apart.
    let state = 20261114;
    const draw = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return Math.round((state / 2 ** 32) * 200 - 100) / 10;
    };
    const worst = { point_mm: 0, rotation_deg: 0 };
    for (let k = 0; k < 12; k++) {
      const degrees: Vec3 = [draw(), draw(), draw()],
        shift: Vec3 = [draw(), draw(), draw()],
        s = setup(k % 2 ? [LAO30, RAO30] : [AP, LATERAL], degrees, shift),
        e = errors(s, proposeBiplaneRegistration(s.input));
      worst.point_mm = Math.max(worst.point_mm, e.point_mm);
      worst.rotation_deg = Math.max(worst.rotation_deg, e.rotation_deg);
    }
    expect(worst.point_mm).toBeLessThan(1);
    expect(worst.rotation_deg).toBeLessThan(1);
  });

  it("bounds, but does not remove, the pull of a vessel no frame shows", () => {
    // About a third of the 3D points belong to a vessel in the mask and in
    // neither frame. Where its projection crosses an unrelated line it still
    // matches, so the pose turns by up to a few degrees. Reported, not gated.
    const poses: [Vec3, Vec3][] = [
      [
        [4, -5, 7],
        [6, -7, 4],
      ],
      [
        [-6, 5, 6],
        [5, 5, -7],
      ],
      [
        [7, 0, 0],
        [5, 10, -5],
      ],
    ];
    let worst = 0;
    for (const [degrees, shift] of poses) {
      const s = setup([AP, LATERAL], degrees, shift, {
          maskTree: [...TREE, extra],
          a: { frameTree: TREE },
          b: { frameTree: TREE },
        }),
        proposal = proposeBiplaneRegistration(s.input),
        e = errors(s, proposal);
      expect(e.point_mm).toBeLessThan(1);
      expect(e.rotation_deg).toBeLessThan(3);
      worst = Math.max(worst, e.rotation_deg);
      for (const plane of proposal.planes)
        expect(plane.score.matched_fraction).toBeLessThan(0.9);
    }
    expect(worst).toBeGreaterThan(1);
  });

  it("determines what one plane leaves open", () => {
    // The same frame and start, alone and with a second plane. One plane
    // leaves depth near the start; two do not.
    const s = setup([AP, LATERAL], [7, 0, 0], [5, 10, -5]),
      [a] = s.input.planes,
      single = proposeProjectionRegistration({
        points: s.points,
        view: a.view,
        isocenter: a.isocenter,
        frame: a.frame,
        target: a.target,
        start: identity,
        fit_detector_scale: false,
      }),
      alone = errors(s, {
        matrix: single.matrix,
      } as BiplaneRegistrationProposal),
      joint = errors(s, proposeBiplaneRegistration(s.input));
    expect(Math.abs(alone.depth_mm[0])).toBeGreaterThan(3);
    expect(alone.point_mm).toBeGreaterThan(3);
    expect(Math.abs(joint.depth_mm[0])).toBeLessThan(1);
    expect(joint.point_mm).toBeLessThan(1);
  });

  it("leaves a pose that already matches where it is", () => {
    const s = setup([AP, LATERAL], [0, 0, 0], [0, 0, 0]),
      proposal = proposeBiplaneRegistration(s.input),
      e = errors(s, proposal);
    expect(e.point_mm).toBeLessThan(0.5);
    expect(e.rotation_deg).toBeLessThan(0.5);
    for (const plane of proposal.planes)
      expect(plane.score.mean_distance_mm).toBeLessThan(0.6);
  });

  it("composes onto a starting matrix that is not the identity", () => {
    const s = setup([AP, LATERAL], [4, -5, 7], [6, -7, 4]),
      start = rigid([3, -4, 5], [4, -5, 3], s.isocenter),
      proposal = proposeBiplaneRegistration({ ...s.input, start }),
      e = errors(s, proposal);
    expect(e.point_mm).toBeLessThan(1);
    expect(e.rotation_deg).toBeLessThan(1);
    // A closer start means a smaller reported move.
    expect(proposal.translation_mm).toBeLessThan(8);
    expect(proposal.rotation_deg).toBeLessThan(6);
  });

  it("gives each plane its own isocenter", () => {
    // Plane B's central ray passes 12 mm above plane A's isocenter.
    const s = setup([AP, LATERAL], [4, -5, 7], [6, -7, 4]),
      raised: Vec3 = [s.isocenter[0], s.isocenter[1], s.isocenter[2] + 12],
      gray = renderFrame(LATERAL, raised, s.truth, {
        width: 300,
        height: 300,
        polarity: "dark",
        noise: 12,
        seed: 11,
      });
    const input: BiplaneRegistrationInput = {
      ...s.input,
      planes: [
        s.input.planes[0],
        {
          ...s.input.planes[1],
          isocenter: raised,
          target: vesselTarget(gray, 300, 300, "dark"),
        },
      ],
    };
    const e = errors(s, proposeBiplaneRegistration(input));
    expect(e.point_mm).toBeLessThan(1);
    expect(e.rotation_deg).toBeLessThan(1);
    // Scored against the shared isocenter instead, the same frames do not fit.
    const wrong = errors(
      s,
      proposeBiplaneRegistration({
        ...input,
        planes: [
          input.planes[0],
          { ...input.planes[1], isocenter: s.isocenter },
        ],
      }),
    );
    expect(wrong.point_mm).toBeGreaterThan(2);
  });

  it("fits each uncalibrated plane's detector scale only when asked", () => {
    // Both frames were acquired 180 mm wide. 150 mm was entered for plane A
    // and 210 mm for plane B.
    const narrow = { ...AP, detector_width_mm: 150, detector_height_mm: 150 },
      wide = { ...LATERAL, detector_width_mm: 210, detector_height_mm: 210 };
    const fixed = setup([narrow, wide], [4, -5, 7], [6, -7, 4], {
        a: { trueView: AP },
        b: { trueView: LATERAL },
      }),
      unfit = proposeBiplaneRegistration(fixed.input);
    expect(unfit.planes.map((plane) => plane.detector_scale)).toEqual([1, 1]);
    const free = setup([narrow, wide], [4, -5, 7], [6, -7, 4], {
        a: { trueView: AP, fit: true },
        b: { trueView: LATERAL, fit: true },
      }),
      fit = proposeBiplaneRegistration(free.input),
      e = errors(free, fit);
    // The fitted scales read a few percent high on this phantom. They are
    // reported, not gated; the bound here only pins the behaviour.
    expect(Math.abs(fit.planes[0].detector_scale - 180 / 150)).toBeLessThan(
      0.07,
    );
    expect(Math.abs(fit.planes[1].detector_scale - 180 / 210)).toBeLessThan(
      0.07,
    );
    expect(fit.planes[0].view.detector_width_mm).toBeCloseTo(
      150 * fit.planes[0].detector_scale,
      9,
    );
    expect(fit.planes[1].view.detector_height_mm).toBeCloseTo(
      210 * fit.planes[1].detector_scale,
      9,
    );
    // Two planes keep depth determined while the scales are fitted.
    expect(e.point_mm).toBeLessThan(1.5);
    expect(e.rotation_deg).toBeLessThan(1.5);
    expect(e.point_mm).toBeLessThan(errors(fixed, unfit).point_mm);
    // Only the plane that asks is fitted.
    const one = setup([AP, LATERAL], [4, -5, 7], [6, -7, 4], {
      b: { fit: true },
    });
    const half = proposeBiplaneRegistration(one.input);
    expect(half.planes[0].detector_scale).toBe(1);
    expect(Math.abs(half.planes[1].detector_scale - 1)).toBeLessThan(0.07);
    expect(errors(one, half).point_mm).toBeLessThan(1);
  });

  it("refuses planes too close to parallel, and reports their angle", () => {
    const s = setup([AP, LATERAL], [4, -5, 7], [6, -7, 4]);
    expect(proposeBiplaneRegistration(s.input).plane_angle_deg).toBeCloseTo(90);
    const apart = setup([LAO30, RAO30], [0, 0, 0], [0, 0, 0]);
    expect(proposeBiplaneRegistration(apart.input).plane_angle_deg).toBeCloseTo(
      60,
    );
    const near = (primary_deg: number): BiplaneRegistrationInput => ({
      ...s.input,
      planes: [
        s.input.planes[0],
        { ...s.input.planes[1], view: { ...AP, primary_deg } },
      ],
    });
    for (const angle of [0, 29, 151, 180, -29])
      expect(() => proposeBiplaneRegistration(near(angle))).toThrow(
        "The two planes are too close to parallel",
      );
    // Planes entered exactly at the limit pass, whichever way rounding falls.
    expect(planesFarEnough(planeAngleDeg(AP, LAO30))).toBe(true);
    expect(planesFarEnough(planeAngleDeg(AP, RAO30))).toBe(true);
    expect(
      planesFarEnough(planeAngleDeg(AP, { ...AP, primary_deg: 150 })),
    ).toBe(true);
    expect(planesFarEnough(30)).toBe(true);
    expect(planesFarEnough(29.999)).toBe(false);
    expect(planesFarEnough(Number.NaN)).toBe(false);
    expect(planeAngleDeg(AP, { ...AP, primary_deg: 31 })).toBeCloseTo(31);
    expect(planeAngleDeg(AP, { ...AP, primary_deg: 151 })).toBeCloseTo(29);
    expect(
      planeAngleDeg(AP, { ...AP, primary_deg: 90, secondary_deg: 40 }),
    ).toBeCloseTo(90);
  });

  it("runs as a resumable job with the same result", () => {
    const s = setup([AP, LATERAL], [4, -5, 7], [6, -7, 4]),
      whole = proposeBiplaneRegistration(s.input),
      job = createBiplaneRegistrationJob(s.input);
    expect(() => job.result()).toThrow("Registration is not complete");
    let slices = 0,
      calls = 0;
    while (!job.advance(() => ++calls % 50 === 0)) slices++;
    expect(slices).toBeGreaterThan(10);
    expect(job.result()).toEqual(whole);
  });

  it("rejects input it cannot score", () => {
    const s = setup([AP, LATERAL], [4, -5, 7], [6, -7, 4]),
      [a, b] = s.input.planes;
    const run = (change: Partial<BiplaneRegistrationInput>) => () =>
      proposeBiplaneRegistration({ ...s.input, ...change });
    expect(run({ points: s.points.slice(0, 60) })).toThrow(
      "Too few vessel points to register",
    );
    const bad = s.points.slice();
    bad[4] = NaN;
    expect(run({ points: bad })).toThrow("Nonfinite vessel point");
    expect(run({ start: [[1, 0, 0, 0]] })).toThrow();
    expect(
      run({ planes: [a, { ...b, isocenter: [0, NaN, 0] as Vec3 }] }),
    ).toThrow("Invalid isocenter");
    expect(
      run({ planes: [a, { ...b, frame: { width: 200, height: 300 } }] }),
    ).toThrow("Vessel target does not belong to this frame");
    expect(
      run({
        planes: [a, { ...b, view: { ...LATERAL, detector_height_mm: 150 } }],
      }),
    ).toThrow("Detector pixels must be square");
    expect(
      run({
        planes: [
          a,
          {
            ...b,
            view: {
              ...LATERAL,
              source_isocenter_mm: 400,
              detector_width_mm: 50,
              detector_height_mm: 50,
            },
          },
        ],
      }),
    ).toThrow("Field too small for this frame");
    expect(
      run({ planes: [a] as unknown as BiplaneRegistrationInput["planes"] }),
    ).toThrow("Two planes are required");
    // A start that puts the vessels outside one plane has no pose to return.
    expect(run({ start: rigid([0, 0, 0], [0, 0, 400]) })).toThrow(
      "No pose in the search range keeps the vessel points inside both frames",
    );
  });
});
