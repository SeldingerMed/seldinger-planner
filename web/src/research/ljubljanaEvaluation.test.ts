// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Vec3 } from "../obliqueSlice";
import { writeSubject } from "./__fixtures__/preparedPhantom";
import { ARMS, evaluatePrepared } from "./ljubljanaEvaluation";

describe("Ljubljana evaluation on a phantom stored the same way", () => {
  const root = mkdtempSync(join(tmpdir(), "ljubljana-phantom-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("finds the reference pose from the files and scores every arm against it", () => {
    mkdirSync(join(root, "subject01"));
    writeSubject(join(root, "subject01"));
    const starts = [
      [
        { degrees: [4, -5, 7] as Vec3, shift_mm: [6, -7, 4] as Vec3 },
        { degrees: [-6, 5, 6] as Vec3, shift_mm: [5, 5, -7] as Vec3 },
      ],
    ];
    const seen: string[] = [];
    const { arms, summary } = evaluatePrepared(root, starts, (m) =>
      seen.push(m),
    );
    expect(seen).toEqual(["subject 1 of 1 done"]);
    expect(Object.keys(arms)).toEqual([...ARMS]);
    expect(summary.subjects).toBe(1);
    expect(summary.frame_sizes).toEqual(["252x280", "300x268"]);
    expect(summary.largest_window_residual_px).toBe(0);
    for (const arm of ARMS) {
      const a = summary.arms[arm];
      expect(a.failures).toEqual([]);
      expect(a.target_error_mm.no_proposal).toBe(0);
      expect(a.target_error_mm.runs).toBe(
        arm.endsWith("from_reference") ? 1 : 2,
      );
      expect(a.in_plane_error_mm.runs).toBe(
        a.target_error_mm.runs * (arm.startsWith("biplane") ? 2 : 1),
      );
    }
    // A wrong reading of the stored cameras would put the reference pose
    // off the frames, and none of these could hold.
    const from = summary.arms.biplane_from_reference;
    expect(from.start_error_mm.max).toBe(0);
    expect(from.median_mean_distance_mm.at_start).toBeLessThan(0.6);
    expect(from.target_error_mm.max).toBeLessThan(0.5);
    const biplane = summary.arms.biplane;
    expect(biplane.start_error_mm.median).toBeGreaterThan(5);
    expect(biplane.target_error_mm.max).toBeLessThan(1);
    expect(biplane.in_plane_error_mm.max).toBeLessThan(1);
    expect(biplane.target_error_mm.success).toEqual([1, 1, 1]);
    expect(biplane.subjects_with_every_run_under).toEqual([1, 1, 1]);
    expect(summary.arms.frontal.subjects_with_every_run_under[0]).toBe(0);
    expect(summary.methods).toEqual([
      "centerline_distance_compass_v1",
      "centerline_distance_compass_biplane_v1",
    ]);
    expect(biplane.detector_scale_abs_error).toBeUndefined();
    // One plane fixes the picture and leaves depth open.
    for (const arm of ["frontal", "lateral"] as const) {
      expect(summary.arms[arm].in_plane_error_mm.max).toBeLessThan(1);
      expect(summary.arms[arm].target_error_mm.max).toBeGreaterThan(
        biplane.target_error_mm.max!,
      );
    }
    // Entered 0.85 and 1.2 times too large, the detector sizes are fitted back.
    const loose = summary.arms.biplane_uncalibrated;
    expect(loose.detector_scale_abs_error!.runs).toBe(4);
    expect(loose.detector_scale_abs_error!.max).toBeLessThan(0.07);
    expect(loose.target_error_mm.max).toBeLessThan(2);
  });

  it("refuses a directory with no prepared subject", () => {
    expect(() => evaluatePrepared(join(root, "missing"), [[]])).toThrow();
  });
});
