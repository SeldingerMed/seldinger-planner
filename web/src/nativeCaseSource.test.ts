import { afterEach, expect, test, vi } from "vitest";
import source from "./__fixtures__/territory-native-source.json";
import { findNativeCaseSource } from "./nativeCaseSource";
const caseState = {
  case_id: source.case_id,
  image_sha256: source.image_sha256,
  dimensions: source.dimensions,
  spacing_mm: source.spacing_mm,
  spatial_units: "mm" as const,
};
afterEach(() => vi.unstubAllGlobals());
test("admits the actual synthetic installed-source producer, without a demo source ID", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify(source))),
  );
  const loaded = await findNativeCaseSource(caseState);
  expect(loaded?.source_id).toBe("phase3-synthetic");
});
test.each([
  (x: typeof source) => {
    x.image_url = "https://untrusted.invalid/volume";
  },
  (x: typeof source) => {
    x.image_sha256 = "a".repeat(64);
  },
  (x: typeof source) => {
    x.dimensions = [33, 32, 32];
  },
  (x: typeof source) => {
    x.image_affine_ras[0][0] = 2;
  },
  (x: typeof source) => {
    x.image_affine_ras[3][0] = 1;
  },
  (x: typeof source) => {
    x.reference_revision = x.image_sha256;
  },
  (x: typeof source) => {
    x.method = "untrusted";
  },
])(
  "rejects mismatched or untrusted source metadata before enabling annotation",
  async (mutate) => {
    const value = structuredClone(source);
    mutate(value);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(value))),
    );
    await expect(findNativeCaseSource(caseState)).rejects.toThrow();
  },
);
