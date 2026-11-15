import { describe, expect, it } from "vitest";
import {
  applyRigid,
  renderFrame,
  rigid,
  treeMask,
  TREE,
  type Tube,
} from "./__fixtures__/angioPhantom";
import { proposeBiplaneRegistration } from "./biplaneRegistration";
import { camera, project, type ViewNumbers } from "./carmGeometry";
import { detectorToPixel } from "./carmProjection";
import { centroid, medialPoints } from "./maskPoints";
import type { Vec3 } from "./obliqueSlice";
import {
  projectRegistered,
  proposeProjectionRegistration,
} from "./projectionRegistration";
import { vesselTarget, type VesselTarget } from "./vesselness2d";
import {
  PRESENCE_CLASSES,
  VESSEL_PRESENCE_LIMITS as LIMITS,
  VESSEL_PRESENCE_METHOD,
  vesselPresence,
  type PresenceClass,
  type PresencePlaneInput,
} from "./vesselPresence";
import { vesselSegments, type VesselSegments } from "./vesselSegments";

const AP: ViewNumbers = {
  primary_deg: 0,
  secondary_deg: 0,
  source_detector_mm: 1200,
  source_isocenter_mm: 800,
  detector_width_mm: 180,
  detector_height_mm: 180,
};
const LAO60: ViewNumbers = { ...AP, primary_deg: 60 };
const LAO30: ViewNumbers = { ...AP, primary_deg: 30 };
const LATERAL: ViewNumbers = { ...AP, primary_deg: 90 };
const FRAME = { width: 300, height: 300 };
const identity = rigid([0, 0, 0], [0, 0, 0]);
/** A vessel beside the tree, clear of it in the AP and LAO 60 views. */
const aside: Tube = {
  path: [
    [-25, -15, -30],
    [-28, -18, 0],
    [-22, -12, 30],
  ],
  radius: 2,
};

const grid = treeMask(1, TREE),
  segments = vesselSegments(grid.mask, grid.shape, grid.affine),
  medial = medialPoints(grid.mask, grid.shape, grid.affine).points,
  center = centroid(medial);

function axisDistance(p: number[], a: Vec3, b: Vec3) {
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
/** The tube of the phantom each segment lies along. */
const tubeOf = segments.segments.map((_, index) => {
  const counts = TREE.map(() => 0);
  segments.labels.forEach((label, i) => {
    if (label !== index) return;
    const p = Array.from(segments.points.subarray(3 * i, 3 * i + 3)),
      d = TREE.map(({ path }) =>
        Math.min(...path.slice(1).map((b, k) => axisDistance(p, path[k], b))),
      );
    counts[d.indexOf(Math.min(...d))]++;
  });
  return counts.indexOf(Math.max(...counts));
});

type Scene = {
  isocenter: Vec3;
  truth: number[][];
  planes: PresencePlaneInput[];
};
function scene(
  frameTree: Tube[],
  views: ViewNumbers[] = [AP, LAO60],
  shift: Vec3 = [0, 0, 0],
  detector_mm = 180,
): Scene {
  const isocenter: Vec3 = [
      center[0] + shift[0],
      center[1] + shift[1],
      center[2] + shift[2],
    ],
    truth = rigid([4, -5, 7], [6, -7, 4], isocenter);
  return {
    isocenter,
    truth,
    planes: views.map((entered, i) => {
      const view = {
        ...entered,
        detector_width_mm: detector_mm,
        detector_height_mm: detector_mm,
      };
      return {
        view,
        frame: FRAME,
        target: vesselTarget(
          renderFrame(view, isocenter, truth, {
            ...FRAME,
            polarity: "dark",
            noise: 12,
            seed: 7 + 4 * i,
            tree: frameTree,
          }),
          FRAME.width,
          FRAME.height,
          "dark",
        ),
      };
    }),
  };
}
/** Mean distance between where two poses put the vessel points. */
function poseError(a: number[][], b: number[][]) {
  let sum = 0;
  for (let k = 0; k < medial.length; k += 3) {
    const x: Vec3 = [medial[k], medial[k + 1], medial[k + 2]],
      p = applyRigid(a, x),
      q = applyRigid(b, x);
    sum += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  }
  return sum / (medial.length / 3);
}
const fromOnePlane = (s: Scene) =>
  proposeProjectionRegistration({
    points: medial,
    view: s.planes[0].view,
    isocenter: s.isocenter,
    frame: FRAME,
    target: s.planes[0].target,
    start: identity,
    fit_detector_scale: false,
  }).matrix;
const fromTwoPlanes = (s: Scene) =>
  proposeBiplaneRegistration({
    points: medial,
    planes: [0, 1].map((i) => ({
      ...s.planes[i],
      isocenter: s.isocenter,
      fit_detector_scale: false,
    })) as never,
    start: identity,
  }).matrix;
const classesOf = (s: Scene, matrix: number[][], planes = s.planes) =>
  vesselPresence({
    segments,
    isocenter: s.isocenter,
    matrix,
    planes,
  }).planes.map((plane) => plane.segments.map((entry) => entry.class));

/** Frame coordinates of a volume point at the scene's true pose, through
 * the reference camera and not through the registration's projection. */
function reference(s: Scene, plane: PresencePlaneInput, point: number[]) {
  const [x, y] = project(
    camera(plane.view, s.isocenter),
    applyRigid(s.truth, point as Vec3),
  );
  return detectorToPixel(plane.view, FRAME, x, y);
}
/** Millimeters at the isocenter per frame pixel. */
const mmPerFramePixel = (view: ViewNumbers) =>
  ((view.detector_width_mm / FRAME.width) * view.source_isocenter_mm) /
  view.source_detector_mm;

type Case = {
  name: string;
  scene: () => Scene;
  expected: (s: Scene) => PresenceClass[][];
  /** The tube that is in the frames and not in the mask, if any. */
  only_in_frame?: Tube;
};
const supportedUnless = (absent: number) => () =>
  [0, 1].map(() =>
    tubeOf.map((tube): PresenceClass =>
      tube === absent ? "no_2d_support" : "supported",
    ),
  );
const CASES: Case[] = [
  {
    name: "a vessel removed from the frame, three segments long",
    scene: () => scene([TREE[0], TREE[1], TREE[3]]),
    expected: supportedUnless(2),
  },
  {
    name: "a vessel removed from the frame, one segment long",
    scene: () => scene(TREE.slice(0, 3)),
    expected: supportedUnless(3),
  },
  {
    name: "a vessel only in the frame",
    scene: () => scene([...TREE, aside]),
    expected: supportedUnless(-1),
    only_in_frame: aside,
  },
  {
    name: "a vessel outside the field",
    // A smaller field, centered higher: the foot of the trunk is below it.
    scene: () => scene(TREE, [AP, LAO60], [0, 0, 25], 120),
    expected: (s) =>
      s.planes.map((plane) =>
        segments.segments.map((_, index): PresenceClass => {
          let inside = 0,
            all = 0;
          segments.labels.forEach((label, i) => {
            if (label !== index) return;
            const [x, y] = reference(
              s,
              plane,
              Array.from(segments.points.subarray(3 * i, 3 * i + 3)),
            );
            all++;
            if (x >= 0 && y >= 0 && x <= FRAME.width && y <= FRAME.height)
              inside++;
          });
          // The case is built so that no segment is cut near its middle.
          expect(Math.abs(inside / all - 0.5)).toBeGreaterThan(0.3);
          return inside / all < 0.5 ? "outside_field" : "supported";
        }),
      ),
  },
];

describe("the synthetic gate: every segment classed as constructed", () => {
  it("has segments on every tube of the phantom", () => {
    expect(new Set(tubeOf)).toEqual(new Set([0, 1, 2, 3]));
    expect(tubeOf.filter((tube) => tube === 2)).toHaveLength(3);
    expect(tubeOf.filter((tube) => tube === 3)).toHaveLength(1);
  });

  describe.each(CASES)("$name", (entry) => {
    let made: Scene | undefined;
    const get = () => (made ??= entry.scene());

    function unmatched(s: Scene, matrix: number[][], planes = s.planes) {
      const result = vesselPresence({
        segments,
        isocenter: s.isocenter,
        matrix,
        planes,
      });
      result.planes.forEach((plane, at) => {
        const extra = entry.only_in_frame;
        if (!extra) return expect(plane.unmatched).toEqual([]);
        // One piece, along the vessel that is only in the frame and about
        // as long as it is there.
        expect(plane.unmatched).toHaveLength(1);
        const { target, view } = planes[at],
          path = extra.path.map((p) => reference(s, planes[at], p)),
          mm = mmPerFramePixel(view);
        let length = 0;
        for (let k = 1; k < path.length; k++)
          length +=
            Math.hypot(
              path[k][0] - path[k - 1][0],
              path[k][1] - path[k - 1][1],
            ) * mm;
        expect(
          Math.abs(plane.unmatched[0].length_mm - length) / length,
        ).toBeLessThan(0.1);
        for (const pixel of plane.unmatched[0].pixels) {
          const p = [
            ((pixel % target.width) + 0.5) * target.scale,
            (Math.floor(pixel / target.width) + 0.5) * target.scale,
            0,
          ];
          expect(
            Math.min(
              ...path
                .slice(1)
                .map((b, k) =>
                  axisDistance(p, [...path[k], 0] as Vec3, [...b, 0] as Vec3),
                ),
            ) * mm,
          ).toBeLessThan(2.5);
        }
      });
    }

    it("at the true pose", () => {
      const s = get(),
        expected = entry.expected(s);
      expect(classesOf(s, s.truth)).toEqual(expected);
      expect(expected.flat()).toContain("supported");
      unmatched(s, s.truth);
    });

    it("at the pose recovered from one plane", () => {
      const s = get(),
        matrix = fromOnePlane(s);
      // One plane leaves depth loose. The pose is not the true one.
      expect(poseError(matrix, s.truth)).toBeGreaterThan(1);
      expect(classesOf(s, matrix, [s.planes[0]])).toEqual([
        entry.expected(s)[0],
      ]);
      unmatched(s, matrix, [s.planes[0]]);
    }, 60_000);

    it("at the pose recovered from two planes", () => {
      const s = get(),
        matrix = fromTwoPlanes(s);
      expect(poseError(matrix, s.truth)).toBeLessThan(1);
      expect(classesOf(s, matrix)).toEqual(entry.expected(s));
      unmatched(s, matrix);
    }, 60_000);
  });

  it("classes every segment as supported when nothing is missing", () => {
    const s = scene(TREE),
      result = vesselPresence({
        segments,
        isocenter: s.isocenter,
        matrix: s.truth,
        planes: s.planes,
      });
    expect(result.method).toBe(VESSEL_PRESENCE_METHOD);
    expect(result.planes).toHaveLength(2);
    for (const plane of result.planes) {
      expect(plane.unmatched).toEqual([]);
      plane.segments.forEach((entry, index) => {
        expect(entry.class).toBe("supported");
        expect(entry.in_field).toBe(segments.segments[index].sample_count);
        expect(entry.clear).toBeLessThanOrEqual(entry.in_field);
        expect(entry.supported).toBeLessThanOrEqual(entry.clear);
        // Samples are left out only next to a branching.
        expect(entry.clear).toBeGreaterThanOrEqual(0.5 * entry.in_field);
      });
    }
  });
});

describe("what the classes cannot tell", () => {
  it("leaves a vessel seen end-on indeterminate whatever the frame shows", () => {
    // The lateral beam runs along the first leg of tube 1.
    const present = scene(TREE, [LATERAL]),
      absent = scene([TREE[0], TREE[2]], [LATERAL]),
      seen = classesOf(present, present.truth)[0],
      unseen = classesOf(absent, absent.truth)[0],
      endOn = seen.flatMap((found, index) =>
        found === "indeterminate" ? [index] : [],
      );
    expect(endOn.length).toBeGreaterThan(0);
    expect(endOn.map((index) => tubeOf[index])).toContain(1);
    for (const index of endOn) expect(unseen[index]).toBe("indeterminate");
    // Away from it the frame decides.
    tubeOf.forEach((tube, index) => {
      if (endOn.includes(index)) return;
      expect(seen[index]).toBe("supported");
      if (tube === 0 || tube === 2) expect(unseen[index]).toBe("supported");
    });
    expect(unseen).toContain("no_2d_support");
  });

  it("can lose a segment's support to a vessel that is only in the frame", () => {
    // In the LAO 30 view the vessel beside the tree lies over tube 3, and
    // the frame's centerline there follows the wider of the two.
    const alone = scene(TREE, [LAO30]),
      crossed = scene([...TREE, aside], [LAO30]),
      small = tubeOf.indexOf(3);
    expect(classesOf(alone, alone.truth)[0][small]).toBe("supported");
    expect(classesOf(crossed, crossed.truth)[0][small]).not.toBe("supported");
  });

  it("reads a wrong registration as missing and unmatched vessels", () => {
    const s = scene(TREE),
      wrong = rigid([4, -5, 7], [16, -7, 4], s.isocenter),
      result = vesselPresence({
        segments,
        isocenter: s.isocenter,
        matrix: wrong,
        planes: s.planes,
      });
    expect(poseError(wrong, s.truth)).toBeCloseTo(10, 6);
    for (const plane of result.planes) {
      expect(
        plane.segments.filter((entry) => entry.class === "no_2d_support")
          .length,
      ).toBeGreaterThan(segments.segments.length / 2);
      expect(plane.unmatched.length).toBeGreaterThan(0);
    }
  });
});

/** A hand-made frame of 256 pixels a side in which a quarter millimeter at
 * the isocenter is one pixel, with the centerline pixels given. */
const FLAT: ViewNumbers = {
  primary_deg: 0,
  secondary_deg: 0,
  source_detector_mm: 1600,
  source_isocenter_mm: 800,
  detector_width_mm: 128,
  detector_height_mm: 128,
};
const SIDE = 256;
function flatTarget(centerline: [number, number][]): VesselTarget {
  const distance = new Float32Array(SIDE * SIDE);
  for (let y = 0; y < SIDE; y++)
    for (let x = 0; x < SIDE; x++)
      distance[y * SIDE + x] = Math.min(
        96,
        ...centerline.map(([cx, cy]) => Math.hypot(cx - x, cy - y)),
      );
  return {
    width: SIDE,
    height: SIDE,
    scale: 1,
    distance,
    centerline: Int32Array.from(
      centerline.map(([x, y]) => y * SIDE + x),
    ).sort(),
  };
}
type Row = { run: number; points: number[][] };
function handMade(rows: Row[]): VesselSegments {
  return {
    segments: rows.map(({ run, points }, index) => ({
      index,
      length_mm: 5 * (points.length - 1),
      mean_radius_mm: 1,
      sample_count: points.length,
      run,
    })),
    points: Float32Array.from(rows.flatMap(({ points }) => points.flat())),
    labels: Int32Array.from(
      rows.flatMap(({ points }, index) => points.map(() => index)),
    ),
    unassigned_fraction: 0,
    pooling: 1,
  };
}
/** Ten samples 5 mm apart across the frame, moved by `shift` millimeters. */
const row = (shift: number[] = [0, 0, 0], count = 10) =>
  Array.from({ length: count }, (_, i) => [
    5 * i - 22.375 + shift[0],
    shift[1],
    0.125 + shift[2],
  ]);
function flat(
  rows: Row[],
  centerline: [number, number][],
  target = flatTarget(centerline),
) {
  return vesselPresence({
    segments: handMade(rows),
    isocenter: [0, 0, 0],
    matrix: identity,
    planes: [{ view: FLAT, frame: { width: SIDE, height: SIDE }, target }],
  }).planes[0];
}
/** Working-grid pixel of each sample of a row. */
function pixels(points: number[][]): [number, number][] {
  const projected = projectRegistered(
    FLAT,
    [0, 0, 0],
    identity,
    Float32Array.from(points.flat()),
    { width: SIDE, height: SIDE },
  );
  return points.map((_, k) => [
    projected[2 * k] - 0.5,
    projected[2 * k + 1] - 0.5,
  ]);
}

describe("the rules, on a hand-made frame", () => {
  const base = pixels(row());

  it("is built as intended: samples on pixel centers, 20 pixels apart", () => {
    base.forEach(([x, y], k) => {
      expect(x).toBeCloseTo(
        base[0][0] + 20 * k * Math.sign(base[1][0] - base[0][0]),
        3,
      );
      expect(y).toBeCloseTo(127, 3);
      expect(Math.abs(x - Math.round(x))).toBeLessThan(1e-3);
    });
    // 2 mm at the isocenter is 8 pixels.
    expect(LIMITS.support_mm / 0.25).toBe(8);
  });

  it.each([
    [10, "supported"],
    [7, "supported"],
    [6, "indeterminate"],
    [4, "indeterminate"],
    [3, "no_2d_support"],
    [0, "no_2d_support"],
  ] as const)("with %i of 10 samples supported is %s", (count, expected) => {
    // A centerline pixel far from every sample keeps the target non-empty.
    const found = flat(
      [{ run: 0, points: row() }],
      [...base.slice(0, count), [10, 10]],
    ).segments[0];
    expect(found).toEqual({
      class: expected,
      in_field: 10,
      clear: 10,
      supported: count,
    });
  });

  it("counts a centerline 2 mm away as support and one pixel more as none", () => {
    const at = (offset: number) =>
      flat(
        [{ run: 0, points: row() }],
        base.map(([x, y]): [number, number] => [x, y + offset]),
      ).segments[0];
    expect(at(8)).toMatchObject({ class: "supported", supported: 10 });
    expect(at(-8)).toMatchObject({ class: "supported", supported: 10 });
    expect(at(9)).toMatchObject({ class: "no_2d_support", supported: 0 });
    expect(at(-9)).toMatchObject({ class: "no_2d_support", supported: 0 });
  });

  it("puts a segment outside the field below half its samples inside", () => {
    // Each 5 mm moves the row by one sample past the edge of the frame.
    const moved = (mm: number) =>
      flat([{ run: 0, points: row([mm, 0, 0]) }], base).segments[0];
    const direction = Math.sign(base[1][0] - base[0][0]);
    expect(moved(direction * 25)).toMatchObject({ in_field: 6 });
    expect(moved(direction * 30).in_field).toBe(5);
    expect(moved(direction * 30).class).not.toBe("outside_field");
    expect(moved(direction * 35)).toMatchObject({
      class: "outside_field",
      in_field: 4,
    });
    expect(moved(direction * 200)).toEqual({
      class: "outside_field",
      in_field: 0,
      clear: 0,
      supported: 0,
    });
  });

  it("takes the frame's edge as inside and a point behind the source as outside", () => {
    // 32 mm from the axis is the edge of a 64 mm field.
    const edge = (x: number, y = 0) =>
      flat([{ run: 0, points: [[x, y, 0.125], ...row()] }], base).segments[0]
        .in_field;
    expect(edge(32)).toBe(11);
    expect(edge(-32)).toBe(11);
    expect(edge(32.01)).toBe(10);
    expect(edge(-32.01)).toBe(10);
    // Along the beam, behind the source and beyond the detector.
    const beam = camera(FLAT, [0, 0, 0]).d;
    for (const far of [-900, 900])
      expect(
        flat(
          [
            {
              run: 0,
              points: [beam.map((value) => value * far), ...row()],
            },
          ],
          base,
        ).segments[0].in_field,
      ).toBe(10);
  });

  it("leaves out samples that lie over another run", () => {
    const beam = camera(FLAT, [0, 0, 0]).d,
      behind = (count: number, mm: number) =>
        row(
          beam.map((value) => value * mm),
          count,
        );
    // Seven samples of another run behind the first seven: three are left,
    // which is enough to judge by.
    let found = flat(
      [
        { run: 0, points: row() },
        { run: 1, points: behind(7, 30) },
      ],
      base,
    );
    expect(found.segments[0]).toEqual({
      class: "supported",
      in_field: 10,
      clear: 3,
      supported: 3,
    });
    expect(found.segments[1]).toMatchObject({
      class: "indeterminate",
      in_field: 7,
      clear: 0,
    });
    // Eight behind: two are left, too few.
    found = flat(
      [
        { run: 0, points: row() },
        { run: 1, points: behind(8, 30) },
      ],
      base,
    );
    expect(found.segments[0]).toEqual({
      class: "indeterminate",
      in_field: 10,
      clear: 2,
      supported: 2,
    });
    // Another run counts however near it is in the volume.
    found = flat(
      [
        { run: 0, points: row() },
        { run: 1, points: behind(10, 1) },
      ],
      base,
    );
    expect(found.segments[0]).toMatchObject({ clear: 0 });
  });

  it("leaves out samples of one run that lie over each other 6 mm apart", () => {
    const beam = camera(FLAT, [0, 0, 0]).d,
      doubled = (mm: number) =>
        flat(
          [
            {
              run: 0,
              points: [
                ...row(),
                ...row(
                  beam.map((value) => value * mm),
                  10,
                ),
              ],
            },
          ],
          base,
        ).segments[0];
    expect(doubled(5.9)).toMatchObject({ in_field: 20, clear: 20 });
    expect(doubled(6)).toMatchObject({
      class: "indeterminate",
      in_field: 20,
      clear: 0,
    });
    // Two segments of one run are judged as one vessel would be.
    const split = flat(
      [
        { run: 0, points: row() },
        { run: 0, points: row(beam.map((value) => value * 5.9)) },
      ],
      base,
    );
    expect(split.segments[0]).toMatchObject({ clear: 10 });
    expect(split.segments[1]).toMatchObject({ clear: 10 });
  });

  it("needs three clear samples and three in ten of those in the field", () => {
    const beam = camera(FLAT, [0, 0, 0]).d,
      long = row([0, 0, 0], 10).concat(row([0, 0, 2], 10)),
      cover = (count: number) => [
        ...row(
          beam.map((value) => value * 30),
          10,
        ),
        ...row([0, 0, 2], 10)
          .slice(0, count - 10)
          .map((p) => p.map((value, a) => value + 30 * beam[a])),
      ];
    // Twenty samples in two rows 8 pixels apart: each supports the other's
    // centerline, so every clear sample is supported.
    const judged = (covered: number) =>
      flat(
        [
          { run: 0, points: long },
          { run: 1, points: cover(covered) },
        ],
        base,
      ).segments[0];
    expect(judged(14)).toMatchObject({ class: "supported", clear: 6 });
    expect(judged(15)).toMatchObject({ class: "indeterminate", clear: 5 });
  });

  it("lists unmatched centerline in pieces, longest first", () => {
    const line = (y: number, from: number, length: number) =>
      Array.from({ length }, (_, k): [number, number] => [from + k, y]);
    const found = flat(
      [{ run: 0, points: row() }],
      [
        ...base,
        // 20 pixels are 5 mm; 19 are not listed.
        ...line(30, 40, 20),
        ...line(60, 40, 19),
        ...line(200, 40, 100),
        // A diagonal step joins two stretches into one piece.
        ...line(230, 40, 12),
        ...line(231, 52, 12),
      ],
    );
    expect(found.unmatched.map((piece) => piece.length_mm)).toEqual([25, 6, 5]);
    expect(Array.from(found.unmatched[2].pixels)).toEqual(
      line(30, 40, 20).map(([x, y]) => y * SIDE + x),
    );
    expect(found.unmatched[1].pixels).toHaveLength(24);
    expect(found.segments[0]).toMatchObject({ class: "supported" });
  });

  it("matches centerline within 2 mm of a sample and no farther", () => {
    const beside = (offset: number) =>
      flat(
        [{ run: 0, points: row() }],
        [
          ...base,
          ...Array.from({ length: 200 }, (_, k): [number, number] => [
            28 + k,
            127 + offset,
          ]),
        ],
      ).unmatched;
    // Nine pixels off, the whole line is unmatched. Eight off, the pixel
    // opposite each sample is matched and what is left is too short.
    expect(beside(9).map((piece) => piece.length_mm)).toEqual([50]);
    expect(beside(8).map((piece) => piece.pixels.length)).toEqual([]);
    expect(beside(-8)).toEqual([]);
  });

  it("refuses input it cannot use", () => {
    const good = handMade([{ run: 0, points: row() }]),
      target = flatTarget(base),
      plane = { view: FLAT, frame: { width: SIDE, height: SIDE }, target },
      call = (change: Record<string, unknown>) => () =>
        vesselPresence({
          segments: good,
          isocenter: [0, 0, 0],
          matrix: identity,
          planes: [plane],
          ...change,
        } as never);
    expect(call({})).not.toThrow();
    for (const planes of [[], [plane, plane, plane], null])
      expect(call({ planes })).toThrow(new Error("Invalid presence input"));
    for (const labels of [
      Int32Array.from({ length: 10 }, () => 1),
      Int32Array.from({ length: 10 }, () => -1),
      new Int32Array(9),
    ])
      expect(call({ segments: { ...good, labels } })).toThrow(
        new Error("Invalid presence input"),
      );
    expect(call({ segments: { ...good, segments: [] } })).toThrow(
      new Error("Invalid presence input"),
    );
    for (const broken of [
      { ...target, distance: target.distance.slice(1) },
      { ...target, scale: 0 },
      { ...target, scale: Number.NaN },
      { ...target, width: 1 },
      { ...target, centerline: Int32Array.of(SIDE * SIDE) },
      { ...target, centerline: Int32Array.of(-1) },
    ])
      expect(call({ planes: [{ ...plane, target: broken }] })).toThrow(
        new Error("Invalid vessel target"),
      );
    expect(
      call({
        planes: [{ ...plane, view: { ...FLAT, detector_height_mm: 140 } }],
      }),
    ).toThrow(new Error("Detector pixels must be square"));
    // 2 mm is more working pixels than the distance map reaches.
    expect(
      call({
        planes: [
          {
            ...plane,
            view: {
              ...FLAT,
              detector_width_mm: 50,
              detector_height_mm: 50,
              source_isocenter_mm: 100,
              source_detector_mm: 2000,
            },
          },
        ],
      }),
    ).toThrow(new Error("Field too small for this frame"));
    expect(call({ matrix: [[1]] })).toThrow();
    expect(
      call({ planes: [{ ...plane, view: { ...FLAT, primary_deg: 500 } }] }),
    ).toThrow();
    expect(PRESENCE_CLASSES).toEqual([
      "supported",
      "no_2d_support",
      "outside_field",
      "indeterminate",
    ]);
  });
});
