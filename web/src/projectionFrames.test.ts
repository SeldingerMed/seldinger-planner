import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bundleAnswer,
  currentAnswer,
  gray,
  hex,
  identity,
  maskBlob,
  nifti,
  phantom,
  registrationAnswer,
  REVISION,
  savedInputs,
  SCORE,
  SIDE,
  VIEW,
} from "./__fixtures__/overlayCase";
import {
  decodeVesselMask,
  loadFrameBundle,
  loadVerifiedFrame,
  parseFrameBundle,
  parseSavedRegistration,
} from "./projectionFrames";

afterEach(() => vi.unstubAllGlobals());
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const buffer = (bytes: Uint8Array) =>
  bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
function plane(change: (plane: Record<string, any>) => void) {
  const answer = clone(bundleAnswer());
  change(answer.manifest.planes[0]);
  return answer;
}

describe("frame bundle parsing", () => {
  it("keeps what the browser acts on", () => {
    const bundle = parseFrameBundle(bundleAnswer(), "phantom-run");
    expect(bundle).toEqual({
      source_id: "phantom-run",
      manifest_revision: REVISION,
      scope: "synthetic",
      method: "admitted_png_frames",
      planes: [
        {
          plane: "single",
          rows: SIDE,
          columns: SIDE,
          geometry: null,
          basis: "operator_attested_crop_and_redaction",
          cropped: true,
          frames: [
            { index: 12, sha256: hex(gray) },
            { index: 30, sha256: "d".repeat(64) },
          ],
        },
      ],
    });
    const dicom = plane((p) => {
      p.geometry = VIEW;
      p.deidentification.crop = null;
      p.deidentification.basis = "dicom_declared_no_burned_in_annotation";
    });
    dicom.manifest.method = "admitted_dicom_xa_frames";
    expect(parseFrameBundle(dicom, "phantom-run").planes[0].geometry).toEqual(
      VIEW,
    );
  });

  it.each([
    ["another source", { ...bundleAnswer(), source_id: "other" }],
    ["a bad revision", { ...bundleAnswer(), manifest_revision: "abc" }],
    ["a validated claim", bundleAnswer({ clinical_validation: true })],
    ["another version", bundleAnswer({ version: 2 })],
    ["another kind", bundleAnswer({ kind: "projection_series" })],
    ["another pixel format", bundleAnswer({ pixel_format: "gray16" })],
    ["an unknown scope", bundleAnswer({ scope: "private" })],
    ["an unknown method", bundleAnswer({ method: "typed" })],
    ["no planes", bundleAnswer({ planes: [] })],
    ["an unknown plane", plane((p) => (p.plane = "c"))],
    ["a lone plane A", plane((p) => (p.plane = "a"))],
    ["too many rows", plane((p) => (p.rows = 1025))],
    ["too few columns", plane((p) => (p.columns = 63))],
    ["fractional rows", plane((p) => (p.rows = 300.5))],
    ["no frames", plane((p) => (p.frames = []))],
    ["nine frames", plane((p) => (p.frames = Array(9).fill(p.frames[0])))],
    ["descending frames", plane((p) => p.frames.reverse())],
    ["a bad digest", plane((p) => (p.frames[0].sha256 = "Z".repeat(64)))],
    ["a negative index", plane((p) => (p.frames[0].index = -1))],
    ["an unknown basis", plane((p) => (p.deidentification.basis = "none"))],
    // Geometry is only kept for an uncropped DICOM plane.
    ["geometry on a PNG plane", plane((p) => (p.geometry = VIEW))],
    ["a missing manifest", { source_id: "phantom-run" }],
    ["a non-object", null],
  ])("rejects %s", (_, answer) => {
    expect(() => parseFrameBundle(answer, "phantom-run")).toThrow();
  });

  it("keeps geometry for an uncropped DICOM plane and refuses it on a cropped one", () => {
    const dicom = (crop: number[] | null) => {
      const answer = plane((p) => {
        p.geometry = VIEW;
        p.deidentification.crop = crop;
        if (!crop)
          p.deidentification.source_rows = p.deidentification.source_columns =
            SIDE;
      });
      answer.manifest.method = "admitted_dicom_xa_frames";
      return answer;
    };
    const kept = parseFrameBundle(dicom(null), "phantom-run").planes[0];
    expect(kept.geometry).toEqual(VIEW);
    expect(kept.cropped).toBe(false);
    // A crop moves the image center off the central ray.
    expect(() =>
      parseFrameBundle(dicom([100, 50, SIDE, SIDE]), "phantom-run"),
    ).toThrow();
  });

  it("rejects out-of-range geometry on a DICOM plane", () => {
    const dicom = plane((p) => {
      p.geometry = { ...VIEW, source_isocenter_mm: 1300 };
      p.deidentification.crop = null;
    });
    dicom.manifest.method = "admitted_dicom_xa_frames";
    expect(() => parseFrameBundle(dicom, "phantom-run")).toThrow();
  });
});

describe("frame loading", () => {
  const serve = (body: Uint8Array, revision = REVISION, status = 200) =>
    vi.fn(
      async () =>
        new Response(buffer(body), {
          status,
          headers: { "X-Frame-Manifest-Revision": revision },
        }),
    );
  const bundle = parseFrameBundle(bundleAnswer(), "phantom-run");

  it("returns a frame whose digest matches the manifest", async () => {
    const fetch = serve(gray);
    vi.stubGlobal("fetch", fetch);
    const frame = await loadVerifiedFrame(bundle, "single", 12);
    expect(fetch).toHaveBeenCalledWith(
      "/api/projection-frames/phantom-run/planes/single/frames/12",
      { cache: "no-store" },
    );
    expect(frame.gray).toEqual(gray);
    expect([frame.width, frame.height, frame.sha256]).toEqual([
      SIDE,
      SIDE,
      hex(gray),
    ]);
  });

  it("refuses changed, short, stale or missing frames", async () => {
    const flipped = gray.slice();
    flipped[100] ^= 1;
    for (const fetch of [
      serve(flipped),
      serve(gray.subarray(1)),
      serve(gray, "b".repeat(64)),
      serve(gray, REVISION, 503),
    ]) {
      vi.stubGlobal("fetch", fetch);
      await expect(loadVerifiedFrame(bundle, "single", 12)).rejects.toThrow();
    }
    // A manifest that records the digest of a short buffer: the bytes match
    // their digest and still do not fill the frame.
    const short = gray.subarray(0, gray.length - SIDE),
      answer = bundleAnswer();
    answer.manifest.planes[0].frames[0].sha256 = hex(short);
    vi.stubGlobal("fetch", serve(short));
    await expect(
      loadVerifiedFrame(parseFrameBundle(answer, "phantom-run"), "single", 12),
    ).rejects.toThrow("integrity");
    // Frame 30's recorded digest is not that of these pixels.
    vi.stubGlobal("fetch", serve(gray));
    await expect(loadVerifiedFrame(bundle, "single", 30)).rejects.toThrow(
      "integrity",
    );
    const never = vi.fn();
    vi.stubGlobal("fetch", never);
    await expect(loadVerifiedFrame(bundle, "single", 13)).rejects.toThrow();
    await expect(loadVerifiedFrame(bundle, "a", 12)).rejects.toThrow();
    await expect(loadFrameBundle("../etc")).rejects.toThrow();
    expect(never).not.toHaveBeenCalled();
  });

  it("loads a bundle by identifier", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify(bundleAnswer())),
    );
    vi.stubGlobal("fetch", fetch);
    expect((await loadFrameBundle("phantom-run")).manifest_revision).toBe(
      REVISION,
    );
    expect(fetch).toHaveBeenCalledWith("/api/projection-frames/phantom-run", {
      cache: "no-store",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 })),
    );
    await expect(loadFrameBundle("phantom-run")).rejects.toThrow();
  });
});

describe("vessel mask decoding", () => {
  const { mask, shape, affine } = phantom;
  const gz = (bytes: Uint8Array) => buffer(new Uint8Array(gzipSync(bytes)));

  it("returns the voxels of a mask on the source grid", async () => {
    const voxels = await decodeVesselMask(buffer(maskBlob), shape, affine);
    expect(voxels).toEqual(mask);
  });

  it("accepts a mask that stores no affine of its own", async () => {
    const blob = gz(
      nifti(mask, shape, affine, (v) => v.setInt16(254, 0, true)),
    );
    expect(await decodeVesselMask(blob, shape, affine)).toEqual(mask);
  });

  it.each([
    ["another shape", (v: DataView) => v.setInt16(42, shape[0] + 1, true)],
    ["four dimensions", (v: DataView) => v.setInt16(40, 4, true)],
    ["16-bit voxels", (v: DataView) => v.setInt16(70, 4, true)],
    ["another bit depth", (v: DataView) => v.setInt16(72, 16, true)],
    ["a big-endian header", (v: DataView) => v.setInt32(0, 348, false)],
    ["another magic", (v: DataView) => v.setUint8(344, 0x6f)],
    [
      "a data offset past the header",
      (v: DataView) => v.setFloat32(108, 360, true),
    ],
    ["intensity scaling", (v: DataView) => v.setFloat32(112, 2, true)],
    ["an intercept", (v: DataView) => v.setFloat32(116, 1, true)],
    [
      "a shifted grid",
      (v: DataView) => v.setFloat32(280 + 12, affine[0][3] + 1, true),
    ],
    ["a flipped axis", (v: DataView) => v.setFloat32(280, -affine[0][0], true)],
  ])("rejects %s", async (_, change) => {
    const blob = gz(nifti(mask, shape, affine, change));
    await expect(decodeVesselMask(blob, shape, affine)).rejects.toThrow();
  });

  it("rejects non-binary, truncated, oversized and non-gzip input", async () => {
    const labelled = mask.slice();
    labelled[0] = 2;
    await expect(
      decodeVesselMask(gz(nifti(labelled, shape, affine)), shape, affine),
    ).rejects.toThrow("binary");
    const whole = nifti(mask, shape, affine);
    await expect(
      decodeVesselMask(gz(whole.subarray(0, whole.length - 1)), shape, affine),
    ).rejects.toThrow();
    // Inflation stops at the bound for the expected grid.
    const bomb = gz(new Uint8Array(4_000_000));
    await expect(decodeVesselMask(bomb, [8, 8, 8], affine)).rejects.toThrow(
      "bound",
    );
    await expect(
      decodeVesselMask(buffer(whole), shape, affine),
    ).rejects.toThrow();
    await expect(
      decodeVesselMask(buffer(maskBlob), [0, 1, 1], affine),
    ).rejects.toThrow();
  });
});

describe("saved registration parsing", () => {
  it("parses the three states", () => {
    expect(
      parseSavedRegistration(registrationAnswer(), identity).current,
    ).toEqual({ status: "not_confirmed" });
    const stale = registrationAnswer(
      { status: "stale", registration_id: "r", inputs: null, result: null },
      2,
    );
    expect(parseSavedRegistration(stale, identity).current).toEqual({
      status: "stale",
      registration_id: "r",
    });
    const saved = parseSavedRegistration(currentAnswer(), identity);
    expect(saved.registration_revision).toBe(1);
    expect(saved.current).toMatchObject({
      status: "current",
      evidence: "verified",
      result: { validated: false, rotation_deg: 4, isocenter_shift_mm: 6.4 },
    });
  });

  const result = (change: Record<string, unknown>) =>
    currentAnswer(savedInputs(), {
      result: { ...(currentAnswer().current.result as object), ...change },
    });
  it.each([
    ["another case", { ...currentAnswer(), case_id: "other" }],
    ["another case revision", { ...currentAnswer(), artifact_version: "8" }],
    [
      "another source revision",
      { ...currentAnswer(), reference_revision: "3".repeat(64) },
    ],
    ["a current record at revision 0", currentAnswer(savedInputs(), {}, 0)],
    [
      "nothing confirmed at revision 1",
      registrationAnswer({ status: "not_confirmed" }, 1),
    ],
    ["a fractional revision", currentAnswer(savedInputs(), {}, 1.5)],
    [
      "an unknown status",
      registrationAnswer({ status: "validated", registration_id: "r" }, 1),
    ],
    ["a validated claim", result({ validated: true })],
    ["another result status", result({ status: "validated_registration" })],
    ["another version", result({ version: "v0" })],
    ["a text rotation", result({ rotation_deg: "4.000" })],
    [
      "an unknown evidence state",
      currentAnswer(savedInputs(), { evidence: "assumed" }),
    ],
    ["an unconfirmed record", currentAnswer(savedInputs({ confirmed: false }))],
    ["another method", currentAnswer(savedInputs({ method: "other" }))],
    [
      "a non-rigid matrix",
      currentAnswer(
        savedInputs({
          volume_to_carm_ras: [
            [2, 0, 0, 0],
            [0, 1, 0, 0],
            [0, 0, 1, 0],
            [0, 0, 0, 1],
          ],
        }),
      ),
    ],
    [
      "an out-of-range view",
      currentAnswer(
        savedInputs({ view: { ...VIEW, source_isocenter_mm: 1300 } }),
      ),
    ],
    [
      "a view with extra fields",
      currentAnswer(savedInputs({ view: { ...VIEW, name: "AP" } })),
    ],
    ["a bad frame digest", currentAnswer(savedInputs({ frame_sha256: "x" }))],
    [
      "a bad frame source",
      currentAnswer(savedInputs({ frame_source_id: "../x" })),
    ],
    [
      "a fractional frame index",
      currentAnswer(savedInputs({ frame_index: 1.5 })),
    ],
    ["an unknown plane", currentAnswer(savedInputs({ plane: "c" }))],
    [
      "a scale without a fit",
      currentAnswer(savedInputs({ detector_scale: 1.2 })),
    ],
    [
      "a fit on manifest geometry",
      currentAnswer(
        savedInputs({
          geometry_source: "frame_manifest",
          fit_detector_scale: true,
        }),
      ),
    ],
    [
      "a scale out of range",
      currentAnswer(
        savedInputs({ fit_detector_scale: true, detector_scale: 2 }),
      ),
    ],
    [
      "a two-number isocenter",
      currentAnswer(savedInputs({ isocenter: [0, 0] })),
    ],
    [
      "a score above one",
      currentAnswer(
        savedInputs({ reported_score: { ...SCORE, matched_fraction: 1.2 } }),
      ),
    ],
    [
      "a score with extra fields",
      currentAnswer(
        savedInputs({ reported_score: { ...SCORE, accuracy_mm: 1 } }),
      ),
    ],
    [
      "an unknown polarity",
      currentAnswer(savedInputs({ polarity: "inverted" })),
    ],
    ["missing inputs", currentAnswer(null)],
  ])("rejects %s", (_, answer) => {
    expect(() => parseSavedRegistration(answer, identity)).toThrow();
  });
});
