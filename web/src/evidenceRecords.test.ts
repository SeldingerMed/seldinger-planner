/** Saved records of the vessel evidence methods: what the browser accepts
 * from the server, and what it refuses. */
import { describe, expect, it } from "vitest";
import {
  currentAnswer,
  currentPairAnswer,
  EVIDENCE_SCORE,
  identity,
  savedEvidenceInputs,
  savedEvidencePairInputs,
  savedInputs,
  savedPairInputs,
  registrationAnswer,
  SCORE,
} from "./__fixtures__/overlayCase";
import records from "./__fixtures__/evidence-registration-records.json";
import {
  isBiplane,
  isEvidence,
  parseSavedRegistration,
} from "./projectionFrames";

const parse = (answer: unknown) => parseSavedRegistration(answer, identity);
/** The answer with `change` applied to a deep copy of its current record. */
function changed(answer: unknown, change: (current: any) => void) {
  const copy = JSON.parse(JSON.stringify(answer));
  change(copy.current);
  return copy;
}
const single = (change: Record<string, unknown> = {}) =>
    currentAnswer(savedEvidenceInputs(change)),
  pair = (change: Record<string, unknown> = {}) =>
    currentPairAnswer(savedEvidencePairInputs(change)),
  /** A pair with plane B changed. */
  pairB = (plane: Record<string, unknown>, change = {}) => {
    const inputs = savedEvidencePairInputs(change);
    inputs.planes[1] = { ...inputs.planes[1], ...plane } as never;
    return currentPairAnswer(inputs);
  };

describe("vessel evidence records", () => {
  it("reads a single-plane record and keeps its own score", () => {
    const read = parse(single()).current;
    if (read.status !== "current") throw new Error("not current");
    expect(read.inputs.method).toBe("vessel_evidence_compass_v1");
    expect(isEvidence(read.inputs)).toBe(true);
    expect(isBiplane(read.inputs)).toBe(false);
    expect("sensitivity" in read.inputs).toBe(false);
    if (!isEvidence(read.inputs) || isBiplane(read.inputs))
      throw new Error("wrong kind");
    expect(read.inputs.detector_fit).toBe("not_requested");
    expect(read.inputs.reported_score).toEqual(EVIDENCE_SCORE);
    expect(read.result.plane_angle_deg).toBeNull();
  });

  it("reads a two-plane record with a kept fit on one plane", () => {
    const read = parse(
      pairB(
        { fit_detector_scale: true, detector_scale: 1.18 },
        { detector_fit: "kept" },
      ),
    ).current;
    if (read.status !== "current") throw new Error("not current");
    expect(isEvidence(read.inputs) && isBiplane(read.inputs)).toBe(true);
    expect(read.result.plane_angle_deg).toBe(90);
  });

  it("reads a dropped fit, which leaves the entered size", () => {
    expect(
      parse(single({ fit_detector_scale: true, detector_fit: "dropped" }))
        .current.status,
    ).toBe("current");
  });

  it("still reads records of the centerline distance methods", () => {
    for (const answer of [
      currentAnswer(savedInputs()),
      currentPairAnswer(savedPairInputs()),
    ]) {
      const read = parse(answer).current;
      if (read.status !== "current") throw new Error("not current");
      expect(isEvidence(read.inputs)).toBe(false);
    }
  });

  it.each<[string, unknown]>([
    ["a centerline distance score", single({ reported_score: SCORE })],
    [
      "a centerline distance start score",
      single({ reported_start_score: SCORE }),
    ],
    [
      "evidence above one",
      single({ reported_score: { ...EVIDENCE_SCORE, mean_evidence: 1.2 } }),
    ],
    [
      "a score with an accuracy in it",
      single({ reported_score: { ...EVIDENCE_SCORE, accuracy_mm: 1 } }),
    ],
    ["a sensitivity", single({ sensitivity: 0.5 })],
    ["no fit outcome", changed(single(), (c) => delete c.inputs.detector_fit)],
    ["an unknown fit outcome", single({ detector_fit: "guessed" })],
    ["a kept fit that was not requested", single({ detector_fit: "kept" })],
    [
      "a dropped fit that was not requested",
      single({ detector_fit: "dropped" }),
    ],
    ["a requested fit with no outcome", single({ fit_detector_scale: true })],
    [
      "a dropped fit that changed the size",
      single({
        fit_detector_scale: true,
        detector_fit: "dropped",
        detector_scale: 1.1,
      }),
    ],
    [
      "a fit on admitted geometry",
      single({
        fit_detector_scale: true,
        detector_fit: "kept",
        geometry_source: "frame_manifest",
      }),
    ],
    [
      "the centerline distance record version",
      changed(single(), (c) => {
        c.dependencies.version = "step-c1-projection-registration-v1";
        c.result.version = "step-c1-projection-registration-v1";
      }),
    ],
    [
      "a result of the other method",
      changed(single(), (c) => {
        c.result.method = "centerline_distance_compass_v1";
      }),
    ],
    [
      "a result with another fit outcome",
      changed(
        single({ fit_detector_scale: true, detector_fit: "dropped" }),
        (c) => {
          c.result.detector_fit = "kept";
        },
      ),
    ],
    [
      "a result with no score kind",
      changed(single(), (c) => delete c.result.score_kind),
    ],
    [
      "a result whose score is called an accuracy",
      changed(single(), (c) => {
        c.result.score_kind = "registration_accuracy";
      }),
    ],
    [
      "a result with another score",
      changed(single(), (c) => {
        c.result.reported_score = { ...EVIDENCE_SCORE, mean_evidence: 0.9 };
      }),
    ],
    [
      "a centerline distance record with a fit outcome",
      currentAnswer(savedInputs({ detector_fit: "not_requested" })),
    ],
    [
      "a centerline distance record with an evidence score",
      currentAnswer(savedInputs({ reported_score: EVIDENCE_SCORE })),
    ],
    [
      "a pair whose fit outcome is missing a request",
      pair({ detector_fit: "kept" }),
    ],
    ["a pair plane with a sensitivity", pairB({ sensitivity: 0.5 })],
    [
      "a pair plane with a centerline distance score",
      pairB({ reported_score: SCORE }),
    ],
    [
      "a pair whose dropped fit changed a size",
      pairB(
        { fit_detector_scale: true, detector_scale: 1.1 },
        { detector_fit: "dropped" },
      ),
    ],
    [
      "a pair without the attestation",
      changed(pair(), (c) => {
        c.inputs.same_position_attested = false;
      }),
    ],
    [
      "a pair under the single-plane evidence version",
      changed(pair(), (c) => {
        c.dependencies.version = "step-c4-evidence-registration-v3";
        c.result.version = "step-c4-evidence-registration-v3";
      }),
    ],
  ])("refuses %s", (_name, answer) => {
    expect(() => parse(answer)).toThrow(/Invalid/);
  });
});

/** Records the studio saved on the phantom, each with the Python module's
 * own summary of it. The server tests read the same file. */
describe("the studio's own records, as the server summarizes them", () => {
  const answer = (one: (typeof records.cases)[number]) =>
    registrationAnswer(
      {
        status: "current",
        registration_id: "registration-3",
        evidence: "verified",
        dependencies: { ...identity, version: one.result.version },
        input_sha256: "f".repeat(64),
        inputs: one.inputs,
        result: one.result,
      },
      1,
    );

  it.each(records.cases.map((one) => [one.name, one] as const))(
    "reads %s",
    (_name, one) => {
      const read = parse(answer(one)).current;
      if (read.status !== "current") throw new Error("not current");
      expect(isEvidence(read.inputs)).toBe(true);
      expect(read.inputs).toEqual(one.inputs);
      expect(read.result.rotation_deg).toBe(one.result.rotation_deg);
    },
  );

  it("covers both methods and every fit outcome", () => {
    expect(new Set(records.cases.map((one) => one.inputs.method))).toEqual(
      new Set([
        "vessel_evidence_compass_v1",
        "vessel_evidence_compass_biplane_v1",
      ]),
    );
    expect(
      new Set(records.cases.map((one) => one.inputs.detector_fit)),
    ).toEqual(new Set(["not_requested", "kept", "dropped"]));
  });

  it("refuses a server summary that drifted from the record", () => {
    for (const one of records.cases) {
      const drifted = changed(answer(one), (c) => {
        c.result.detector_fit =
          one.inputs.detector_fit === "kept" ? "dropped" : "kept";
      });
      expect(() => parse(drifted)).toThrow(/Invalid/);
    }
  });
});
