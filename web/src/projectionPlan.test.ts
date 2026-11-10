import { expect, test } from "vitest";
import plans from "./__fixtures__/step-a-projection-plans.json";
import seriesFixtures from "./__fixtures__/step-a-projection-series.json";
import {
  parsePlan,
  parseProjectionSeries,
  planeToView,
} from "./projectionPlan";
import type { Identity } from "./territoryWorkflow";

const identity = (value: Identity): Identity => ({
  case_id: value.case_id,
  image_sha256: value.image_sha256,
  artifact_version: value.artifact_version,
  reference_revision: value.reference_revision,
});
const current = () => structuredClone(plans.current);

test.each(Object.entries(plans))(
  "parses the actual default API %s plan",
  (_, value) => {
    const plan = parsePlan(value, identity(value));
    expect(plan.current.status).toBe(value.current.status);
    expect(plan.plan_revision).toBe(value.plan_revision);
  },
);

test("the captured plan carries the known AP and lateral foreshortening", () => {
  const plan = parsePlan(plans.current, identity(plans.current));
  if (plan.current.status !== "current") throw new Error("fixture");
  const byName = Object.fromEntries(
    plan.current.result.views.map((view) => [view.name, view]),
  );
  // Target: 5 mm left-right leg then 5 mm anterior leg. AP sees only the
  // first, a left lateral sees only the second.
  expect(byName.AP.foreshortening_percent).toBeCloseTo(50, 9);
  expect(byName.Lateral.foreshortening_percent).toBeCloseTo(50, 9);
  expect(byName.AP.magnification_at_isocenter).toBe(1.6);
});

test.each<[string, (value: ReturnType<typeof current>) => void]>([
  ["foreign case", (v) => (v.case_id = "x".repeat(22))],
  ["extra key", (v) => Object.assign(v, { extra: 1 })],
  ["zero revision", (v) => (v.plan_revision = 0)],
  ["fractional revision", (v) => (v.plan_revision = 1.5)],
  ["bad plan id", (v) => (v.current.plan_id = "short")],
  ["foreign dependency", (v) => (v.current.dependencies.version = "other")],
  ["bad digest", (v) => (v.current.input_sha256 = "zz")],
  [
    "forged foreshortening",
    (v) => (v.current.result.views[0].foreshortening_percent = 0),
  ],
  [
    "forged field flag",
    (v) => (v.current.result.views[0].target_in_field = false),
  ],
  [
    "forged magnification",
    (v) => (v.current.result.views[0].magnification_at_isocenter = 2),
  ],
  ["forged length", (v) => (v.current.result.target_length_mm = 11)],
  ["forged count", (v) => (v.current.result.target_point_count = 2)],
  ["foreign convention", (v) => (v.current.result.convention = "other")],
  ["result view renamed", (v) => (v.current.result.views[0].name = "Other")],
  [
    "result angle differs from input",
    (v) => (v.current.result.views[1].primary_deg = 31),
  ],
  ["dropped result view", (v) => v.current.result.views.pop()],
  ["unconfirmed", (v) => ((v.current.inputs.confirmed as boolean) = false)],
  [
    "duplicate names",
    (v) => (v.current.inputs.views[1].name = v.current.inputs.views[0].name),
  ],
  ["markdown in name", (v) => (v.current.inputs.views[0].name = "# AP")],
  ["angle out of bounds", (v) => (v.current.inputs.views[0].primary_deg = 181)],
  [
    "isocenter outside the beam",
    (v) => (v.current.inputs.views[0].source_isocenter_mm = 1200),
  ],
  [
    "repeated target point",
    (v) => (v.current.inputs.target_path[1] = v.current.inputs.target_path[0]),
  ],
  ["short isocenter", (v) => v.current.inputs.isocenter.pop()],
  ["no views", (v) => (v.current.inputs.views = [])],
])("rejects a contradictory current plan: %s", (_name, mutate) => {
  const value = current();
  mutate(value);
  expect(() => parsePlan(value, identity(plans.current))).toThrow();
});

test("absent and stale plans cannot carry values", () => {
  const absent = structuredClone(plans.not_confirmed);
  expect(() =>
    parsePlan({ ...absent, plan_revision: 1 }, identity(absent)),
  ).toThrow();
  expect(() =>
    parsePlan(
      { ...absent, current: { status: "not_confirmed", inputs: null } },
      identity(absent),
    ),
  ).toThrow();
  const stale = structuredClone(plans.stale);
  expect(() =>
    parsePlan(
      {
        ...stale,
        current: { ...stale.current, inputs: plans.current.current.inputs },
      },
      identity(stale),
    ),
  ).toThrow();
  expect(() =>
    parsePlan(
      { ...stale, current: { ...stale.current, status: "unknown" } },
      identity(stale),
    ),
  ).toThrow();
});

test("parses the real converter biplane manifest and maps planes to views", () => {
  const series = parseProjectionSeries(
    seriesFixtures.biplane,
    "synthetic-biplane",
  );
  expect(series.biplane_linkage).toBe("cross_referenced");
  expect(series.planes.map((plane) => plane.plane)).toEqual(["a", "b"]);
  // 1024 x 1024 stored pixels at 0.2 mm imager spacing is a 204.8 mm field.
  expect(planeToView(series.planes[0])).toEqual({
    primary_deg: -30.5,
    secondary_deg: 20.25,
    source_detector_mm: 1195,
    source_isocenter_mm: 765,
    detector_width_mm: 204.8,
    detector_height_mm: 204.8,
  });
  expect(planeToView(series.planes[1])?.primary_deg).toBe(90);
});

test("an uncalibrated plane is parsed but never becomes a view", () => {
  const series = parseProjectionSeries(
    seriesFixtures.uncalibrated,
    "synthetic-rotation",
  );
  expect(series.planes[0].calibration).toEqual({
    status: "uncalibrated",
    missing: ["imager_pixel_spacing", "static_positioner"],
  });
  expect(planeToView(series.planes[0])).toBeNull();
  // A calibrated plane whose field is outside the planning bounds is refused.
  const tiny = structuredClone(seriesFixtures.biplane);
  tiny.manifest.planes[0].rows = 8;
  expect(
    planeToView(parseProjectionSeries(tiny, "synthetic-biplane").planes[0]),
  ).toBeNull();
});

type Series = typeof seriesFixtures.biplane;
test.each<[string, (value: Series) => void]>([
  ["wrong source", (v) => (v.source_id = "other")],
  ["bad revision", (v) => (v.manifest_revision = "abc")],
  ["pixels retained", (v) => ((v.manifest.pixels_retained as boolean) = true)],
  [
    "clinical claim",
    (v) => ((v.manifest.clinical_validation as boolean) = true),
  ],
  ["unlinked biplane", (v) => (v.manifest.biplane_linkage = "not_applicable")],
  ["reordered planes", (v) => v.manifest.planes.reverse()],
  [
    "forged calibration",
    (v) => {
      (v.manifest.planes[0].imager_pixel_spacing_mm as unknown) = null;
    },
  ],
  [
    "missing term not declared",
    (v) => {
      v.manifest.planes[0].positioner_motion = "dynamic";
    },
  ],
  [
    "inconsistent distances",
    (v) => (v.manifest.planes[0].source_isocenter_mm = 1195),
  ],
  ["angle out of range", (v) => (v.manifest.planes[0].primary_angle_deg = 200)],
  ["extra plane key", (v) => Object.assign(v.manifest.planes[0], { extra: 1 })],
  ["extra manifest key", (v) => Object.assign(v.manifest, { extra: 1 })],
])("rejects a contradictory projection series: %s", (_name, mutate) => {
  const value = structuredClone(seriesFixtures.biplane);
  mutate(value);
  expect(() => parseProjectionSeries(value, "synthetic-biplane")).toThrow();
});
