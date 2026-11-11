import type { NVImage } from "@niivue/niivue";
import { expect, test } from "vitest";
import {
  makeVolume,
  phantomPair,
  rigidAbout,
  scene,
  transform,
} from "./__fixtures__/registrationPhantom";
import type { Vec3 } from "./obliqueSlice";
import { inverseRigidPoint, validateRigid } from "./rigidFusion";
import {
  createRegistrationJob,
  proposeRigidRegistration,
  REGISTRATION_LIMITS,
  REGISTRATION_METHOD,
  scanGrid,
} from "./rigidRegistration";

const identity = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];
/** Largest distance between where two transforms put the same points. */
const worst = (a: number[][], b: number[][], points: Vec3[]) =>
  Math.max(
    ...points.map((p) => {
      const u = transform(a, p),
        v = transform(b, p);
      return Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]);
    }),
  );
const pair = phantomPair();
const proposal = proposeRigidRegistration(
  pair.primary,
  pair.secondary,
  identity,
);

test("a known rigid offset is recovered from the identity across contrasts", () => {
  // Truth is 14° and about 117 mm from the identity; the secondary has
  // inverted, nonlinear contrast and noise on a different grid.
  expect(worst(identity, pair.truth, pair.corners)).toBeGreaterThan(100);
  // One primary voxel (1.5 mm) at the corners of the secondary volume.
  expect(worst(proposal.matrix, pair.truth, pair.corners)).toBeLessThan(1.5);
  expect(proposal.method).toBe(REGISTRATION_METHOD);
  expect(proposal.start_score).toBe(0);
  expect(proposal.score).toBeGreaterThan(1.2);
  expect(proposal.overlap).toBeGreaterThan(0.95);
  expect(proposal.rotation_deg).toBeGreaterThan(13);
  expect(proposal.rotation_deg).toBeLessThan(15);
  expect(proposal.translation_mm).toBeGreaterThan(110);
  expect(proposal.sample_mm).toBeCloseTo(1.2, 9);
  // A bounded search: the starting matrix, the translation scan and the
  // capped compass search.
  expect(proposal.evaluations).toBeGreaterThan(1000);
  expect(proposal.evaluations).toBeLessThanOrEqual(
    1 +
      REGISTRATION_LIMITS.max_scan_positions +
      REGISTRATION_LIMITS.max_search_evaluations,
  );
});

test("the proposal is a rigid matrix in the direction the fusion view uses", () => {
  expect(validateRigid(proposal.matrix)).toEqual(proposal.matrix);
  // Fusion samples the secondary at inverse(matrix)·primary point.
  for (const q of pair.corners) {
    const back = inverseRigidPoint(proposal.matrix, transform(pair.truth, q));
    expect(
      Math.hypot(back[0] - q[0], back[1] - q[1], back[2] - q[2]),
    ).toBeLessThan(1.5);
  }
});

test("a search started near the answer stays there and improves the score", () => {
  const near = rigidAbout([1, 2, -1], 11, pair.center, [8, 2, 9]);
  const refined = proposeRigidRegistration(pair.primary, pair.secondary, near);
  expect(worst(near, pair.truth, pair.corners)).toBeGreaterThan(4);
  expect(worst(refined.matrix, pair.truth, pair.corners)).toBeLessThan(1.5);
  expect(refined.score).toBeGreaterThan(refined.start_score);
  expect(refined.rotation_deg).toBeLessThan(5);
});

test("rotation beyond the declared search range is not recovered", () => {
  // 60° away: the search may not turn more than 20° per axis, so the
  // proposal must not be read as a global search.
  const far = rigidAbout([0, 0, 1], 60, pair.center, [5, 4, 6]);
  const tilted = phantomPair(far);
  const result = proposeRigidRegistration(
    tilted.primary,
    tilted.secondary,
    identity,
  );
  expect(result.rotation_deg).toBeLessThan(
    REGISTRATION_LIMITS.rotation_deg * 1.8,
  );
  expect(worst(result.matrix, far, tilted.corners)).toBeGreaterThan(5);
});

test("a left-handed, anisotropic secondary grid is registered alike", () => {
  // Converted DICOM is often LAS: the first voxel axis runs to patient
  // right, so the native affine has a negative determinant.
  const affine = [
    [-1, 0, 0, -36],
    [0, 1.4, 0, 46],
    [0, 0, 1.1, 22],
    [0, 0, 0, 1],
  ];
  const secondary = makeVolume(
    56,
    affine,
    (q) => 2000 - 0.9 * scene(transform(pair.truth, q)),
  );
  const corners = Array.from({ length: 8 }, (_, c) =>
    transform(affine, [(c & 1) * 55, ((c >> 1) & 1) * 55, ((c >> 2) & 1) * 55]),
  );
  const result = proposeRigidRegistration(pair.primary, secondary, identity);
  expect(worst(identity, pair.truth, corners)).toBeGreaterThan(100);
  expect(worst(result.matrix, pair.truth, corners)).toBeLessThan(1.5);
  expect(validateRigid(result.matrix)).toEqual(result.matrix);
  // 1.5 mm asked for: two 1 mm voxels along x, one voxel along y and z.
  expect(result.sample_mm).toBeCloseTo(2, 9);
});

test("a turn the coarser levels misjudge is settled at the finest level", () => {
  // The scene is nearly round about the anterior axis, so its turn there
  // shows only in small detail. From the unturned start alone this pair
  // ends 7 mm out, at a middle-level optimum that outscores the truth.
  const truth = rigidAbout([1, 2, -1], 10, [0, 0, 0], [10, -15, 22]);
  const cube = (mm: number, origin: number) => [
    [mm, 0, 0, origin],
    [0, mm, 0, origin],
    [0, 0, mm, origin],
    [0, 0, 0, 1],
  ];
  const affine = cube(1.2, -47.4);
  const result = proposeRigidRegistration(
    makeVolume(96, cube(1.5, -71.25), scene),
    makeVolume(80, affine, (q) => 1500 - 0.8 * scene(transform(truth, q))),
    identity,
  );
  const corners = Array.from({ length: 8 }, (_, c) =>
    transform(affine, [(c & 1) * 79, ((c >> 1) & 1) * 79, ((c >> 2) & 1) * 79]),
  );
  expect(worst(result.matrix, truth, corners)).toBeLessThan(1.5);
  expect(result.sample_mm).toBeCloseTo(1.2, 9);
});

/** A block from inside the phantom, without the shell: mostly even tissue
 * with parts of the tubes and the blob, so there is little to register on.
 * Its own frame is unrelated to the primary's. `shift` moves the scene. */
const block = (
  n: number,
  mm: number,
  land: readonly number[],
  shift: readonly number[] = [0, 0, 0],
) => {
  const affine = [
    [mm, 0, 0, 150],
    [0, mm, 0, -80],
    [0, 0, mm, 60],
    [0, 0, 0, 1],
  ];
  const half = (mm * (n - 1)) / 2,
    center: Vec3 = [150 + half, -80 + half, 60 + half],
    at = land.map((v, k) => v + shift[k]) as Vec3,
    truth = rigidAbout([2, -1, 1], 9, center, at);
  let seed = 99;
  const secondary = makeVolume(n, affine, (q) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const p = transform(truth, q);
    return (
      3000 -
      0.7 * scene([p[0] - shift[0], p[1] - shift[1], p[2] - shift[2]]) +
      (seed / 2147483648 - 0.5) * 30
    );
  });
  const corners = Array.from({ length: 8 }, (_, c) =>
    transform(affine, [
      (c & 1) * (n - 1),
      ((c >> 1) & 1) * (n - 1),
      ((c >> 2) & 1) * (n - 1),
    ]),
  );
  // The right place but for 12 mm and the 9° turn.
  const near = [
    [1, 0, 0, at[0] - center[0] + 9],
    [0, 1, 0, at[1] - center[1] - 6],
    [0, 0, 1, at[2] - center[2] + 5],
    [0, 0, 0, 1],
  ];
  return { secondary, truth, corners, near };
};

// Each case fails without the safeguard it names.
test.each([
  [
    "found from an unrelated frame, with few histogram bins on coarse levels",
    { n: 40, mm: 1.2, land: [2, 4, 3], near: false, within: 1.5 },
  ],
  [
    "not drawn to the edge of the primary, where little of it overlaps",
    { n: 32, mm: 1.2, land: [4, 6, 4], near: false, within: 1.5 },
  ],
  [
    // 1.8 mm blocks here: within two of them.
    "kept near the starting matrix when the translation scan is misled",
    { n: 40, mm: 0.9, land: [3, 5, 4], near: true, within: 3.6 },
  ],
] as const)(
  "a low-detail block is %s",
  (_name, { n, mm, land, near, within }) => {
    const made = block(n, mm, land),
      start = near ? made.near : identity;
    const result = proposeRigidRegistration(
      pair.primary,
      made.secondary,
      start,
    );
    expect(worst(start, made.truth, made.corners)).toBeGreaterThan(10);
    expect(worst(result.matrix, made.truth, made.corners)).toBeLessThan(within);
    expect(result.overlap).toBeGreaterThan(0.95);
  },
);

test("the scan covers a primary that lies away from the RAS origin", () => {
  const shift = [120, -90, 60],
    made = block(40, 1.2, [2, 4, 3], shift);
  const primary = makeVolume(
    72,
    [
      [1.5, 0, 0, shift[0] - 53.25],
      [0, 1.5, 0, shift[1] - 53.25],
      [0, 0, 1.5, shift[2] - 53.25],
      [0, 0, 0, 1],
    ],
    (p) => scene([p[0] - shift[0], p[1] - shift[1], p[2] - shift[2]]),
  );
  const result = proposeRigidRegistration(primary, made.secondary, identity);
  expect(worst(result.matrix, made.truth, made.corners)).toBeLessThan(1.5);
});

test("the translation scan never visits more positions than its limit", () => {
  // 12 mm steps where they fit.
  expect(scanGrid([100, 100, 100])).toEqual({ step: 12, counts: [9, 9, 9] });
  // Equal shares of the limit would be 18.17 positions an axis; rounding
  // each axis up to a whole position must not carry the grid past it.
  for (const extent of [
    [300, 300, 300],
    [900, 200, 200],
    [226, 226, 226],
  ]) {
    const { step, counts } = scanGrid(extent);
    expect(step).toBeGreaterThan(12);
    expect(counts[0] * counts[1] * counts[2]).toBeLessThanOrEqual(
      REGISTRATION_LIMITS.max_scan_positions,
    );
    // Not much coarser than it has to be.
    expect(counts[0] * counts[1] * counts[2]).toBeGreaterThan(
      0.7 * REGISTRATION_LIMITS.max_scan_positions,
    );
  }
});

test("a small body in a primary too wide to scan at the base step is found", () => {
  // 300 mm across: 12 mm steps would visit 26³ positions, far past the limit.
  // The phantom is under 2% of the voxels, the rest air, so an intensity
  // range cut at the 1st and 99th percentiles would flatten all its detail.
  const wide = makeVolume(
    100,
    [
      [3, 0, 0, -148.5],
      [0, 3, 0, -148.5],
      [0, 0, 3, -148.5],
      [0, 0, 0, 1],
    ],
    scene,
  );
  const result = proposeRigidRegistration(wide, pair.secondary, identity);
  expect(result.evaluations).toBeLessThanOrEqual(
    1 +
      REGISTRATION_LIMITS.max_scan_positions +
      REGISTRATION_LIMITS.max_search_evaluations,
  );
  expect(worst(result.matrix, pair.truth, pair.corners)).toBeLessThan(3);
});

test("a job advanced one step at a time equals the one-shot proposal", () => {
  const job = createRegistrationJob(pair.primary, pair.secondary, identity);
  expect(() => job.result()).toThrow("Registration is not complete");
  let turns = 1;
  while (!job.advance(() => true)) turns++;
  expect(turns).toBeGreaterThan(500);
  expect(job.result()).toEqual(proposal);
});

const flatVolume = (value: number) =>
  makeVolume(
    16,
    [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ],
    () => value,
  );
test.each([
  [
    "a constant secondary",
    () => flatVolume(7),
    "no usable intensity variation",
  ],
  [
    "a nonfinite secondary",
    () => flatVolume(Number.NaN),
    "Nonfinite source sample",
  ],
  [
    "a secondary without millimeter units",
    () => {
      const v = flatVolume(1) as unknown as { hdr: { xyzt_units: number } };
      v.hdr.xyzt_units = 0;
      return v as unknown as NVImage;
    },
    "Confirmed mm units required",
  ],
  [
    "a secondary too small to register",
    () =>
      makeVolume(
        4,
        [
          [1, 0, 0, 0],
          [0, 1, 0, 0],
          [0, 0, 1, 0],
          [0, 0, 0, 1],
        ],
        (p) => p[0],
      ),
    "too small to register",
  ],
])("%s is refused, and the failure repeats", (_name, build, message) => {
  const job = createRegistrationJob(pair.primary, build(), identity);
  expect(() => job.advance(() => false)).toThrow(message);
  expect(() => job.advance(() => false)).toThrow(message);
  expect(() => job.result()).toThrow("Registration is not complete");
});

test("a start that is not a rigid matrix is refused", () => {
  const skewed = identity.map((r) => [...r]);
  skewed[0][1] = 0.2;
  expect(() =>
    proposeRigidRegistration(pair.primary, pair.secondary, skewed),
  ).toThrow("Rotation must be orthonormal");
});

test("sources that never overlap enough are refused", () => {
  // A secondary far larger than the primary can never place three quarters
  // of its samples inside it.
  const wide = makeVolume(
    40,
    [
      [20, 0, 0, -400],
      [0, 20, 0, -400],
      [0, 0, 20, -400],
      [0, 0, 0, 1],
    ],
    (p) => p[0] + 2 * p[1],
  );
  expect(() => proposeRigidRegistration(pair.primary, wide, identity)).toThrow(
    "No position puts enough of the secondary inside the primary",
  );
});
