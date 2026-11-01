import { afterEach, expect, test, vi } from "vitest";
import { webcrypto, createHash } from "node:crypto";
import {
  loadCalibratedVolume,
  findCaseImageSource,
} from "./calibratedSource";
afterEach(() => vi.unstubAllGlobals());

const bytes = new TextEncoder().encode("Synthetic calibrated transport bytes");
const sha = createHash("sha256").update(bytes).digest("hex");
const revision = "b".repeat(64);
const meta = {
  source_id: "zenodo-case006-calibrated",
  case_label: "Synthetic calibrated fixture",
  source_url: "https://doi.org/10.5281/zenodo.15697196",
  license_url: "https://creativecommons.org/licenses/by/4.0/",
  citation: "Synthetic contract fixture",
  image_sha256: sha,
  image_url: "/api/image-sources/zenodo-case006-calibrated/volume",
  reference_revision: revision,
  spatial_units: "mm",
  dimensions: [8, 9, 10],
  spacing_mm: [1, 1, 2],
  image_affine_ras: [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 2, 0],
    [0, 0, 0, 1],
  ],
  method: "calibrated_context_crop",
  selection_basis: "reference-informed candidate context",
  clinical_validation: false,
  stl_registration_validated: false,
  case_id: "case-a",
};

function setup(value: unknown = meta, blob: BodyInit = bytes) {
  vi.stubGlobal("crypto", webcrypto);
  const mock = vi.fn(
    async (url: string | URL, init?: RequestInit) =>
      new Response(
        (String(url).startsWith("/api/image-sources/") && !String(url).endsWith("/volume")) ||
        String(url).endsWith("/image-source")
          ? JSON.stringify(value)
          : blob,
      ),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

test("rejects contexts above the exact 8,000,000 voxel cap", async () => {
  setup({...meta,dimensions:[200,201,200]});
  await expect(loadCalibratedVolume()).rejects.toThrow(/dimensions/i);
});

test("rejects a nonhomogeneous affine even when its 3x3 block is valid", async () => {
  setup({...meta,image_affine_ras:[[1,0,0,0],[0,1,0,0],[0,0,2,0],[0.1,0,0,1]]});
  await expect(loadCalibratedVolume()).rejects.toThrow(/affine/i);
});

test("loads the distinct broader planning source without repinning the old source", async () => {
  const id="zenodo-case006-planning-context";
  const mock=setup({...meta,source_id:id,image_url:`/api/image-sources/${id}/volume`});
  const result=await loadCalibratedVolume(id);
  expect(result.metadata.source_id).toBe(id);
  expect(mock.mock.calls[0][0]).toBe(`/api/image-sources/${id}`);
});

test("opens only the hash-verified fixed calibrated volume", async () => {
  const mock = setup();
  const loaded = await loadCalibratedVolume();
  expect(loaded.file.name).toBe("context-cta.nii.gz");
  expect(loaded.metadata.image_sha256).toBe(sha);
  expect(loaded.metadata.spatial_units).toBe("mm");
  expect(mock.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
});

test("refuses changed image bytes before accepting a calibrated volume", async () => {
  setup(meta, new TextEncoder().encode("tampered"));
  await expect(loadCalibratedVolume()).rejects.toThrow(/integrity/i);
});

test("refuses oversized declared bodies before materializing them", async () => {
  setup();
  const read=vi.fn(async()=>{throw new Error("must not materialize oversized body");});
  const response=new Response(null,{headers:{"Content-Length":String(16*1024*1024+1)}});
  Object.defineProperty(response,"arrayBuffer",{value:read});
  const mock=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(meta))).mockResolvedValueOnce(response);
  vi.stubGlobal("fetch",mock);
  await expect(loadCalibratedVolume()).rejects.toThrow(/integrity|limit|size/i);
  expect(read).not.toHaveBeenCalled();
});

test("refuses oversized image bodies beyond the 16MiB cap", async () => {
  setup(meta, new ArrayBuffer(16 * 1024 * 1024 + 1));
  await expect(loadCalibratedVolume()).rejects.toThrow(/integrity|limit|size/i);
});

test("refuses foreign source identity, units, method or true flags", async () => {
  for (const mutated of [
    { ...meta, source_id: "other-source" },
    { ...meta, spatial_units: "voxel" },
    { ...meta, method: "curated_dataset_annotation" },
    { ...meta, clinical_validation: true },
    { ...meta, stl_registration_validated: true },
    { ...meta, selection_basis: "independent lesion localization" },
    { ...meta, annotations: [] },
    { ...meta, focus_ras: [0, 0, 0] },
    { ...meta, transform: {} },
    { ...meta, image_url: "https://example.com/volume" },
    { ...meta, reference_revision: sha },
    { ...meta, reference_revision: revision + "\n" },
    { ...meta, dimensions: [0, 9, 10] },
    { ...meta, dimensions: [2049, 9, 10] },
    { ...meta, spacing_mm: [0, 1, 2] },
    {
      ...meta,
      image_affine_ras: [
        [2, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 2, 0],
        [0, 0, 0, 1],
      ],
    },
    { ...meta, image_affine_ras: [[1, 0], [0, 1]] },
  ]) {
    setup(mutated);
    await expect(loadCalibratedVolume()).rejects.toThrow();
  }
});

test("returns null only on 404 and validates exact case identity", async () => {
  const mock = setup(meta);
  const found = await findCaseImageSource("case-a", sha);
  expect(found).not.toBeNull();
  expect(found?.case_id).toBe("case-a");
  expect(mock).toHaveBeenCalledWith(
    "/api/cases/case-a/image-source",
    { cache: "no-store" },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 404 })),
  );
  await expect(findCaseImageSource("case-a", sha)).resolves.toBeNull();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 500 })),
  );
  await expect(findCaseImageSource("case-a", sha)).rejects.toThrow();
});

test("does not bind calibrated source to another image or case", async () => {
  setup();
  await expect(findCaseImageSource("case-a", "0".repeat(64))).rejects.toThrow(
    /identity/i,
  );
  setup({ ...meta, case_id: "case-b" });
  await expect(findCaseImageSource("case-a", sha)).rejects.toThrow(
    /identity/i,
  );
});
