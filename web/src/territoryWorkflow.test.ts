import { expect, test } from "vitest";
import producer from "./__fixtures__/territory-tavr.json";
import { parseWorkflow, stable } from "./territoryWorkflow";
const identity = {
  case_id: producer.case_id,
  image_sha256: producer.image_sha256,
  artifact_version: producer.artifact_version,
  reference_revision: producer.reference_revision,
};
test("actual default-app synthetic TAVR producer passes without field adapters", () => {
  const result = parseWorkflow(producer, identity, "tavr");
  expect(result.current.status).toBe("current");
  if (result.current.status === "current")
    expect(result.current.result.left_coronary_height_mm).toBe(5);
});
test.each([
  (x: typeof producer) => {
    x.reference_revision = "a".repeat(64);
  },
  (x: typeof producer) => {
    x.current.dependencies.artifact_version = "99";
  },
  (x: typeof producer) => {
    x.current.result.area_mm2 = NaN;
  },
  (x: typeof producer) => {
    x.current.result.left_coronary_height_mm = Infinity;
  },
  (x: typeof producer) => {
    (x.current as unknown as Record<string, unknown>).status = "mystery";
  },
  (x: typeof producer) => {
    delete (x.current.result as Partial<typeof x.current.result>)
      .left_coronary_height_mm;
  },
])(
  "rejects contradictory identity, status and measurements as a whole",
  (mutate) => {
    const value = structuredClone(producer);
    mutate(value);
    expect(() => parseWorkflow(value, identity, "tavr")).toThrow();
  },
);
test("empty/stale shapes suppress outputs rather than parse fake numbers", () => {
  expect(
    parseWorkflow(
      {
        ...identity,
        mode: "tavr",
        workflow_revision: 0,
        current: { status: "not_computed" },
      },
      identity,
      "tavr",
    ).current.status,
  ).toBe("not_computed");
  expect(
    parseWorkflow(
      {
        ...identity,
        mode: "tavr",
        workflow_revision: 1,
        current: {
          status: "stale",
          result_id: producer.current.result_id,
          inputs: null,
          result: null,
        },
      },
      identity,
      "tavr",
    ).current.status,
  ).toBe("stale");
  expect(() =>
    parseWorkflow(
      {
        ...producer,
        current: { status: "not_computed", result: producer.current.result },
      },
      identity,
      "tavr",
    ),
  ).toThrow();
});
test("structural comparison ignores object insertion order but not input values", () => {
  expect(stable({ b: [1, 2], a: 3 })).toBe(stable({ a: 3, b: [1, 2] }));
  expect(stable({ a: 3 })).not.toBe(stable({ a: 4 }));
});
