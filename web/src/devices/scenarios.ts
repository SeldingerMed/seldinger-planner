import { newRandomId } from "../browserCrypto";
export type Triple = [number, number, number];
export type SceneBinding = {
  caseId: string;
  imageSha: string;
  artifactVersion: string;
  referenceRevision: string;
  geometryResultId: string;
  catalogVersion?: string;
};
export type Placement = {
  deviceId: string;
  diameter: number;
  length: number;
  height: number;
  center: Triple;
  axis: Triple;
  path: Triple[];
  offset: number;
  roll: number;
  coilLength: number;
  braidAngle?: number;
};
export type Scenario = {
  id: string;
  name: string;
  binding: SceneBinding;
  placement: Placement;
  modelVersion: "procedural-device-v2";
};
export function bindingKey(binding: SceneBinding) {
  return JSON.stringify([
    binding.caseId,
    binding.imageSha,
    binding.artifactVersion,
    binding.referenceRevision,
    binding.geometryResultId,
    binding.catalogVersion ?? "",
  ]);
}
function triple(p: unknown): p is Triple {
  return (
    Array.isArray(p) &&
    p.length === 3 &&
    p.every(
      (v) =>
        typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 100000,
    )
  );
}
export function validPlacement(p: unknown): p is Placement {
  if (!p || typeof p !== "object") return false;
  const v = p as Placement;
  return (
    typeof v.deviceId === "string" &&
    v.deviceId.length < 100 &&
    triple(v.center) &&
    triple(v.axis) &&
    Math.hypot(...v.axis) > 1e-6 &&
    Array.isArray(v.path) &&
    v.path.length >= 2 &&
    v.path.length <= 64 &&
    v.path.every(triple) &&
    [v.diameter, v.length, v.height, v.coilLength].every(
      (x) => typeof x === "number" && Number.isFinite(x) && x > 0 && x <= 1000,
    ) &&
    typeof v.offset === "number" &&
    Number.isFinite(v.offset) &&
    Math.abs(v.offset) <= 100 &&
    typeof v.roll === "number" &&
    Number.isFinite(v.roll) &&
    Math.abs(v.roll) <= 360 &&
    (v.braidAngle === undefined ||
      (typeof v.braidAngle === "number" &&
        Number.isFinite(v.braidAngle) &&
        v.braidAngle >= 35 &&
        v.braidAngle <= 75))
  );
}
export function restoreScenarios(
  raw: string | null,
  binding: SceneBinding,
): Scenario[] {
  try {
    if (!raw || raw.length > 200000) return [];
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows) || rows.length > 12) return [];
    return rows.filter(
      (r): r is Scenario =>
        !!r &&
        typeof r === "object" &&
        typeof r.id === "string" &&
        typeof r.name === "string" &&
        r.name.length <= 80 &&
        r.modelVersion === "procedural-device-v2" &&
        bindingKey(r.binding) === bindingKey(binding) &&
        validPlacement(r.placement),
    );
  } catch {
    return [];
  }
}
export function saveScenario(
  existing: Scenario[],
  binding: SceneBinding,
  placement: Placement,
  name: string,
): Scenario[] {
  if (!validPlacement(placement) || !name.trim() || name.length > 80)
    throw new Error("Invalid placement or scenario name");
  const rows = restoreScenarios(JSON.stringify(existing), binding);
  if (rows.length >= 12)
    throw new Error("Maximum twelve saved scenarios per anatomy revision");
  return [
    ...rows,
    {
      id: newRandomId(),
      name: name.trim(),
      binding: structuredClone(binding),
      placement: structuredClone(placement),
      modelVersion: "procedural-device-v2",
    },
  ];
}
