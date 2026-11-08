import { validate } from "./calibratedSource";
import type { CaseState } from "./api";
import { record } from "./territoryWorkflow";
// Server-selected metadata only. This never uploads a volume or follows source URLs.
export type NativeCaseSource = {
  case_id: string;
  source_id: string;
  image_sha256: string;
  reference_revision: string;
  dimensions: number[];
  spacing_mm: number[];
  image_affine_ras: number[][];
  case_label: string;
};
export async function findNativeCaseSource(
  caseState: Pick<
    CaseState,
    "case_id" | "image_sha256" | "dimensions" | "spacing_mm" | "spatial_units"
  >,
): Promise<NativeCaseSource | null> {
  const response = await fetch(
    `/api/cases/${encodeURIComponent(caseState.case_id)}/image-source`,
    { cache: "no-store" },
  );
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error("Native planning source could not be verified.");
  return parseNativeCaseSource(await response.json(), caseState);
}
export function parseNativeCaseSource(
  value: unknown,
  caseState: Pick<
    CaseState,
    "case_id" | "image_sha256" | "dimensions" | "spacing_mm" | "spatial_units"
  >,
): NativeCaseSource {
  const bad = () => {
    throw new Error("Native planning source metadata is inconsistent.");
  };
  if (
    !record(value) ||
    caseState.spatial_units !== "mm" ||
    value.spatial_units !== "mm" ||
    value.case_id !== caseState.case_id ||
    value.image_sha256 !== caseState.image_sha256 ||
    typeof value.image_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.image_sha256) ||
    typeof value.reference_revision !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.reference_revision) ||
    value.reference_revision === value.image_sha256 ||
    typeof value.source_id !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(value.source_id) ||
    value.image_url !== `/api/image-sources/${value.source_id}/volume` ||
    value.clinical_validation !== false ||
    value.stl_registration_validated !== false
  )
    return bad();
  // Public demo providers retain their original stricter provenance validator.
  if (value.method === "calibrated_context_crop") {
    validate(value);
  } else if (
    value.method !== "installed_nifti_source" ||
    value.selection_basis !== "server-installed calibrated volume" ||
    value.source_id.startsWith("zenodo-case006-")
  )
    return bad();
  if (
    typeof value.case_label !== "string" ||
    value.case_label.length > 500 ||
    !Array.isArray(value.dimensions) ||
    value.dimensions.length !== 3 ||
    !value.dimensions.every((x) => Number.isInteger(x) && x > 0 && x <= 2048) ||
    value.dimensions.reduce((a, b) => a * b, 1) > 8_000_000 ||
    !Array.isArray(value.spacing_mm) ||
    value.spacing_mm.length !== 3 ||
    !value.spacing_mm.every(
      (x) => typeof x === "number" && Number.isFinite(x) && x > 0,
    )
  )
    return bad();
  if (
    value.dimensions.some((v, i) => v !== caseState.dimensions[i]) ||
    value.spacing_mm.some(
      (v, i) =>
        !Number.isFinite(caseState.spacing_mm[i]) ||
        Math.abs(v - caseState.spacing_mm[i]) >
          1e-6 * Math.max(v, caseState.spacing_mm[i]),
    )
  )
    return bad();
  const affine = value.image_affine_ras;
  if (
    !Array.isArray(affine) ||
    affine.length !== 4 ||
    !affine.every(
      (row) =>
        Array.isArray(row) &&
        row.length === 4 &&
        row.every((x) => typeof x === "number" && Number.isFinite(x)),
    )
  )
    return bad();
  const a = affine as number[][];
  if (a[3][0] !== 0 || a[3][1] !== 0 || a[3][2] !== 0 || a[3][3] !== 1)
    return bad();
  const det =
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
    a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
    a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return bad();
  for (let i = 0; i < 3; i++)
    if (
      Math.abs(
        Math.hypot(a[0][i], a[1][i], a[2][i]) - (value.spacing_mm[i] as number),
      ) >
      1e-6 * Math.max(1, value.spacing_mm[i] as number)
    )
      return bad();
  return JSON.parse(JSON.stringify(value)) as NativeCaseSource;
}
