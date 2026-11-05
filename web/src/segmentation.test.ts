import { expect, test, vi, afterEach } from "vitest";
import { webcrypto } from "node:crypto";
import { loadSegmentationMask, type SegmentationEntry } from "./segmentation";

Object.defineProperty(globalThis, "crypto", {
  value: webcrypto,
  configurable: true,
});
afterEach(() => vi.unstubAllGlobals());
const bytes = new TextEncoder().encode(
  "explicit synthetic mask-loader fixture",
);
async function fixture() {
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  return {
    case_id: "case-a",
    image_sha256: "a".repeat(64),
    reference_revision: "b".repeat(64),
    candidate_id: "candidate-a",
    mask_sha256: hash,
    mask_url: "/api/cases/case-a/segmentations/candidate-a/mask",
    producer: "owned_vessel",
    role: "vessel",
    status: "preview",
    produced_artifact_version: "1",
    segmentation_revision: null,
    provenance: {},
  } as SegmentationEntry;
}
test("verifies actual bytes and exact case-bound route", async () => {
  const entry = await fixture();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(bytes)),
  );
  const buffer = await loadSegmentationMask(entry, {
    case_id: "case-a",
    image_sha256: "a".repeat(64),
    reference_revision: "b".repeat(64),
  });
  expect(Array.from(new Uint8Array(buffer))).toEqual(Array.from(bytes));
});
test("rejects foreign identity and arbitrary URL before fetching", async () => {
  const entry = await fixture();
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(
    loadSegmentationMask(
      { ...entry, mask_url: "https://example.org/mask" },
      entry,
    ),
  ).rejects.toThrow();
  await expect(
    loadSegmentationMask(entry, { ...entry, case_id: "case-b" }),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
test("rejects corrupt bytes", async () => {
  const entry = await fixture();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("different synthetic bytes")),
  );
  await expect(loadSegmentationMask(entry, entry)).rejects.toThrow(
    /integrity/i,
  );
});
