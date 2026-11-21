import { describe, expect, it } from "vitest";
import {
  gray,
  medial,
  pivot,
  SIDE,
  truth,
  VIEW,
} from "./__fixtures__/overlayCase";
import { bestStartSteps, meanEvidence } from "./bestStart";
import {
  proposeEvidenceRegistration,
  type EvidenceRegistrationInput,
} from "./evidenceRegistration";
import { centroid } from "./maskPoints";
import { startFromProposedView } from "./poseInitializer";
import { IDENTITY_MATRIX } from "./projectionOverlayJob";
import { projectRegistered } from "./projectionRegistration";
import { vesselEvidence } from "./vesselEvidence2d";

const size = { width: SIDE, height: SIDE },
  evidence = vesselEvidence(gray, SIDE, SIDE, "dark"),
  // The entered angles are 40 degrees off. The frame was taken at VIEW.
  entered = { ...VIEW, primary_deg: VIEW.primary_deg + 40 },
  seen = {
    primary_deg: VIEW.primary_deg,
    secondary_deg: VIEW.secondary_deg,
    turn_deg: 0,
  },
  input: EvidenceRegistrationInput = {
    points: medial.points,
    planes: [
      {
        view: entered,
        isocenter: pivot,
        frame: size,
        evidence,
        fit_detector_scale: false,
      },
    ],
    start: IDENTITY_MATRIX,
  },
  right = startFromProposedView(entered, seen, centroid(medial.points)),
  wrong = startFromProposedView(
    entered,
    { ...seen, primary_deg: seen.primary_deg - 60 },
    centroid(medial.points),
  );

function finish(others: number[][][], from = input) {
  const steps = bestStartSteps(from, others, { expired: () => false });
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}
/** Mean distance, in pixels, between where a pose puts the vessel points
 * and where the frame's true pose puts them. */
function pixelsOff(matrix: number[][]) {
  const got = projectRegistered(entered, pivot, matrix, medial.points, size),
    want = projectRegistered(VIEW, pivot, truth, medial.points, size);
  let sum = 0;
  for (let k = 0; k < got.length; k += 2)
    sum += Math.hypot(got[k] - want[k], got[k + 1] - want[k + 1]);
  return sum / (got.length / 2);
}

describe("search from the best of several starts", () => {
  const alone = proposeEvidenceRegistration(input);

  it("with no other start gives the single search's numbers under its own name", () => {
    const found = finish([]);
    expect(found.searched).toBe(1);
    expect(found.kept).toBe(0);
    expect(found.proposal).toEqual({
      ...alone,
      method: "vessel_evidence_best_start_v1",
    });
  }, 60000);

  it("keeps the start that finds the frame, wherever it is in the list", () => {
    expect(pixelsOff(alone.matrix)).toBeGreaterThan(3);
    for (const others of [
      [right, wrong],
      [wrong, right],
    ]) {
      const found = finish(others);
      expect(found.searched).toBe(3);
      expect(found.kept).toBe(others.indexOf(right) + 1);
      expect(pixelsOff(found.proposal.matrix)).toBeLessThan(1.5);
      expect(meanEvidence(found.proposal)).toBeGreaterThan(meanEvidence(alone));
      // Described against the volume's own position: its scores are the
      // start scores, and the turn from it is the 40 degrees found.
      expect(found.proposal.planes[0].start_score).toEqual(
        alone.planes[0].start_score,
      );
      expect(found.proposal.rotation_deg).toBeGreaterThan(30);
      expect(found.proposal.rotation_deg).toBeLessThan(50);
      // The distance moved is that of the centre of the vessel points.
      const m = found.proposal.matrix,
        c = centroid(medial.points),
        moved = [0, 1, 2].map(
          (i) => m[i][0] * c[0] + m[i][1] * c[1] + m[i][2] * c[2] + m[i][3],
        );
      expect(found.proposal.translation_mm).toBeGreaterThan(1);
      expect(found.proposal.translation_mm).toBeCloseTo(
        Math.hypot(moved[0] - c[0], moved[1] - c[1], moved[2] - c[2]),
        9,
      );
      expect(found.proposal.planes[0].view).toEqual(entered);
    }
  }, 120000);

  it("keeps the own position when no other start is better", () => {
    const found = finish([wrong, IDENTITY_MATRIX], {
      ...input,
      planes: [{ ...input.planes[0], view: VIEW }],
    });
    expect(found.searched).toBe(3);
    expect(found.kept).toBe(0);
  }, 120000);

  it("passes over a start that fails and reports the first failure when all do", () => {
    const off = IDENTITY_MATRIX.map((row, i) =>
      i === 0 ? [1, 0, 0, 5000] : row,
    );
    const found = finish([off, right]);
    expect(found.kept).toBe(2);
    const skewed = IDENTITY_MATRIX.map((row, i) =>
      i === 0 ? [2, 0, 0, 0] : row,
    );
    expect(() => finish([skewed], { ...input, start: off })).toThrow(
      "No pose in the search range keeps the vessel points inside every frame",
    );
  }, 120000);
});
