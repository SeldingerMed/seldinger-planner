import { describe, expect, it, vi } from "vitest";
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
import { sizeSearchSteps } from "./sizeSearch";
import { vesselEvidence } from "./vesselEvidence2d";

// The search of the size is the real one, with its calls kept.
vi.mock("./sizeSearch", async (original) => {
  const real = await original<typeof import("./sizeSearch")>();
  return { ...real, sizeSearchSteps: vi.fn(real.sizeSearchSteps) };
});

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

  it("reports the kept start's scores when the points fall outside the frame at the first start", () => {
    // 80 mm aside, a fifth of the points are in the frame: too few to
    // score, though the search still finds a pose from there.
    const aside = IDENTITY_MATRIX.map((row, i) =>
        i === 0 ? [1, 0, 0, 80] : row,
      ),
      from = { ...input, start: aside },
      own = proposeEvidenceRegistration(from).planes[0].start_score;
    expect(own.in_field_fraction).toBeLessThan(0.5);
    expect(own.in_field_fraction).toBeGreaterThan(0);
    const found = finish([right], from);
    expect(found.kept).toBe(1);
    expect(found.proposal.planes[0].start_score).toEqual(
      proposeEvidenceRegistration({ ...input, start: right }).planes[0]
        .start_score,
    );
    expect(
      found.proposal.planes[0].start_score.in_field_fraction,
    ).toBeGreaterThanOrEqual(0.5);
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
    const far = IDENTITY_MATRIX.map((row, i) =>
      i === 2 ? [0, 0, 1, 5000] : row,
    );
    expect(() => finish([far], { ...input, start: off })).toThrow(
      "No pose in the search range keeps the vessel points inside every frame",
    );
  }, 120000);

  it("stops on a start that is not a rigid pose, wherever it is in the list", () => {
    const skewed = IDENTITY_MATRIX.map((row, i) =>
      i === 0 ? [2, 0, 0, 0] : row,
    );
    // Passed over, it would be the reference the result is described from.
    expect(() => finish([right], { ...input, start: skewed })).toThrow(
      "Rotation must be orthonormal",
    );
    expect(() => finish([right, skewed])).toThrow(
      "Rotation must be orthonormal",
    );
  }, 120000);
});

describe("best start with a requested fit of the field size", () => {
  // The entered width is a fifth too small, so the real one is 1.25 times it.
  const small = (view: typeof VIEW) => ({
      ...view,
      detector_width_mm: view.detector_width_mm * 0.8,
      detector_height_mm: view.detector_height_mm * 0.8,
    }),
    fitted = (view: typeof VIEW): EvidenceRegistrationInput => ({
      ...input,
      planes: [{ ...input.planes[0], view, fit_detector_scale: true }],
    }),
    sized = (from: EvidenceRegistrationInput) => {
      const steps = sizeSearchSteps(from, { expired: () => false });
      for (;;) {
        const next = steps.next();
        if (next.done) return next.value;
      }
    };

  it("with no other start gives the size search's result from the own position", () => {
    const from = fitted(small(VIEW)),
      found = finish([], from);
    expect(found.searched).toBe(1);
    expect(found.kept).toBe(0);
    expect(found.proposal).toEqual(sized(from));
    expect(found.proposal.method).toBe("vessel_evidence_size_search_v1");
    expect(found.proposal.detector_fit).toBe("kept");
    expect(found.proposal.planes[0].detector_scale).toBeGreaterThan(1.2);
    expect(found.proposal.planes[0].detector_scale).toBeLessThan(1.3);
  }, 120000);

  it("searches the size from the kept start and describes the result from the own position", () => {
    const from = fitted(small(entered)),
      found = finish([wrong, right], from),
      asked = vi.mocked(sizeSearchSteps).mock.lastCall!,
      own = proposeEvidenceRegistration(from),
      there = sized({ ...from, start: right });
    expect(found.searched).toBe(3);
    expect(found.kept).toBe(2);
    // The size is searched from the kept start, and that start's result is
    // handed over and not searched for again.
    expect(asked[0]).toEqual({ ...from, start: right });
    expect(asked[2]!.entered).toEqual(
      proposeEvidenceRegistration({ ...from, start: right }),
    );
    expect(found.proposal.method).toBe("vessel_evidence_size_search_v1");
    expect(found.proposal.matrix).toEqual(there.matrix);
    expect(found.proposal.planes[0].detector_scale).toBe(
      there.planes[0].detector_scale,
    );
    expect(found.proposal.planes[0].detector_scale).toBeGreaterThan(1.2);
    expect(found.proposal.planes[0].detector_scale).toBeLessThan(1.3);
    expect(found.proposal.planes[0].start_score).toEqual(
      own.planes[0].start_score,
    );
    expect(found.proposal.rotation_deg).toBeGreaterThan(30);
    expect(found.proposal.rotation_deg).toBeLessThan(50);
  }, 120000);

  it("searches the size from the own position when no start finds a pose", () => {
    const off = IDENTITY_MATRIX.map((row, i) =>
        i === 0 ? [1, 0, 0, 5000] : row,
      ),
      far = IDENTITY_MATRIX.map((row, i) => (i === 2 ? [0, 0, 1, 5000] : row)),
      from = { ...fitted(small(VIEW)), start: off },
      made = {
        ...proposeEvidenceRegistration(fitted(VIEW)),
        method: "vessel_evidence_size_search_v1" as const,
      };
    vi.mocked(sizeSearchSteps).mockImplementationOnce(function* () {
      return made;
    });
    const found = finish([far], from),
      asked = vi.mocked(sizeSearchSteps).mock.lastCall!;
    // No start gave a result to hand over; the sizes are tried from the
    // own position.
    expect(asked[0]).toEqual(from);
    expect(asked[2]).toEqual({ entered: null });
    expect(found).toEqual({ proposal: made, searched: 2, kept: 0 });
    // When no size finds a pose either, that is the failure.
    expect(() => finish([far], from)).toThrow(
      "No pose in the search range keeps the vessel points inside every frame",
    );
    // With no fit requested the size is not searched.
    const calls = vi.mocked(sizeSearchSteps).mock.calls.length;
    expect(() => finish([far], { ...input, start: off })).toThrow(
      "No pose in the search range keeps the vessel points inside every frame",
    );
    expect(vi.mocked(sizeSearchSteps).mock.calls.length).toBe(calls);
  }, 120000);

  it("with no fit requested keeps the best-start name and numbers", () => {
    const found = finish([right]);
    expect(found.proposal.method).toBe("vessel_evidence_best_start_v1");
    expect(found.proposal.detector_fit).toBe("not_requested");
  }, 120000);
});
