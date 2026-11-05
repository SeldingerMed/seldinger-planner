import type { Point3 } from "./geometry";
import { sha256Hex } from "./browserCrypto";
export type ReferenceMetadata = {
  case_label: string;
  source_url: string;
  license_url: string;
  citation: string;
  image_sha256: string;
  image_url: string;
  reference_revision: string;
  spatial_units: "unknown";
  alignment_status: "candidate_image_consistent";
  method: "curated_dataset_annotation";
  focus_ras: Point3;
};
export type ReferenceAnnotation = {
  id: "aneurysm" | "artery";
  sha256: string;
  triangle_count: number;
  url: string;
};
export type CaseReference = ReferenceMetadata & {
  case_id: string;
  annotations: ReferenceAnnotation[];
};
const sha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function validate(meta: ReferenceMetadata) {
  if (
    !sha(meta.image_sha256) ||
    !sha(meta.reference_revision) ||
    meta.method !== "curated_dataset_annotation" ||
    meta.spatial_units !== "unknown" ||
    meta.alignment_status !== "candidate_image_consistent" ||
    meta.source_url !== "https://doi.org/10.6084/m9.figshare.26965450.v1" ||
    meta.license_url !== "https://creativecommons.org/licenses/by/4.0/" ||
    !Array.isArray(meta.focus_ras) ||
    meta.focus_ras.length !== 3 ||
    !meta.focus_ras.every((x) => typeof x === "number" && Number.isFinite(x))
  )
    throw new Error("Invalid reference identity or provenance.");
}
async function verified(url: string, expected: string, cap: number) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Reference asset unavailable.");
  const declared = Number(response.headers.get("Content-Length"));
  if (declared > cap) throw new Error("Reference asset exceeds size limit.");
  const buffer = await response.arrayBuffer();
  const actual = await sha256Hex(buffer);
  if (buffer.byteLength > cap || actual !== expected)
    throw new Error("Reference asset integrity check failed.");
  return buffer;
}
export async function loadReferenceVolume() {
  const response = await fetch("/api/reference");
  if (!response.ok)
    throw new Error(
      "Original-case reference is not installed or failed integrity checks.",
    );
  const metadata = (await response.json()) as ReferenceMetadata;
  validate(metadata);
  if (metadata.image_url !== "/api/reference-volume")
    throw new Error("Reference route outside approved scope.");
  const buffer = await verified(
    "/api/reference-volume",
    metadata.image_sha256,
    100 * 1024 ** 2,
  );
  return { file: new File([buffer], "reference-cta.nii.gz"), metadata };
}
export async function findCaseReference(
  caseId: string,
  imageSha: string,
): Promise<CaseReference | null> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(caseId))
    throw new Error("Invalid reference case identity.");
  const response = await fetch(`/api/cases/${caseId}/reference`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Reference surfaces are unavailable.");
  const reference = (await response.json()) as CaseReference;
  validate(reference);
  if (reference.case_id !== caseId || reference.image_sha256 !== imageSha)
    throw new Error("Reference identity does not match this image.");
  validateAssets(reference);
  return reference;
}
function validateAssets(reference: CaseReference) {
  validate(reference);
  if (
    !/^[A-Za-z0-9_-]{1,100}$/.test(reference.case_id) ||
    !Array.isArray(reference.annotations) ||
    reference.annotations.length !== 2 ||
    new Set(reference.annotations.map((a) => a.id)).size !== 2
  )
    throw new Error("Invalid reference scope.");
  for (const a of reference.annotations) {
    if (
      !["aneurysm", "artery"].includes(a.id) ||
      !sha(a.sha256) ||
      !Number.isInteger(a.triangle_count) ||
      a.triangle_count <= 0 ||
      a.triangle_count > 50000 ||
      a.url !==
        `/api/cases/${reference.case_id}/reference/${reference.reference_revision}/${a.id}.stl`
    )
      throw new Error("Reference route outside approved scope.");
  }
}
export async function loadReferenceMeshes(reference: CaseReference) {
  validateAssets(reference);
  return Promise.all(
    reference.annotations.map(async (a) => ({
      ...a,
      buffer: await verified(a.url, a.sha256, 2 * 1024 ** 2),
    })),
  );
}
