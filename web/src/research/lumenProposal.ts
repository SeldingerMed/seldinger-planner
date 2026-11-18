/** Adapter from the Lumen blind-registration pack to Planner's native
 * vessel-evidence proposal (lumen-registration-protocol.md, step 1). The
 * pack's declared intrinsics and original grayscale frame go in; the native
 * `vesselEvidence` target and single-plane `proposeEvidenceRegistration`
 * search do all of the matching. Nothing here imitates the native methods
 * and nothing touches the filesystem: this module is pure.
 *
 * Coordinates. The Lumen camera is a centered, square fx/fy pinhole whose
 * pose maps model points to camera millimetres (u right, v down the image,
 * d depth in front of the source), as `lumenGate` projects them. Native's
 * camera instead has fixed axes (u, v, d) at zero angles with v up the
 * image and depth measured from the source. The two agree exactly when the
 * world is expressed through the fixed improper basis below, whose columns
 * are (u, -v, d): a camera millimetre point c sits at B·c, with the source
 * at the world origin and the isocenter at sod·d. The same basis mirrors
 * the model coords, (x, y, z) to (-x, z, -y), so the model axes run
 * parallel to the camera axes at the generic depth prior. The adapter
 * mirrors the incoming model points, conjugates the start pose by the
 * basis in both directions, and conjugates the fitted native matrix back
 * the same way, so the returned pose is proper rigid in the Lumen
 * convention over the raw model coords. */
import {
  EVIDENCE_REGISTRATION_LIMITS,
  proposeEvidenceRegistration,
  type EvidenceRegistrationProposal,
} from "../evidenceRegistration";
import {
  VIEW_LIMITS,
  validateView,
  viewFrame,
  type ViewNumbers,
} from "../carmGeometry";
import { validateRigid } from "../rigidFusion";
import { VESSEL_EVIDENCE_LIMITS, vesselEvidence } from "../vesselEvidence2d";
import type { LumenCamera } from "./lumenGate";

/** The fixed improper basis of the Lumen camera frame, as columns
 * (u, -v, d) at zero C-arm angles. The flipped v is the image's downward
 * pixel axis: a native-world point B·c projects to exactly the Lumen
 * pinhole pixel of camera millimetres c. Model (x, y, z) mirrors to
 * (-x, z, -y) through the same basis. */
export const LUMEN_MIRROR_BASIS: number[][] = (() => {
  const { u, v, d } = viewFrame(0, 0);
  return [0, 1, 2].map((i) => [u[i], -v[i], d[i]]);
})();

/** The generic depth prior places the model origin on the central ray at
 * this fraction of the source-detector distance; the native search's
 * isocenter sits on that same ray so the prior depth is the isocenter
 * depth. It is a generic start, not knowledge of the true depth. */
export const LUMEN_DEPTH_PRIOR_FRACTION = 2 / 3;

/** Isocenter depth from the source, at the generic depth prior. */
export function lumenIsocenterDepth(source_to_detector_mm: number): number {
  return LUMEN_DEPTH_PRIOR_FRACTION * source_to_detector_mm;
}

/** Model point mirrored through the camera's fixed improper basis. */
export function mirrorModelPoint(point: readonly number[]): number[] {
  return [0, 1, 2].map(
    (i) =>
      LUMEN_MIRROR_BASIS[i][0] * point[0] +
      LUMEN_MIRROR_BASIS[i][1] * point[1] +
      LUMEN_MIRROR_BASIS[i][2] * point[2],
  );
}

/** Millimetres per frame pixel at the detector, at the fixed detector
 * scale. The same tracer the research gate measures with. */
export function lumenMmPerPixel(camera: LumenCamera): number {
  return camera.source_to_detector_mm / camera.fx_px;
}

/** The centered, square fx/fy pinhole axis and size contract: integer frame
 * sides the evidence extractor supports, equal focal lengths, the principal
 * point on the frame center, a source-detector distance the view model
 * accepts, and derived detector sides inside the view model's range. */
export function validateLumenCamera(camera: LumenCamera): LumenCamera {
  const { width_px: w, height_px: h, fx_px: fx, fy_px: fy } = camera;
  if (
    !Number.isInteger(w) ||
    !Number.isInteger(h) ||
    w < VESSEL_EVIDENCE_LIMITS.min_side_px ||
    h < VESSEL_EVIDENCE_LIMITS.min_side_px ||
    w > VESSEL_EVIDENCE_LIMITS.max_side_px ||
    h > VESSEL_EVIDENCE_LIMITS.max_side_px
  )
    throw new Error("Lumen frame size is outside the supported range");
  if (!Number.isFinite(fx) || !Number.isFinite(fy) || fx <= 0 || fy <= 0)
    throw new Error("Lumen focal length must be finite and positive");
  if (fx !== fy)
    throw new Error("The Lumen pinhole must be square: fx must equal fy");
  if (camera.cx_px !== (w - 1) / 2 || camera.cy_px !== (h - 1) / 2)
    throw new Error("The Lumen principal point must be centered on the frame");
  const sid = camera.source_to_detector_mm;
  if (
    !Number.isFinite(sid) ||
    sid < VIEW_LIMITS.source_detector_mm[0] ||
    sid > VIEW_LIMITS.source_detector_mm[1]
  )
    throw new Error(
      "Lumen source-detector distance is outside the supported range",
    );
  const sides: [number, readonly number[], string][] = [
    [(sid * w) / fx, VIEW_LIMITS.detector_width_mm, "width"],
    [(sid * h) / fy, VIEW_LIMITS.detector_height_mm, "height"],
  ];
  for (const [size, [low, high], name] of sides)
    if (!(size >= low && size <= high))
      throw new Error(
        `Lumen detector ${name} falls outside the supported range`,
      );
  const sod = lumenIsocenterDepth(sid);
  if (
    sod < VIEW_LIMITS.source_isocenter_mm[0] ||
    sod > VIEW_LIMITS.source_isocenter_mm[1] ||
    sid - sod < 1
  )
    throw new Error(
      "The Lumen isocenter depth falls outside the supported range",
    );
  return camera;
}

/** The declared single-plane view at zero angles: the pack's intrinsics
 * carried into the native view model with the detector scale fixed. */
export function lumenView(camera: LumenCamera): ViewNumbers {
  return validateView({
    primary_deg: 0,
    secondary_deg: 0,
    source_detector_mm: camera.source_to_detector_mm,
    source_isocenter_mm: lumenIsocenterDepth(camera.source_to_detector_mm),
    detector_width_mm:
      (camera.source_to_detector_mm * camera.width_px) / camera.fx_px,
    detector_height_mm:
      (camera.source_to_detector_mm * camera.height_px) / camera.fy_px,
  });
}

const mul3 = (a: number[][], b: number[][]): number[][] =>
  [0, 1, 2].map((i) =>
    [0, 1, 2].map(
      (j) => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j],
    ),
  );

const mulVec = (a: number[][], v: readonly number[]): number[] =>
  [0, 1, 2].map((i) => a[i][0] * v[0] + a[i][1] * v[1] + a[i][2] * v[2]);

const transpose3 = (m: number[][]): number[][] =>
  [0, 1, 2].map((i) => [0, 1, 2].map((j) => m[j][i]));

/** The input pose (raw model coords to camera millimetres, proper, as
 * `validateRigid` demands) conjugated by the improper basis in both
 * directions: the native search's start, from the mirrored model coords
 * into the native world whose origin is the X-ray source. */
export function toNativeStart(start: number[][]): number[][] {
  const s = validateRigid(start),
    inverse = transpose3(LUMEN_MIRROR_BASIS),
    rotation = mul3(
      mul3(LUMEN_MIRROR_BASIS, [
        s[0].slice(0, 3),
        s[1].slice(0, 3),
        s[2].slice(0, 3),
      ]),
      inverse,
    ),
    translation = mulVec(LUMEN_MIRROR_BASIS, [s[0][3], s[1][3], s[2][3]]);
  return [
    [...rotation[0], translation[0]],
    [...rotation[1], translation[1]],
    [...rotation[2], translation[2]],
    [0, 0, 0, 1],
  ];
}

/** The native fitted matrix (mirrored model coords to the native world)
 * conjugated back in both directions: the proper rigid pose from raw model
 * coords to Lumen camera millimetres. */
export function fromNativeMatrix(matrix: number[][]): number[][] {
  const inverse = transpose3(LUMEN_MIRROR_BASIS),
    rotation = mul3(
      mul3(inverse, [
        matrix[0].slice(0, 3),
        matrix[1].slice(0, 3),
        matrix[2].slice(0, 3),
      ]),
      LUMEN_MIRROR_BASIS,
    ),
    translation = mulVec(inverse, [matrix[0][3], matrix[1][3], matrix[2][3]]);
  return [
    [...rotation[0], translation[0]],
    [...rotation[1], translation[1]],
    [...rotation[2], translation[2]],
    [0, 0, 0, 1],
  ];
}

/** Every branch sample, mirrored through the camera's improper basis, as
 * the flat native point set. */
function collectPoints(branches: number[][][]): Float32Array {
  const points: number[] = [];
  for (const branch of branches) {
    if (!Array.isArray(branch))
      throw new Error("Each model branch must be a list of points");
    for (const point of branch) {
      if (
        !Array.isArray(point) ||
        point.length !== 3 ||
        !point.every(Number.isFinite)
      )
        throw new Error("Model branch points must be finite xyz triples");
      const q = mirrorModelPoint(point);
      points.push(q[0], q[1], q[2]);
    }
  }
  if (points.length / 3 < EVIDENCE_REGISTRATION_LIMITS.min_points)
    throw new Error(
      `Too few vessel points to register: ${points.length / 3} of ${EVIDENCE_REGISTRATION_LIMITS.min_points}`,
    );
  return Float32Array.from(points);
}

/** Runs the protocol-1 proposal for one frame: native dark-line vessel
 * evidence from the original grayscale, then the native single-plane
 * search at the declared intrinsics with the detector scale fixed. Returns
 * the proper rigid pose (raw model coords to camera millimetres) and the
 * native proposal unchanged for the record. Native failures — a frame with
 * no line-like vessels, or no pose in range — throw with their original
 * reason preserved. */
export function runProposal(
  camera: LumenCamera,
  branches: number[][][],
  gray: Uint8Array,
  start: number[][],
): { pose: number[][]; native: EvidenceRegistrationProposal } {
  const cam = validateLumenCamera(camera);
  if (
    !(gray instanceof Uint8Array) ||
    gray.length !== cam.width_px * cam.height_px
  )
    throw new Error("Lumen frame gray must be one byte per pixel");
  const nativeStart = toNativeStart(start);
  const points = collectPoints(branches);
  // Dark polarity: vessels are made valleys of the original grayscale.
  // A blank frame throws here, before any search.
  const evidence = vesselEvidence(gray, cam.width_px, cam.height_px, "dark");
  const sod = lumenIsocenterDepth(cam.source_to_detector_mm),
    { d } = viewFrame(0, 0);
  const native = proposeEvidenceRegistration({
    points,
    planes: [
      {
        view: lumenView(cam),
        // The isocenter at the prior depth along the central ray puts the
        // X-ray source at the world origin, where the conjugated pose
        // expects it.
        isocenter: [sod * d[0], sod * d[1], sod * d[2]],
        frame: { width: cam.width_px, height: cam.height_px },
        evidence,
        fit_detector_scale: false,
      },
    ],
    start: nativeStart,
  });
  const pose = fromNativeMatrix(native.matrix);
  // The output contract is a proper rigid pose; if the native search ever
  // produced less, that is a failure, not a repair.
  validateRigid(pose);
  return { pose, native };
}
