import { describe, expect, it } from "vitest";
import {
  gray,
  medial,
  pivot,
  SIDE,
  truth,
  VIEW,
} from "./__fixtures__/overlayCase";
import type { ViewNumbers } from "./carmGeometry";
import {
  EVIDENCE_NO_POSE,
  proposeEvidenceRegistration,
  type EvidenceRegistrationInput,
  type EvidenceRegistrationJob,
  type EvidenceRegistrationProposal,
} from "./evidenceRegistration";
import { IDENTITY_MATRIX } from "./projectionOverlayJob";
import { projectRegistered } from "./projectionRegistration";
import { evidenceCost, sizeSearchSteps } from "./sizeSearch";
import { vesselEvidence } from "./vesselEvidence2d";

const size = { width: SIDE, height: SIDE },
  evidence = vesselEvidence(gray, SIDE, SIDE, "dark"),
  sized = (view: ViewNumbers, factor: number) => ({
    ...view,
    detector_width_mm: view.detector_width_mm * factor,
    detector_height_mm: view.detector_height_mm * factor,
  }),
  plane = (width: number, fit: boolean) => ({
    view: sized(VIEW, width / VIEW.detector_width_mm),
    isocenter: pivot,
    frame: size,
    evidence,
    fit_detector_scale: fit,
  }),
  one = (width: number): EvidenceRegistrationInput => ({
    points: medial.points,
    planes: [plane(width, true)],
    start: IDENTITY_MATRIX,
  }),
  pair = (a: number, b: number, fit = [true, true]) => ({
    points: medial.points,
    planes: [plane(a, fit[0]), plane(b, fit[1])],
    start: IDENTITY_MATRIX,
  });

type Search = (
  input: EvidenceRegistrationInput,
) => EvidenceRegistrationProposal;
function finish(
  input: EvidenceRegistrationInput,
  search?: Search,
  entered?: EvidenceRegistrationProposal | null,
) {
  const steps = sizeSearchSteps(
    input,
    { expired: () => false },
    {
      entered,
      job: search
        ? (asked): EvidenceRegistrationJob => ({
            advance: () => true,
            result: () => search(asked),
          })
        : undefined,
    },
  );
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

/** A stand-in for the search. Each plane's frame was taken with a detector
 * `truth[k]` mm wide. A search with the size held ends at a cost that grows
 * with the distance of the entered size from it; a search with the size
 * free reaches it only from within `reach` (in log size), and otherwise
 * stays where it was entered. */
function standIn(
  real: number[],
  reach = 0.12,
  log: string[] = [],
  slope = 1,
): Search {
  return (input) => {
    const planes = input.planes.map((entry, k) => {
      const width = entry.view.detector_width_mm,
        away = Math.abs(
          Math.log(width / real[input.planes.length === 1 ? 0 : k]),
        ),
        scale =
          entry.fit_detector_scale && away <= reach
            ? real[input.planes.length === 1 ? 0 : k] / width
            : 1,
        left = Math.abs(
          Math.log((width * scale) / real[input.planes.length === 1 ? 0 : k]),
        ),
        score = {
          mean_evidence: 0.6 - Math.min(0.5, slope * left),
          in_field_fraction: 1,
          uncovered_fraction: 0.1,
        };
      return {
        view: sized(entry.view, scale),
        detector_scale: scale,
        score,
        start_score: {
          mean_evidence: 0.01 * Math.round(width),
          in_field_fraction: 1,
          uncovered_fraction: 1,
        },
      };
    });
    log.push(
      input.planes
        .map(
          (entry) =>
            `${entry.view.detector_width_mm.toFixed(0)}${entry.fit_detector_scale ? "f" : ""}`,
        )
        .join(" "),
    );
    const fitted = input.planes.some((entry) => entry.fit_detector_scale),
      moved = planes.some((entry) => entry.detector_scale !== 1),
      held =
        input.planes.reduce(
          (sum, entry, k) =>
            sum +
            Math.min(
              0.5,
              slope *
                Math.abs(
                  Math.log(
                    entry.view.detector_width_mm /
                      real[input.planes.length === 1 ? 0 : k],
                  ),
                ),
            ),
          0,
        ) / planes.length,
      now =
        planes.reduce(
          (sum, entry) => sum + 0.6 - entry.score.mean_evidence,
          0,
        ) / planes.length;
    return {
      method:
        planes.length === 2
          ? "vessel_evidence_compass_biplane_v1"
          : "vessel_evidence_compass_v1",
      matrix: IDENTITY_MATRIX,
      planes,
      plane_angle_deg: planes.length === 2 ? 90 : null,
      detector_fit: !fitted ? "not_requested" : moved ? "kept" : "dropped",
      fit_gain: fitted ? held - now : null,
      translation_mm: 0,
      rotation_deg: 0,
      point_count: 100,
      evaluations: 1,
    } as EvidenceRegistrationProposal;
  };
}

describe("search of the field size from several entered sizes", () => {
  it("refuses an input with no size to fit", () => {
    expect(() => finish({ ...one(180), planes: [plane(180, false)] })).toThrow(
      "No field size is to be fitted",
    );
  });

  it("keeps the fitted search's result when the entered size is within its reach, under its own name", () => {
    const search = standIn([200]),
      found = finish(one(190), search),
      plain = search(one(190));
    expect(found).toEqual({
      ...plain,
      method: "vessel_evidence_size_search_v1",
      evaluations: found.evaluations,
    });
    expect(found.planes[0].detector_scale).toBeCloseTo(200 / 190, 12);
  });

  it("finds a size the fit cannot reach from the entered one, and describes it against the entered size", () => {
    const search = standIn([200]),
      plain = search(one(150)),
      found = finish(one(150), search);
    // The fit alone stays at the entered size.
    expect(plain.detector_fit).toBe("dropped");
    expect(found.method).toBe("vessel_evidence_size_search_v1");
    expect(found.detector_fit).toBe("kept");
    expect(found.planes[0].detector_scale).toBeCloseTo(200 / 150, 12);
    expect(found.planes[0].view.detector_width_mm).toBeCloseTo(200, 9);
    // The start scores are those at the entered size, not at a rung.
    expect(found.planes[0].start_score).toEqual(plain.planes[0].start_score);
    // Gain: cost at the entered size with no size free, less the cost kept.
    expect(found.fit_gain).toBeCloseTo(
      evidenceCost(plain) - evidenceCost(found),
      12,
    );
    expect(found.fit_gain).toBeCloseTo(Math.log(200 / 150), 12);
  });

  it("runs each fitted plane alone along the ladder, then the fit from its two best sizes", () => {
    const log: string[] = [];
    finish(pair(150, 240), standIn([200, 200], 0.12, log));
    const rung = (width: number) =>
      [-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3].map((step) =>
        (width * Math.exp(step)).toFixed(0),
      );
    expect(log).toEqual([
      "150f 240f",
      ...rung(150),
      ...rung(240),
      // 150 e^0.3 = 202 and e^0.2 = 183; 240 e^-0.2 = 196 and e^-0.1 = 217.
      "202f 196f",
      "202f 217f",
      "183f 196f",
      "183f 217f",
    ]);
  });

  it("does not run the fit from the entered sizes a second time when they are among the best", () => {
    const log: string[] = [];
    finish(one(200), standIn([200], 0.12, log));
    // The entered size and the rung below it are the two best.
    expect(log.filter((line) => line.endsWith("f"))).toEqual(["200f", "181f"]);
  });

  it("measures the margin from the cost at the entered sizes when the fit from them was kept", () => {
    // The fit from the entered size moved partway and gained 0.05. Its
    // result costs 0.01 more than the best from another size.
    const search = standIn([200]),
      plain = search(one(150)),
      partway = {
        ...plain,
        detector_fit: "kept" as const,
        fit_gain: 0.05,
        planes: [
          {
            ...plain.planes[0],
            detector_scale: 1.05,
            score: { ...plain.planes[0].score, mean_evidence: 0.59 },
          },
        ],
      },
      found = finish(one(150), search, partway);
    expect(found.planes[0].detector_scale).toBeCloseTo(200 / 150, 12);
    expect(found.fit_gain).toBeCloseTo(0.06, 12);
  });

  it("fits each plane to its own size when the two are entered wrong in opposite senses", () => {
    const found = finish(pair(150, 266), standIn([200, 200]));
    expect(found.method).toBe("vessel_evidence_size_search_biplane_v1");
    expect(found.planes[0].detector_scale).toBeCloseTo(200 / 150, 12);
    expect(found.planes[1].detector_scale).toBeCloseTo(200 / 266, 12);
  });

  it("keeps a plane whose searches alone find no pose at its entered size, and still searches the other's", () => {
    const log: string[] = [],
      search = standIn([200, 300], 0.12, log),
      found = finish(pair(150, 300), (input) => {
        // The second plane alone finds no pose at any size.
        if (
          input.planes.length === 1 &&
          input.planes[0].view.detector_width_mm > 210
        )
          throw new Error(EVIDENCE_NO_POSE);
        return search(input);
      });
    expect(log.filter((line) => line.includes(" "))).toEqual([
      "150f 300f",
      "202f 300f",
      "183f 300f",
    ]);
    expect(found.planes[0].detector_scale).toBeCloseTo(200 / 150, 12);
    expect(found.planes[1].detector_scale).toBe(1);
    expect(found.detector_fit).toBe("kept");
  });

  it("leaves a plane with no fit requested at its entered size and off the ladder", () => {
    const log: string[] = [],
      found = finish(
        pair(150, 200, [true, false]),
        standIn([200, 200], 0.12, log),
      );
    expect(found.planes[1].detector_scale).toBe(1);
    expect(found.planes[0].detector_scale).toBeCloseTo(200 / 150, 12);
    expect(log.filter((line) => line.includes(" "))).toEqual([
      "150f 200",
      "202f 200",
      "183f 200",
    ]);
  });

  it("does not run the search of the input again when its result is handed in", () => {
    const log: string[] = [],
      search = standIn([200], 0.12, log),
      handed = { ...search(one(150)), evaluations: 40 };
    log.length = 0;
    const found = finish(one(150), search, handed);
    expect(log).not.toContain("150f");
    expect(found.planes[0].detector_scale).toBeCloseTo(200 / 150, 12);
    // Seven rungs and one fitted search from the best rung other than the
    // entered size, one evaluation each, on top of those handed in.
    expect(found.evaluations).toBe(40 + log.length);
  });

  it("keeps another size only when it lowers the cost by the fit's own margin", () => {
    // The fit reaches the real size from the rung above the entered size
    // and not from the entered size. The cost rises by 0.15 for each unit
    // of log size, so a size 0.105 off costs 0.016 and one 0.14 off 0.021.
    const entered = 200,
      at = (away: number) =>
        finish(
          one(entered),
          standIn([entered * Math.exp(away)], 0.05, [], 0.15),
        );
    expect(at(0.105).detector_fit).toBe("dropped");
    expect(at(0.105).planes[0].detector_scale).toBe(1);
    expect(at(0.14).detector_fit).toBe("kept");
    expect(at(0.14).planes[0].detector_scale).toBeCloseTo(Math.exp(0.14), 12);
  });

  it("passes over a size the view model or the record does not accept", () => {
    const log: string[] = [];
    finish(one(560), standIn([400], 0.12, log));
    // 560 e^0.1 = 619 is past the 600 mm the view model accepts.
    expect(log.some((line) => Number.parseFloat(line) > 600)).toBe(false);
    // The real size is 1.6 times the entered one. From the top rung the
    // fit reaches it, past the 1.45 a record accepts, so that result is
    // passed over and the next rung's, which the fit leaves in place, kept.
    const past = finish(one(125), standIn([200], 0.25));
    expect(past.detector_fit).toBe("kept");
    expect(past.planes[0].detector_scale).toBeCloseTo(Math.exp(0.2), 12);
    // The same below: the real size is 0.625 times the entered one, under
    // the 0.7 a record accepts.
    const under = finish(one(320), standIn([200], 0.25));
    expect(under.detector_fit).toBe("kept");
    expect(under.planes[0].detector_scale).toBeCloseTo(Math.exp(-0.2), 12);
  });

  it("passes over a search that finds no pose, and stops on any other error", () => {
    const search = standIn([200]),
      failing =
        (message: string, when: (line: string) => boolean): Search =>
        (input) => {
          const width = input.planes[0].view.detector_width_mm.toFixed(0);
          if (when(width)) throw new Error(message);
          return search(input);
        };
    // No pose at the entered size, fitted or held: the ladder still finds one.
    const found = finish(
      one(150),
      failing(EVIDENCE_NO_POSE, (width) => width === "150"),
    );
    expect(found.planes[0].detector_scale).toBeCloseTo(200 / 150, 12);
    expect(found.fit_gain).toBeNull();
    expect(() =>
      finish(
        one(150),
        failing(EVIDENCE_NO_POSE, () => true),
      ),
    ).toThrow(EVIDENCE_NO_POSE);
    expect(() =>
      finish(
        one(150),
        failing("Rotation must be orthonormal", (width) => width === "183"),
      ),
    ).toThrow("Rotation must be orthonormal");
  });

  it("on a rendered frame, recovers a size entered a third too small as the fit does, yielding between slices", () => {
    const input = one(VIEW.detector_width_mm * 0.75),
      plain = proposeEvidenceRegistration(input);
    let slices = 0;
    const steps = sizeSearchSteps(input, { expired: () => true });
    let next = steps.next();
    for (; !next.done; next = steps.next()) slices++;
    const found = next.value;
    expect(slices).toBeGreaterThan(50);
    expect(found.method).toBe("vessel_evidence_size_search_v1");
    expect(found.detector_fit).toBe("kept");
    expect(found.planes[0].detector_scale * 0.75).toBeGreaterThan(0.97);
    expect(found.planes[0].detector_scale * 0.75).toBeLessThan(1.03);
    expect(evidenceCost(found)).toBeLessThanOrEqual(evidenceCost(plain));
    expect(found.planes[0].start_score).toEqual(plain.planes[0].start_score);
    expect(found.evaluations).toBeGreaterThan(plain.evaluations);
    const got = projectRegistered(
        found.planes[0].view,
        pivot,
        found.matrix,
        medial.points,
        size,
      ),
      want = projectRegistered(VIEW, pivot, truth, medial.points, size);
    let sum = 0;
    for (let k = 0; k < got.length; k += 2)
      sum += Math.hypot(got[k] - want[k], got[k + 1] - want[k + 1]);
    expect(sum / (got.length / 2)).toBeLessThan(1.5);
  });
});
