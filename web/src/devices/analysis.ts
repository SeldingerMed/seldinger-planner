import catalog from "./catalog.json";
import type { Placement, Triple } from "./scenarios";
/** Signed clearance of sampled MODEL vertices from the operator plane. Not lumen collision or patency. */
export function planeClearance(
  points: Triple[],
  origin: Triple,
  normal: Triple,
  sacSeed: Triple,
) {
  const all = [origin, normal, sacSeed, ...points];
  if (
    !points.length ||
    points.length > 120000 ||
    all.some((p) => p.length !== 3 || !p.every(Number.isFinite))
  )
    return null;
  const magnitude = Math.hypot(...normal);
  if (magnitude < 1e-9) return null;
  const signed = (p: Triple) =>
    p.reduce((s, v, k) => s + ((v - origin[k]) * normal[k]) / magnitude, 0);
  const orientation = signed(sacSeed);
  if (Math.abs(orientation) < 1e-6) return null;
  let minimumMm = Infinity,
    maximumMm = -Infinity;
  for (const point of points) {
    const distance = signed(point) * Math.sign(orientation);
    minimumMm = Math.min(minimumMm, distance);
    maximumMm = Math.max(maximumMm, distance);
  }
  return { minimumMm, maximumMm };
}
export type DeviceSpec = {
  id: string;
  name: string;
  manufacturer: string;
  category: string;
  usStatus: string;
  shape: string;
  wireCount: number | null;
  displayWireCount: number;
  primaryDiameterMm?: number;
  sizeCoverage: string;
  wireCountBasis: string;
  sizes: {
    diameterMm: number;
    lengthMm: number | null;
    heightMm: number | null;
    primaryDiameterMm?: number;
    sku: string | null;
    catheter?: string;
    minimumIdInch?: number;
  }[];
  construction: string;
  appearance: string;
  modelLimits: string;
  sources: { url: string; section: string }[];
  warning: string | null;
};
export const DEVICE_CATALOG = catalog as {
  catalogVersion: string;
  verifiedDate: string;
  purpose: string;
  devices: DeviceSpec[];
};
export type PlanningAnatomy = {
  path: Triple[];
  sacWidth: number | null;
  sacHeight: number | null;
  neckWidth: number | null;
  proximalDiameter: number | null;
  distalDiameter: number | null;
  sacVolume: number | null;
  geometryResultId: string;
  center?: Triple;
  neckOrigin?: Triple;
  axis?: Triple;
};
export function pathLength(path: Triple[]) {
  return path
    .slice(1)
    .reduce((n, p, i) => n + Math.hypot(...p.map((x, k) => x - path[i][k])), 0);
}
export const referenceOnly = (d: DeviceSpec) =>
  /reference only/i.test(d.usStatus);
export function resolveCoilPrimaryDiameterMm(
  device: DeviceSpec,
  p: Placement,
): number | null {
  const exact = device.sizes.find(
    (s) =>
      Math.abs(s.diameterMm - p.diameter) < 1e-6 &&
      s.lengthMm !== null &&
      Math.abs(s.lengthMm - p.coilLength) < 1e-6,
  );
  // Only an exact SKU diameter+length match resolves a per-SKU primary
  // diameter. A same-diameter SKU with a different length is a different
  // SKU and must never be substituted. The device-level value is used only
  // when the manufacturer declares one usable primary diameter.
  const candidate = exact?.primaryDiameterMm ?? device.primaryDiameterMm;
  return typeof candidate === "number" &&
    Number.isFinite(candidate) &&
    candidate > 0
    ? candidate
    : null;
}
export function comparePlacement(
  device: DeviceSpec,
  p: Placement,
  a: PlanningAnatomy | null,
) {
  const notes: string[] = [],
    metrics: { label: string; value: number; unit: string }[] = [];
  const blocked = referenceOnly(device);
  if (device.warning) notes.push(device.warning);
  if (!a)
    notes.push(
      "No current accepted anatomical measurement set: this is device-bench exploration, not a case suitability assessment.",
    );
  if (device.category === "flow-diverter") {
    const arc = pathLength(p.path);
    metrics.push(
      { label: "Selected path arc", value: arc, unit: "mm" },
      {
        label: "Device/path length difference",
        value: p.length - arc,
        unit: "mm",
      },
    );
    if (p.length > arc + 1e-6)
      notes.push(
        "Selected device exceeds the picked path. Extend and inspect the parent-vessel path; no extrapolated landing zone is assumed.",
      );
    if (a?.proximalDiameter)
      metrics.push({
        label: "Nominal/proximal section ratio",
        value: p.diameter / a.proximalDiameter,
        unit: "×",
      });
    if (a?.distalDiameter)
      metrics.push({
        label: "Nominal/distal section ratio",
        value: p.diameter / a.distalDiameter,
        unit: "×",
      });
    notes.push(
      "Parent-vessel reconstruction approach: inspect both landing zones, branch ostia and wall contact. This visualization does not establish apposition forces or branch patency.",
    );
    notes.push(
      "Review current labeling, antiplatelet requirements, rupture context and delayed occlusion expectations before considering flow diversion. Surface modification is not proof that antiplatelet therapy can be omitted.",
    );
  } else if (device.category === "intrasaccular") {
    if (a?.sacWidth)
      metrics.push({
        label: "Nominal diameter minus sac section width",
        value: p.diameter - a.sacWidth,
        unit: "mm",
      });
    if (a?.sacHeight)
      metrics.push({
        label: "Nominal height minus measured sac height",
        value: p.height - a.sacHeight,
        unit: "mm",
      });
    notes.push(
      device.shape === "contour"
        ? "Neck-covering cup concept, retained as a research reference; do not treat it as a verified US-available alternative."
        : "Intrasaccular approach: inspect neck seating, parent/branch protrusion and sac shape. US WEB indication is specific to wide-neck bifurcation anatomy; not every aneurysm is an eligible WEB case.",
    );
    notes.push(
      "CTA-derived section extrema are not the IFU's independent orthogonal angiographic measurements. No automatic +1/−1 SKU selection is made here.",
    );
  } else {
    if (Number.isFinite(p.coilLength) && p.coilLength > 0)
      metrics.push({
        label: "Planned secondary coil-centerline length",
        value: p.coilLength,
        unit: "mm",
      });
    const wireDiameterMm = resolveCoilPrimaryDiameterMm(device, p);
    const coilVolumeMm3 =
      wireDiameterMm !== null &&
      Number.isFinite(p.coilLength) &&
      p.coilLength > 0
        ? Math.PI * Math.pow(wireDiameterMm / 2, 2) * p.coilLength
        : null;
    if (
      coilVolumeMm3 !== null &&
      Number.isFinite(coilVolumeMm3) &&
      coilVolumeMm3 > 0
    ) {
      metrics.push({
        label: "Coil wire volume",
        value: coilVolumeMm3,
        unit: "mm³",
      });
      if (
        a?.sacVolume &&
        Number.isFinite(a.sacVolume) &&
        a.sacVolume > 0 &&
        Number.isFinite((coilVolumeMm3 / a.sacVolume) * 100)
      ) {
        metrics.push({
          label: "Packing volume density",
          value: (coilVolumeMm3 / a.sacVolume) * 100,
          unit: "%",
        });
      }
    }
    notes.push(
      "Coiling approach: assess neck containment and whether an adjunct is required. The displayed coil skeleton is not a prediction of how a specific heat-set coil will deploy.",
    );
    notes.push(
      "Packing volume needs the selected SKU's primary coil diameter and an accepted sac volume. Missing values are not replaced by defaults; packing is not an occlusion probability.",
    );
  }
  return {
    blocked,
    metrics,
    notes,
    sourceUrls: device.sources.map((s) => s.url),
    outcomeProbability: null,
    flowReduction: null,
    scientificStatus: "geometric-planning-not-validated-efficacy",
  };
}
