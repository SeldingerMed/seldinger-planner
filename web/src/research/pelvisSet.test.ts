import { describe, expect, it } from "vitest";
import {
  PELVIS,
  pelvisFrames,
  pelvisInputs,
  pelvisMoving,
  pelvisSubjects,
  pelvisVolume,
  targetErrorMm,
  type PelvisRecord,
} from "./pelvisSet";

const frame = (shift: number) => ({
  pose: [
    [-1, 0, 0, shift],
    [0, -1, 0, -700],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ],
  intrinsics: {
    sdd: 1020,
    delx: 0.2,
    dely: 0.2,
    x0: -0.1,
    y0: -0.1,
    height: 64,
    width: 64,
  },
  stored_height: 80,
  stored_width: 80,
  height: 20,
  width: 20,
});
const record = (): PelvisRecord => ({
  set: "deepfluoro",
  subject: "subject01",
  volume_shape: [4, 4, 6],
  volume_affine: [
    [-1, 0, 0, 1.5],
    [0, -1, 0, 1.5],
    [0, 0, 1, -2.5],
    [0, 0, 0, 1],
  ],
  fiducial_count: 2,
  frame_block: 4,
  label_values: [0, 1, 2, 3, 4, 5, 6, 7],
  frames: { "000": frame(0), "001": frame(5) },
});
const pixels = () => {
  const p = new Uint16Array(400);
  for (let i = 0; i < 400; i++) p[i] = i;
  return p;
};

describe("pelvisVolume", () => {
  it("is the scan on the record's grid, and refuses one that is not", () => {
    const scan = new Int16Array(96),
      volume = pelvisVolume(record(), scan);
    expect(volume.data).toBe(scan);
    expect(volume.shape).toEqual([4, 4, 6]);
    expect(volume.affine).toEqual(record().volume_affine);
    expect(() => pelvisVolume(record(), new Int16Array(5))).toThrow(
      "Scan does not match its record",
    );
    const other = record();
    other.set = "lspine";
    expect(() => pelvisVolume(other, scan)).toThrow("Not a pelvis record");
  });
});

describe("pelvisInputs", () => {
  it("cuts the collimated margin and reads the stored view", () => {
    const read = pelvisInputs(
      record(),
      new Float32Array([1, 2, 3, -4, 5, 6]),
      "000",
      pixels(),
    );
    // 80 stored pixels hold a 64-pixel picture: 8 a side, 2 prepared pixels.
    expect(read.frame.width).toBe(16);
    expect(read.frame.height).toBe(16);
    expect(read.frame.pixels[0]).toBe(2 * 20 + 2);
    expect(read.frame.pixels[16 * 16 - 1]).toBe(17 * 20 + 17);
    expect(read.frame.view).toEqual({
      primary_deg: 0,
      secondary_deg: 0,
      source_detector_mm: 1020,
      source_isocenter_mm: 700,
      detector_width_mm: 64 * 0.2,
      detector_height_mm: 64 * 0.2,
    });
    expect(read.center).toEqual([0, 0, 0]);
    // Fiducials are stored about the scan's center.
    expect(Array.from(read.fiducials)).toEqual([1, 2, 3, -4, 5, 6]);
    // The stated pose puts the scan's center on the beam's axis.
    for (const row of read.stated.slice(0, 3)) expect(row[3]).toBeCloseTo(0, 9);
    expect(read.residual_px).toEqual([0.5, 0.5]);
  });

  it("holds the scan where the stored poses do, part of a voxel off its header", () => {
    const read = pelvisInputs(
      record(),
      new Float32Array([1, 2, 3, -4, 5, 6]),
      "001",
      pixels(),
    );
    // The record's grid runs -1, -1 and +1 mm a voxel.
    const [i, j, k] = PELVIS.grid_offset_voxels,
      moved = [-i, -j, k];
    expect(PELVIS.grid_offset_voxels).toEqual([0.5, 0.5, 0.5]);
    for (const point of [
      [0, 0, 0],
      [3, -7, 11],
    ])
      for (let r = 0; r < 3; r++) {
        const at = (m: number[][], p: number[]) =>
          m[r][0] * p[0] + m[r][1] * p[1] + m[r][2] * p[2] + m[r][3];
        expect(at(read.reference, point)).toBeCloseTo(
          at(
            read.stated,
            point.map((value, axis) => value + moved[axis]),
          ),
          9,
        );
      }
    expect(read.reference[3]).toEqual([0, 0, 0, 1]);
    // The stored pose itself is kept as its files give it.
    for (const row of read.stated.slice(0, 3)) expect(row[3]).not.toBeNaN();
  });

  it("refuses a record it would have to guess at", () => {
    const args = () => [new Float32Array(6), "000", pixels()] as const;
    const other = record();
    other.set = "lspine";
    expect(() => pelvisInputs(other, ...args())).toThrow("Not a pelvis record");
    expect(() =>
      pelvisInputs(record(), new Float32Array(3), "000", pixels()),
    ).toThrow("Fiducials do not match their record");
    expect(() =>
      pelvisInputs(record(), new Float32Array(6), "007", pixels()),
    ).toThrow("No such frame: 007");
    expect(() =>
      pelvisInputs(record(), new Float32Array(6), "000", new Uint16Array(9)),
    ).toThrow("Frame does not match its record");
    const uneven = record();
    uneven.frames["000"].stored_width = 82;
    expect(() => pelvisInputs(uneven, ...args())).toThrow(
      "Frame and stored picture do not match: 000",
    );
  });
});

describe("pelvis design set", () => {
  it("keeps the design and held-back specimens apart", () => {
    expect(pelvisSubjects("design")).toEqual([
      "subject01",
      "subject02",
      "subject03",
    ]);
    expect(pelvisSubjects("2")).toEqual(["subject02"]);
    expect(pelvisSubjects("held_back")).toEqual([
      "subject04",
      "subject05",
      "subject06",
    ]);
    // A named list is for design work: it cannot reach a held-back specimen.
    expect(() => pelvisSubjects("4")).toThrow("Not a design specimen: 4");
  });

  it("takes frames evenly through a specimen, the same ones every time", () => {
    const keys = Array.from({ length: 111 }, (_, i) =>
      String(i).padStart(3, "0"),
    );
    const taken = pelvisFrames(keys);
    expect(taken).toHaveLength(PELVIS.frames_per_subject);
    expect(taken[0]).toBe("000");
    expect(new Set(taken).size).toBe(taken.length);
    expect(pelvisFrames(keys)).toEqual(taken);
    expect(pelvisFrames(keys.slice(0, 5))).toEqual(keys.slice(0, 5));
  });
});

describe("targetErrorMm", () => {
  it("is the mean distance at the landmarks, whole or across a beam", () => {
    const identity = [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
      moved = [
        [1, 0, 0, 3],
        [0, 1, 0, 4],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
      points = new Float32Array([0, 0, 0, 10, -20, 30]);
    expect(targetErrorMm(points, identity, identity)).toBe(0);
    expect(targetErrorMm(points, moved, identity)).toBeCloseTo(5, 9);
    expect(targetErrorMm(points, moved, identity, [0, 1, 0])).toBeCloseTo(3, 9);
  });
});

describe("pelvisMoving", () => {
  it("marks the femurs, which turn at the hip, and nothing else", () => {
    const labels = new Uint8Array(96);
    labels.set([0, 1, 2, 3, 4, 5, 6, 7]);
    const moving = pelvisMoving(record(), labels);
    expect(Array.from(moving.subarray(0, 8))).toEqual([0, 0, 0, 0, 0, 1, 1, 0]);
    expect(moving.subarray(8).every((value) => value === 0)).toBe(true);
  });

  it("can write over the labels, for a scan too large to hold twice", () => {
    const labels = new Uint8Array(96);
    labels.set([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(pelvisMoving(record(), labels, labels)).toBe(labels);
    expect(Array.from(labels.subarray(0, 8))).toEqual([0, 0, 0, 0, 0, 1, 1, 0]);
  });

  it("refuses labels it would have to guess at", () => {
    expect(() => pelvisMoving(record(), new Uint8Array(95))).toThrow(
      "Labels do not match their record",
    );
    const other = record();
    other.label_values = [0, 1, 2];
    expect(() => pelvisMoving(other, new Uint8Array(96))).toThrow(
      "Labels do not match their record",
    );
  });
});
