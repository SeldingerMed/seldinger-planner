import { expect, it } from "vitest";
import { restoreScenarios, saveScenario, type SceneBinding } from "./scenarios";
const binding: SceneBinding = {
  caseId: "case-a",
  imageSha: "a".repeat(64),
  artifactVersion: "3",
  referenceRevision: "b".repeat(64),
  geometryResultId: "geometry-1",
};
it("isolates saved placements and refuses stale anatomy on reopening", () => {
  const point: [number, number, number] = [1, 2, 3];
  const draft = {
    deviceId: "fd",
    diameter: 4,
    length: 20,
    height: 4,
    center: point,
    axis: [0, 0, 1] as [number, number, number],
    path: [
      [0, 0, 0],
      [0, 0, 25],
    ] as [number, number, number][],
    offset: 0,
    roll: 0,
    coilLength: 100,
  };
  const saved = saveScenario([], binding, draft, "Plan A");
  point[0] = 99;
  expect(saved[0].placement.center[0]).toBe(1);
  expect(restoreScenarios(JSON.stringify(saved), binding)).toHaveLength(1);
  expect(
    restoreScenarios(JSON.stringify(saved), {
      ...binding,
      geometryResultId: "geometry-2",
    }),
  ).toHaveLength(0);
  expect(
    restoreScenarios(
      JSON.stringify(
        saved.map((s) => ({ ...s, modelVersion: "procedural-device-v1" })),
      ),
      binding,
    ),
  ).toHaveLength(0);
  expect(restoreScenarios('{"bad":true}', binding)).toEqual([]);
  expect(
    restoreScenarios(
      JSON.stringify(saved),
      Object.fromEntries(Object.entries(binding).reverse()) as SceneBinding,
    ),
  ).toHaveLength(1);
  expect(
    restoreScenarios(
      JSON.stringify(
        saved.map((s) => ({
          ...s,
          placement: { ...s.placement, braidAngle: "bad" },
        })),
      ),
      binding,
    ),
  ).toHaveLength(0);
});
