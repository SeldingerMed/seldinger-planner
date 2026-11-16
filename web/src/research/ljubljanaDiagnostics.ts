/** Measurements for the reference-pose diagnostics written in
 * docs/research/ljubljana-reference-diagnostics-protocol.md. Research only:
 * nothing here is reachable from the application, and nothing here is a
 * registration method. */
import { crc32, deflateSync } from "node:zlib";
import { distanceToSeeds } from "../distanceTransform";
import type { VesselTarget } from "../vesselness2d";
import type { FrameWindow, StoredView } from "./ljubljanaGeometry";

export const DIAGNOSTICS_PROTOCOL = {
  id: "ljubljana-reference-diagnostics-v1",
  /** The only subjects any diagnostic may open. */
  subjects: [1, 2, 3, 4, 5],
  polarity: "dark",
  match_mm: 2,
  cap_mm: 8,
  /** In-plane shifts tried about the reference, in eight directions. */
  shifts_mm: [1, 2, 3, 5],
  /** Reach of the darkness slide, in 1 mm steps. */
  slide_mm: 10,
} as const;

/** The prepared directory of a diagnostic subject. Any other subject is
 * refused: subjects 06 to 10 are held back from diagnosis and tuning. */
export function diagnosticDirectory(prepared: string, subject: number): string {
  if (!(DIAGNOSTICS_PROTOCOL.subjects as readonly number[]).includes(subject))
    throw new Error("This subject is held back from diagnostics");
  return `${prepared}/subject${String(subject).padStart(2, "0")}`;
}

/** The window of a stored 16-bit frame as block means, unconverted. */
export function framePixels(
  pixels: Uint16Array,
  view: StoredView,
  window: FrameWindow,
): Float32Array {
  if (pixels.length !== view.width * view.height)
    throw new Error("Frame does not match its stored size");
  const f = window.factor,
    w = window.width / f,
    h = window.height / f,
    out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let j = 0; j < f; j++) {
        const at = (window.top + y * f + j) * view.width + window.left + x * f;
        for (let i = 0; i < f; i++) sum += pixels[at + i];
      }
      out[y * w + x] = sum / (f * f);
    }
  return out;
}

/** Values at the given quantiles, by nearest rank. */
export function percentiles(values: Float32Array, at: number[]): number[] {
  const sorted = Float32Array.from(values).sort();
  return at.map(
    (q) =>
      sorted[
        Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))
      ],
  );
}

/** The frame with its 0.5th to 99.5th percentile range mapped linearly onto
 * 0 to 255. A frame of one value maps to 0. */
export function stretched(raw: Float32Array): Uint8Array {
  const [low, high] = percentiles(raw, [0.005, 0.995]),
    out = new Uint8Array(raw.length),
    range = high - low;
  if (!(range > 0)) return out;
  for (let k = 0; k < raw.length; k++)
    out[k] = Math.max(
      0,
      Math.min(255, Math.round(((raw[k] - low) / range) * 255)),
    );
  return out;
}

/** Number of distinct gray levels in use. */
export function levels(gray: Uint8Array): number {
  const seen = new Uint8Array(256);
  let count = 0;
  for (const value of gray)
    if (!seen[value]) {
      seen[value] = 1;
      count++;
    }
  return count;
}

const inside = (x: number, y: number, width: number, height: number) =>
  x >= -0.5 && y >= -0.5 && x <= width - 0.5 && y <= height - 0.5;

/** 3D to 2D: the mean distance from projected points to the nearest 2D
 * centerline, capped, and the share within the match distance. `pixels`
 * holds frame pixel pairs, NaN where a point did not project; `shift` moves
 * them all, in frame pixels. A point outside the frame counts at the cap. */
export function forward(
  target: VesselTarget,
  pixels: Float32Array,
  width: number,
  height: number,
  mm_per_px: number,
  dx = 0,
  dy = 0,
): { forward_mm: number; forward_matched: number } {
  const { cap_mm, match_mm } = DIAGNOSTICS_PROTOCOL,
    count = pixels.length / 2;
  let sum = 0,
    matched = 0;
  for (let k = 0; k < count; k++) {
    const x = pixels[2 * k] + dx,
      y = pixels[2 * k + 1] + dy;
    if (!inside(x, y, width, height)) {
      sum += cap_mm;
      continue;
    }
    // Nearest working pixel; `inside` rejects NaN.
    const wx = Math.min(
        target.width - 1,
        Math.max(0, Math.round((x + 0.5) / target.scale - 0.5)),
      ),
      wy = Math.min(
        target.height - 1,
        Math.max(0, Math.round((y + 0.5) / target.scale - 0.5)),
      ),
      d = target.distance[wy * target.width + wx] * target.scale * mm_per_px;
    sum += Math.min(d, cap_mm);
    if (d <= match_mm) matched++;
  }
  return { forward_mm: sum / count, forward_matched: matched / count };
}

/** 2D to 3D: the mean distance from 2D centerline pixels to the nearest
 * projected point, capped, and the share within the match distance. */
export function backward(
  target: VesselTarget,
  pixels: Float32Array,
  width: number,
  height: number,
  mm_per_px: number,
  dx = 0,
  dy = 0,
): { backward_mm: number; backward_matched: number } {
  const { cap_mm, match_mm } = DIAGNOSTICS_PROTOCOL,
    w = target.width,
    h = target.height,
    step = target.scale * mm_per_px,
    seeds = new Uint8Array(w * h);
  for (let k = 0; k < pixels.length; k += 2) {
    const x = pixels[k] + dx,
      y = pixels[k + 1] + dy;
    if (!inside(x, y, width, height)) continue;
    const wx = Math.round((x + 0.5) / target.scale - 0.5),
      wy = Math.round((y + 0.5) / target.scale - 0.5);
    if (wx >= 0 && wy >= 0 && wx < w && wy < h) seeds[wy * w + wx] = 1;
  }
  const distance = distanceToSeeds(seeds, w, h, Math.ceil(cap_mm / step) + 1);
  let sum = 0,
    matched = 0;
  for (const at of target.centerline) {
    const d = distance[at] * step;
    sum += Math.min(d, cap_mm);
    if (d <= match_mm) matched++;
  }
  const count = target.centerline.length;
  return { backward_mm: sum / count, backward_matched: matched / count };
}

/** How far, in millimeters, the projected points must be slid in the image
 * plane to lie on the darkest pixels: the length of the whole-millimeter
 * shift, out to the protocol's reach on each axis, with the lowest mean
 * frame value under the points. A shift that leaves fewer than half the
 * points in the frame is not considered. Ties go to the shortest shift. */
export function darkestShift(
  raw: Float32Array,
  width: number,
  height: number,
  pixels: Float32Array,
  mm_per_px: number,
): number {
  const reach = DIAGNOSTICS_PROTOCOL.slide_mm,
    count = pixels.length / 2;
  let best = Infinity,
    length = NaN;
  for (let sy = -reach; sy <= reach; sy++)
    for (let sx = -reach; sx <= reach; sx++) {
      let sum = 0,
        used = 0;
      for (let k = 0; k < count; k++) {
        const x = Math.round(pixels[2 * k] + sx / mm_per_px),
          y = Math.round(pixels[2 * k + 1] + sy / mm_per_px);
        if (!(x >= 0 && y >= 0 && x < width && y < height)) continue;
        sum += raw[y * width + x];
        used++;
      }
      if (used < count / 2) continue;
      const mean = sum / used,
        here = Math.hypot(sx, sy);
      if (mean < best || (mean === best && here < length)) {
        best = mean;
        length = here;
      }
    }
  return length;
}

export type Picture = { width: number; height: number; rgb: Uint8Array };

/** Three panels side by side: the frame, the frame with the extracted
 * centerlines in green, and the frame with the projected points in red. */
export function overlay(
  gray: Uint8Array,
  width: number,
  height: number,
  target: VesselTarget,
  pixels: Float32Array,
): Picture {
  const rgb = new Uint8Array(3 * 3 * width * height);
  const put = (panel: number, x: number, y: number, color: number[]) => {
    const at = 3 * (y * 3 * width + panel * width + x);
    rgb[at] = color[0];
    rgb[at + 1] = color[1];
    rgb[at + 2] = color[2];
  };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const value = gray[y * width + x];
      for (let panel = 0; panel < 3; panel++)
        put(panel, x, y, [value, value, value]);
    }
  for (const at of target.centerline) {
    const wx = at % target.width,
      wy = (at - wx) / target.width;
    for (let j = 0; j < target.scale; j++)
      for (let i = 0; i < target.scale; i++) {
        const x = wx * target.scale + i,
          y = wy * target.scale + j;
        if (x < width && y < height) put(1, x, y, [0, 255, 0]);
      }
  }
  for (let k = 0; k < pixels.length; k += 2) {
    const x = Math.round(pixels[k]),
      y = Math.round(pixels[k + 1]);
    if (x >= 0 && y >= 0 && x < width && y < height) put(2, x, y, [255, 0, 0]);
  }
  return { width: 3 * width, height, rgb };
}

/** An 8-bit RGB PNG. */
export function png(picture: Picture): Buffer {
  const { width, height, rgb } = picture;
  if (rgb.length !== 3 * width * height) throw new Error("Invalid picture");
  const rows = Buffer.alloc((3 * width + 1) * height);
  for (let y = 0; y < height; y++)
    rows.set(
      rgb.subarray(3 * width * y, 3 * width * (y + 1)),
      (3 * width + 1) * y + 1,
    );
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]),
      out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
