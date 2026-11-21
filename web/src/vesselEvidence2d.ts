/** Vessel evidence in one angiographic frame: a continuous map of how
 * line-like each pixel is at the declared polarity, blurred to several
 * widths. It is what the `vessel_evidence_compass` registration methods
 * score a projected 3D vessel model against.
 *
 * The older target (vesselness2d.ts) thresholds the same kind of ridge
 * response into a line set. On real frames that kept the large trunks and
 * dropped most smaller vessels. Here nothing is thresholded: the response
 * along the crest of each line is compressed so that a faint vessel still
 * counts, and a registration reads the map itself.
 *
 * This is a matching target, not a vessel segmentation. Catheters, sutures,
 * skull outlines and dental work can score as lines. */
import type { Polarity } from "./vesselness2d";

export const VESSEL_EVIDENCE_LIMITS = {
  min_side_px: 64,
  max_side_px: 1024,
  /** The filter runs on a block-averaged copy no longer than this. */
  work_side_px: 768,
  ridge_scales_px: [1.2, 2, 3.2, 5, 8],
  /** Evidence is 0 at and below this quantile of the ridge response and 1
   * at and above the upper one, with a square root in between. */
  floor_quantile: 0.75,
  full_quantile: 0.995,
  /** The upper end is never below this share of the response of the
   * `peak_rank`-th strongest pixel. Vessels that fill under half a percent
   * of the frame leave the upper quantile on the background; this keeps
   * the upper end on the vessels. */
  peak_share: 0.25,
  peak_rank: 50,
  /** Blur widths of the levels, widest first, in working pixels. */
  blur_px: [16, 8, 4, 2, 1],
  /** Smallest ridge response, in gray levels, that the upper quantile may
   * have. Below it the frame holds no line clearer than faint noise. */
  min_response: 1.5,
  /** Evidence at or above this at the narrowest level counts as strong. */
  strong: 0.5,
  min_strong_px: 40,
  max_strong_samples: 4000,
} as const;

export type VesselEvidence = {
  /** Working grid. */
  width: number;
  height: number;
  /** Frame pixels per working pixel, the same on both axes. */
  scale: number;
  /** One map per blur width, widest first, each from 0 to 1. */
  levels: Float32Array[];
  /** Working-grid indices (`y * width + x`) of an even sample of the
   * strong-evidence pixels. */
  strong: Int32Array;
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

const quantile = (sorted: Float32Array, q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

/** Resumable evidence extraction. Yields between filter scales and between
 * blur levels. */
export function* vesselEvidenceSteps(
  gray: Uint8Array,
  width: number,
  height: number,
  polarity: Polarity,
  /** Frame pixels that are not vessel, nonzero where so: a device. They
   * carry no evidence and do not count toward its scale. */
  exclude?: Uint8Array,
): Generator<void, VesselEvidence> {
  const L = VESSEL_EVIDENCE_LIMITS;
  if (
    exclude &&
    (!(exclude instanceof Uint8Array) || exclude.length !== gray.length)
  )
    throw new Error("Excluded pixels do not match the frame");
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
  for (const sigma of L.ridge_scales_px) {
    const g = blur(image, w, h, sigma),
      margin = Math.ceil(2 * sigma) + 1,
      reach = Math.round(sigma);
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
        if (!(value > response[at])) continue;
        // Eigenvector of the strong curvature: the direction across the line.
        let ex = b,
          ey = strong - a;
        if (Math.abs(ex) + Math.abs(ey) < 1e-12) {
          ex = strong - c;
          ey = b;
        }
        const n = Math.hypot(ex, ey) || 1,
          dx = Math.round(ex / n),
          dy = Math.round(ey / n),
          step = reach * (dx + w * dy);
        // A vessel is a dip: lower here than one filter width to either side.
        if (step !== 0 && g[at] < g[at + step] && g[at] < g[at - step]) {
          response[at] = value;
          across[2 * at] = dx;
          across[2 * at + 1] = dy;
        }
      }
    yield;
  }
  // A working pixel with an excluded frame pixel in its block has no response.
  if (exclude)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        block: for (let j = 0; j < scale; j++)
          for (let i = 0; i < scale; i++)
            if (exclude[(y * scale + j) * width + x * scale + i]) {
              response[y * w + x] = 0;
              break block;
            }
  // `sorted` holds every pixel of the working grid, at least `min_side_px`
  // squared, so the pixel `peak_rank` from the top always exists.
  const sorted = Float32Array.from(response).sort(),
    low = quantile(sorted, L.floor_quantile),
    high = Math.max(
      quantile(sorted, L.full_quantile),
      L.peak_share * sorted[Math.max(0, sorted.length - L.peak_rank)],
    ),
    evidence = new Float32Array(w * h);
  // Only the crest of each line carries evidence: the pixels where the
  // response is no lower than at either neighbor across the line. A wide
  // vessel is then as sharp a target as a narrow one, and its width cannot
  // hide a pose that is off by part of it.
  if (high >= L.min_response && high > low)
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const at = y * w + x,
          value = response[at],
          step = across[2 * at] + w * across[2 * at + 1];
        if (
          !(value > low) ||
          step === 0 ||
          value < response[at + step] ||
          value < response[at - step]
        )
          continue;
        const t = (value - low) / (high - low);
        evidence[at] = t >= 1 ? 1 : Math.sqrt(t);
      }
  const levels: Float32Array[] = [];
  for (const sigma of L.blur_px) {
    const level = blur(evidence, w, h, sigma);
    // Scaled so that the middle of a straight line of full evidence, one
    // pixel wide, reads 1 at every level.
    let middle = 0;
    for (let i = -Math.ceil(3 * sigma); i <= Math.ceil(3 * sigma); i++)
      middle += Math.exp((-i * i) / (2 * sigma * sigma));
    for (let k = 0; k < level.length; k++)
      level[k] = Math.min(1, level[k] * middle);
    levels.push(level);
    yield;
  }
  const narrowest = levels[levels.length - 1],
    strong: number[] = [];
  for (let k = 0; k < narrowest.length; k++)
    if (narrowest[k] >= L.strong) strong.push(k);
  if (strong.length < L.min_strong_px)
    throw new Error(
      "No line-like vessels were found in this frame at this polarity",
    );
  const stride = Math.ceil(strong.length / L.max_strong_samples);
  return {
    width: w,
    height: h,
    scale,
    levels,
    strong: Int32Array.from(strong.filter((_, k) => k % stride === 0)),
  };
}

/** One-shot evidence extraction. Interactive callers should step
 * `vesselEvidenceSteps` in short slices instead. */
export function vesselEvidence(
  gray: Uint8Array,
  width: number,
  height: number,
  polarity: Polarity,
  exclude?: Uint8Array,
): VesselEvidence {
  const steps = vesselEvidenceSteps(gray, width, height, polarity, exclude);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}
