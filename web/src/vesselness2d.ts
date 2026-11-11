/** 2D vessel centerlines in one angiographic frame, and the distance map a
 * projection registration is scored against.
 *
 * A multi-scale Hessian ridge filter marks line-like structures of the
 * declared polarity. A pixel counts only where the smoothed image is lowest
 * across the line, which drops step edges (skull outline, collimator,
 * redaction boxes) and the flanks of opposite-polarity lines. Non-maximum
 * suppression across the line keeps its crest. This is a matching target, not a vessel segmentation: it
 * misses faint vessels and can mark catheters, sutures and bone edges. */
import { distanceToSeeds } from "./distanceTransform";

export const VESSEL_TARGET_LIMITS = {
  min_side_px: 64,
  max_side_px: 1024,
  /** The filter runs on a block-averaged copy no longer than this. */
  work_side_px: 384,
  scales_px: [1.2, 2, 3.2],
  min_component_px: 20,
  /** Smallest filter response kept, in gray levels: about a 4-level dip
   * for a line as wide as the filter scale. */
  min_response: 1.5,
  min_centerline_px: 40,
  max_distance_px: 96,
} as const;

export type Polarity = "dark" | "bright";
export type VesselTarget = {
  /** Working grid. */
  width: number;
  height: number;
  /** Frame pixels per working pixel, the same on both axes. */
  scale: number;
  /** Working-grid pixels to the nearest centerline pixel, capped. */
  distance: Float32Array;
  /** Working-grid indices (`y * width + x`) of centerline pixels. */
  centerline: Int32Array;
};

function blur(
  source: Float32Array,
  width: number,
  height: number,
  sigma: number,
): Float32Array {
  const radius = Math.ceil(3 * sigma),
    kernel = new Float32Array(2 * radius + 1);
  let total = 0;
  for (let i = -radius; i <= radius; i++)
    total += kernel[i + radius] = Math.exp((-i * i) / (2 * sigma * sigma));
  for (let i = 0; i < kernel.length; i++) kernel[i] /= total;
  const reflect = (i: number, n: number) =>
    i < 0 ? Math.min(n - 1, -i - 1) : i >= n ? Math.max(0, 2 * n - i - 1) : i;
  const pass = new Float32Array(width * height),
    out = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++)
        sum += kernel[k + radius] * source[y * width + reflect(x + k, width)];
      pass[y * width + x] = sum;
    }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++)
        sum += kernel[k + radius] * pass[reflect(y + k, height) * width + x];
      out[y * width + x] = sum;
    }
  return out;
}

/** Resumable target extraction. `sensitivity` runs from 0 (strongest lines
 * only) to 1 (faint lines too). Yields between filter scales. */
export function* vesselTargetSteps(
  gray: Uint8Array,
  width: number,
  height: number,
  polarity: Polarity,
  sensitivity: number,
): Generator<void, VesselTarget> {
  const L = VESSEL_TARGET_LIMITS;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    Math.min(width, height) < L.min_side_px ||
    Math.max(width, height) > L.max_side_px ||
    !(gray instanceof Uint8Array) ||
    gray.length !== width * height
  )
    throw new Error("Frame size is outside the supported range");
  if (polarity !== "dark" && polarity !== "bright")
    throw new Error("Invalid vessel polarity");
  if (!Number.isFinite(sensitivity) || sensitivity < 0 || sensitivity > 1)
    throw new Error("Invalid vessel sensitivity");
  const scale = Math.ceil(Math.max(width, height) / L.work_side_px),
    w = Math.floor(width / scale),
    h = Math.floor(height / scale);
  // Block average; vessels are made valleys whatever the polarity.
  const image = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let j = 0; j < scale; j++)
        for (let i = 0; i < scale; i++)
          sum += gray[(y * scale + j) * width + x * scale + i];
      const mean = sum / (scale * scale);
      image[y * w + x] = polarity === "dark" ? mean : 255 - mean;
    }
  yield;
  const response = new Float32Array(w * h),
    across = new Int8Array(2 * w * h);
  for (const sigma of L.scales_px) {
    const g = blur(image, w, h, sigma),
      margin = Math.ceil(2 * sigma) + 1;
    for (let y = margin; y < h - margin; y++)
      for (let x = margin; x < w - margin; x++) {
        const at = y * w + x,
          gx = (g[at + 1] - g[at - 1]) / 2,
          gy = (g[at + w] - g[at - w]) / 2,
          a = g[at + 1] - 2 * g[at] + g[at - 1],
          c = g[at + w] - 2 * g[at] + g[at - w],
          b =
            (g[at + w + 1] - g[at + w - 1] - g[at - w + 1] + g[at - w - 1]) / 4;
        const half = (a + c) / 2,
          root = Math.hypot((a - c) / 2, b),
          strong = half + root,
          weak = half - root;
        if (!(strong > 0)) continue;
        const ratio = weak / strong;
        // Curved about as much along the line as across it: a blob.
        if (ratio > 0.5) continue;
        // Scale-normalized valley curvature, less a line-versus-blob term
        // and the gradient a step edge would have at this pixel.
        const value =
          sigma * sigma * strong * Math.exp(-2 * ratio * ratio) -
          0.5 * sigma * Math.hypot(gx, gy);
        if (value > response[at]) {
          // Eigenvector of the strong curvature: the direction across the line.
          let ex = b,
            ey = strong - a;
          if (Math.abs(ex) + Math.abs(ey) < 1e-12) {
            ex = strong - c;
            ey = b;
          }
          const n = Math.hypot(ex, ey) || 1,
            two = 2 * Math.round(ex / n) + 2 * w * Math.round(ey / n);
          // A vessel is a dip: lower here than two pixels to either side.
          if (!(g[at] < g[at + two] && g[at] < g[at - two])) continue;
          response[at] = value;
          across[2 * at] = Math.round(ex / n);
          across[2 * at + 1] = Math.round(ey / n);
        }
      }
    yield;
  }
  // The threshold follows the strongest half percent of the frame, which is
  // vessel-strength wherever vessels cover at least that much of it.
  const sorted = Float32Array.from(response).sort(),
    high =
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.995))],
    threshold = Math.max(L.min_response, high * (0.6 - 0.5 * sensitivity));
  const crest = new Uint8Array(w * h);
  if (high > 0)
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const at = y * w + x,
          value = response[at];
        if (value < threshold) continue;
        const step = across[2 * at] + w * across[2 * at + 1];
        if (step === 0) continue;
        if (value >= response[at + step] && value >= response[at - step])
          crest[at] = 1;
      }
  // Drop specks: 8-connected components below the size floor.
  const seen = new Uint8Array(w * h),
    stack = new Int32Array(w * h);
  let kept = 0;
  for (let start = 0; start < crest.length; start++) {
    if (!crest[start] || seen[start]) continue;
    let top = 0,
      size = 0;
    stack[top++] = start;
    seen[start] = 1;
    const first = top - 1;
    while (top > first + size) {
      const at = stack[first + size++],
        x = at % w,
        y = (at - x) / w;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx,
            ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const next = ny * w + nx;
          if (crest[next] && !seen[next]) {
            seen[next] = 1;
            stack[top++] = next;
          }
        }
    }
    if (size < L.min_component_px)
      for (let i = 0; i < size; i++) crest[stack[first + i]] = 0;
    else kept += size;
  }
  if (kept < L.min_centerline_px)
    throw new Error(
      "No line-like vessels were found in this frame at this polarity and sensitivity",
    );
  yield;
  const centerline = new Int32Array(kept);
  for (let at = 0, k = 0; at < crest.length; at++)
    if (crest[at]) centerline[k++] = at;
  return {
    width: w,
    height: h,
    scale,
    distance: distanceToSeeds(crest, w, h, L.max_distance_px),
    centerline,
  };
}

/** One-shot target extraction. Interactive callers should step
 * `vesselTargetSteps` in short slices instead. */
export function vesselTarget(
  gray: Uint8Array,
  width: number,
  height: number,
  polarity: Polarity,
  sensitivity = 0.5,
): VesselTarget {
  const steps = vesselTargetSteps(gray, width, height, polarity, sensitivity);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}
