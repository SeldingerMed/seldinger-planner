import { expect, it } from "vitest";
import {
  DEVICE_CATALOG,
  comparePlacement,
  planeClearance,
  resolveCoilPrimaryDiameterMm,
  type DeviceSpec,
  type PlanningAnatomy,
} from "./analysis";
import type { Placement } from "./scenarios";

const coilPlacement: Placement = {
  deviceId: "test-coil",
  diameter: 6,
  length: 20,
  height: 4,
  center: [0, 0, 0],
  axis: [0, 0, 1],
  path: [],
  offset: 0,
  roll: 0,
  coilLength: 40,
  braidAngle: 55,
};
function coilDevice(overrides: Partial<DeviceSpec> = {}): DeviceSpec {
  return {
    id: "test-coil",
    name: "Test coil",
    manufacturer: "Test",
    category: "coil",
    usStatus: "US-cleared family",
    shape: "helical",
    wireCount: null,
    displayWireCount: 1,
    sizeCoverage: "synthetic fixture",
    wireCountBasis: "test",
    sizes: [
      {
        diameterMm: 6,
        lengthMm: 20,
        heightMm: null,
        primaryDiameterMm: 0.27,
        sku: "TC-6-20",
      },
      {
        diameterMm: 6,
        lengthMm: 40,
        heightMm: null,
        primaryDiameterMm: 0.3,
        sku: "TC-6-40",
      },
    ],
    construction: "",
    appearance: "",
    modelLimits: "",
    sources: [],
    warning: null,
    ...overrides,
  };
}
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
it("resolves primary diameter only from the exact SKU diameter+length match", () => {
  // Exact match on both diameter and length.
  expect(
    resolveCoilPrimaryDiameterMm(coilDevice(), {
      ...coilPlacement,
      diameter: 6,
      coilLength: 40,
    }),
  ).toBe(0.3);
  expect(
    resolveCoilPrimaryDiameterMm(coilDevice(), {
      ...coilPlacement,
      diameter: 6,
      coilLength: 20,
    }),
  ).toBe(0.27);
  // Same-diameter but mismatched-length SKU must NOT fall back to the other SKU.
  expect(
    resolveCoilPrimaryDiameterMm(coilDevice(), {
      ...coilPlacement,
      diameter: 6,
      coilLength: 30,
    }),
  ).toBeNull();
  // Explicit usable device-level value is used when no SKU matches.
  expect(
    resolveCoilPrimaryDiameterMm(coilDevice({ primaryDiameterMm: 0.25 }), {
      ...coilPlacement,
      diameter: 6,
      coilLength: 30,
    }),
  ).toBe(0.25);
  // Non-usable device-level values are never used.
  for (const bad of [undefined, 0, -0.2, Number.NaN, Infinity])
    expect(
      resolveCoilPrimaryDiameterMm(coilDevice({ primaryDiameterMm: bad }), {
        ...coilPlacement,
        diameter: 6,
        coilLength: 30,
      }),
    ).toBeNull();
});

it("suppresses coil volume and density when real coil data is missing", () => {
  const catalog = DEVICE_CATALOG.devices.find((d) => d.id === "target-360")!;
  const report = comparePlacement(catalog, coilPlacement, {
    ...anatomy,
    sacVolume: 50,
  });
  expect(report.metrics.map((m) => m.label)).not.toContain("Coil wire volume");
  expect(report.metrics.map((m) => m.label)).not.toContain(
    "Packing volume density",
  );
});

it("computes coil wire volume and packing density from a declared primary diameter", () => {
  const device = coilDevice({
    sizes: [
      {
        diameterMm: 6,
        lengthMm: 40,
        heightMm: null,
        primaryDiameterMm: 0.3,
        sku: "TC-6-40",
      },
    ],
  });
  const sacVolume = 1234.5;
  const report = comparePlacement(device, coilPlacement, {
    ...anatomy,
    sacVolume,
  });
  const volume = report.metrics.find((m) => m.label === "Coil wire volume");
  expect(volume).toBeDefined();
  const expected = Math.PI * Math.pow(0.3 / 2, 2) * 40;
  expect(volume!.value).toBeCloseTo(expected, 9);
  expect(volume!.unit).toBe("mm³");
  const density = report.metrics.find(
    (m) => m.label === "Packing volume density",
  );
  expect(density).toBeDefined();
  expect(density!.value).toBeCloseTo((expected / sacVolume) * 100, 9);
  expect(density!.unit).toBe("%");
  // No finite positive sac volume -> density suppressed, volume kept.
  const noVol = comparePlacement(device, coilPlacement, {
    ...anatomy,
    sacVolume: null,
  });
  expect(
    noVol.metrics.find((m) => m.label === "Coil wire volume"),
  ).toBeDefined();
  expect(
    noVol.metrics.find((m) => m.label === "Packing volume density"),
  ).toBeUndefined();
});

it("suppresses nonfinite or nonpositive physical inputs instead of rendering numeric artifacts", () => {
  const device = coilDevice({ sizes: [], primaryDiameterMm: 0.3 });
  for (const value of [Infinity, Number.NaN, 0, -1]) {
    expect(
      comparePlacement(device, coilPlacement, {
        ...anatomy,
        sacVolume: value,
      }).metrics.find((m) => m.label === "Packing volume density"),
    ).toBeUndefined();
    expect(
      comparePlacement(
        device,
        { ...coilPlacement, coilLength: value },
        anatomy,
      ).metrics.find((m) => m.label === "Coil wire volume"),
    ).toBeUndefined();
  }
  expect(
    comparePlacement(
      coilDevice({ sizes: [], primaryDiameterMm: 1e308 }),
      coilPlacement,
      anatomy,
    ).metrics.find((m) => m.label === "Coil wire volume"),
  ).toBeUndefined();
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
