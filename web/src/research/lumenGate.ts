/** Research gate for lumen registration estimates (protocol step 3).

 * Measures the fraction of model branches supported by dark pixels and the
 * disagreement between the estimates from the two depth starts, both purely
 * from the estimate itself, independently of truth. A branch is supported
 * when at least half its sample points land within 2 px (Euclidean) of ink
 * (grayscale <= 192). Acceptance requires at least 75% of branches
 * supported and paired-start estimates within 5 mm whole-tree RMS of each
 * other; any failed paired start prevents acceptance. */

/** Detector geometry, structurally typed so any camera record with these
 * fields works. `source_to_detector_mm` fixes the detector scale: millimetres
 * per pixel at the detector are source_to_detector_mm / fx_px. */
export interface LumenCamera {
  fx_px: number;
  fy_px: number;
  cx_px: number;
  cy_px: number;
  width_px: number;
  height_px: number;
  source_to_detector_mm: number;
}

export interface LumenGateDecision {
  accepted: boolean;
  reasons: string[];
  supported_fraction: number | null;
  start_disagreement_mm: number | null;
}

const INK_LEVEL = 192;
const NEAR_PX = 2;
const MIN_SUPPORTED_FRACTION = 0.75;
const MAX_START_DISAGREEMENT_MM = 5;

/** Projects a model point through the pose into detector pixels. Returns
 * null when the point falls behind the source or off the detector. */
function project(
  camera: LumenCamera,
  pose: number[][],
  point: number[],
): [number, number] | null {
  const [x, y, z] = point;
  const u = pose[0][0] * x + pose[0][1] * y + pose[0][2] * z + pose[0][3];
  const v = pose[1][0] * x + pose[1][1] * y + pose[1][2] * z + pose[1][3];
  const d = pose[2][0] * x + pose[2][1] * y + pose[2][2] * z + pose[2][3];
  if (!(d > 0 && d <= camera.source_to_detector_mm)) return null;
  const px = (camera.fx_px * u) / d + camera.cx_px;
  const py = (camera.fy_px * v) / d + camera.cy_px;
  if (px < 0 || py < 0 || px > camera.width_px - 1 || py > camera.height_px - 1)
    return null;
  return [px, py];
}

/** Whether any pixel within 2 px (Euclidean) of the projected point is ink. */
function nearInk(
  gray: Uint8Array,
  width: number,
  height: number,
  px: number,
  py: number,
): boolean {
  const cx = Math.round(px),
    cy = Math.round(py);
  for (let dy = -NEAR_PX; dy <= NEAR_PX; dy++) {
    for (let dx = -NEAR_PX; dx <= NEAR_PX; dx++) {
      const x = cx + dx,
        y = cy + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      if ((x - px) ** 2 + (y - py) ** 2 > NEAR_PX ** 2) continue;
      if (gray[y * width + x] <= INK_LEVEL) return true;
    }
  }
  return false;
}

/** Applies the research gate to one estimate. `pose` is the estimate itself;
 * `other` is the paired depth start's estimate, or null when that start
 * failed natively. Refusal reasons are preserved individually. */
export function decide(
  camera: LumenCamera,
  branches: number[][][],
  gray: Uint8Array,
  pose: number[][] | null,
  other: number[][] | null,
): LumenGateDecision {
  const reasons: string[] = [];

  // Branch support against the frame's dark pixels.
  let supported_fraction: number | null = null;

  if (pose !== null) {
    if (branches.length === 0) {
      reasons.push("no_branches");
    } else {
      let supported = 0;
      for (const branch of branches) {
        if (branch.length === 0) {
          reasons.push("empty_branch");
          continue;
        }
        let near = 0;
        for (const point of branch) {
          const pixel = project(camera, pose, point);
          if (pixel === null) {
            continue;
          }
          if (
            nearInk(gray, camera.width_px, camera.height_px, pixel[0], pixel[1])
          )
            near += 1;
        }
        if (near * 2 >= branch.length) supported += 1;
      }
      supported_fraction = supported / branches.length;

      if (supported_fraction < MIN_SUPPORTED_FRACTION)
        reasons.push("unsupported_branches");
    }
  } else {
    reasons.push("missing_pose");
  }

  let start_disagreement_mm: number | null = null;
  if (pose && other) {
    let sum = 0,
      count = 0;
    for (const branch of branches)
      for (const point of branch) {
        for (let i = 0; i < 3; ++i) {
          let d = pose[i][3] - other[i][3];
          for (let k = 0; k < 3; ++k)
            d += (pose[i][k] - other[i][k]) * point[k];
          sum += d * d;
        }
        ++count;
      }
    if (count) start_disagreement_mm = Math.sqrt(sum / count);
    if (
      start_disagreement_mm === null ||
      !(start_disagreement_mm <= MAX_START_DISAGREEMENT_MM)
    )
      reasons.push("start_disagreement_exceeds_5_mm");
  } else if (pose) reasons.push("missing_paired_start");

  return {
    accepted: reasons.length === 0,
    reasons,
    supported_fraction,
    start_disagreement_mm,
  };
}
