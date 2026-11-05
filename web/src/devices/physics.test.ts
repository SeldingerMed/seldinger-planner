import { expect, it } from "vitest";
import {
  screenPressureDrop,
  screenVelocity,
  coilPacking,
  braidForeshortening,
} from "./physics";
it("computes primary-coil volume only from explicit dimensions and preserves ideal braid wire length", () => {
  const p = coilPacking(0.25, 100, 100);
  expect(p.packingFraction).toBeCloseTo((Math.PI * 0.25 ** 2) / 4);
  expect(p.clinicalOutcome).toBeNull();
  const a = braidForeshortening({
    nominalDiameterMm: 4,
    nominalLengthMm: 20,
    turns: 2,
    expandedDiameterMm: 4.5,
  });
  expect(a.deployedLengthMm).toBeLessThan(20);
  expect(Math.hypot(a.deployedLengthMm, Math.PI * 4.5 * 2)).toBeCloseTo(
    a.wireLengthMm,
  );
  expect(() => coilPacking(0, 100, 100)).toThrow();
});
it("reproduces the primary-paper thin-screen equation in SI units and inverts it", () => {
  const input = {
    porosity: 0.75,
    hydraulicDiameterMm: 0.12,
    velocityMps: 0.05,
    densityKgM3: 1060,
    viscosityPas: 0.0035,
  };
  const r = screenPressureDrop(input);
  expect(r.viscousPa).toBeCloseTo(16.0416666667, 8);
  expect(r.inertialPa).toBeCloseTo(0.5778472222, 8);
  expect(screenVelocity({ ...input, pressureDropPa: r.totalPa })).toBeCloseTo(
    0.05,
    10,
  );
  expect(() => screenPressureDrop({ ...input, porosity: 1 })).toThrow();
});
