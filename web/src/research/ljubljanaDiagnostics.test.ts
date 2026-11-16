// @vitest-environment node
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { distanceToSeeds } from "../distanceTransform";
import type { VesselTarget } from "../vesselness2d";
import {
  DIAGNOSTICS_PROTOCOL,
  backward,
  darkestShift,
  diagnosticDirectory,
  forward,
  framePixels,
  levels,
  overlay,
  percentiles,
  png,
  stretched,
} from "./ljubljanaDiagnostics";

/** A 20 by 20 working grid, two frame pixels per working pixel, with one
 * vertical centerline at working column 10. */
function lineTarget(): VesselTarget {
  const width = 20,
    height = 20,
    seeds = new Uint8Array(width * height),
    centerline: number[] = [];
  for (let y = 0; y < height; y++) {
    seeds[y * width + 10] = 1;
    centerline.push(y * width + 10);
  }
  return {
    width,
    height,
    scale: 2,
    distance: distanceToSeeds(seeds, width, height, 96),
    centerline: Int32Array.from(centerline),
  };
}
/** Frame pixel at the middle of a working pixel. */
const middle = (w: number) => 2 * w + 0.5;

describe("diagnostic subjects", () => {
  it("opens subjects 01 to 05 and refuses the rest", () => {
    expect(DIAGNOSTICS_PROTOCOL.subjects).toEqual([1, 2, 3, 4, 5]);
    expect(diagnosticDirectory("/p", 5)).toBe("/p/subject05");
    for (const held of [0, 6, 10, 1.5])
      expect(() => diagnosticDirectory("/p", held)).toThrow(
        "held back from diagnostics",
      );
  });
});

describe("frame conversion", () => {
  it("takes block means of the window", () => {
    const pixels = Uint16Array.from([
      // 4 columns by 2 rows; the window is the right 2 by 2 block.
      9, 9, 100, 200, 9, 9, 300, 400,
    ]);
    const view = {
      pose: [],
      intrinsics: { sdd: 1, delx: 1, dely: 1, x0: 0, y0: 0 },
      width: 4,
      height: 2,
    };
    const window = {
      left: 2,
      top: 0,
      width: 2,
      height: 2,
      factor: 2,
      residual_px: [0, 0] as [number, number],
    };
    expect(Array.from(framePixels(pixels, view, window))).toEqual([250]);
    expect(() => framePixels(pixels.subarray(1), view, window)).toThrow(
      "does not match its stored size",
    );
  });

  it("stretches the middle 99% of the range onto 0 to 255", () => {
    const raw = new Float32Array(1000);
    for (let k = 0; k < 1000; k++) raw[k] = 1000 + k;
    expect(percentiles(raw, [0.005, 0.5, 0.995])).toEqual([1005, 1500, 1995]);
    const gray = stretched(raw);
    expect(gray[0]).toBe(0);
    expect(gray[5]).toBe(0);
    expect(gray[500]).toBe(128);
    expect(gray[995]).toBe(255);
    expect(gray[999]).toBe(255);
    expect(Array.from(stretched(new Float32Array(4).fill(7)))).toEqual([
      0, 0, 0, 0,
    ]);
  });

  it("counts distinct gray levels", () => {
    expect(levels(Uint8Array.from([3, 3, 4, 250, 4]))).toBe(3);
    // A level used more often than a byte can count is still one level.
    const many = new Uint8Array(600).fill(9);
    many[0] = 1;
    expect(levels(many)).toBe(2);
  });
});

describe("line agreement", () => {
  const target = lineTarget(),
    side = 40,
    mm = 0.5;

  it("measures 3D to 2D distance in millimeters at the isocenter", () => {
    // On the line, 1 working pixel off (1 mm), 3 off (3 mm), 9 off (9 mm,
    // capped at 8), outside the frame (8) and unprojected (8).
    const pixels = Float32Array.from([
      middle(10),
      middle(4),
      middle(11),
      middle(4),
      middle(13),
      middle(4),
      middle(19),
      middle(4),
      -5,
      middle(4),
      NaN,
      NaN,
    ]);
    const result = forward(target, pixels, side, side, mm);
    expect(result.forward_mm).toBeCloseTo((0 + 1 + 3 + 8 + 8 + 8) / 6, 6);
    expect(result.forward_matched).toBeCloseTo(2 / 6, 6);
    // Two frame pixels to the right is one working pixel: 1, 2 and 4 mm,
    // and the fourth point leaves the frame.
    const shifted = forward(target, pixels, side, side, mm, 2, 0);
    expect(shifted.forward_mm).toBeCloseTo((1 + 2 + 4 + 8 + 8 + 8) / 6, 6);
  });

  it("measures 2D to 3D distance in millimeters at the isocenter", () => {
    // One projected point on the line at working row 0. A centerline pixel
    // at row r is r working pixels, r millimeters, from it.
    const pixels = Float32Array.from([middle(10), middle(0)]);
    const result = backward(target, pixels, side, side, mm);
    let sum = 0;
    for (let r = 0; r < 20; r++) sum += Math.min(r, 8);
    expect(result.backward_mm).toBeCloseTo(sum / 20, 6);
    expect(result.backward_matched).toBeCloseTo(3 / 20, 6);
    // With no point in the frame every centerline pixel is at the cap.
    const none = backward(
      target,
      Float32Array.from([NaN, NaN]),
      side,
      side,
      mm,
    );
    expect(none.backward_mm).toBeCloseTo(8, 6);
    expect(none.backward_matched).toBe(0);
  });
});

describe("darkness slide", () => {
  it("finds how far the points are from the dark line", () => {
    const width = 80,
      height = 80,
      raw = new Float32Array(width * height).fill(1000);
    for (let y = 0; y < height; y++) raw[y * width + 46] = 100;
    // Points on column 40 at 2 px per mm: the line is 3 mm to the right.
    const pixels: number[] = [];
    for (let y = 30; y < 50; y++) pixels.push(40, y);
    expect(
      darkestShift(raw, width, height, Float32Array.from(pixels), 0.5),
    ).toBe(3);
    // Points already on the line need no shift.
    const on: number[] = [];
    for (let y = 30; y < 50; y++) on.push(46, y);
    expect(darkestShift(raw, width, height, Float32Array.from(on), 0.5)).toBe(
      0,
    );
  });
});

describe("pictures", () => {
  it("draws three panels and writes a PNG that decodes to them", () => {
    const target = lineTarget(),
      side = 40,
      gray = new Uint8Array(side * side).fill(50),
      picture = overlay(gray, side, side, target, Float32Array.from([3, 5]));
    expect([picture.width, picture.height]).toEqual([120, 40]);
    const pixel = (x: number, y: number) =>
      Array.from(
        picture.rgb.subarray(3 * (y * 120 + x), 3 * (y * 120 + x) + 3),
      );
    expect(pixel(20, 7)).toEqual([50, 50, 50]);
    expect(pixel(40 + 20, 7)).toEqual([0, 255, 0]);
    expect(pixel(40 + 3, 5)).toEqual([50, 50, 50]);
    expect(pixel(80 + 3, 5)).toEqual([255, 0, 0]);
    expect(pixel(80 + 20, 7)).toEqual([50, 50, 50]);

    const file = png(picture);
    expect(Array.from(file.subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(file.readUInt32BE(16)).toBe(120);
    expect(file.readUInt32BE(20)).toBe(40);
    // IHDR is 25 bytes after the signature; IDAT follows.
    const length = file.readUInt32BE(33);
    expect(file.subarray(37, 41).toString("latin1")).toBe("IDAT");
    const rows = inflateSync(file.subarray(41, 41 + length));
    expect(rows.length).toBe((3 * 120 + 1) * 40);
    expect(rows[0]).toBe(0);
    expect(Array.from(rows.subarray(1, 361))).toEqual(
      Array.from(picture.rgb.subarray(0, 360)),
    );
    expect(() => png({ width: 2, height: 2, rgb: new Uint8Array(3) })).toThrow(
      "Invalid picture",
    );
  });
});
