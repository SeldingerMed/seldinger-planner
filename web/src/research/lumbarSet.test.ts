import { describe, expect, it } from "vitest";
import { validateRigid } from "../rigidFusion";
import {
  apartMm,
  disturbedStart,
  LUMBAR,
  lumbarCases,
  lumbarInputs,
  seeded,
  type LumbarRecord,
} from "./lumbarSet";

const record = (): LumbarRecord => ({
  set: "lspine",
  subject: "case1",
  volume_shape: [4, 4, 6],
  volume_affine: [
    [-1, 0, 0, 1.5],
    [0, -1, 0, 1.5],
    [0, 0, 1, -2.5],
    [0, 0, 0, 1],
  ],
  frames: Object.fromEntries(
    [
      ["000", "0.0"],
      ["001", "90.0"],
    ].map(([key, angle]) => [
      key,
      {
        tags: {
          PositionerPrimaryAngle: angle,
          PositionerSecondaryAngle: "0.7",
          DistanceSourceToDetector: "1140",
          DistanceSourceToPatient: "745",
        },
        height: 16,
        width: 16,
      },
    ]),
  ),
});
const volume = () => new Int16Array(4 * 4 * 6),
  frames = () => [new Uint16Array(256), new Uint16Array(256)];

describe("lumbarInputs", () => {
  it("reads the stated C-arm geometry into the planner's view model", () => {
    const read = lumbarInputs(record(), volume(), frames());
    expect(read.center).toEqual([0, 0, 0]);
    expect(read.volume.shape).toEqual([4, 4, 6]);
    expect(read.frames.map((frame) => frame.view)).toEqual(
      [0, 90].map((primary_deg) => ({
        primary_deg,
        secondary_deg: 0.7,
        source_detector_mm: 1140,
        source_isocenter_mm: 745,
        detector_width_mm: LUMBAR.detector_mm,
        detector_height_mm: LUMBAR.detector_mm,
      })),
    );
    expect(read.frames[1].isocenter).toEqual([0, 0, 0]);
    expect(read.frames[0].width).toBe(16);
  });

  it("refuses a record it would have to guess at", () => {
    const other = record();
    other.set = "deepfluoro";
    expect(() => lumbarInputs(other, volume(), frames())).toThrow(
      "Not a lumbar record",
    );
    expect(() => lumbarInputs(record(), new Int16Array(5), frames())).toThrow(
      "Scan does not match its record",
    );
    expect(() => lumbarInputs(record(), volume(), frames().slice(1))).toThrow(
      "Frames do not match their record",
    );
    expect(() =>
      lumbarInputs(record(), volume(), [
        new Uint16Array(3),
        new Uint16Array(256),
      ]),
    ).toThrow("Frames do not match their record");
    const untagged = record();
    untagged.frames["000"].tags.DistanceSourceToPatient = "";
    expect(() => lumbarInputs(untagged, volume(), frames())).toThrow(
      "Frame states no geometry: 000",
    );
  });
});

describe("lumbarCases", () => {
  it("keeps the design and held-back cases apart", () => {
    const design = lumbarCases("design"),
      held = lumbarCases("held_back");
    expect(design).toHaveLength(49);
    expect(held).toHaveLength(100);
    expect(design[0]).toBe("case1");
    expect(held[0]).toBe("case50");
    expect(held.at(-1)).toBe("case149");
    expect(design.filter((name) => held.includes(name))).toEqual([]);
    expect(lumbarCases("3,11")).toEqual(["case3", "case11"]);
    // A named list is for design work: it cannot reach a held-back case.
    expect(() => lumbarCases("3,50")).toThrow("Not a design case: 50");
    expect(() => lumbarCases("")).toThrow("No cases named");
  });
});

describe("disturbed starts and distances", () => {
  const axes = [
    [-1, 0, 0],
    [0, 0, 1],
    [0, 1, 0],
  ];
  it("draws the same rigid starts from the same seed, inside the stated ranges", () => {
    const a = seeded(7),
      b = seeded(7);
    for (let i = 0; i < 20; i++) {
      const start = disturbedStart(a, axes, [3, -2, 5]);
      expect(start).toEqual(disturbedStart(b, axes, [3, -2, 5]));
      validateRigid(start);
      // The center moves by the shift alone: across within 15 mm each way,
      // along the beam (y here) within 30 mm.
      const moved = [0, 1, 2].map(
        (r) =>
          start[r][0] * 3 + start[r][1] * -2 + start[r][2] * 5 + start[r][3],
      );
      expect(Math.abs(moved[0] - 3)).toBeLessThanOrEqual(LUMBAR.across_mm);
      expect(Math.abs(moved[2] - 5)).toBeLessThanOrEqual(LUMBAR.across_mm);
      expect(Math.abs(moved[1] + 2)).toBeLessThanOrEqual(LUMBAR.depth_mm);
      const cosine = (start[0][0] + start[1][1] + start[2][2] - 1) / 2;
      expect((Math.acos(cosine) * 180) / Math.PI).toBeLessThanOrEqual(
        Math.sqrt(3) * LUMBAR.turn_deg,
      );
    }
    expect(disturbedStart(seeded(8), axes, [0, 0, 0])).not.toEqual(
      disturbedStart(seeded(7), axes, [0, 0, 0]),
    );
  });

  it("measures how far apart two poses put the anatomy", () => {
    const identity = [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
      shifted = identity.map((row, i) =>
        i === 1 ? [0, 1, 0, 4] : i === 0 ? [1, 0, 0, 3] : row,
      );
    expect(apartMm(identity, identity, [0, 0, 0])).toBe(0);
    expect(apartMm(identity, shifted, [9, 9, 9])).toBeCloseTo(5, 9);
    // Across a beam along y, only the 3 mm counts.
    expect(apartMm(identity, shifted, [0, 0, 0], [0, 1, 0])).toBeCloseTo(3, 9);
  });
});
