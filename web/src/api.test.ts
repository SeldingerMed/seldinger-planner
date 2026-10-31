import { afterEach, expect, test, vi } from "vitest";
import { restoreOrCreateCase } from "./api";
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});
test("reopens the saved workspace for the same image rather than losing its notes", async () => {
  const sha = "a".repeat(64);
  const saved = {
    case_id: "saved-case",
    image_sha256: sha,
    notes: "Synthetic saved note",
    measurements: [],
    artifact_version: "3",
  };
  localStorage.setItem("seldinger-case:" + sha, "saved-case");
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify(saved), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  const restored = await restoreOrCreateCase({
    title: "Synthetic fixture",
    image_sha256: sha,
    source_url: null,
    dimensions: [10, 10, 10],
    spacing_mm: [1, 1, 1],
  });
  expect(restored.notes).toBe("Synthetic saved note");
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][0]).toBe("/api/cases/saved-case");
});
