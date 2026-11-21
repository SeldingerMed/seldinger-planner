/** Synthetic overlay case shared by the frame, job and studio tests: the
 * angiography phantom's mask as a gzipped NIfTI-1 blob, one frame rendered
 * at a known pose, a frontal and lateral pair rendered at another, and the
 * server answers that describe them. No patient data. */
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
export const CONTAINER = "e".repeat(64);
const EVIDENCE_METHOD = "vessel_evidence_compass_v1",
  EVIDENCE_PAIR_METHOD = "vessel_evidence_compass_biplane_v1";
/** What the server adds to the summary of a vessel evidence record. */
const evidenceSummary = (inputs: Record<string, any>) => ({
  detector_fit: inputs.detector_fit,
  score_source: "browser_reported_not_recomputed",
  score_kind: "mean_vessel_evidence_under_projected_points",
});
/** The server's own summary of confirmed inputs, mirroring `summarize`. */
export function savedResult(inputs: Record<string, any> = savedInputs()) {
  const best = inputs.method === "vessel_evidence_best_start_v1",
    sized = inputs.method === "vessel_evidence_size_search_v1",
    evidence = best || sized || inputs.method === EVIDENCE_METHOD;
  return {
    version: sized
      ? "step-c4-evidence-size-search-registration-v7"
      : best
        ? "step-c4-evidence-best-start-registration-v5"
        : evidence
          ? "step-c4-evidence-registration-v3"
          : "step-c1-projection-registration-v1",
    convention: "dicom_xa_patient_longitude_latitude_ras_v1",
    method: evidence ? inputs.method : "centerline_distance_compass_v1",
    status: "operator_confirmed_proposal",
    validated: false,
    geometry_source: inputs.geometry_source,
    rotation_deg: 4,
    isocenter_shift_mm: 6.4,
    ...(evidence
      ? evidenceSummary(inputs)
      : { score_source: "browser_reported_not_recomputed" }),
    reported_score: inputs.reported_score,
    reported_start_score: inputs.reported_start_score,
  };
}
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
  return {
    ...identity,
    registration_revision: revision,
    current:
      current.status === "stale"
        ? { inputs: null, result: null, ...current }
        : current,
  };
}
/** The server's answer for the vessel-presence report of a registration. */
export function presenceAnswer(
  registrationRevision: number,
  current: Record<string, unknown> = { status: "not_confirmed" },
  revision = 0,
) {
  return {
    ...identity,
    registration_revision: registrationRevision,
    report_revision: revision,
    current:
      current.status === "stale"
        ? { inputs: null, result: null, ...current }
        : current,
  };
}
/** The server's own summary of a confirmed report, mirroring `summarize`
 * in `planner/vessel_presence.py`. Lengths are rounded to a micrometer. */
export function presenceResult(inputs: Record<string, any>) {
  const round = (value: number) => Math.round(value * 1000) / 1000,
    sum = (values: number[]) => round(values.reduce((a, b) => a + b, 0)),
    names = ["supported", "no_2d_support", "outside_field", "indeterminate"];
  return {
    version: "step-c3-vessel-presence-v1",
    method: "segment_centerline_support_v1",
    segment_method: "mask_band_sweep_v1",
    status: "operator_confirmed_report",
    validated: false,
    cause: "not_asserted",
    counts_source: "browser_reported_not_recomputed",
    segment_count: inputs.segments.length,
    segment_length_mm: sum(inputs.segments.map((s: any) => s.length_mm)),
    unassigned_fraction: inputs.unassigned_fraction,
    planes: inputs.planes.map((plane: any) => ({
      plane: plane.plane,
      classes: Object.fromEntries(
        names.map((name) => {
          const mine = inputs.segments.filter(
            (_: unknown, k: number) => plane.segments[k].presence === name,
          );
          return [
            name,
            {
              count: mine.length,
              length_mm: sum(mine.map((s: any) => s.length_mm)),
            },
          ];
        }),
      ),
      unmatched_count: plane.unmatched_mm.length,
      unmatched_length_mm: sum(plane.unmatched_mm),
    })),
  };
}
/** A current report as the server answers it, for confirmed `inputs`. */
export function presenceCurrent(
  inputs: Record<string, any>,
  change: Record<string, unknown> = {},
  revision = 1,
) {
  return presenceAnswer(
    inputs.registration_revision,
    {
      status: "current",
      report_id: "report-1",
      dependencies: {
        ...identity,
        version: "step-c3-vessel-presence-v1",
        registration_id: inputs.registration_id,
        registration_revision: inputs.registration_revision,
        registration_input_sha256: inputs.registration_input_sha256,
      },
      input_sha256: "9".repeat(64),
      inputs,
      result: presenceResult(inputs),
      ...change,
    },
    revision,
  );
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
      dependencies: {
        ...identity,
        version: savedResult((inputs ?? savedInputs()) as Record<string, any>)
          .version,
      },
      input_sha256: "f".repeat(64),
      inputs,
      result: savedResult((inputs ?? savedInputs()) as Record<string, any>),
      ...change,
    },
    revision,
  );
}

/** A declared pair: plane A is the frontal view above, plane B a lateral
 * one. Both were rendered at one pose that is off in every freedom,
 * including along each beam. */
export const VIEW_B: ViewNumbers = { ...VIEW, primary_deg: 90 };
export const pairTruth = rigid([3, -4, 4], [5, 6, -4], pivot);
export const pairGray = [VIEW, VIEW_B].map((view, k) =>
  renderFrame(view, pivot, pairTruth, {
    width: SIDE,
    height: SIDE,
    polarity: "dark",
    noise: 12,
    seed: 11 + k,
  }),
) as [Uint8Array, Uint8Array];
export function pairBundleAnswer(change: Record<string, unknown> = {}) {
  const single = bundleAnswer().manifest.planes[0];
  return bundleAnswer({
    biplane_linkage: "operator_declared",
    planes: ["a", "b"].map((plane, k) => ({
      ...single,
      plane,
      frames: [
        { index: 12, sha256: hex(pairGray[k]), input_sha256: "c".repeat(64) },
        { index: 30, sha256: "d".repeat(64), input_sha256: "c".repeat(64) },
      ],
    })),
    ...change,
  });
}
export function savedPairInputs(change: Record<string, unknown> = {}) {
  return {
    confirmed: true,
    same_position_attested: true,
    frame_source_id: "phantom-run",
    frame_manifest_revision: REVISION,
    mask_candidate_id: maskEntry.candidate_id,
    mask_sha256: maskEntry.mask_sha256,
    isocenter: [...pivot] as Vec3,
    volume_to_carm_ras: pairTruth,
    method: "centerline_distance_compass_biplane_v1",
    planes: ["a", "b"].map((plane, k) => ({
      plane,
      frame_index: 12,
      frame_sha256: hex(pairGray[k]),
      geometry_source: "operator_entered",
      view: k ? VIEW_B : VIEW,
      fit_detector_scale: false,
      detector_scale: 1,
      polarity: "dark",
      sensitivity: 0.5,
      reported_score: SCORE,
      reported_start_score: { ...SCORE, mean_distance_mm: 5.5 + k },
    })),
    ...change,
  };
}
/** The server's own summary of a two-plane record, mirroring `summarize`.
 * Both fixture views have no secondary angle, so the angle between their
 * central rays is the difference of their primary angles, folded to 90. */
export function savedPairResult(inputs: Record<string, any>) {
  const primary = (k: number) => inputs.planes[k]?.view?.primary_deg ?? 0,
    apart = Math.abs(primary(0) - primary(1)),
    best = inputs.method === "vessel_evidence_best_start_biplane_v1",
    sized = inputs.method === "vessel_evidence_size_search_biplane_v1",
    evidence = best || sized || inputs.method === EVIDENCE_PAIR_METHOD;
  return {
    version: sized
      ? "step-c4-evidence-size-search-biplane-registration-v8"
      : best
        ? "step-c4-evidence-best-start-biplane-registration-v6"
        : evidence
          ? "step-c4-evidence-biplane-registration-v4"
          : "step-c2-biplane-registration-v2",
    convention: "dicom_xa_patient_longitude_latitude_ras_v1",
    method: evidence ? inputs.method : "centerline_distance_compass_biplane_v1",
    status: "operator_confirmed_proposal",
    validated: false,
    same_position: "operator_attested_not_checked",
    plane_angle_deg: Math.min(apart, 180 - apart),
    rotation_deg: 6.4,
    isocenter_shift_mm: 8.8,
    ...(evidence
      ? evidenceSummary(inputs)
      : { score_source: "browser_reported_not_recomputed" }),
    planes: inputs.planes.map((plane: Record<string, unknown>) => ({
      plane: plane.plane,
      geometry_source: plane.geometry_source,
      reported_score: plane.reported_score,
      reported_start_score: plane.reported_start_score,
    })),
  };
}
export function currentPairAnswer(
  inputs: Record<string, any> = savedPairInputs(),
  change: Record<string, unknown> = {},
  revision = 1,
) {
  return registrationAnswer(
    {
      status: "current",
      registration_id: "registration-2",
      evidence: "verified",
      dependencies: {
        ...identity,
        version: savedPairResult(inputs).version,
      },
      input_sha256: "f".repeat(64),
      inputs,
      result: savedPairResult(inputs),
      ...change,
    },
    revision,
  );
}

/** A vessel evidence score: no distance, and no sensitivity beside it. */
export const EVIDENCE_SCORE = {
  mean_evidence: 0.21,
  in_field_fraction: 1,
  uncovered_fraction: 0.1,
};
/** A single-plane record of the vessel evidence method. */
export function savedEvidenceInputs(change: Record<string, unknown> = {}) {
  const { sensitivity: _none, ...rest } = savedInputs();
  return {
    ...rest,
    method: EVIDENCE_METHOD,
    detector_fit: "not_requested",
    reported_score: EVIDENCE_SCORE,
    reported_start_score: { ...EVIDENCE_SCORE, mean_evidence: 0.12 },
    ...change,
  };
}
/** A two-plane record of the vessel evidence method. */
export function savedEvidencePairInputs(change: Record<string, unknown> = {}) {
  const base = savedPairInputs();
  return {
    ...base,
    method: EVIDENCE_PAIR_METHOD,
    detector_fit: "not_requested",
    planes: base.planes.map(({ sensitivity: _none, ...plane }, k) => ({
      ...plane,
      reported_score: EVIDENCE_SCORE,
      reported_start_score: {
        ...EVIDENCE_SCORE,
        mean_evidence: 0.12 + k / 100,
      },
    })),
    ...change,
  };
}
