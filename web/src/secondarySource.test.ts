import { test, expect, vi, afterEach } from "vitest";
import fixture from "./__fixtures__/phase4-secondary-source.json";
import { loadSecondarySource } from "./secondarySource";
import { createNativeSampler } from "./nativeSampling";
const bytes = () =>
  Uint8Array.from(atob(fixture.nifti_base64), (c) => c.charCodeAt(0)).buffer;
afterEach(() => vi.unstubAllGlobals());
function responses(meta = fixture.metadata, data = bytes()) {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(meta)))
    .mockResolvedValueOnce(new Response(data));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
test("loads the actual default API synthetic source through real NVImage decode", async () => {
  const fetch = responses();
  const loaded = await loadSecondarySource(fixture.metadata.source_id);
  expect(loaded.metadata.image_sha256).toBe(fixture.metadata.image_sha256);
  expect(createNativeSampler(loaded.volume).shape).toEqual([32, 32, 32]);
  expect(createNativeSampler(loaded.volume).sample([4, 5, 6])).toBe(0);
  expect(fetch.mock.calls[1][0]).toBe(
    `/api/image-sources/${fixture.metadata.source_id}/volume`,
  );
});
test("rejects invalid IDs without following arbitrary URLs", async () => {
  const fetch = responses();
  await expect(
    loadSecondarySource("https://untrusted.invalid/data"),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
test("rejects wrong immutable image bytes", async () => {
  responses(fixture.metadata, new Uint8Array([1, 2, 3]).buffer);
  await expect(
    loadSecondarySource(fixture.metadata.source_id),
  ).rejects.toThrow();
});
test("rejects source revision changes before downloading pixels", async () => {
  const fetch = responses();
  await expect(
    loadSecondarySource(fixture.metadata.source_id, {
      image_sha256: fixture.metadata.image_sha256,
      reference_revision: "a".repeat(64),
    }),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});
test("binds actual decoded native affine to metadata, not merely file SHA", async () => {
  const meta = structuredClone(fixture.metadata);
  meta.image_affine_ras[0][3] = 17;
  responses(meta);
  await expect(loadSecondarySource(meta.source_id)).rejects.toThrow();
});

test("failed stream cleanup cannot mask the original byte-bound rejection", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(65537));
    },
    cancel() {
      throw new Error("Cleanup failure");
    },
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
  await expect(loadSecondarySource(fixture.metadata.source_id)).rejects.toThrow(
    "byte bound exceeded",
  );
});
