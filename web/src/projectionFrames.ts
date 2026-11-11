/** Admitted angiographic pixel frames and the saved 2D-to-3D registration
 * proposal: strict parsing of what the server returns, and verification of
 * every pixel buffer against its manifest digest before anything is drawn.
 * Nothing here sends pixels anywhere. */
import { sha256Hex } from "./browserCrypto";
import { validateView, type ViewNumbers } from "./carmGeometry";
import type { Vec3 } from "./obliqueSlice";
import {
  PROJECTION_REGISTRATION_LIMITS,
  PROJECTION_REGISTRATION_METHOD,
  type RegistrationScore,
} from "./projectionRegistration";
import { validateRigid } from "./rigidFusion";
import type { Identity } from "./territoryWorkflow";
import type { Polarity } from "./vesselness2d";

export const FRAME_LIMITS = {
  max_planes: 2,
  max_frames_per_plane: 8,
  min_side: 64,
  max_side: 1024,
  max_frame_index: 1_000_000,
} as const;
export const REGISTRATION_VERSION = "step-c1-projection-registration-v1";
export const FRAME_SOURCE_ID = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const SHA = /^[a-f0-9]{64}$/;
const VIEW_KEYS = [
  "primary_deg",
  "secondary_deg",
  "source_detector_mm",
  "source_isocenter_mm",
  "detector_width_mm",
  "detector_height_mm",
] as const;

export type PlaneLabel = "single" | "a" | "b";
export type FramePlane = {
  plane: PlaneLabel;
  rows: number;
  columns: number;
  /** Acquisition geometry, kept only for an uncropped calibrated DICOM plane. */
  geometry: ViewNumbers | null;
  basis:
    | "dicom_declared_no_burned_in_annotation"
    | "operator_attested_crop_and_redaction";
  cropped: boolean;
  frames: { index: number; sha256: string }[];
};
export type FrameBundle = {
  source_id: string;
  manifest_revision: string;
  scope: "synthetic" | "public" | "authorized";
  method: "admitted_png_frames" | "admitted_dicom_xa_frames";
  planes: FramePlane[];
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const integer = (value: unknown, low: number, high: number): number => {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < low ||
    value > high
  )
    throw new Error("Invalid frame manifest");
  return value;
};
function fail(): never {
  throw new Error("Invalid frame manifest");
}

function parseView(value: unknown): ViewNumbers {
  if (
    !isObject(value) ||
    Object.keys(value).length !== VIEW_KEYS.length ||
    VIEW_KEYS.some((key) => typeof value[key] !== "number")
  )
    throw new Error("Invalid view");
  return validateView(
    Object.fromEntries(
      VIEW_KEYS.map((key) => [key, value[key]]),
    ) as ViewNumbers,
  );
}

/** Parses `GET /api/projection-frames/{id}`. The server has already applied
 * the full contract; this re-checks everything the browser acts on. */
export function parseFrameBundle(
  value: unknown,
  sourceId: string,
): FrameBundle {
  if (!isObject(value) || !isObject(value.manifest)) fail();
  const manifest = value.manifest;
  if (
    value.source_id !== sourceId ||
    typeof value.manifest_revision !== "string" ||
    !SHA.test(value.manifest_revision) ||
    manifest.version !== 1 ||
    manifest.kind !== "projection_frames" ||
    manifest.clinical_validation !== false ||
    manifest.pixel_format !== "gray8" ||
    !["synthetic", "public", "authorized"].includes(manifest.scope as string) ||
    !["admitted_png_frames", "admitted_dicom_xa_frames"].includes(
      manifest.method as string,
    ) ||
    !Array.isArray(manifest.planes) ||
    manifest.planes.length < 1 ||
    manifest.planes.length > FRAME_LIMITS.max_planes
  )
    fail();
  const planes = (manifest.planes as unknown[]).map((raw): FramePlane => {
    if (!isObject(raw) || !isObject(raw.deidentification)) fail();
    const deid = raw.deidentification;
    if (
      !["single", "a", "b"].includes(raw.plane as string) ||
      ![
        "dicom_declared_no_burned_in_annotation",
        "operator_attested_crop_and_redaction",
      ].includes(deid.basis as string) ||
      !Array.isArray(raw.frames) ||
      raw.frames.length < 1 ||
      raw.frames.length > FRAME_LIMITS.max_frames_per_plane
    )
      fail();
    const cropped = deid.crop !== null;
    let geometry: ViewNumbers | null = null;
    if (raw.geometry !== null) {
      if (cropped || manifest.method !== "admitted_dicom_xa_frames") fail();
      try {
        geometry = parseView(raw.geometry);
      } catch {
        fail();
      }
    }
    const frames = (raw.frames as unknown[]).map((frame) => {
      if (
        !isObject(frame) ||
        typeof frame.sha256 !== "string" ||
        !SHA.test(frame.sha256)
      )
        fail();
      return {
        index: integer(frame.index, 0, FRAME_LIMITS.max_frame_index),
        sha256: frame.sha256,
      };
    });
    if (frames.some((frame, i) => i > 0 && frame.index <= frames[i - 1].index))
      fail();
    return {
      plane: raw.plane as PlaneLabel,
      rows: integer(raw.rows, FRAME_LIMITS.min_side, FRAME_LIMITS.max_side),
      columns: integer(
        raw.columns,
        FRAME_LIMITS.min_side,
        FRAME_LIMITS.max_side,
      ),
      geometry,
      basis: deid.basis as FramePlane["basis"],
      cropped,
      frames,
    };
  });
  const labels = planes.map((plane) => plane.plane).join(",");
  if (labels !== "single" && labels !== "a,b") fail();
  return {
    source_id: sourceId,
    manifest_revision: value.manifest_revision,
    scope: manifest.scope as FrameBundle["scope"],
    method: manifest.method as FrameBundle["method"],
    planes,
  };
}

export async function loadFrameBundle(sourceId: string): Promise<FrameBundle> {
  if (!FRAME_SOURCE_ID.test(sourceId)) throw new Error("Invalid frame source");
  const response = await fetch(`/api/projection-frames/${sourceId}`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Frame bundle unavailable");
  return parseFrameBundle(await response.json(), sourceId);
}

export type VerifiedFrame = {
  source_id: string;
  manifest_revision: string;
  plane: PlaneLabel;
  index: number;
  sha256: string;
  width: number;
  height: number;
  /** Row-major 8-bit display brightness, verified against `sha256`. */
  gray: Uint8Array;
};

/** Fetches one frame and returns it only if its length, its digest and the
 * manifest revision it was served under all match the bundle. */
export async function loadVerifiedFrame(
  bundle: FrameBundle,
  planeLabel: PlaneLabel,
  index: number,
): Promise<VerifiedFrame> {
  const plane = bundle.planes.find((item) => item.plane === planeLabel),
    frame = plane?.frames.find((item) => item.index === index);
  if (!plane || !frame) throw new Error("Unknown frame");
  const response = await fetch(
    `/api/projection-frames/${bundle.source_id}/planes/${plane.plane}/frames/${frame.index}`,
    { cache: "no-store" },
  );
  const size = plane.rows * plane.columns;
  if (
    !response.ok ||
    response.headers.get("X-Frame-Manifest-Revision") !==
      bundle.manifest_revision ||
    Number(response.headers.get("Content-Length") ?? size) !== size
  )
    throw new Error("Frame unavailable");
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength !== size || (await sha256Hex(buffer)) !== frame.sha256)
    throw new Error("Frame integrity check failed");
  return {
    source_id: bundle.source_id,
    manifest_revision: bundle.manifest_revision,
    plane: plane.plane,
    index: frame.index,
    sha256: frame.sha256,
    width: plane.columns,
    height: plane.rows,
    gray: new Uint8Array(buffer),
  };
}

async function gunzip(buffer: ArrayBuffer, cap: number): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(buffer));
        controller.close();
      },
    }),
    reader = source
      .pipeThrough(
        new DecompressionStream("gzip") as unknown as ReadableWritablePair<
          Uint8Array,
          Uint8Array
        >,
      )
      .getReader(),
    chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel();
      throw new Error("Vessel mask exceeds its bound");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Voxels of a verified vessel-mask blob (gzipped NIfTI-1, unsigned 8-bit,
 * zero or one) on the grid of the loaded source. The mask is accepted only
 * if its dimensions equal the source's and its own affine, when it stores
 * one, agrees with the source affine; the source affine is the one used. */
export async function decodeVesselMask(
  buffer: ArrayBuffer,
  shape: readonly [number, number, number],
  affine: number[][],
): Promise<Uint8Array> {
  const count = shape[0] * shape[1] * shape[2];
  if (!Number.isInteger(count) || count < 1 || count > 600_000_000)
    throw new Error("Unsupported vessel mask grid");
  const bytes = await gunzip(buffer, 352 + count + 4096);
  if (bytes.length < 352) throw new Error("Unsupported vessel mask");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    offset = view.getFloat32(108, true);
  if (
    view.getInt32(0, true) !== 348 ||
    String.fromCharCode(...bytes.subarray(344, 347)) !== "n+1" ||
    view.getInt16(40, true) !== 3 ||
    [0, 1, 2].some((k) => view.getInt16(42 + 2 * k, true) !== shape[k]) ||
    view.getInt16(70, true) !== 2 ||
    view.getInt16(72, true) !== 8 ||
    !Number.isInteger(offset) ||
    offset < 352 ||
    offset + count !== bytes.length
  )
    throw new Error("Vessel mask does not match the loaded source");
  const slope = view.getFloat32(112, true),
    inter = view.getFloat32(116, true);
  if ((slope !== 0 && slope !== 1) || (slope !== 0 && inter !== 0))
    throw new Error("Unsupported vessel mask scaling");
  if (view.getInt16(254, true) > 0)
    for (let row = 0; row < 3; row++)
      for (let column = 0; column < 4; column++) {
        const stored = view.getFloat32(280 + 4 * (4 * row + column), true),
          expected = affine[row][column];
        if (!(Math.abs(stored - expected) <= 1e-3 + 1e-5 * Math.abs(expected)))
          throw new Error("Vessel mask does not match the loaded source");
      }
  const voxels = bytes.subarray(offset);
  for (let i = 0; i < voxels.length; i++)
    if (voxels[i] > 1) throw new Error("Vessel mask is not binary");
  return voxels;
}

export type RegistrationInputs = {
  confirmed: true;
  frame_source_id: string;
  frame_manifest_revision: string;
  plane: PlaneLabel;
  frame_index: number;
  frame_sha256: string;
  mask_candidate_id: string;
  mask_sha256: string;
  geometry_source: "frame_manifest" | "operator_entered";
  /** The view the proposal was scored in. With a fitted detector scale, its
   * detector size is the entered size times `detector_scale`. */
  view: ViewNumbers;
  fit_detector_scale: boolean;
  detector_scale: number;
  isocenter: Vec3;
  volume_to_carm_ras: number[][];
  method: typeof PROJECTION_REGISTRATION_METHOD;
  polarity: Polarity;
  sensitivity: number;
  reported_score: RegistrationScore;
  reported_start_score: RegistrationScore;
};
export type RegistrationResult = {
  status: "operator_confirmed_proposal";
  validated: false;
  rotation_deg: number;
  isocenter_shift_mm: number;
};
export type RegistrationCurrent =
  | { status: "not_confirmed" }
  | { status: "stale"; registration_id: string }
  | {
      status: "current";
      registration_id: string;
      /** Whether the frame and mask the record names are still installed
       * and unchanged. */
      evidence: "verified" | "unavailable";
      inputs: RegistrationInputs;
      result: RegistrationResult;
    };
export type SavedRegistration = Identity & {
  registration_revision: number;
  current: RegistrationCurrent;
};

const fraction = (value: unknown) =>
  typeof value === "number" && value >= 0 && value <= 1;
function parseScore(value: unknown): RegistrationScore {
  if (
    !isObject(value) ||
    Object.keys(value).length !== 4 ||
    typeof value.mean_distance_mm !== "number" ||
    !(value.mean_distance_mm >= 0 && value.mean_distance_mm <= 1000) ||
    !fraction(value.matched_fraction) ||
    !fraction(value.in_field_fraction) ||
    !fraction(value.uncovered_fraction)
  )
    throw new Error("Invalid score");
  return value as RegistrationScore;
}

function parseInputs(value: unknown): RegistrationInputs {
  if (!isObject(value)) throw new Error("Invalid registration");
  const [low, high] = PROJECTION_REGISTRATION_LIMITS.detector_scale;
  if (
    value.confirmed !== true ||
    typeof value.frame_source_id !== "string" ||
    !FRAME_SOURCE_ID.test(value.frame_source_id) ||
    ![
      value.frame_manifest_revision,
      value.frame_sha256,
      value.mask_sha256,
    ].every((item) => typeof item === "string" && SHA.test(item)) ||
    !["single", "a", "b"].includes(value.plane as string) ||
    typeof value.mask_candidate_id !== "string" ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(value.mask_candidate_id) ||
    !["frame_manifest", "operator_entered"].includes(
      value.geometry_source as string,
    ) ||
    typeof value.fit_detector_scale !== "boolean" ||
    typeof value.detector_scale !== "number" ||
    !(value.detector_scale >= low && value.detector_scale <= high) ||
    (!value.fit_detector_scale && value.detector_scale !== 1) ||
    (value.fit_detector_scale &&
      value.geometry_source !== "operator_entered") ||
    !Array.isArray(value.isocenter) ||
    value.isocenter.length !== 3 ||
    !value.isocenter.every(
      (x) => typeof x === "number" && Number.isFinite(x),
    ) ||
    value.method !== PROJECTION_REGISTRATION_METHOD ||
    !["dark", "bright"].includes(value.polarity as string) ||
    !fraction(value.sensitivity)
  )
    throw new Error("Invalid registration");
  integer(value.frame_index, 0, FRAME_LIMITS.max_frame_index);
  parseView(value.view);
  validateRigid(value.volume_to_carm_ras);
  parseScore(value.reported_score);
  parseScore(value.reported_start_score);
  return value as RegistrationInputs;
}

/** Parses `GET` and `PUT /api/cases/{id}/projection-registration` and binds
 * the answer to the identity that was asked about. */
export function parseSavedRegistration(
  value: unknown,
  identity: Identity,
): SavedRegistration {
  if (!isObject(value) || !isObject(value.current))
    throw new Error("Invalid registration");
  const current = value.current,
    revision = value.registration_revision;
  if (
    (Object.keys(identity) as (keyof Identity)[]).some(
      (key) => value[key] !== identity[key],
    ) ||
    typeof revision !== "number" ||
    !Number.isInteger(revision) ||
    revision < 0
  )
    throw new Error("Registration belongs to another case revision");
  const base = { ...identity, registration_revision: revision };
  if (current.status === "not_confirmed") {
    if (revision !== 0) throw new Error("Invalid registration");
    return { ...base, current: { status: "not_confirmed" } };
  }
  if (revision < 1 || typeof current.registration_id !== "string")
    throw new Error("Invalid registration");
  if (current.status === "stale")
    return {
      ...base,
      current: { status: "stale", registration_id: current.registration_id },
    };
  const result = current.result;
  if (
    current.status !== "current" ||
    !["verified", "unavailable"].includes(current.evidence as string) ||
    !isObject(result) ||
    result.version !== REGISTRATION_VERSION ||
    result.status !== "operator_confirmed_proposal" ||
    result.validated !== false ||
    typeof result.rotation_deg !== "number" ||
    typeof result.isocenter_shift_mm !== "number"
  )
    throw new Error("Invalid registration");
  return {
    ...base,
    current: {
      status: "current",
      registration_id: current.registration_id,
      evidence: current.evidence as "verified" | "unavailable",
      inputs: parseInputs(current.inputs),
      result: {
        status: "operator_confirmed_proposal",
        validated: false,
        rotation_deg: result.rotation_deg,
        isocenter_shift_mm: result.isocenter_shift_mm,
      },
    },
  };
}
