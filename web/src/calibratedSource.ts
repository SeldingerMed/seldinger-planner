import { sha256Hex as digest } from "./browserCrypto";
export type CalibratedSourceId = "zenodo-case006-calibrated" | "zenodo-case006-planning-context";
export const PLANNING_SOURCE_ID = "zenodo-case006-planning-context";
export type CalibratedSourceMetadata = {
  source_id: CalibratedSourceId;
  case_label: string;
  source_url: "https://doi.org/10.5281/zenodo.15697196";
  license_url: "https://creativecommons.org/licenses/by/4.0/";
  citation: string;
  image_sha256: string;
  image_url: `/api/image-sources/${CalibratedSourceId}/volume`;
  reference_revision: string;
  spatial_units: "mm";
  dimensions: [number, number, number];
  spacing_mm: [number, number, number];
  image_affine_ras: number[][];
  method: "calibrated_context_crop";
  selection_basis: "reference-informed candidate context";
  clinical_validation: false;
  stl_registration_validated: false;
};
export type CaseImageSource = CalibratedSourceMetadata & {
  case_id: string;
};

const SOURCE_ID = "zenodo-case006-calibrated";
const SOURCE_URL = "https://doi.org/10.5281/zenodo.15697196";
const LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/";
const knownSource = (value: unknown): value is CalibratedSourceId => value === SOURCE_ID || value === PLANNING_SOURCE_ID;
const METHOD = "calibrated_context_crop";
const SELECTION_BASIS = "reference-informed candidate context";
const MAX_IMAGE_BYTES = 16 * 1024 ** 2;

const sha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export function validate(meta: unknown): asserts meta is CalibratedSourceMetadata {
  if (typeof meta !== "object" || meta === null)
    throw new Error("Invalid calibrated source metadata.");
  const m = meta as Record<string, unknown>;
  if (
    !knownSource(m.source_id) ||
    m.method !== METHOD ||
    m.selection_basis !== SELECTION_BASIS ||
    m.spatial_units !== "mm" ||
    m.source_url !== SOURCE_URL ||
    m.license_url !== LICENSE_URL ||
    m.image_url !== `/api/image-sources/${m.source_id}/volume` ||
    m.clinical_validation !== false ||
    m.stl_registration_validated !== false ||
    typeof m.case_label !== "string" ||
    typeof m.citation !== "string" ||
    !sha(m.image_sha256) ||
    !sha(m.reference_revision) ||
    (m.reference_revision as string) === (m.image_sha256 as string) ||
    "annotations" in m ||
    "focus_ras" in m ||
    "transform" in m
  )
    throw new Error("Invalid calibrated source identity or provenance.");
  if (
    !Array.isArray(m.dimensions) ||
    m.dimensions.length !== 3 ||
    !m.dimensions.every(
      (x) => Number.isInteger(x) && x > 0 && x <= 2048,
    ) ||
    (m.dimensions as number[]).reduce((a, b) => a * b, 1) > 8_000_000
  )
    throw new Error("Invalid calibrated source dimensions.");
  if (
    !Array.isArray(m.spacing_mm) ||
    m.spacing_mm.length !== 3 ||
    !m.spacing_mm.every((x) => finite(x) && x > 0)
  )
    throw new Error("Invalid calibrated source spacing.");
  const affine = m.image_affine_ras;
  if (
    !Array.isArray(affine) ||
    affine.length !== 4 ||
    !affine.every((row) => Array.isArray(row) && row.length === 4)
  )
    throw new Error("Invalid calibrated source affine.");
  const a = affine as number[][];
  for (const row of a)
    if (!row.every((x) => finite(x)))
      throw new Error("Invalid calibrated source affine.");
  const det =
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
    a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
    a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  if (!Number.isFinite(det) || det === 0 || a[3][0] !== 0 || a[3][1] !== 0 || a[3][2] !== 0 || a[3][3] !== 1)
    throw new Error("Invalid calibrated source affine.");
  const spacing = m.spacing_mm as [number, number, number];
  for (let col = 0; col < 3; col++) {
    const norm = Math.hypot(a[0][col], a[1][col], a[2][col]);
    if (Math.abs(norm - spacing[col]) > 1e-6 * Math.max(1, spacing[col]))
      throw new Error("Affine spacing inconsistent with spacing_mm.");
  }
}

export async function loadCalibratedVolume(sourceId: CalibratedSourceId = SOURCE_ID): Promise<{
  file: File;
  metadata: CalibratedSourceMetadata;
}> {
  if (!knownSource(sourceId)) throw new Error("Unknown calibrated image source.");
  const response = await fetch(`/api/image-sources/${sourceId}`, { cache: "no-store" });
  if (!response.ok)
    throw new Error(
      "Calibrated image source is not installed or failed to load.",
    );
  const metadata = (await response.json()) as CalibratedSourceMetadata;
  validate(metadata);
  if (metadata.source_id !== sourceId) throw new Error("Calibrated source identity changed.");
  const image = await fetch(metadata.image_url, { cache: "no-store" });
  if (!image.ok)
    throw new Error("Calibrated volume asset is unavailable.");
  const declaredLength = image.headers.get("Content-Length");
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || !Number.isSafeInteger(Number(declaredLength)) || Number(declaredLength) > MAX_IMAGE_BYTES))
    throw new Error("Calibrated volume size limit exceeded.");
  const buffer = await image.arrayBuffer();
  if (
    buffer.byteLength > MAX_IMAGE_BYTES ||
    (await digest(buffer)) !== metadata.image_sha256
  )
    throw new Error("Calibrated volume integrity check failed.");
  return { file: new File([buffer], "context-cta.nii.gz"), metadata };
}

export async function findCaseImageSource(
  caseId: string,
  imageSha256: string,
): Promise<CaseImageSource | null> {
  const response = await fetch(
    `/api/cases/${encodeURIComponent(caseId)}/image-source`,
    { cache: "no-store" },
  );
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(
      `Calibrated image-source request failed (${response.status}).`,
    );
  const source = (await response.json()) as CaseImageSource;
  if (
    source.case_id !== caseId ||
    source.image_sha256 !== imageSha256 ||
    typeof imageSha256 !== "string"
  )
    throw new Error("Invalid calibrated source identity.");
  validate(source);
  return source;
}
