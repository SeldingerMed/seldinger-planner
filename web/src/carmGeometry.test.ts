import { expect, test } from "vitest";
import vectors from "./__fixtures__/carm-geometry-vectors.json";
import {
  CARM_CONVENTION,
  angleLabel,
  camera,
  foreshorteningFraction,
  project,
  proposeLowForeshorteningAngles,
  summarizeView,
  validateView,
  viewFrame,
  type ViewNumbers,
} from "./carmGeometry";
import type { Vec3 } from "./obliqueSlice";

const VIEW: ViewNumbers = {
  primary_deg: 0,
  secondary_deg: 0,
  source_detector_mm: 1200,
  source_isocenter_mm: 750,
  detector_width_mm: 200,
  detector_height_mm: 200,
};
const near = (
  actual: readonly number[],
  expected: readonly number[],
  digits = 8,
) =>
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], digits));

test("the fixture convention is the implemented convention", () => {
  expect(vectors.convention).toBe(CARM_CONVENTION);
  expect(vectors.cases.length).toBeGreaterThanOrEqual(8);
});

test.each(vectors.cases.map((c) => [c.name, c] as const))(
  "matches the independent NumPy vectors: %s",
  (_name, c) => {
    const frame = viewFrame(c.view.primary_deg, c.view.secondary_deg);
    near(frame.u, c.frame.u);
    near(frame.v, c.frame.v);
    near(frame.d, c.frame.d);
    const cam = camera(c.view, c.isocenter);
    near(cam.source, c.source);
    c.path.forEach((p, i) => near(project(cam, p), c.projected[i], 7));
    const summary = summarizeView(c.view, c.isocenter, c.path);
    expect(summary.foreshortening_percent).toBeCloseTo(
      c.foreshortening_percent,
      8,
    );
    expect(summary.magnification_at_isocenter).toBe(
      c.magnification_at_isocenter,
    );
    expect(summary.target_in_field).toBe(c.target_in_field);
  },
);

test("hand-computed anchors: patient left lands on image right, magnified", () => {
  const cam = camera(VIEW, [0, 0, 0]);
  near(project(cam, [-10, 0, 0]), [16, 0, 750]);
  near(project(cam, [0, 0, 5]), [0, 8, 750]);
  near(project(cam, [-10, 10, 0]), [(10 * 1200) / 760, 0, 760]);
  expect(
    foreshorteningFraction(
      [
        [0, 0, 0],
        [3, 4, 0],
      ],
      [0, 1, 0],
    ),
  ).toBeCloseTo(0.4, 12);
  expect(angleLabel(30, 20)).toBe("LAO 30.0 / CRA 20.0");
  expect(angleLabel(-45.25, -10)).toBe("RAO 45.3 / CAU 10.0");
  expect(angleLabel(0, 0)).toBe("LAO/RAO 0.0 / CRA/CAU 0.0");
});

test.each([
  { primary_deg: 181 },
  { secondary_deg: -91 },
  { primary_deg: Number.NaN },
  { source_detector_mm: 299 },
  { source_isocenter_mm: 1200 },
  { source_isocenter_mm: 1199.5 },
  { detector_width_mm: 0 },
  { detector_height_mm: 601 },
  { primary_deg: "30" as unknown as number },
])("rejects unbounded or contradictory views %#", (change) => {
  expect(() => validateView({ ...VIEW, ...change })).toThrow();
});

test("points at or behind the source are refused", () => {
  const cam = camera(VIEW, [0, 0, 0]);
  expect(() => project(cam, [0, -750, 0])).toThrow();
  expect(() => project(cam, [0, -900, 0])).toThrow();
  expect(() => project(cam, [0, Number.NaN, 0])).toThrow();
});

test("the proposal finds a perpendicular view with the least angulation", () => {
  // A segment along the anterior axis is end-on in AP and needs a lateral
  // view. Views within 0.5 percentage points of the minimum are tied, and
  // 1 - cos(t) <= 0.005 holds up to t = 5.7 degrees, so the least-angulated
  // whole-degree view is 85 degrees lateral, at 1 - cos(5 deg) = 0.38 percent.
  const anterior = proposeLowForeshorteningAngles([
    [0, -10, 0],
    [0, 10, 0],
  ]);
  expect(Math.abs(anterior.primary_deg)).toBe(85);
  expect(anterior.secondary_deg).toBe(0);
  expect(anterior.foreshortening_percent).toBeCloseTo(
    100 * (1 - Math.cos((5 * Math.PI) / 180)),
    9,
  );
  // A left-right segment is already in profile at AP.
  expect(
    proposeLowForeshorteningAngles([
      [-10, 0, 0],
      [10, 0, 0],
    ]),
  ).toEqual({ primary_deg: 0, secondary_deg: 0, foreshortening_percent: 0 });
  // An oblique segment: the proposal must be perpendicular to it.
  const segment: Vec3 = [3, -7, 5];
  const oblique = proposeLowForeshorteningAngles([[0, 0, 0], segment]);
  const d = viewFrame(oblique.primary_deg, oblique.secondary_deg).d;
  const cosine =
    (d[0] * segment[0] + d[1] * segment[1] + d[2] * segment[2]) /
    Math.hypot(...segment);
  expect(oblique.foreshortening_percent).toBeLessThan(0.5);
  expect(1 - Math.sqrt(1 - cosine * cosine)).toBeCloseTo(
    oblique.foreshortening_percent / 100,
    9,
  );
  expect(() => proposeLowForeshorteningAngles([[0, 0, 0]])).toThrow();
});
