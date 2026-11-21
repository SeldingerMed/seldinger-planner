/** A place marked in a frame, carried to the axis of the 3D vessel mask.
 *
 * The carried point is the axis sample that lies nearest the mark in the
 * frame under the registration. A mark in each of two planes fixes the
 * place in space. One plane does not: every vessel under the mark is as
 * near, so the number of other vessels under it is returned with the
 * point. */
import type { ViewNumbers } from "./carmGeometry";
import { placedSamples } from "./framePlacement";
import type { Vec3 } from "./obliqueSlice";
import type { VesselSegments } from "./vesselSegments";

export const CARRY_POINT_LIMITS = {
  /** A sample this far from a mark, measured in the frame at the sample's
   * depth, is not under it. */
  reach_mm: 3,
  /** Samples under one mark that lie this far apart in the volume are of
   * two vessels, or of one vessel passing twice. */
  apart_mm: 6,
  max_planes: 2,
} as const;

export type CarryInput = {
  segments: VesselSegments;
  isocenter: Vec3;
  /** Volume RAS to C-arm RAS, as confirmed. */
  matrix: number[][];
  planes: { view: ViewNumbers; frame: { width: number; height: number } }[];
};
/** A place in the frame of `planes[plane]`, in frame pixels. */
export type FrameMark = { plane: number; x: number; y: number };
export type CarriedPoint = {
  /** Index of the axis sample in `segments.points`. */
  sample: number;
  segment: number;
  /** The sample, in the RAS millimeters of the volume. */
  point: Vec3;
  /** Distance of the sample from each mark, in the mark's order. */
  off_mm: number[];
  /** Other vessels under every mark: unbranched runs with a sample in
   * reach that lies apart from the carried point in the volume. */
  crossings: number;
};

/** The axis sample under the marks, or null when none is in reach of every
 * mark. */
export function carryPoint(
  input: CarryInput,
  marks: FrameMark[],
): CarriedPoint | null {
  const L = CARRY_POINT_LIMITS,
    { segments, points, labels } = input.segments,
    count = labels.length;
  if (
    !Array.isArray(input.planes) ||
    input.planes.length < 1 ||
    input.planes.length > L.max_planes
  )
    throw new Error("One or two planes are required");
  if (points.length !== 3 * count || !count)
    throw new Error("Invalid vessel segments");
  if (
    !Array.isArray(marks) ||
    marks.length < 1 ||
    marks.length > input.planes.length ||
    marks.some(
      (mark, i) =>
        !Number.isInteger(mark.plane) ||
        mark.plane < 0 ||
        mark.plane >= input.planes.length ||
        marks.findIndex((other) => other.plane === mark.plane) !== i,
    )
  )
    throw new Error("One mark per plane");
  const off = marks.map((mark) => {
    const { view, frame } = input.planes[mark.plane];
    if (!(
      mark.x >= 0 &&
      mark.y >= 0 &&
      mark.x <= frame.width &&
      mark.y <= frame.height
    ))
      throw new Error("A mark lies outside its frame");
    const placed = placedSamples(
        view,
        input.isocenter,
        input.matrix,
        points,
        frame,
      ),
      out = new Float32Array(count);
    for (let k = 0; k < count; k++)
      // NaN, for a sample that cannot be projected, is in reach of nothing.
      out[k] =
        Math.hypot(
          placed.pixels[2 * k] - mark.x,
          placed.pixels[2 * k + 1] - mark.y,
        ) * placed.mm_per_px[k];
    return out;
  });
  const under: number[] = [];
  let best = -1,
    least = Infinity;
  for (let k = 0; k < count; k++) {
    let sum = 0;
    for (const one of off) sum += one[k] <= L.reach_mm ? one[k] ** 2 : NaN;
    if (Number.isNaN(sum)) continue;
    under.push(k);
    // Of two samples as near, the first is kept.
    if (sum < least) {
      least = sum;
      best = k;
    }
  }
  if (best < 0) return null;
  const point = Array.from(points.subarray(3 * best, 3 * best + 3)) as Vec3,
    runs = new Set<number>();
  for (const k of under)
    if (
      Math.hypot(
        points[3 * k] - point[0],
        points[3 * k + 1] - point[1],
        points[3 * k + 2] - point[2],
      ) >= L.apart_mm
    )
      runs.add(segments[labels[k]].run);
  return {
    sample: best,
    segment: labels[best],
    point,
    off_mm: off.map((one) => one[best]),
    crossings: runs.size,
  };
}
