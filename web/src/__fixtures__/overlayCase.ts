/** Synthetic overlay case shared by the frame, job and studio tests: the
 * angiography phantom's mask as a gzipped NIfTI-1 blob, one frame rendered
 * at a known pose, and the server answers that describe them. No patient
 * data. */
import { gzipSync } from "node:zlib";
import { sha256 } from "@noble/hashes/sha2.js";
import type { NVImage } from "@niivue/niivue";
import type { ViewNumbers } from "../carmGeometry";
import { centroid, medialPoints } from "../maskPoints";
import type { Vec3 } from "../obliqueSlice";
import { renderFrame, rigid, treeMask } from "./angioPhantom";

export const hex = (bytes: Uint8Array) =>
  [...sha256(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

export const VIEW: ViewNumbers = {
  primary_deg: 0,
  secondary_deg: 0,
  source_detector_mm: 1200,
  source_isocenter_mm: 800,
  detector_width_mm: 180,
  detector_height_mm: 180,
};
export const SIDE = 300;
export const phantom = treeMask(1);
export const medial = medialPoints(phantom.mask, phantom.shape, phantom.affine);
export const pivot = centroid(medial.points);
/** The pose the frame was rendered at: 4 degrees in plane and a few mm. */
export const truth = rigid([0, 0, 4], [5, 0, -4], pivot);
export const gray = renderFrame(VIEW, pivot, truth, {
  width: SIDE,
  height: SIDE,
  polarity: "dark",
  noise: 12,
  seed: 7,
});

/** NIfTI-1 single-file bytes for an unsigned 8-bit volume. */
export function nifti(
  voxels: Uint8Array,
  shape: readonly number[],
  affine: number[][],
  change: (view: DataView) => void = () => {},
): Uint8Array {
  const bytes = new Uint8Array(352 + voxels.length),
    view = new DataView(bytes.buffer);
  view.setInt32(0, 348, true);
  [3, ...shape, 1, 1, 1, 1].forEach((n, i) =>
    view.setInt16(40 + 2 * i, n, true),
  );
  view.setInt16(70, 2, true);
  view.setInt16(72, 8, true);
  view.setFloat32(108, 352, true);
  view.setFloat32(112, 1, true);
  view.setInt8(123, 2);
  view.setInt16(254, 1, true);
  for (let row = 0; row < 3; row++)
    for (let column = 0; column < 4; column++)
      view.setFloat32(280 + 4 * (4 * row + column), affine[row][column], true);
  bytes.set([0x6e, 0x2b, 0x31, 0], 344);
  change(view);
  bytes.set(voxels, 352);
  return bytes;
}
export const maskBlob = new Uint8Array(
  gzipSync(nifti(phantom.mask, phantom.shape, phantom.affine)),
);

export const volume = {
  hdr: {
    dims: [3, ...phantom.shape, 1, 1, 1, 1],
    datatypeCode: 2,
    xyzt_units: 2,
    scl_slope: 1,
    scl_inter: 0,
  },
  getAffine: () => phantom.affine,
  img: new Uint8Array(phantom.mask.length),
} as unknown as NVImage;

export const binding = {
  case_id: "case-overlay-1",
  image_sha256: "1".repeat(64),
  reference_revision: "2".repeat(64),
};
export const identity = { ...binding, artifact_version: "7" };
export const caseState = { ...identity, spatial_units: "mm" as const };
export const maskEntry = {
  candidate_id: "vessel-candidate-1",
  case_id: binding.case_id,
  image_sha256: binding.image_sha256,
  reference_revision: binding.reference_revision,
  produced_artifact_version: "6",
  producer: "rsna_vessel_model",
  role: "vessel",
  mask_sha256: hex(maskBlob),
  mask_url: `/api/cases/${binding.case_id}/segmentations/vessel-candidate-1/mask`,
  status: "accepted",
  segmentation_revision: 1,
  provenance: {},
};
export const REVISION = "a".repeat(64);
export function bundleAnswer(change: Record<string, unknown> = {}) {
  return {
    source_id: "phantom-run",
    manifest_revision: REVISION,
    manifest: {
      version: 1,
      kind: "projection_frames",
      clinical_validation: false,
      scope: "synthetic",
      method: "admitted_png_frames",
      pixel_format: "gray8",
      biplane_linkage: "not_applicable",
      planes: [
        {
          plane: "single",
          rows: SIDE,
          columns: SIDE,
          container_sha256: null,
          container_bytes: null,
          deidentification: {
            basis: "operator_attested_crop_and_redaction",
            burned_in_annotation: "not_declared",
            source_rows: 480,
            source_columns: 720,
            crop: [100, 50, SIDE, SIDE],
            redactions: [],
          },
          geometry: null,
          frames: [
            { index: 12, sha256: hex(gray), input_sha256: "c".repeat(64) },
            { index: 30, sha256: "d".repeat(64), input_sha256: "c".repeat(64) },
          ],
        },
      ],
      ...change,
    },
  };
}
export const SCORE = {
  mean_distance_mm: 0.4,
  matched_fraction: 0.95,
  in_field_fraction: 1,
  uncovered_fraction: 0.1,
};
export function registrationAnswer(
  current: Record<string, unknown> = { status: "not_confirmed" },
  revision = 0,
) {
  return { ...identity, registration_revision: revision, current };
}
export function savedInputs(change: Record<string, unknown> = {}) {
  return {
    confirmed: true,
    frame_source_id: "phantom-run",
    frame_manifest_revision: REVISION,
    plane: "single",
    frame_index: 12,
    frame_sha256: hex(gray),
    mask_candidate_id: maskEntry.candidate_id,
    mask_sha256: maskEntry.mask_sha256,
    geometry_source: "operator_entered",
    view: VIEW,
    fit_detector_scale: false,
    detector_scale: 1,
    isocenter: [...pivot] as Vec3,
    volume_to_carm_ras: truth,
    method: "centerline_distance_compass_v1",
    polarity: "dark",
    sensitivity: 0.5,
    reported_score: SCORE,
    reported_start_score: { ...SCORE, mean_distance_mm: 5.5 },
    ...change,
  };
}
export function currentAnswer(
  inputs: unknown = savedInputs(),
  change: Record<string, unknown> = {},
  revision = 1,
) {
  return registrationAnswer(
    {
      status: "current",
      registration_id: "registration-1",
      evidence: "verified",
      inputs,
      result: {
        version: "step-c1-projection-registration-v1",
        status: "operator_confirmed_proposal",
        validated: false,
        rotation_deg: 4,
        isocenter_shift_mm: 6.4,
      },
      ...change,
    },
    revision,
  );
}
