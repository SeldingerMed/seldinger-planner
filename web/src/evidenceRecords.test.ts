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
    [
      "an unknown fit outcome on a requested fit",
      single({ fit_detector_scale: true, detector_fit: "guessed" }),
    ],
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

/** The same records as found from the best of several starts. */
describe("best-start records", () => {
  const SINGLE = [
      "vessel_evidence_best_start_v1",
      "step-c4-evidence-best-start-registration-v5",
    ] as const,
    PAIR = [
      "vessel_evidence_best_start_biplane_v1",
      "step-c4-evidence-best-start-biplane-registration-v6",
    ] as const,
    named = (answer: unknown, method: string, version: string) =>
      changed(answer, (c) => {
        c.inputs.method = method;
        c.result.method = method;
        c.result.version = version;
        c.dependencies.version = version;
      });

  it("reads a single-plane and a two-plane record under their own versions", () => {
    const one = parse(named(single(), ...SINGLE)).current,
      two = parse(named(pair(), ...PAIR)).current;
    if (one.status !== "current" || two.status !== "current")
      throw new Error("not current");
    expect(one.inputs.method).toBe(SINGLE[0]);
    expect(isEvidence(one.inputs)).toBe(true);
    expect(isBiplane(one.inputs)).toBe(false);
    expect(two.inputs.method).toBe(PAIR[0]);
    expect(isEvidence(two.inputs)).toBe(true);
    expect(isBiplane(two.inputs)).toBe(true);
    expect(two.result.plane_angle_deg).not.toBeNull();
  });

  it.each([
    [
      "a single-plane record under the single-start version",
      named(single(), SINGLE[0], "step-c4-evidence-registration-v3"),
    ],
    [
      "a single-start record under the best-start version",
      named(single(), "vessel_evidence_compass_v1", SINGLE[1]),
    ],
    [
      "a pair under the single-start version",
      named(pair(), PAIR[0], "step-c4-evidence-biplane-registration-v4"),
    ],
    [
      "a pair under the single-plane version",
      named(pair(), PAIR[0], SINGLE[1]),
    ],
    ["a single-plane record named as a pair", named(single(), ...PAIR)],
    [
      "a record with a sensitivity",
      changed(named(single(), ...SINGLE), (c) => {
        c.inputs.sensitivity = 0.5;
      }),
    ],
  ])("refuses %s", (_name, answer) => {
    expect(() => parse(answer)).toThrow(/Invalid/);
  });
});

/** The same records as found by the search of the field size. */
describe("size-search records", () => {
  const SINGLE = [
      "vessel_evidence_size_search_v1",
      "step-c4-evidence-size-search-registration-v7",
    ] as const,
    PAIR = [
      "vessel_evidence_size_search_biplane_v1",
      "step-c4-evidence-size-search-biplane-registration-v8",
    ] as const,
    fitted = {
      fit_detector_scale: true,
      geometry_source: "operator_entered",
      detector_scale: 1.2,
    },
    named = (answer: unknown, method: string, version: string) =>
      changed(answer, (c) => {
        c.inputs.method = method;
        c.result.method = method;
        c.result.version = version;
        c.dependencies.version = version;
      }),
    one = (change: Record<string, unknown> = {}) =>
      named(single({ ...fitted, detector_fit: "kept", ...change }), ...SINGLE),
    two = (plane: Record<string, unknown> = fitted, fit = "kept") =>
      named(pairB(plane, { detector_fit: fit }), ...PAIR);

  it("reads a single-plane and a two-plane record under their own versions", () => {
    const a = parse(one()).current,
      b = parse(two()).current;
    if (a.status !== "current" || b.status !== "current")
      throw new Error("not current");
    expect(a.inputs.method).toBe(SINGLE[0]);
    expect(isEvidence(a.inputs)).toBe(true);
    expect(isBiplane(a.inputs)).toBe(false);
    expect(b.inputs.method).toBe(PAIR[0]);
    expect(isEvidence(b.inputs)).toBe(true);
    expect(isBiplane(b.inputs)).toBe(true);
    // A fit that was requested and dropped is a size-search record too.
    expect(
      parse(one({ detector_fit: "dropped", detector_scale: 1 })).current.status,
    ).toBe("current");
  });

  it.each([
    ["a single-plane record with no fit requested", named(single(), ...SINGLE)],
    ["a pair with no fit requested", named(pair(), ...PAIR)],
    [
      "a single-plane record under the single-start version",
      named(
        single({ ...fitted, detector_fit: "kept" }),
        SINGLE[0],
        "step-c4-evidence-registration-v3",
      ),
    ],
    [
      "a best-start record under the size-search version",
      named(
        single({ ...fitted, detector_fit: "kept" }),
        "vessel_evidence_best_start_v1",
        SINGLE[1],
      ),
    ],
    [
      "a pair under the single-plane version",
      named(pairB(fitted, { detector_fit: "kept" }), PAIR[0], SINGLE[1]),
    ],
    [
      "a single-plane record named as a pair",
      named(single({ ...fitted, detector_fit: "kept" }), ...PAIR),
    ],
    ["a size past what a record accepts", one({ detector_scale: 1.5 })],
    ["a record with a sensitivity", one({ sensitivity: 0.5 })],
  ])("refuses %s", (_name, answer) => {
    expect(() => parse(answer)).toThrow(/Invalid/);
  });
});
