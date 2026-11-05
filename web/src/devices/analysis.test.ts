import { expect, it } from "vitest";
import {
  DEVICE_CATALOG,
  comparePlacement,
  planeClearance,
  type PlanningAnatomy,
} from "./analysis";
const anatomy: PlanningAnatomy = {
  path: [
    [0, 0, 0],
    [0, 0, 30],
  ],
  sacWidth: 6,
  sacHeight: 5,
  neckWidth: 4,
  proximalDiameter: 3,
  distalDiameter: 3.5,
  sacVolume: null,
  geometryResultId: "g",
};
it("checks the actual modeled envelope against an operator neck plane, oriented by the sac seed", () => {
  const points: [number, number, number][] = [
    [1, 2, 2],
    [1, 2, 5],
  ];
  expect(planeClearance(points, [1, 2, 3], [0, 0, 2], [1, 2, 4])).toEqual({
    minimumMm: -1,
    maximumMm: 2,
  });
  expect(planeClearance(points, [1, 2, 3], [0, 0, -2], [1, 2, 4])).toEqual({
    minimumMm: -1,
    maximumMm: 2,
  });
  expect(planeClearance(points, [1, 2, 3], [0, 0, 1], [1, 2, 3])).toBeNull();
});
it("models each requested family separately and never promotes recalled references", () => {
  for (const d of DEVICE_CATALOG.devices.filter((d) => d.category !== "coil"))
    expect(d.displayWireCount).toBeGreaterThan(0);
  expect(
    DEVICE_CATALOG.devices.find((d) => d.id === "surpass-elite")!.sizeCoverage,
  ).toMatch(/subset/i);
  expect(
    DEVICE_CATALOG.devices.filter((d) => d.category === "coil"),
  ).toHaveLength(2);
  expect(
    DEVICE_CATALOG.devices
      .filter((d) => d.id.startsWith("web-"))
      .flatMap((d) => d.sizes),
  ).toHaveLength(37);
  const d = DEVICE_CATALOG.devices.find(
    (d) => d.id === "pipeline-vantage-027",
  )!;
  const report = comparePlacement(
    d,
    {
      deviceId: d.id,
      diameter: 4.5,
      length: 25,
      height: 4,
      center: [0, 0, 0],
      axis: [0, 0, 1],
      path: anatomy.path,
      offset: 0,
      roll: 0,
      coilLength: 100,
    },
    anatomy,
  );
  expect(report.blocked).toBe(true);
  expect(report.outcomeProbability).toBeNull();
  expect(report.flowReduction).toBeNull();
  expect(report.notes.join(" ")).toMatch(/FDA/);
});
