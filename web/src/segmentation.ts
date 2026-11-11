import { sha256Hex } from "./browserCrypto";
export type SegmentationEntry = {
  candidate_id: string;
  case_id: string;
  image_sha256: string;
  reference_revision: string;
  produced_artifact_version: string;
  producer:
    | "owned_vessel"
    | "rsna_vessel_model"
    | "sam2_prompted_slice"
    | "aneurysm_model";
  role: "vessel" | "aneurysm";
  mask_sha256: string;
  mask_url: string;
  status: "preview" | "accepted" | "rejected" | "superseded";
  segmentation_revision: number | null;
  provenance: Record<string, unknown>;
  artifact_version?: string;
};
export type SegmentationBinding = Pick<
  SegmentationEntry,
  "case_id" | "image_sha256" | "reference_revision"
>;
export async function loadSegmentationMask(
  entry: SegmentationEntry,
  binding: SegmentationBinding,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const identifier = /^[A-Za-z0-9_-]{1,100}$/;
  if (
    !identifier.test(entry.case_id) ||
    !identifier.test(entry.candidate_id) ||
    entry.case_id !== binding.case_id ||
    entry.image_sha256 !== binding.image_sha256 ||
    entry.reference_revision !== binding.reference_revision ||
    !/^[a-f0-9]{64}$/.test(entry.mask_sha256) ||
    !["preview", "accepted"].includes(entry.status) ||
    entry.mask_url !==
      `/api/cases/${entry.case_id}/segmentations/${entry.candidate_id}/mask`
  )
    throw new Error(
      "Segmentation identity or route does not match this image.",
    );
  const response = await fetch(entry.mask_url, {
    cache: "no-store",
    ...(signal ? { signal } : {}),
  });
  const cap = 16 * 1024 ** 2;
  if (!response.ok || Number(response.headers.get("Content-Length")) > cap)
    throw new Error("Segmentation mask unavailable.");
  const buffer = await response.arrayBuffer();
  if (!buffer.byteLength || buffer.byteLength > cap)
    throw new Error("Segmentation size exceeds its bound.");
  const actual = await sha256Hex(buffer);
  if (actual !== entry.mask_sha256)
    throw new Error("Segmentation integrity check failed.");
  return buffer;
}
