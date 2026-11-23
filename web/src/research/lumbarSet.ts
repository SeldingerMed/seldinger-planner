/** Reads a prepared C-ArmLSpine case (scripts/research/prepare_bone_sets.py)
 * into the bone line-up's inputs, for an offline evaluation. Research only:
 * nothing here is reachable from the application.
 *
 * Each case holds a front and a side C-arm frame and the cone-beam scan the
 * same C-arm took about a minute earlier. As found on the design cases and
 * written in docs/plans/fusion-step-d.md:
 *
 * - The scan's RAS frame, centered on the scan, is the C-arm's frame, so the
 *   stated pose of the scan is the identity.
 * - The frames enter this planner's view model as stored, at the stated
 *   angles and distances, with no mirroring.
 * - The stated pixel size is a placeholder. One detector size, 306 mm, fits
 *   both frames of every design case it was fitted on.
 *
 * The set has no reference pose from markers. What is measured is whether
 * the line-up comes back to one answer from disturbed starts, and how far
 * that answer is from the stated geometry. */
import type { BoneFrameInput, BoneVolume } from "../boneLineup";
import type { ViewNumbers } from "../carmGeometry";
import type { Vec3 } from "../obliqueSlice";

export const LUMBAR = {
  id: "lumbar-bone-lineup-design",
  /** Case numbers, first and last. Fixed before any run. */
  design: [1, 49],
  held_back: [50, 149],
  detector_mm: 306,
  /** Disturbed starts per case, and how far each may be from the stated
   * pose: across the first frame, along its beam, and each turn. */
  starts: 6,
  across_mm: 15,
  depth_mm: 30,
  turn_deg: 8,
  seed: 20261122,
  /** Half side of the 27-point grid distances are measured on. */
  targets_mm: 40,
} as const;

export type LumbarRecord = {
  set: string;
  subject: string;
  volume_shape: number[];
  volume_affine: number[][];
  frames: Record<
    string,
    { tags: Record<string, unknown>; height: number; width: number }
  >;
};

/** Case names of a set: `design`, `held_back`, or design case numbers. */
export function lumbarCases(set: string): string[] {
  const range = ([first, last]: readonly number[]) =>
    Array.from({ length: last - first + 1 }, (_, i) => `case${first + i}`);
  if (set === "design") return range(LUMBAR.design);
  if (set === "held_back") return range(LUMBAR.held_back);
  const numbers = set.split(",").filter((part) => part.trim() !== "");
  if (numbers.length === 0) throw new Error("No cases named");
  return numbers.map((part) => {
    const n = Number(part);
    if (!Number.isInteger(n) || n < LUMBAR.design[0] || n > LUMBAR.design[1])
      throw new Error("Not a design case: " + part.trim());
    return `case${n}`;
  });
}

export function lumbarInputs(
  record: LumbarRecord,
  scan: Int16Array,
  pixels: Uint16Array[],
): { volume: BoneVolume; frames: BoneFrameInput[]; center: Vec3 } {
  if (record?.set !== "lspine") throw new Error("Not a lumbar record");
  const shape = record.volume_shape,
    affine = record.volume_affine;
  if (
    !Array.isArray(shape) ||
    shape.length !== 3 ||
    scan.length !== shape[0] * shape[1] * shape[2]
  )
    throw new Error("Scan does not match its record");
  const center = [0, 1, 2].map((r) => {
    const value =
      (affine[r][0] * (shape[0] - 1)) / 2 +
      (affine[r][1] * (shape[1] - 1)) / 2 +
      (affine[r][2] * (shape[2] - 1)) / 2 +
      affine[r][3];
    return value === 0 ? 0 : value;
  }) as Vec3;
  const keys = Object.keys(record.frames).sort();
  if (keys.length !== pixels.length)
    throw new Error("Frames do not match their record");
  const frames = keys.map((key, i): BoneFrameInput => {
    const { tags, width, height } = record.frames[key];
    if (pixels[i].length !== width * height)
      throw new Error("Frames do not match their record");
    const stated = [
      "PositionerPrimaryAngle",
      "PositionerSecondaryAngle",
      "DistanceSourceToDetector",
      "DistanceSourceToPatient",
    ].map((tag) =>
      tags[tag] === "" || tags[tag] == null ? NaN : Number(tags[tag]),
    );
    if (!stated.every(Number.isFinite))
      throw new Error("Frame states no geometry: " + key);
    const view: ViewNumbers = {
      primary_deg: stated[0],
      secondary_deg: stated[1],
      source_detector_mm: stated[2],
      source_isocenter_mm: stated[3],
      detector_width_mm: LUMBAR.detector_mm,
      detector_height_mm: LUMBAR.detector_mm,
    };
    return { view, isocenter: [...center], pixels: pixels[i], width, height };
  });
  return { volume: { data: scan, shape, affine }, frames, center };
}

/** Repeatable uniform numbers in [0, 1) (mulberry32). */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A start away from the stated pose: a shift along, and turns about, the
 * rows of `axes` (image right, image up, beam), about `center`. */
export function disturbedStart(
  random: () => number,
  axes: readonly (readonly number[])[],
  center: readonly number[],
): number[][] {
  const draw = (reach: number) => (2 * random() - 1) * reach;
  const t = [
      draw(LUMBAR.across_mm),
      draw(LUMBAR.across_mm),
      draw(LUMBAR.depth_mm),
    ],
    [rx, ry, rz] = [0, 1, 2].map(() => (draw(LUMBAR.turn_deg) * Math.PI) / 180);
  const cx = Math.cos(rx),
    sx = Math.sin(rx),
    cy = Math.cos(ry),
    sy = Math.sin(ry),
    cz = Math.cos(rz),
    sz = Math.sin(rz);
  const r = [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx],
  ];
  const turn = [0, 1, 2].map((i) =>
    [0, 1, 2].map((j) => {
      let sum = 0;
      for (let a = 0; a < 3; a++)
        for (let b = 0; b < 3; b++) sum += axes[a][i] * r[a][b] * axes[b][j];
      return sum;
    }),
  );
  return [
    ...[0, 1, 2].map((i) => [
      ...turn[i],
      center[i] +
        axes[0][i] * t[0] +
        axes[1][i] * t[1] +
        axes[2][i] * t[2] -
        (turn[i][0] * center[0] +
          turn[i][1] * center[1] +
          turn[i][2] * center[2]),
    ]),
    [0, 0, 0, 1],
  ];
}

/** Mean distance between where two poses put a grid of points about
 * `center`; with `beam`, only the part across that direction. */
export function apartMm(
  a: number[][],
  b: number[][],
  center: readonly number[],
  beam?: readonly number[],
): number {
  const reach = [-LUMBAR.targets_mm, 0, LUMBAR.targets_mm];
  let sum = 0;
  for (const x of reach)
    for (const y of reach)
      for (const z of reach) {
        const p = [center[0] + x, center[1] + y, center[2] + z];
        const d = [0, 1, 2].map(
          (r) =>
            (a[r][0] - b[r][0]) * p[0] +
            (a[r][1] - b[r][1]) * p[1] +
            (a[r][2] - b[r][2]) * p[2] +
            a[r][3] -
            b[r][3],
        );
        if (beam) {
          const along = d[0] * beam[0] + d[1] * beam[1] + d[2] * beam[2];
          for (let r = 0; r < 3; r++) d[r] -= along * beam[r];
        }
        sum += Math.hypot(d[0], d[1], d[2]);
      }
  return sum / 27;
}
