// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Vec3 } from "../obliqueSlice";
import { writeSubject } from "./__fixtures__/preparedPhantom";
import { DIAGNOSTICS_PROTOCOL } from "./ljubljanaDiagnostics";
import { LJUBLJANA_PROTOCOL } from "./ljubljanaProtocol";
import {
  ARMS,
  EVIDENCE_PROTOCOL,
  evaluateEvidence,
  summarizeEvidence,
} from "./ljubljanaEvidenceEvaluation";

describe("vessel evidence evaluation on a phantom stored the same way", () => {
  const root = mkdtempSync(join(tmpdir(), "ljubljana-evidence-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("scores every arm against the reference pose read from the files", () => {
    for (const name of ["subject01", "subject02"]) {
      mkdirSync(join(root, name));
      writeSubject(join(root, name));
    }
    const pair = [
      { degrees: [4, -5, 7] as Vec3, shift_mm: [6, -7, 4] as Vec3 },
      { degrees: [-6, 5, 6] as Vec3, shift_mm: [5, 5, -7] as Vec3 },
    ];
    const seen: string[] = [];
    const { arms, summary } = evaluateEvidence(
      root,
      [1, 2],
      [pair, pair],
      (m) => seen.push(m),
    );
    expect(seen).toEqual(["subject 1 done", "subject 2 done"]);
    expect(Object.keys(arms)).toEqual([...ARMS]);
    expect(summary.subjects).toEqual([1, 2]);
    expect(summary.methods).toEqual([
      "vessel_evidence_compass_v1",
      "vessel_evidence_compass_biplane_v1",
    ]);
    for (const arm of ARMS) {
      const a = summary.arms[arm];
      expect(a.failures).toEqual([]);
      expect(a.runs).toBe(arm.endsWith("from_reference") ? 2 : 4);
      expect(a.target_error_mm.no_proposal).toBe(0);
      expect(a.in_plane_error_mm.runs).toBe(
        a.runs * (arm.startsWith("biplane") ? 2 : 1),
      );
    }
    const from = summary.arms.biplane_from_reference;
    expect(from.start_error_mm.max).toBe(0);
    expect(from.target_error_mm.max).toBeLessThan(0.5);
    expect(from.starts_scored_below_reference).toBeUndefined();
    const biplane = summary.arms.biplane;
    expect(biplane.start_error_mm.median).toBeGreaterThan(5);
    expect(biplane.target_error_mm.max).toBeLessThan(1);
    expect(biplane.runs_under).toEqual([4, 4, 4]);
    expect(biplane.subjects_with_every_run_under).toEqual([2, 2, 2]);
    // The score puts the reference pose above every perturbed start.
    expect(biplane.starts_scored_below_reference).toBe(4);
    expect(biplane.median_mean_evidence.at_result).toBeGreaterThan(
      biplane.median_mean_evidence.at_start! + 0.2,
    );
    expect(biplane.fits_kept).toBeUndefined();
    expect(biplane.detector_scale_abs_error).toBeUndefined();
    // One plane fixes the picture and leaves depth open.
    for (const arm of ["frontal", "lateral"] as const) {
      expect(summary.arms[arm].in_plane_error_mm.max).toBeLessThan(1);
      expect(summary.arms[arm].starts_scored_below_reference).toBe(4);
    }
    // Entered 0.85 and 1.2 times too large: the fit is kept and lands close.
    const loose = summary.arms.biplane_uncalibrated;
    expect(loose.fits_kept).toBe(4);
    expect(loose.detector_scale_abs_error!.max).toBeLessThan(0.05);
    expect(loose.target_error_mm.max).toBeLessThan(2);
    // Entered right: the fit is dropped and the result is the unfitted one.
    const right = summary.arms.biplane_fit_right_size;
    expect(right.fits_kept).toBe(0);
    expect(right.detector_scale_abs_error!.max).toBe(0);
    expect(right.target_error_mm).toEqual(biplane.target_error_mm);

    // A summary over one group counts only that group's runs.
    const one = summarizeEvidence(arms, [2]);
    expect(one.subjects).toEqual([2]);
    expect(one.arms.biplane.runs).toBe(2);
    expect(one.arms.biplane.subjects_with_every_run_under).toEqual([1, 1, 1]);
  });

  it("keeps the development subjects those of the diagnostics", () => {
    expect(EVIDENCE_PROTOCOL.development).toEqual(
      DIAGNOSTICS_PROTOCOL.subjects,
    );
    expect(
      [...EVIDENCE_PROTOCOL.development, ...EVIDENCE_PROTOCOL.held_back].sort(
        (a, b) => a - b,
      ),
    ).toEqual(
      Array.from({ length: LJUBLJANA_PROTOCOL.subjects }, (_, k) => k + 1),
    );
  });

  it("refuses a subject that was not prepared", () => {
    expect(() => evaluateEvidence(root, [9])).toThrow();
  });
});
