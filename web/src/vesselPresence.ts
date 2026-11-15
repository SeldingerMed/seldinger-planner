/** Which segments of the 3D vessel mask have a vessel under them in a frame.
 *
 * Each segment's axis samples are projected with a registration. A sample is
 * supported when a 2D vessel centerline of the frame lies within a fixed
 * distance of it. A segment is then put in one of four classes per plane.
 * 2D centerline with no projected sample near it is listed separately.
 *
 * Nothing here says why a segment has no support. The vessel may be
 * occluded, unfilled, outside the injected territory, absent, or the
 * registration may be wrong: the classes describe the frame under the
 * registration it was given, and they are only as good as that
 * registration. */
import { type ViewNumbers } from "./carmGeometry";
import type { Vec3 } from "./obliqueSlice";
import { projectRegistered } from "./projectionRegistration";
import { VESSEL_TARGET_LIMITS, type VesselTarget } from "./vesselness2d";
import type { VesselSegments } from "./vesselSegments";

export const VESSEL_PRESENCE_METHOD = "segment_centerline_support_v1";
export const VESSEL_PRESENCE_LIMITS = {
  /** A sample is supported by a 2D centerline this near, and a 2D centerline
   * pixel is matched by a sample this near. Millimeters at the isocenter. */
  support_mm: 2,
  /** A sample lies over another when the two are within `support_mm` in
   * the frame and either belong to different runs of the mask (one vessel
   * crossing another, or a branch leaving its parent) or are this far from
   * each other in the volume (a vessel seen end-on, or looping back).
   * Neither can be judged there: what the frame shows under them cannot be
   * put down to one of them. */
  apart_mm: 6,
  /** Below this share of its samples inside the frame, a segment is outside
   * the field. */
  min_in_field: 0.5,
  /** A segment is judged on the samples that lie over no other. It needs
   * this many of them, and this share of its samples inside the frame. */
  min_clear_samples: 3,
  min_clear_fraction: 0.3,
  /** Share of the judged samples that must be supported, and the share at
   * or below which the segment has no support. Between them it is
   * indeterminate. */
  supported_fraction: 0.7,
  unsupported_fraction: 0.3,
  /** Shorter unmatched 2D pieces are not listed. */
  min_piece_mm: 5,
  max_planes: 2,
} as const;

export const PRESENCE_CLASSES = [
  "supported",
  "no_2d_support",
  "outside_field",
  "indeterminate",
] as const;
export type PresenceClass = (typeof PRESENCE_CLASSES)[number];

export type PresencePlaneInput = {
  view: ViewNumbers;
  frame: { width: number; height: number };
  target: VesselTarget;
};
export type PresenceInput = {
  segments: VesselSegments;
  isocenter: Vec3;
  /** Volume to C-arm, as a registration record stores it. */
  matrix: number[][];
  planes: PresencePlaneInput[];
};
export type SegmentPresence = {
  class: PresenceClass;
  /** Samples inside the frame, those of them that lie over no other
   * sample, and those of the latter with a 2D centerline near. */
  in_field: number;
  clear: number;
  supported: number;
};
export type UnmatchedPiece = {
  /** Pixel count times the size of a working pixel at the isocenter: an
   * estimate, since a centerline is not everywhere one pixel wide. */
  length_mm: number;
  /** Working-grid indices, `y * width + x`, of the piece. */
  pixels: Int32Array;
};
export type PlanePresence = {
  segments: SegmentPresence[];
  /** Longest first. */
  unmatched: UnmatchedPiece[];
};
export type VesselPresence = {
  method: typeof VESSEL_PRESENCE_METHOD;
  planes: PlanePresence[];
};

function planePresence(
  input: PresenceInput,
  plane: PresencePlaneInput,
): PlanePresence {
  const L = VESSEL_PRESENCE_LIMITS,
    { segments, points, labels } = input.segments,
    { view, frame, target } = plane,
    { width: w, height: h, distance, centerline, scale } = target,
    count = labels.length;
  if (
    !Number.isFinite(scale) ||
    scale <= 0 ||
    !Number.isInteger(w) ||
    !Number.isInteger(h) ||
    w < 2 ||
    h < 2 ||
    distance.length !== w * h
  )
    throw new Error("Invalid vessel target");
  // Throws on a view, frame size or matrix it cannot use.
  const projected = projectRegistered(
    view,
    input.isocenter,
    input.matrix,
    points,
    frame,
  );
  const pitch = view.detector_width_mm / frame.width;
  if (Math.abs(view.detector_height_mm / frame.height / pitch - 1) > 0.02)
    throw new Error("Detector pixels must be square");
  // One working pixel in millimeters at the isocenter, as registration
  // measures it.
  const mm_per_px =
      (pitch * scale * view.source_isocenter_mm) / view.source_detector_mm,
    reach = L.support_mm / mm_per_px;
  if (!(reach > 0) || reach > VESSEL_TARGET_LIMITS.max_distance_px)
    throw new Error("Field too small for this frame");

  // Working-grid position of each sample inside the frame, and whether a
  // 2D centerline is near it.
  const at = new Float32Array(2 * count),
    inside = new Uint8Array(count),
    near = new Uint8Array(count);
  for (let k = 0; k < count; k++) {
    const fx = projected[2 * k],
      fy = projected[2 * k + 1];
    // Frame coordinates run from 0 at one edge of the frame to its width or
    // height at the other. NaN, for a point that cannot be projected, fails
    // this test.
    if (!(fx >= 0 && fy >= 0 && fx <= frame.width && fy <= frame.height))
      continue;
    inside[k] = 1;
    // Working-grid coordinates count from the center of the first pixel.
    const px = fx / scale - 0.5,
      py = fy / scale - 0.5;
    at[2 * k] = px;
    at[2 * k + 1] = py;
    // The distance map is sampled at the nearest place it is defined.
    const sx = px < 0 ? 0 : px > w - 1 ? w - 1 : px,
      sy = py < 0 ? 0 : py > h - 1 ? h - 1 : py,
      x0 = Math.min(w - 2, Math.floor(sx)),
      y0 = Math.min(h - 2, Math.floor(sy)),
      tx = sx - x0,
      ty = sy - y0,
      corner = y0 * w + x0;
    if (
      distance[corner] * (1 - tx) * (1 - ty) +
        distance[corner + 1] * tx * (1 - ty) +
        distance[corner + w] * (1 - tx) * ty +
        distance[corner + w + 1] * tx * ty <=
      reach
    )
      near[k] = 1;
  }

  // Samples by cell of a grid as coarse as the reach, so that everything
  // within reach of a place is in the cells around it.
  const cell = Math.max(1, Math.ceil(reach)),
    gw = Math.floor((w + 2) / cell) + 2,
    gh = Math.floor((h + 2) / cell) + 2,
    cellAt = (px: number, py: number) =>
      Math.min(gh - 1, Math.max(0, Math.floor((py + 1) / cell))) * gw +
      Math.min(gw - 1, Math.max(0, Math.floor((px + 1) / cell))),
    first = new Int32Array(gw * gh).fill(-1),
    next = new Int32Array(count).fill(-1);
  for (let k = 0; k < count; k++)
    if (inside[k]) {
      const c = cellAt(at[2 * k], at[2 * k + 1]);
      next[k] = first[c];
      first[c] = k;
    }
  /** Calls `visit` with each sample within reach of a working-grid place,
   * until it returns true. */
  function around(px: number, py: number, visit: (k: number) => boolean) {
    const cx = Math.min(gw - 1, Math.max(0, Math.floor((px + 1) / cell))),
      cy = Math.min(gh - 1, Math.max(0, Math.floor((py + 1) / cell)));
    for (let j = Math.max(0, cy - 1); j <= Math.min(gh - 1, cy + 1); j++)
      for (let i = Math.max(0, cx - 1); i <= Math.min(gw - 1, cx + 1); i++)
        for (let k = first[j * gw + i]; k !== -1; k = next[k])
          if (
            Math.hypot(at[2 * k] - px, at[2 * k + 1] - py) <= reach &&
            visit(k)
          )
            return;
  }

  // A sample lies over another when the two are near in the frame and
  // are of different runs, or apart in the volume.
  const tally = segments.map(() => ({ in_field: 0, clear: 0, supported: 0 })),
    total = segments.map(() => 0);
  for (let k = 0; k < count; k++) {
    total[labels[k]]++;
    if (!inside[k]) continue;
    const mine = tally[labels[k]];
    mine.in_field++;
    let over = false;
    const run = segments[labels[k]].run;
    around(at[2 * k], at[2 * k + 1], (other) => {
      over =
        segments[labels[other]].run !== run ||
        Math.hypot(
          points[3 * k] - points[3 * other],
          points[3 * k + 1] - points[3 * other + 1],
          points[3 * k + 2] - points[3 * other + 2],
        ) >= L.apart_mm;
      return over;
    });
    if (over) continue;
    mine.clear++;
    if (near[k]) mine.supported++;
  }
  const classed = tally.map((mine, index): SegmentPresence => {
    let found: PresenceClass;
    if (mine.in_field < L.min_in_field * total[index]) found = "outside_field";
    else if (
      mine.clear < L.min_clear_samples ||
      mine.clear < L.min_clear_fraction * mine.in_field
    )
      found = "indeterminate";
    else if (mine.supported >= L.supported_fraction * mine.clear)
      found = "supported";
    else if (mine.supported <= L.unsupported_fraction * mine.clear)
      found = "no_2d_support";
    else found = "indeterminate";
    return { class: found, ...mine };
  });

  // 2D centerline pixels with no sample near, in connected pieces.
  const loose = new Uint8Array(w * h);
  for (const pixel of centerline) {
    if (!Number.isInteger(pixel) || pixel < 0 || pixel >= w * h)
      throw new Error("Invalid vessel target");
    let matched = false;
    around(pixel % w, Math.floor(pixel / w), () => (matched = true));
    if (!matched) loose[pixel] = 1;
  }
  const unmatched: UnmatchedPiece[] = [],
    stack: number[] = [];
  for (const seed of centerline) {
    if (loose[seed] !== 1) continue;
    const piece: number[] = [];
    loose[seed] = 2;
    stack.push(seed);
    while (stack.length) {
      const pixel = stack.pop()!,
        x = pixel % w,
        y = Math.floor(pixel / w);
      piece.push(pixel);
      for (let j = Math.max(0, y - 1); j <= Math.min(h - 1, y + 1); j++)
        for (let i = Math.max(0, x - 1); i <= Math.min(w - 1, x + 1); i++)
          if (loose[j * w + i] === 1) {
            loose[j * w + i] = 2;
            stack.push(j * w + i);
          }
    }
    if (piece.length * mm_per_px >= L.min_piece_mm)
      unmatched.push({
        length_mm: piece.length * mm_per_px,
        pixels: Int32Array.from(piece).sort(),
      });
  }
  unmatched.sort(
    (a, b) => b.length_mm - a.length_mm || a.pixels[0] - b.pixels[0],
  );
  return { segments: classed, unmatched };
}

/** Presence of every segment in each plane of one registration. */
export function vesselPresence(input: PresenceInput): VesselPresence {
  const { segments, points, labels } = input.segments;
  if (
    !Array.isArray(input.planes) ||
    input.planes.length < 1 ||
    input.planes.length > VESSEL_PRESENCE_LIMITS.max_planes ||
    points.length !== 3 * labels.length ||
    segments.length < 1 ||
    labels.some(
      (label) =>
        !Number.isInteger(label) || label < 0 || label >= segments.length,
    )
  )
    throw new Error("Invalid presence input");
  return {
    method: VESSEL_PRESENCE_METHOD,
    planes: input.planes.map((plane) => planePresence(input, plane)),
  };
}
