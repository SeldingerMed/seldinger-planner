/** Reads a prepared DeepFluoro specimen (scripts/research/prepare_bone_sets.py)
 * into the bone line-up's inputs, for an offline evaluation. Research only:
 * nothing here is reachable from the application. The set's licence is
 * non-commercial: internal evaluation only.
 *
 * Each specimen is a cadaver pelvis with one CT, many single C-arm frames,
 * a stored pose for every frame and fourteen landmarks marked in the CT.
 * The stored pose is the reference the line-up is scored against.
 *
 * A frame is stored whole, collimator shadow included; its intrinsics
 * describe the picture inside the shadow. The reader cuts the shadow off
 * in whole prepared pixels and places the stored view as primary 0,
 * secondary 0 of its own C-arm frame (./ljubljanaGeometry.ts, the same
 * stored conventions). */
import type { BoneFrameInput, BoneVolume } from "../boneLineup";
import type { Vec3 } from "../obliqueSlice";
import { singleViewGeometry, storedPoints } from "./ljubljanaGeometry";

export const PELVIS = {
  id: "pelvis-bone-lineup-design",
  /** Specimen numbers, first and last. Fixed before any run. */
  design: [1, 3],
  held_back: [4, 6],
  /** The set's own bone labels: 1 and 2 the hip bones, 3 vertebrae, 4 and 7
   * the sacrum, 5 and 6 the femurs. A femur turns at the hip between the
   * scan and the frames, and the stored pose is the pelvis's. */
  labels: [0, 1, 2, 3, 4, 5, 6, 7],
  femur_labels: [5, 6],
  /** Frames taken per specimen, evenly through its frames. */
  frames_per_subject: 12,
  /** Disturbed starts per frame, and how far each may be from the stored
   * pose: across the frame, along its beam, and each turn. */
  starts: 3,
  across_mm: 15,
  depth_mm: 30,
  turn_deg: 8,
  seed: 20261122,
} as const;

type StoredFrame = {
  pose: number[][];
  intrinsics: {
    sdd: number;
    delx: number;
    dely: number;
    x0: number;
    y0: number;
    height: number;
    width: number;
  };
  stored_height: number;
  stored_width: number;
  height: number;
  width: number;
};
export type PelvisRecord = {
  set: string;
  subject: string;
  volume_shape: number[];
  volume_affine: number[][];
  fiducial_count: number;
  frame_block: number;
  label_values: number[];
  frames: Record<string, StoredFrame>;
};

/** Specimen names: `design`, or design specimen numbers. */
export function pelvisSubjects(set: string): string[] {
  const [first, last] = PELVIS.design;
  const numbers =
    set === "design"
      ? Array.from({ length: last - first + 1 }, (_, i) => first + i)
      : set.split(",").map((part) => {
          const n = Number(part);
          if (
            part.trim() === "" ||
            !Number.isInteger(n) ||
            n < first ||
            n > last
          )
            throw new Error("Not a design specimen: " + part.trim());
          return n;
        });
  return numbers.map((n) => "subject" + String(n).padStart(2, "0"));
}

/** The frames of a specimen that are run: evenly through its frames. */
export function pelvisFrames(keys: string[]): string[] {
  const sorted = [...keys].sort(),
    n = PELVIS.frames_per_subject;
  if (sorted.length <= n) return sorted;
  return Array.from(
    { length: n },
    (_, i) => sorted[Math.floor((i * sorted.length) / n)],
  );
}

export function pelvisInputs(
  record: PelvisRecord,
  scan: Int16Array,
  fiducials: Float32Array,
  key: string,
  pixels: Uint16Array,
): {
  volume: BoneVolume;
  frame: BoneFrameInput;
  center: Vec3;
  /** The stored pose: volume RAS to this frame's C-arm RAS. */
  stated: number[][];
  /** Landmarks in volume RAS, x y z triples. */
  fiducials: Float32Array;
  /** How far the picture's middle is from the central ray, stored pixels. */
  residual_px: [number, number];
} {
  if (record?.set !== "deepfluoro") throw new Error("Not a pelvis record");
  const shape = record.volume_shape,
    block = record.frame_block;
  if (
    !Array.isArray(shape) ||
    shape.length !== 3 ||
    scan.length !== shape[0] * shape[1] * shape[2]
  )
    throw new Error("Scan does not match its record");
  if (fiducials.length !== 3 * record.fiducial_count)
    throw new Error("Fiducials do not match their record");
  const stored = record.frames[key];
  if (!stored) throw new Error("No such frame: " + key);
  if (pixels.length !== stored.width * stored.height)
    throw new Error("Frame does not match its record");
  const { intrinsics } = stored;
  const margins = [
    [stored.stored_width, stored.width, intrinsics.width],
    [stored.stored_height, stored.height, intrinsics.height],
  ].map(([whole, prepared, picture]) => {
    if (
      !Number.isInteger(block) ||
      block < 1 ||
      prepared * block !== whole ||
      !(picture > 0 && picture <= whole) ||
      (whole - picture) % 2 !== 0
    )
      throw new Error("Frame and stored picture do not match: " + key);
    return Math.ceil((whole - picture) / 2 / block);
  });
  const width = stored.width - 2 * margins[0],
    height = stored.height - 2 * margins[1];
  if (width < 16 || height < 16)
    throw new Error("Frame and stored picture do not match: " + key);
  const cut = new Uint16Array(width * height);
  for (let y = 0; y < height; y++)
    cut.set(
      pixels.subarray(
        (y + margins[1]) * stored.width + margins[0],
        (y + margins[1]) * stored.width + margins[0] + width,
      ),
      y * width,
    );
  // The central ray, in stored pixels from the left and top of the whole
  // frame, and the cut around it.
  const column = stored.stored_width / 2 + intrinsics.x0 / intrinsics.delx,
    row = stored.stored_height / 2 + intrinsics.y0 / intrinsics.dely;
  const window = {
    left: margins[0] * block,
    top: margins[1] * block,
    width: width * block,
    height: height * block,
    factor: block,
    residual_px: [
      margins[0] * block + (width * block) / 2 - column,
      margins[1] * block + (height * block) / 2 - row,
    ] as [number, number],
  };
  if (window.residual_px.some((value) => Math.abs(value) > block / 2))
    throw new Error("The central ray is off the picture's middle: " + key);
  const placed = singleViewGeometry(
    shape,
    record.volume_affine,
    {
      pose: stored.pose,
      intrinsics,
      width: stored.stored_width,
      height: stored.stored_height,
    },
    window,
  );
  const center = placed.center.map((value) =>
    value === 0 ? 0 : value,
  ) as Vec3;
  return {
    volume: { data: scan, shape, affine: record.volume_affine },
    frame: {
      view: placed.plane.view,
      isocenter: placed.plane.isocenter,
      pixels: cut,
      width,
      height,
    },
    center,
    stated: placed.matrix,
    fiducials: storedPoints(fiducials, center),
    residual_px: window.residual_px,
  };
}

/** The scan's bone that moves against the pelvis: its femurs. */
export function pelvisMoving(
  record: PelvisRecord,
  labels: Uint8Array,
  moving = new Uint8Array(labels.length),
): Uint8Array {
  const shape = record.volume_shape,
    values = record.label_values;
  if (
    labels.length !== shape[0] * shape[1] * shape[2] ||
    !Array.isArray(values) ||
    values.length !== PELVIS.labels.length ||
    !PELVIS.labels.every((label, i) => values[i] === label)
  )
    throw new Error("Labels do not match their record");
  const femurs: readonly number[] = PELVIS.femur_labels;
  for (let i = 0; i < labels.length; i++)
    moving[i] = femurs.includes(labels[i]) ? 1 : 0;
  return moving;
}

/** Mean distance between where two poses put the landmarks; with `beam`,
 * only the part across that direction, which is what one frame can see. */
export function targetErrorMm(
  points: Float32Array,
  a: number[][],
  b: number[][],
  beam?: readonly number[],
): number {
  let sum = 0;
  for (let k = 0; k < points.length; k += 3) {
    const d = [0, 1, 2].map(
      (r) =>
        (a[r][0] - b[r][0]) * points[k] +
        (a[r][1] - b[r][1]) * points[k + 1] +
        (a[r][2] - b[r][2]) * points[k + 2] +
        a[r][3] -
        b[r][3],
    );
    if (beam) {
      const along = d[0] * beam[0] + d[1] * beam[1] + d[2] * beam[2];
      for (let r = 0; r < 3; r++) d[r] -= along * beam[r];
    }
    sum += Math.hypot(d[0], d[1], d[2]);
  }
  return sum / (points.length / 3);
}
