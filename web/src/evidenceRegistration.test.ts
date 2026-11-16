import { describe, expect, it } from "vitest";
import {
  applyRigid,
  renderFrame,
  rigid,
  treeMask,
  TREE,
  type Tube,
} from "./__fixtures__/angioPhantom";
import { camera, type ViewNumbers } from "./carmGeometry";
import {
  EVIDENCE_REGISTRATION_LIMITS as LIMITS,
  createEvidenceRegistrationJob,
  proposeEvidenceRegistration,
  type EvidenceRegistrationInput,
  type EvidenceRegistrationProposal,
} from "./evidenceRegistration";
import { centroid, medialPoints } from "./maskPoints";
import type { Vec3 } from "./obliqueSlice";
import { projectRegistered } from "./projectionRegistration";
import { vesselEvidence } from "./vesselEvidence2d";

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
const WRONG: ViewNumbers = {
  ...AP,
  detector_width_mm: 150,
  detector_height_mm: 150,
};
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
  polarity?: "dark" | "bright";
  /** View the frame was really acquired with, when the entered one is wrong. */
  trueView?: ViewNumbers;
  frameTree?: Tube[];
  fit?: boolean;
};
type Options = {
  maskTree?: Tube[];
  spacing?: number;
  a?: PlaneOptions;
  b?: PlaneOptions;
};
const masks = new Map<string, Float32Array>();
function setup(
  views: ViewNumbers[],
  degrees: Vec3,
  shift: Vec3,
  o: Options = {},
) {
  const tree = o.maskTree ?? TREE,
    key = `${o.spacing ?? 1}/${tree.length}`;
  if (!masks.has(key)) {
    const { mask, shape, affine } = treeMask(o.spacing ?? 1, tree);
    masks.set(key, medialPoints(mask, shape, affine).points);
  }
  const points = masks.get(key)!,
    isocenter = centroid(points),
    truth = rigid(degrees, shift, isocenter),
    options = [o.a ?? {}, o.b ?? {}];
  const planes = views.map((view, k) => {
    const p = options[k],
      frame = { width: p.px ?? 300, height: p.px ?? 300 },
      polarity = p.polarity ?? "dark";
    const gray = renderFrame(p.trueView ?? view, isocenter, truth, {
      ...frame,
      polarity,
      noise: p.noise ?? 12,
      seed: k ? 11 : 7,
      tree: p.frameTree,
    });
    return {
      view,
      isocenter,
      frame,
      evidence: vesselEvidence(gray, frame.width, frame.height, polarity),
      fit_detector_scale: p.fit ?? false,
    };
  });
  const input: EvidenceRegistrationInput = { points, planes, start: identity };
  const trueViews = views.map((view, k) => options[k].trueView ?? view);
  return { input, truth, isocenter, points, views, trueViews };
}
/** Errors of a proposal against the pose the frames were rendered at. */
function errors(s: ReturnType<typeof setup>, p: EvidenceRegistrationProposal) {
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
  const along = (axis: readonly number[], other: readonly number[]) =>
    dot(
      axis,
      [0, 1, 2].map((i) => dot(e[i], other)),
    );
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
    /** Per plane: mean distance between where the proposal and the truth
     * put each vessel point on the detector, in millimeters at the
     * isocenter, and the residual turn about the viewing axis. */
    planes: s.input.planes.map((plane, k) => {
      const a = projectRegistered(
          p.planes[k].view,
          s.isocenter,
          p.matrix,
          s.points,
          plane.frame,
        ),
        b = projectRegistered(
          s.trueViews[k],
          s.isocenter,
          s.truth,
          s.points,
          plane.frame,
        );
      let total = 0;
      for (let i = 0; i < a.length; i += 2)
        total += Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1]);
      const t = s.trueViews[k],
        cam = camera(plane.view, s.isocenter);
      return {
        projected_mm:
          (((total / (a.length / 2)) * t.detector_width_mm) /
            plane.frame.width) *
          (t.source_isocenter_mm / t.source_detector_mm),
        in_plane_deg:
          (Math.abs(Math.atan2(along(cam.v, cam.u), along(cam.u, cam.u))) *
            180) /
          Math.PI,
      };
    }),
  };
}

const TWO: [string, [ViewNumbers, ViewNumbers], Vec3, Vec3, Options?][] = [
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
const ONE: [string, ViewNumbers, Vec3, Vec3, Options?][] = [
  ["AP, turn about the viewing axis", AP, [0, 10, 0], [8, 0, 6]],
  ["AP, turn about the image-up axis", AP, [0, 0, 10], [8, 0, 6]],
  ["AP, mixed", AP, [4, -5, 7], [6, -7, 4]],
  ["AP, turn about image-right and depth", AP, [7, 0, 0], [5, 10, -5]],
  ["lateral", LATERAL, [5, 6, -6], [-6, 6, 5]],
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
  ["bright vessels", AP, [4, -5, 7], [6, -7, 4], { a: { polarity: "bright" } }],
  ["heavy noise", AP, [4, -5, 7], [6, -7, 4], { a: { noise: 40 } }],
  [
    "0.5 mm mask, 1024 px frame",
    AP,
    [4, -5, 7],
    [6, -7, 4],
    { spacing: 0.5, a: { px: 1024 } },
  ],
  ["14 mm and 14 degrees off", AP, [8, -8, 8], [10, -10, 0]],
];

describe("two-plane vessel evidence registration", () => {
  // The synthetic known-pose gate of the older two-plane method, unchanged.
  it.each(TWO)(
    "recovers a known pose from two planes: %s",
    (_name, views, degrees, shift, o) => {
      const s = setup(views, degrees, shift, o),
        proposal = proposeEvidenceRegistration(s.input),
        e = errors(s, proposal);
      expect(e.point_mm).toBeLessThan(1);
      expect(e.rotation_deg).toBeLessThan(1);
      for (const depth of e.depth_mm) expect(Math.abs(depth)).toBeLessThan(1);
      expect(proposal.method).toBe("vessel_evidence_compass_biplane_v1");
      expect(proposal.point_count).toBe(s.points.length / 3);
      expect(proposal.evaluations).toBeLessThanOrEqual(LIMITS.max_evaluations);
      expect(proposal.translation_mm).toBeGreaterThan(4);
      expect(proposal.rotation_deg).toBeGreaterThan(3);
      expect(proposal.plane_angle_deg).toBeGreaterThan(59);
      proposal.planes.forEach((plane, k) => {
        expect(plane.score.mean_evidence).toBeGreaterThan(
          plane.start_score.mean_evidence + 0.2,
        );
        expect(plane.score.in_field_fraction).toBe(1);
        expect(plane.detector_scale).toBe(1);
        expect(plane.view).toEqual(views[k]);
      });
    },
  );

  it("holds the same gate on poses drawn from a fixed generator", () => {
    // Twelve poses, each freedom within 10 mm or 10 degrees, on orthogonal
    // planes and on planes 60 degrees apart.
    let state = 20261116;
    const draw = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return Math.round((state / 2 ** 32) * 200 - 100) / 10;
    };
    const worst = { point_mm: 0, rotation_deg: 0 };
    for (let k = 0; k < 12; k++) {
      const degrees: Vec3 = [draw(), draw(), draw()],
        shift: Vec3 = [draw(), draw(), draw()],
        s = setup(k % 2 ? [LAO30, RAO30] : [AP, LATERAL], degrees, shift),
        e = errors(s, proposeEvidenceRegistration(s.input));
      worst.point_mm = Math.max(worst.point_mm, e.point_mm);
      worst.rotation_deg = Math.max(worst.rotation_deg, e.rotation_deg);
    }
    expect(worst.point_mm).toBeLessThan(1);
    expect(worst.rotation_deg).toBeLessThan(1);
  });

  // The partial-filling gate. The older method turned by more than a degree
  // here, drawn toward unrelated lines by the points with no partner.
  it.each([
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
  ] as [Vec3, Vec3][])(
    "holds the gate when a third of the 3D vessels are in neither frame: %j",
    (degrees, shift) => {
      const s = setup([AP, LATERAL], degrees, shift, {
          maskTree: [...TREE, extra],
          a: { frameTree: TREE },
          b: { frameTree: TREE },
        }),
        proposal = proposeEvidenceRegistration(s.input),
        e = errors(s, proposal);
      expect(e.point_mm).toBeLessThan(1);
      expect(e.rotation_deg).toBeLessThan(1);
      // The vessel no frame shows is reported, not hidden.
      for (const plane of proposal.planes)
        expect(plane.score.mean_evidence).toBeLessThan(0.85);
    },
  );

  it("holds the gate when the frames show part of the 3D tree", () => {
    const s = setup([AP, LATERAL], [4, -5, 7], [6, -7, 4], {
        a: { frameTree: TREE.slice(0, 3) },
        b: { frameTree: TREE.slice(0, 3) },
      }),
      e = errors(s, proposeEvidenceRegistration(s.input));
    expect(e.point_mm).toBeLessThan(1);
    expect(e.rotation_deg).toBeLessThan(1);
  });

  it("holds the gate when the frames show a vessel the 3D tree lacks", () => {
    const s = setup([AP, LATERAL], [4, -5, 7], [6, -7, 4], {
        a: { frameTree: [...TREE, extra] },
        b: { frameTree: [...TREE, extra] },
      }),
      proposal = proposeEvidenceRegistration(s.input),
      e = errors(s, proposal);
    expect(e.point_mm).toBeLessThan(1);
    expect(e.rotation_deg).toBeLessThan(1);
    for (const plane of proposal.planes)
      expect(plane.score.uncovered_fraction).toBeGreaterThan(0.1);
  });

  it("leaves a pose that already matches where it is", () => {
    const s = setup([AP, LATERAL], [0, 0, 0], [0, 0, 0]),
      proposal = proposeEvidenceRegistration(s.input),
      e = errors(s, proposal);
    expect(e.point_mm).toBeLessThan(0.3);
    expect(e.rotation_deg).toBeLessThan(0.3);
    proposal.planes.forEach((plane) => {
      expect(plane.start_score.mean_evidence).toBeGreaterThan(0.5);
      expect(plane.score.uncovered_fraction).toBeLessThan(0.05);
    });
  });

  it("composes onto a starting matrix that is not the identity", () => {
    const s = setup([AP, LATERAL], [4, -5, 7], [6, -7, 4]),
      start = rigid([3, -4, 5], [4, -5, 3], s.isocenter),
      proposal = proposeEvidenceRegistration({ ...s.input, start }),
      e = errors(s, proposal);
    expect(e.point_mm).toBeLessThan(1);
    expect(e.rotation_deg).toBeLessThan(1);
    // A closer start means a smaller reported move.
    expect(proposal.translation_mm).toBeLessThan(8);
    expect(proposal.rotation_deg).toBeLessThan(6);
  });

  it("gives each plane its own isocenter", () => {
    const s = setup([AP, LATERAL], [4, -5, 7], [6, -7, 4]),
      moved: Vec3 = [s.isocenter[0], s.isocenter[1] + 6, s.isocenter[2]];
    // Plane B's central ray passes 6 mm from plane A's.
    const gray = renderFrame(LATERAL, moved, s.truth, {
      width: 300,
      height: 300,
      polarity: "dark",
      noise: 12,
      seed: 11,
    });
    const planes = [
      s.input.planes[0],
      {
        ...s.input.planes[1],
        isocenter: moved,
        evidence: vesselEvidence(gray, 300, 300, "dark"),
      },
    ];
    const e = errors(s, proposeEvidenceRegistration({ ...s.input, planes }));
    expect(e.point_mm).toBeLessThan(1);
    expect(e.rotation_deg).toBeLessThan(1);
  });

  it("fits each uncalibrated plane's detector scale only when asked", () => {
    // Both frames were acquired 180 mm wide; 150 mm was entered for plane A.
    const o = (fit: boolean): Options => ({ a: { trueView: AP, fit } }),
      fixed = setup([WRONG, LATERAL], [4, -5, 7], [6, -7, 4], o(false)),
      unfit = proposeEvidenceRegistration(fixed.input);
    expect(unfit.planes[0].detector_scale).toBe(1);
    expect(errors(fixed, unfit).planes[0].projected_mm).toBeGreaterThan(1);

    const free = setup([WRONG, LATERAL], [4, -5, 7], [6, -7, 4], o(true)),
      fit = proposeEvidenceRegistration(free.input),
      e = errors(free, fit);
    expect(unfit.detector_fit).toBe("not_requested");
    expect(unfit.fit_gain).toBeNull();
    expect(fit.detector_fit).toBe("kept");
    expect(fit.fit_gain).toBeGreaterThanOrEqual(LIMITS.min_fit_gain);
    expect(Math.abs(fit.planes[0].detector_scale - 1.2)).toBeLessThan(0.03);
    expect(fit.planes[0].view.detector_width_mm).toBeCloseTo(
      150 * fit.planes[0].detector_scale,
      9,
    );
    expect(fit.planes[0].view.detector_height_mm).toBeCloseTo(
      150 * fit.planes[0].detector_scale,
      9,
    );
    expect(fit.planes[1].detector_scale).toBe(1);
    expect(fit.planes[1].view).toEqual(LATERAL);
    expect(e.point_mm).toBeLessThan(1);
    for (const plane of e.planes) expect(plane.projected_mm).toBeLessThan(1);
  });

  it("drops a requested fit that does not beat the entered size", () => {
    // Both entered sizes are right, and a fit is requested on both planes.
    const s = setup([AP, LATERAL], [4, -5, 7], [6, -7, 4], {
        a: { fit: true },
        b: { fit: true },
      }),
      proposal = proposeEvidenceRegistration(s.input),
      e = errors(s, proposal);
    expect(proposal.detector_fit).toBe("dropped");
    expect(proposal.fit_gain).toBeLessThan(LIMITS.min_fit_gain);
    proposal.planes.forEach((plane, k) => {
      expect(plane.detector_scale).toBe(1);
      expect(plane.view).toEqual(s.views[k]);
    });
    expect(e.point_mm).toBeLessThan(1);
    expect(e.rotation_deg).toBeLessThan(1);
  });

  it("keeps a fitted detector inside the sizes the view model accepts", () => {
    // 560 mm entered, 600 mm true: the fit may not pass 600 mm, where the
    // older methods raised an error.
    const big = { ...AP, detector_width_mm: 600, detector_height_mm: 600 },
      entered = { ...AP, detector_width_mm: 560, detector_height_mm: 560 },
      s = setup([entered, LATERAL], [2, -2, 3], [3, -3, 2], {
        a: { trueView: big, fit: true, px: 600 },
      }),
      proposal = proposeEvidenceRegistration(s.input);
    for (const plane of proposal.planes) {
      expect(plane.view.detector_width_mm).toBeLessThanOrEqual(600 + 1e-9);
      expect(plane.view.detector_height_mm).toBeLessThanOrEqual(600 + 1e-9);
    }
    expect(["kept", "dropped"]).toContain(proposal.detector_fit);
  });

  it("refuses planes too close to parallel, and reports their angle", () => {
    const near = setup([AP, { ...AP, primary_deg: 20 }], [0, 0, 0], [3, 0, 0]);
    expect(() => proposeEvidenceRegistration(near.input)).toThrow(
      "The two planes are too close to parallel",
    );
    const edge = setup([AP, LAO30], [0, 0, 0], [3, 0, 0]);
    expect(proposeEvidenceRegistration(edge.input).plane_angle_deg).toBeCloseTo(
      30,
      6,
    );
  });
});

describe("one-plane vessel evidence registration", () => {
  // The synthetic known-pose gate of the older one-plane method. One plane
  // does not determine depth and determines out-of-plane turns only weakly,
  // so those two are bounded by the search range and not gated.
  it.each(ONE)(
    "recovers a known pose: %s",
    (_name, view, degrees, shift, o) => {
      const s = setup([view], degrees, shift, o),
        proposal = proposeEvidenceRegistration(s.input),
        e = errors(s, proposal);
      expect(e.planes[0].projected_mm).toBeLessThan(1);
      expect(e.planes[0].in_plane_deg).toBeLessThan(1);
      expect(Math.abs(e.depth_mm[0])).toBeLessThan(LIMITS.translation_mm);
      expect(proposal.method).toBe("vessel_evidence_compass_v1");
      expect(proposal.plane_angle_deg).toBeNull();
      expect(proposal.planes.length).toBe(1);
      expect(proposal.planes[0].score.mean_evidence).toBeGreaterThan(
        proposal.planes[0].start_score.mean_evidence + 0.2,
      );
      expect(proposal.planes[0].score.in_field_fraction).toBe(1);
      expect(proposal.planes[0].detector_scale).toBe(1);
      expect(proposal.planes[0].view).toEqual(view);
      expect(proposal.point_count).toBe(s.points.length / 3);
      expect(proposal.evaluations).toBeLessThanOrEqual(LIMITS.max_evaluations);
      expect(proposal.translation_mm).toBeGreaterThan(4);
      expect(proposal.rotation_deg).toBeGreaterThan(3);
    },
  );

  it("keeps depth near the start, which one plane cannot see", () => {
    const s = setup([AP], [0, 0, 0], [0, 0, 0]),
      proposal = proposeEvidenceRegistration(s.input),
      e = errors(s, proposal);
    expect(e.planes[0].projected_mm).toBeLessThan(0.3);
    expect(Math.abs(e.depth_mm[0])).toBeLessThan(3);
  });

  it("tolerates vessels present on one side only", () => {
    const more2d = setup([AP], [4, -5, 7], [6, -7, 4], {
      a: { frameTree: [...TREE, extra] },
    });
    expect(
      errors(more2d, proposeEvidenceRegistration(more2d.input)).planes[0]
        .projected_mm,
    ).toBeLessThan(1);
    const more3d = setup([AP], [4, -5, 7], [6, -7, 4], {
      maskTree: [...TREE, extra],
      a: { frameTree: TREE },
    });
    expect(
      errors(more3d, proposeEvidenceRegistration(more3d.input)).planes[0]
        .projected_mm,
    ).toBeLessThan(1);
    const less2d = setup([AP], [4, -5, 7], [6, -7, 4], {
      a: { frameTree: TREE.slice(0, 3) },
    });
    expect(
      errors(less2d, proposeEvidenceRegistration(less2d.input)).planes[0]
        .projected_mm,
    ).toBeLessThan(1);
  });

  it("fits the detector scale of an uncalibrated plane only when asked", () => {
    const fixed = setup([WRONG], [4, -5, 7], [6, -7, 4], {
        a: { trueView: AP },
      }),
      unfit = proposeEvidenceRegistration(fixed.input);
    expect(unfit.planes[0].detector_scale).toBe(1);
    expect(errors(fixed, unfit).planes[0].projected_mm).toBeGreaterThan(1);
    const free = setup([WRONG], [4, -5, 7], [6, -7, 4], {
        a: { trueView: AP, fit: true },
      }),
      fit = proposeEvidenceRegistration(free.input);
    expect(Math.abs(fit.planes[0].detector_scale - 1.2)).toBeLessThan(0.03);
    expect(errors(free, fit).planes[0].projected_mm).toBeLessThan(1);
    // Depth is not searched while the scale is: the two are one freedom.
    expect(errors(free, fit).depth_mm[0]).toBeCloseTo(7, 3);
  });
});

describe("vessel evidence registration, either way", () => {
  it("returns a rigid matrix, the same one every time", () => {
    const s = setup([AP, LATERAL], [4, -5, 7], [6, -7, 4]),
      a = proposeEvidenceRegistration(s.input),
      b = proposeEvidenceRegistration(s.input);
    expect(b).toEqual(a);
    const m = a.matrix;
    expect(m[3]).toEqual([0, 0, 0, 1]);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        expect(dot(m[i].slice(0, 3), m[j].slice(0, 3))).toBeCloseTo(
          i === j ? 1 : 0,
          6,
        );
  });

  it("runs in slices and equals the one-shot result", () => {
    const s = setup([AP, LATERAL], [4, -5, 7], [6, -7, 4]),
      job = createEvidenceRegistrationJob(s.input);
    expect(() => job.result()).toThrow("Registration is not complete");
    let slices = 0,
      calls = 0;
    while (!job.advance(() => ++calls % 50 === 0)) slices++;
    expect(slices).toBeGreaterThan(20);
    expect(job.result()).toEqual(proposeEvidenceRegistration(s.input));
  });

  it("stays inside its search range", () => {
    // The true pose is 30 degrees about the viewing axis: twice the range.
    const s = setup([AP, LATERAL], [0, 30, 0], [0, 0, 0]),
      proposal = proposeEvidenceRegistration(s.input);
    expect(proposal.rotation_deg).toBeLessThanOrEqual(
      Math.sqrt(3) * LIMITS.rotation_deg + 1e-9,
    );
    expect(proposal.translation_mm).toBeLessThanOrEqual(
      Math.sqrt(3) * LIMITS.translation_mm + 1e-9,
    );
    expect(errors(s, proposal).rotation_deg).toBeGreaterThan(4);
  });

  it("refuses when no pose in range keeps the vessels in the frame", () => {
    const s = setup([AP], [0, 0, 0], [0, 0, 0]);
    expect(() =>
      proposeEvidenceRegistration({
        ...s.input,
        start: rigid([0, 0, 0], [400, 0, 0]),
      }),
    ).toThrow(
      "No pose in the search range keeps the vessel points inside every frame",
    );
  });

  it("rejects input it cannot register", () => {
    const s = setup([AP, LATERAL], [0, 0, 0], [3, 0, 0]),
      [a, b] = s.input.planes,
      run = (input: Partial<EvidenceRegistrationInput>) => () =>
        proposeEvidenceRegistration({ ...s.input, ...input });
    expect(run({ planes: [] })).toThrow("One or two planes are required");
    expect(run({ planes: [a, b, a] })).toThrow(
      "One or two planes are required",
    );
    expect(run({ points: s.points.subarray(0, 60) })).toThrow(
      "Too few vessel points to register",
    );
    expect(run({ points: s.points.subarray(0, 100) })).toThrow(
      "Too few vessel points to register",
    );
    const bad = s.points.slice();
    bad[4] = NaN;
    expect(run({ points: bad })).toThrow("Nonfinite vessel point");
    expect(run({ start: [[1, 0, 0, 0]] })).toThrow();
    expect(
      run({ planes: [{ ...a, isocenter: [0, 0, NaN] as Vec3 }, b] }),
    ).toThrow("Invalid isocenter");
    expect(
      run({ planes: [{ ...a, frame: { width: 400, height: 400 } }, b] }),
    ).toThrow("Vessel evidence does not belong to this frame");
    expect(
      run({
        planes: [
          {
            ...a,
            evidence: { ...a.evidence, levels: a.evidence.levels.slice(1) },
          },
          b,
        ],
      }),
    ).toThrow("Vessel evidence does not belong to this frame");
    expect(
      run({
        planes: [{ ...a, view: { ...AP, detector_height_mm: 200 } }, b],
      }),
    ).toThrow("Detector pixels must be square");
    expect(
      run({ planes: [{ ...a, view: { ...AP, source_detector_mm: -1 } }, b] }),
    ).toThrow();
  });
});
