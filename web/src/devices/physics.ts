/** Thin wire-screen pressure model, Abdehkakha et al.2021 Eq.1.
 * Local constitutive relation only, NOT a CFD solution or calibrated device efficacy.
 * DOI10.1016/j.compbiomed.2021.104988; PMC9372908 MathML M3 verified.
 */
type Screen = {
  porosity: number;
  hydraulicDiameterMm: number;
  densityKgM3: number;
  viscosityPas: number;
};
function coefficients(p: Screen) {
  if (
    ![p.porosity, p.hydraulicDiameterMm, p.densityKgM3, p.viscosityPas].every(
      Number.isFinite,
    ) ||
    p.porosity <= 0 ||
    p.porosity >= 1 ||
    p.hydraulicDiameterMm <= 0 ||
    p.hydraulicDiameterMm > 5 ||
    p.densityKgM3 <= 0 ||
    p.densityKgM3 > 3000 ||
    p.viscosityPas <= 0 ||
    p.viscosityPas > 1
  )
    throw new Error("Invalid thin-screen inputs");
  return {
    a: (11 * p.viscosityPas) / (p.hydraulicDiameterMm * 1e-3),
    b:
      (p.densityKgM3 / 2) *
      (1.3 * (1 - p.porosity) + (1 / p.porosity - 1) ** 2),
  };
}
export function screenPressureDrop(p: Screen & { velocityMps: number }) {
  const { a, b } = coefficients(p);
  if (!Number.isFinite(p.velocityMps) || p.velocityMps < 0 || p.velocityMps > 2)
    throw new Error("Unsupported normal screen velocity");
  const viscousPa = a * p.velocityMps,
    inertialPa = b * p.velocityMps ** 2;
  return {
    viscousPa,
    inertialPa,
    totalPa: viscousPa + inertialPa,
    model: "local-thin-screen-Idelchik-v1",
    clinicalOutcome: null,
  };
}
export function screenVelocity(p: Screen & { pressureDropPa: number }) {
  const { a, b } = coefficients(p);
  if (
    !Number.isFinite(p.pressureDropPa) ||
    p.pressureDropPa < 0 ||
    p.pressureDropPa > 1e5
  )
    throw new Error("Unsupported pressure drop");
  return (
    (2 * p.pressureDropPa) / (a + Math.sqrt(a * a + 4 * b * p.pressureDropPa))
  );
}
export function coilPacking(
  diameterMm: number,
  lengthMm: number,
  sacVolumeMm3: number,
) {
  if (
    ![diameterMm, lengthMm, sacVolumeMm3].every(Number.isFinite) ||
    diameterMm <= 0 ||
    diameterMm > 1 ||
    lengthMm <= 0 ||
    lengthMm > 10000 ||
    sacVolumeMm3 <= 0
  )
    throw new Error(
      "Explicit positive coil diameter, length and sac volume required",
    );
  const primaryCoilVolumeMm3 = (Math.PI * diameterMm ** 2 * lengthMm) / 4;
  return {
    primaryCoilVolumeMm3,
    packingFraction: primaryCoilVolumeMm3 / sacVolumeMm3,
    clinicalOutcome: null,
  };
}
export function braidForeshortening(p: {
  nominalDiameterMm: number;
  nominalLengthMm: number;
  turns: number;
  expandedDiameterMm: number;
}) {
  if (!Object.values(p).every((v) => Number.isFinite(v) && v > 0 && v < 1000))
    throw new Error("Invalid ideal helix");
  const wireLengthMm = Math.hypot(
    p.nominalLengthMm,
    Math.PI * p.nominalDiameterMm * p.turns,
  );
  const squared =
    wireLengthMm ** 2 - (Math.PI * p.expandedDiameterMm * p.turns) ** 2;
  if (squared <= 0) throw new Error("Impossible inextensible helix expansion");
  return {
    wireLengthMm,
    deployedLengthMm: Math.sqrt(squared),
    model: "ideal-inextensible-helix-not-calibrated-device-mechanics",
  };
}
