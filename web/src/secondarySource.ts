/** Same-origin, immutable-byte loading for an explicitly selected secondary. */
import type { NVImage } from "@niivue/niivue";
import { sha256Hex } from "./browserCrypto";
import {
  parseNativeCaseSource,
  type NativeCaseSource,
} from "./nativeCaseSource";
import { createNativeSampler } from "./nativeSampling";
import { record } from "./territoryWorkflow";
export type SecondaryVolume = { metadata: NativeCaseSource; volume: NVImage };
async function bounded(response: Response, max: number): Promise<ArrayBuffer> {
  if (!response.ok || !response.body)
    throw new Error("Secondary source is unavailable");
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max))
    throw new Error("Secondary byte bound exceeded");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new Error("Secondary byte bound exceeded");
      chunks.push(value);
    }
  } finally {
    // Cleanup must not replace the original admission or decode outcome.
    try {
      await reader.cancel();
    } catch {
      /* best-effort cleanup */
    }
    try {
      reader.releaseLock();
    } catch {
      /* best-effort cleanup */
    }
  }
  if (size === 0) throw new Error("Empty secondary source");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}
export async function loadSecondarySource(
  sourceId: string,
  expected?: { image_sha256: string; reference_revision: string },
): Promise<SecondaryVolume> {
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(sourceId))
    throw new Error("Select an opaque installed source ID");
  const response = await fetch(`/api/image-sources/${sourceId}`, {
    cache: "no-store",
  });
  const value: unknown = JSON.parse(
    new TextDecoder().decode(await bounded(response, 65536)),
  );
  if (!record(value) || value.source_id !== sourceId)
    throw new Error("Secondary source identity changed");
  // A validation-only anchor allows the existing exact source/grid parser to be
  // shared with case sources. It is never installed or represented as a case.
  const metadata = parseNativeCaseSource(
    { ...value, case_id: "secondary-validation-anchor" },
    {
      case_id: "secondary-validation-anchor",
      image_sha256: String(value.image_sha256),
      dimensions: Array.isArray(value.dimensions) ? value.dimensions : [],
      spacing_mm: Array.isArray(value.spacing_mm) ? value.spacing_mm : [],
      spatial_units: "mm",
    },
  );
  if (
    expected &&
    (metadata.image_sha256 !== expected.image_sha256 ||
      metadata.reference_revision !== expected.reference_revision)
  )
    throw new Error("Registered secondary source changed; reload scene");
  const bytes = await bounded(
    await fetch(`/api/image-sources/${sourceId}/volume`, { cache: "no-store" }),
    16 * 1024 * 1024,
  );
  if ((await sha256Hex(bytes)) !== metadata.image_sha256)
    throw new Error("Secondary image failed SHA-256 verification");
  const { NVImage } = await import("@niivue/niivue");
  const volume = await NVImage.loadFromUrl({
    url: bytes,
    name: "registered-secondary.nii.gz",
  });
  const sampler = createNativeSampler(volume);
  if (
    sampler.shape.some((n, i) => n !== metadata.dimensions[i]) ||
    !volume.hdr ||
    volume.hdr.affine.some((row, i) =>
      row.some(
        (v, j) =>
          Math.abs(v - metadata.image_affine_ras[i][j]) >
          1e-6 * Math.max(1, Math.abs(v)),
      ),
    )
  )
    throw new Error("Decoded secondary geometry differs from source manifest");
  return { metadata, volume };
}
