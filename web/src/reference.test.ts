import { afterEach, expect, test, vi } from "vitest";
import { webcrypto, createHash } from "node:crypto";
import {
  loadReferenceVolume,
  findCaseReference,
  loadReferenceMeshes,
} from "./reference";
afterEach(() => vi.unstubAllGlobals());
const bytes = new TextEncoder().encode("Explicit synthetic unit-test bytes");
const sha = createHash("sha256").update(bytes).digest("hex");
const revision = "a".repeat(64);
const meta = {
  case_label: "CMHA AHMU1218001",
  source_url: "https://doi.org/10.6084/m9.figshare.26965450.v1",
  license_url: "https://creativecommons.org/licenses/by/4.0/",
  citation: "Synthetic contract fixture",
  image_sha256: sha,
  image_url: "/api/reference-volume",
  reference_revision: revision,
  spatial_units: "unknown",
  alignment_status: "candidate_image_consistent",
  method: "curated_dataset_annotation",
  focus_ras: [-1, 2, 3],
  case_id: "case-a",
  annotations: ["aneurysm", "artery"].map((id) => ({
    id,
    sha256: sha,
    triangle_count: 1,
    url: `/api/cases/case-a/reference/${revision}/${id}.stl`,
  })),
};
function setup(value = meta) {
  vi.stubGlobal("crypto", webcrypto);
  const mock = vi.fn(
    async (url: string) =>
      new Response(
        url === "/api/reference" || url.endsWith("/reference")
          ? JSON.stringify(value)
          : bytes,
      ),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}
test("opens only the hash-verified fixed reference volume", async () => {
  setup();
  const loaded = await loadReferenceVolume();
  expect(loaded.file.name).toBe("reference-cta.nii.gz");
  expect(loaded.metadata.image_sha256).toBe(sha);
});
test("refuses changed image bytes before accepting a reference", async () => {
  setup({ ...meta, image_sha256: "0".repeat(64) });
  await expect(loadReferenceVolume()).rejects.toThrow(/integrity/i);
});
test("does not bind reference geometry to another image", async () => {
  setup();
  await expect(findCaseReference("case-a", "0".repeat(64))).rejects.toThrow(
    /identity/i,
  );
});
test("checks exact case and revision routes before mesh fetches", async () => {
  const mock = setup();
  const foreign = {
    ...meta,
    annotations: meta.annotations.map((a) => ({
      ...a,
      url: "https://example.com/unapproved.stl",
    })),
  };
  await expect(loadReferenceMeshes(foreign as never)).rejects.toThrow(/scope/i);
  expect(mock).not.toHaveBeenCalled();
});
test("returns verified surface buffers and rejects changed meshes", async () => {
  setup();
  const ref = await findCaseReference("case-a", sha);
  const loaded = await loadReferenceMeshes(ref!);
  expect(loaded).toHaveLength(2);
  expect(loaded[0].buffer.byteLength).toBe(bytes.byteLength);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("wrong")),
  );
  await expect(loadReferenceMeshes(ref!)).rejects.toThrow(/integrity/i);
});
