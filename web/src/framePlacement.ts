/** Where points of the 3D volume lie in a frame under a registration, and
 * how large a frame pixel is at each of them. */
import { camera, type ViewNumbers } from "./carmGeometry";
import type { Vec3 } from "./obliqueSlice";
import { projectRegistered } from "./projectionRegistration";
import { validateRigid } from "./rigidFusion";

export type PlacedSamples = {
  /** Frame pixel coordinates (x right, y down), two per point. NaN for a
   * point that cannot be projected. */
  pixels: Float32Array;
  /** Millimeters across one frame pixel at the point's distance from the
   * source. NaN where `pixels` is. */
  mm_per_px: Float32Array;
};

export function placedSamples(
  view: ViewNumbers,
  isocenter: Vec3,
  matrix: number[][],
  points: Float32Array,
  size: { width: number; height: number },
): PlacedSamples {
  // Throws on a view, frame size or matrix it cannot use.
  const pixels = projectRegistered(view, isocenter, matrix, points, size),
    pitch = view.detector_width_mm / size.width;
  if (Math.abs(view.detector_height_mm / size.height / pitch - 1) > 0.02)
    throw new Error("Detector pixels must be square");
  const cam = camera(view, isocenter),
    m = validateRigid(matrix),
    count = Math.floor(points.length / 3),
    mm_per_px = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    if (Number.isNaN(pixels[2 * k])) {
      mm_per_px[k] = NaN;
      continue;
    }
    let depth = 0;
    for (let i = 0; i < 3; i++)
      depth +=
        (m[i][0] * points[3 * k] +
          m[i][1] * points[3 * k + 1] +
          m[i][2] * points[3 * k + 2] +
          m[i][3] -
          cam.source[i]) *
        cam.d[i];
    mm_per_px[k] = (pitch * depth) / view.source_detector_mm;
  }
  return { pixels, mm_per_px };
}
