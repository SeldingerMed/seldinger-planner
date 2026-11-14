/** Admitted angiographic pixel frames and the saved 2D-to-3D registration
 * proposal, single-plane or two-plane: strict parsing of what the server
 * returns, and verification of
 * every pixel buffer against its manifest digest before anything is drawn.
 * Nothing here sends pixels anywhere. */
import {
  BIPLANE_REGISTRATION_METHOD,
  planeAngleDeg,
  planesFarEnough,
} from "./biplaneRegistration";
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
export const BIPLANE_REGISTRATION_VERSION = "step-c2-biplane-registration-v2";
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
/** Closed DTO key sets are mirrored from the Python producers, not a UI fixture. */
function exact(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    isObject(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}
const digest = (value: unknown): value is string =>
  typeof value === "string" && SHA.test(value);
const integer = (value: unknown, low: number, high: number): number => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
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
  if (
    !exact(value, ["source_id", "manifest_revision", "manifest"]) ||
    !exact(value.manifest, [
      "version",
      "kind",
      "clinical_validation",
      "scope",
      "method",
      "pixel_format",
      "biplane_linkage",
      "planes",
    ])
  )
    fail();
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
    if (
      !exact(raw, [
        "plane",
        "rows",
        "columns",
        "container_sha256",
        "container_bytes",
        "deidentification",
        "geometry",
        "frames",
      ]) ||
      !exact(raw.deidentification, [
        "basis",
        "burned_in_annotation",
        "source_rows",
        "source_columns",
        "crop",
        "redactions",
      ])
    )
      fail();
    const deid = raw.deidentification;
    const rows = integer(
      raw.rows,
      FRAME_LIMITS.min_side,
      FRAME_LIMITS.max_side,
    );
    const columns = integer(
      raw.columns,
      FRAME_LIMITS.min_side,
      FRAME_LIMITS.max_side,
    );
    const sourceRows = integer(deid.source_rows, 1, 4096);
    const sourceColumns = integer(deid.source_columns, 1, 4096);
    const rectangle = (value: unknown): number[] => {
      if (!Array.isArray(value) || value.length !== 4) fail();
      const [x, y, width, height] = Array.from(value, (n) =>
        integer(n, 0, 4096),
      );
      if (
        width < 1 ||
        height < 1 ||
        x + width > sourceColumns ||
        y + height > sourceRows
      )
        fail();
      return [x, y, width, height];
    };
    if (deid.crop === null) {
      if (rows !== sourceRows || columns !== sourceColumns) fail();
    } else {
      const crop = rectangle(deid.crop);
      if (rows !== crop[3] || columns !== crop[2]) fail();
    }
    if (!Array.isArray(deid.redactions) || deid.redactions.length > 16) fail();
    for (const redaction of deid.redactions) rectangle(redaction);
    if (manifest.method === "admitted_png_frames") {
      if (
        deid.burned_in_annotation !== "not_declared" ||
        deid.crop === null ||
        deid.basis !== "operator_attested_crop_and_redaction"
      )
        fail();
    } else if (deid.burned_in_annotation === "no") {
      if (deid.basis !== "dicom_declared_no_burned_in_annotation") fail();
    } else if (
      ["yes", "unknown"].includes(deid.burned_in_annotation as string)
    ) {
      if (
        deid.basis !== "operator_attested_crop_and_redaction" ||
        (deid.crop === null && deid.redactions.length === 0)
      )
        fail();
    } else fail();
    if (raw.container_sha256 === null) {
      if (
        raw.container_bytes !== null ||
        manifest.method !== "admitted_png_frames"
      )
        fail();
    } else {
      if (!digest(raw.container_sha256)) fail();
      integer(raw.container_bytes, 1, 2 ** 40);
    }
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
        !exact(frame, ["index", "sha256", "input_sha256"]) ||
        !digest(frame.sha256) ||
        !digest(frame.input_sha256) ||
        (manifest.method === "admitted_dicom_xa_frames" &&
          frame.input_sha256 !== raw.container_sha256)
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
  if (
    (labels === "single" && manifest.biplane_linkage === "not_applicable") ||
    (labels === "a,b" && manifest.biplane_linkage === "operator_declared")
  ) {
    // Linkage is a declaration, not a verified correspondence.
  } else fail();
  return {
    source_id: sourceId,
    manifest_revision: value.manifest_revision,
    scope: manifest.scope as FrameBundle["scope"],
    method: manifest.method as FrameBundle["method"],
    planes,
  };
}

export async function loadFrameBundle(
  sourceId: string,
  signal?: AbortSignal,
): Promise<FrameBundle> {
  if (!FRAME_SOURCE_ID.test(sourceId)) throw new Error("Invalid frame source");
  const response = await fetch(`/api/projection-frames/${sourceId}`, {
    cache: "no-store",
    ...(signal ? { signal } : {}),
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
  signal?: AbortSignal,
): Promise<VerifiedFrame> {
  const plane = bundle.planes.find((item) => item.plane === planeLabel),
    frame = plane?.frames.find((item) => item.index === index);
  if (!plane || !frame) throw new Error("Unknown frame");
  const response = await fetch(
    `/api/projection-frames/${bundle.source_id}/planes/${plane.plane}/frames/${frame.index}`,
    { cache: "no-store", ...(signal ? { signal } : {}) },
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
    String.fromCharCode(...bytes.subarray(344, 348)) !== "n+1\0" ||
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
  const chunk = 1_048_576;
  for (let start = 0; start < voxels.length; start += chunk) {
    for (let i = start; i < Math.min(start + chunk, voxels.length); i++)
      if (voxels[i] > 1) throw new Error("Vessel mask is not binary");
    if (start + chunk < voxels.length)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return voxels;
}

/** What a confirmed record states about one plane. */
type PlaneFields = {
  frame_index: number;
  frame_sha256: string;
  geometry_source: "frame_manifest" | "operator_entered";
  /** The view the proposal was scored in. With a fitted detector scale, its
   * detector size is the entered size times `detector_scale`. */
  view: ViewNumbers;
  fit_detector_scale: boolean;
  detector_scale: number;
  polarity: Polarity;
  sensitivity: number;
  reported_score: RegistrationScore;
  reported_start_score: RegistrationScore;
};
type SharedFields = {
  confirmed: true;
  frame_source_id: string;
  frame_manifest_revision: string;
  mask_candidate_id: string;
  mask_sha256: string;
  isocenter: Vec3;
  volume_to_carm_ras: number[][];
};
/** Version 1: one pose against one frame. */
export type RegistrationInputs = SharedFields &
  PlaneFields & {
    plane: PlaneLabel;
    method: typeof PROJECTION_REGISTRATION_METHOD;
  };
export type BiplanePlaneInputs = PlaneFields & { plane: "a" | "b" };
/** Version 2: one pose against one frame from each plane of a declared
 * pair. The operator attests that both frames show the patient in the same
 * position; nothing checks it. */
export type BiplaneRegistrationInputs = SharedFields & {
  same_position_attested: true;
  method: typeof BIPLANE_REGISTRATION_METHOD;
  planes: [BiplanePlaneInputs, BiplanePlaneInputs];
};
export type SavedInputs = RegistrationInputs | BiplaneRegistrationInputs;
export const isBiplane = (
  inputs: SavedInputs,
): inputs is BiplaneRegistrationInputs =>
  inputs.method === BIPLANE_REGISTRATION_METHOD;
export type RegistrationResult = {
  status: "operator_confirmed_proposal";
  validated: false;
  rotation_deg: number;
  isocenter_shift_mm: number;
  /** Angle between the two central rays; null for a single-plane record. */
  plane_angle_deg: number | null;
};
export type RegistrationCurrent =
  | { status: "not_confirmed" }
  | { status: "stale"; registration_id: string }
  | {
      status: "current";
      registration_id: string;
      /** Whether every frame and the mask the record names are still
       * installed and unchanged. */
      evidence: "verified" | "unavailable";
      inputs: SavedInputs;
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

const SHARED_KEYS = [
  "confirmed",
  "frame_source_id",
  "frame_manifest_revision",
  "mask_candidate_id",
  "mask_sha256",
  "isocenter",
  "volume_to_carm_ras",
  "method",
] as const;
const PLANE_KEYS = [
  "plane",
  "frame_index",
  "frame_sha256",
  "geometry_source",
  "view",
  "fit_detector_scale",
  "detector_scale",
  "polarity",
  "sensitivity",
  "reported_score",
  "reported_start_score",
] as const;

function checkShared(value: Record<string, unknown>) {
  if (
    value.confirmed !== true ||
    typeof value.frame_source_id !== "string" ||
    !FRAME_SOURCE_ID.test(value.frame_source_id) ||
    ![value.frame_manifest_revision, value.mask_sha256].every(
      (item) => typeof item === "string" && SHA.test(item),
    ) ||
    typeof value.mask_candidate_id !== "string" ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(value.mask_candidate_id) ||
    !Array.isArray(value.isocenter) ||
    value.isocenter.length !== 3 ||
    !Array.from(value.isocenter).every(
      (x) => typeof x === "number" && Number.isFinite(x),
    )
  )
    throw new Error("Invalid registration");
  validateRigid(value.volume_to_carm_ras);
}
/** Checks one plane's fields and returns its view. */
function checkPlane(
  value: Record<string, unknown>,
  labels: string[],
): ViewNumbers {
  const [low, high] = PROJECTION_REGISTRATION_LIMITS.detector_scale;
  if (
    !labels.includes(value.plane as string) ||
    typeof value.frame_sha256 !== "string" ||
    !SHA.test(value.frame_sha256) ||
    !["frame_manifest", "operator_entered"].includes(
      value.geometry_source as string,
    ) ||
    typeof value.fit_detector_scale !== "boolean" ||
    typeof value.detector_scale !== "number" ||
    !(value.detector_scale >= low && value.detector_scale <= high) ||
    (!value.fit_detector_scale && value.detector_scale !== 1) ||
    (value.fit_detector_scale &&
      value.geometry_source !== "operator_entered") ||
    !["dark", "bright"].includes(value.polarity as string) ||
    !fraction(value.sensitivity)
  )
    throw new Error("Invalid registration");
  integer(value.frame_index, 0, FRAME_LIMITS.max_frame_index);
  parseScore(value.reported_score);
  parseScore(value.reported_start_score);
  return parseView(value.view);
}

function parseInputs(value: unknown): SavedInputs {
  if (!isObject(value)) throw new Error("Invalid registration");
  if (value.method === BIPLANE_REGISTRATION_METHOD) {
    const planes = value.planes;
    if (
      !exact(value, [...SHARED_KEYS, "same_position_attested", "planes"]) ||
      value.same_position_attested !== true ||
      !Array.isArray(planes) ||
      planes.length !== 2 ||
      !planes.every((plane) => exact(plane, [...PLANE_KEYS]))
    )
      throw new Error("Invalid registration");
    checkShared(value);
    const first = checkPlane(planes[0], ["a"]),
      second = checkPlane(planes[1], ["b"]);
    if (!planesFarEnough(planeAngleDeg(first, second)))
      throw new Error("Invalid registration");
    return value as BiplaneRegistrationInputs;
  }
  if (
    !exact(value, [...SHARED_KEYS, ...PLANE_KEYS]) ||
    value.method !== PROJECTION_REGISTRATION_METHOD
  )
    throw new Error("Invalid registration");
  checkShared(value);
  checkPlane(value, ["single", "a", "b"]);
  return value as RegistrationInputs;
}

const sameScore = (reported: unknown, expected: RegistrationScore) => {
  const score = parseScore(reported);
  return (Object.keys(expected) as (keyof RegistrationScore)[]).every(
    (key) => score[key] === expected[key],
  );
};

/** Parses `GET` and `PUT /api/cases/{id}/projection-registration` and binds
 * the answer to the identity that was asked about. */
export function parseSavedRegistration(
  value: unknown,
  identity: Identity,
): SavedRegistration {
  if (
    !exact(value, [
      "case_id",
      "image_sha256",
      "artifact_version",
      "reference_revision",
      "registration_revision",
      "current",
    ]) ||
    !isObject(value.current)
  )
    throw new Error("Invalid registration");
  const current = value.current,
    revision = value.registration_revision;
  if (
    (Object.keys(identity) as (keyof Identity)[]).some(
      (key) => value[key] !== identity[key],
    ) ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  )
    throw new Error("Registration belongs to another case revision");
  const base = { ...identity, registration_revision: revision };
  if (current.status === "not_confirmed") {
    if (revision !== 0 || !exact(current, ["status"]))
      throw new Error("Invalid registration");
    return { ...base, current: { status: "not_confirmed" } };
  }
  if (
    revision < 1 ||
    typeof current.registration_id !== "string" ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(current.registration_id)
  )
    throw new Error("Invalid registration");
  if (current.status === "stale") {
    if (
      !exact(current, ["status", "registration_id", "inputs", "result"]) ||
      current.inputs !== null ||
      current.result !== null
    )
      throw new Error("Invalid registration");
    return {
      ...base,
      current: { status: "stale", registration_id: current.registration_id },
    };
  }
  if (
    !exact(current, [
      "status",
      "registration_id",
      "dependencies",
      "input_sha256",
      "inputs",
      "result",
      "evidence",
    ]) ||
    !exact(current.dependencies, [
      "case_id",
      "image_sha256",
      "artifact_version",
      "reference_revision",
      "version",
    ]) ||
    current.dependencies.case_id !== identity.case_id ||
    current.dependencies.image_sha256 !== identity.image_sha256 ||
    current.dependencies.artifact_version !== identity.artifact_version ||
    current.dependencies.reference_revision !== identity.reference_revision ||
    !digest(current.input_sha256)
  )
    throw new Error("Invalid registration");
  const inputs = parseInputs(current.inputs),
    pair = isBiplane(inputs),
    // A record's version is the one its method belongs to.
    version = pair ? BIPLANE_REGISTRATION_VERSION : REGISTRATION_VERSION;
  const result = current.result;
  if (
    current.status !== "current" ||
    current.dependencies.version !== version ||
    !["verified", "unavailable"].includes(current.evidence as string) ||
    !exact(result, [
      "version",
      "convention",
      "method",
      "status",
      "validated",
      "rotation_deg",
      "isocenter_shift_mm",
      "score_source",
      ...(pair
        ? ["same_position", "plane_angle_deg", "planes"]
        : ["geometry_source", "reported_score", "reported_start_score"]),
    ]) ||
    result.convention !== "dicom_xa_patient_longitude_latitude_ras_v1" ||
    result.method !== inputs.method ||
    result.score_source !== "browser_reported_not_recomputed" ||
    result.version !== version ||
    result.status !== "operator_confirmed_proposal" ||
    result.validated !== false ||
    typeof result.rotation_deg !== "number" ||
    !Number.isFinite(result.rotation_deg) ||
    result.rotation_deg < 0 ||
    result.rotation_deg > 180 ||
    typeof result.isocenter_shift_mm !== "number" ||
    !Number.isFinite(result.isocenter_shift_mm) ||
    result.isocenter_shift_mm < 0
  )
    throw new Error("Invalid registration");
  let planeAngle: number | null = null;
  if (pair) {
    const planes = result.planes,
      angle = result.plane_angle_deg;
    if (
      result.same_position !== "operator_attested_not_checked" ||
      typeof angle !== "number" ||
      // The server's angle, rounded to a thousandth, must be the views' own.
      !(
        Math.abs(
          angle - planeAngleDeg(inputs.planes[0].view, inputs.planes[1].view),
        ) <= 0.001
      ) ||
      !Array.isArray(planes) ||
      planes.length !== 2 ||
      !planes.every(
        (plane, k) =>
          exact(plane, [
            "plane",
            "geometry_source",
            "reported_score",
            "reported_start_score",
          ]) &&
          plane.plane === inputs.planes[k].plane &&
          plane.geometry_source === inputs.planes[k].geometry_source &&
          sameScore(plane.reported_score, inputs.planes[k].reported_score) &&
          sameScore(
            plane.reported_start_score,
            inputs.planes[k].reported_start_score,
          ),
      )
    )
      throw new Error("Invalid registration");
    planeAngle = angle;
  } else if (
    result.geometry_source !== inputs.geometry_source ||
    !sameScore(result.reported_score, inputs.reported_score) ||
    !sameScore(result.reported_start_score, inputs.reported_start_score)
  )
    throw new Error("Invalid registration");
  return {
    ...base,
    current: {
      status: "current",
      registration_id: current.registration_id,
      evidence: current.evidence as "verified" | "unavailable",
      inputs,
      result: {
        status: "operator_confirmed_proposal",
        validated: false,
        rotation_deg: result.rotation_deg,
        isocenter_shift_mm: result.isocenter_shift_mm,
        plane_angle_deg: planeAngle,
      },
    },
  };
}
