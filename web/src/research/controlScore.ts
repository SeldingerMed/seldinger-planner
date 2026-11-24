/** Scores for the known-pose virtual X-ray control
 * (virtualXrayControl.eval.ts): how far a found pose puts the scan's points
 * from where the known pose puts them. */
import { project, type Camera } from "../carmGeometry";

type Matrix = readonly (readonly number[])[];

function moved(m: Matrix, points: Float64Array, i: number): number[] {
  const out = [0, 0, 0];
  for (let r = 0; r < 3; r++) {
    out[r] = m[r][3];
    for (let c = 0; c < 3; c++) out[r] += m[r][c] * points[3 * i + c];
  }
  return out;
}

function summary(distances: number[]) {
  let sum = 0,
    max = 0;
  for (const d of distances) {
    sum += d;
    if (d > max) max = d;
  }
  return { mean: sum / distances.length, max };
}

/** Mean and largest distance, in millimeters, between where two rigid
 * matrices put the points (x, y, z flattened). */
export function poseDistanceMm(
  points: Float64Array,
  a: Matrix,
  b: Matrix,
): { mean: number; max: number } {
  const out: number[] = [];
  for (let i = 0; i < points.length / 3; i++) {
    const pa = moved(a, points, i),
      pb = moved(b, points, i);
    out.push(Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]));
  }
  return summary(out);
}

/** The same, on one frame: the distance between the points' two places on
 * the detector, divided by ``magnification`` (source to detector over source
 * to isocentre) so it reads in millimeters at the isocentre. This is what a
 * single view determines; depth along its beam is not. */
export function inPlaneErrorMm(
  cam: Camera,
  magnification: number,
  points: Float64Array,
  a: Matrix,
  b: Matrix,
): { mean: number; max: number } {
  const out: number[] = [];
  for (let i = 0; i < points.length / 3; i++) {
    const pa = project(cam, moved(a, points, i)),
      pb = project(cam, moved(b, points, i));
    out.push(Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) / magnification);
  }
  return summary(out);
}

type Score = {
  in_plane_mm: { mean: number; max: number };
  three_d_mm: { mean: number; max: number };
};

/** The two scores above for each named group of vessel points (in the
 * scan's RAS millimeters), and for all of them together under ``all``. The
 * line-up never reads these points; they are scored only. */
export function vesselScores(
  cam: Camera,
  magnification: number,
  groups: Record<string, readonly (readonly number[])[]>,
  found: Matrix,
  truth: Matrix,
): Record<string, Score> {
  const score = (points: Float64Array): Score => ({
    in_plane_mm: inPlaneErrorMm(cam, magnification, points, found, truth),
    three_d_mm: poseDistanceMm(points, found, truth),
  });
  const out: Record<string, Score> = {};
  const all: number[] = [];
  for (const [name, list] of Object.entries(groups)) {
    const flat = list.flatMap((p) => [p[0], p[1], p[2]]);
    all.push(...flat);
    out[name] = score(Float64Array.from(flat));
  }
  out.all = score(Float64Array.from(all));
  return out;
}
