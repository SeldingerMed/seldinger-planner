import { describe, expect, it } from "vitest";
import {
  currentAnswer,
  currentPairAnswer,
  identity,
  presenceAnswer,
  presenceCurrent,
  presenceResult,
  registrationAnswer,
} from "./__fixtures__/overlayCase";
import { parseSavedRegistration } from "./projectionFrames";
import {
  parseSavedPresence,
  PRESENCE_REPORT_LIMITS,
  PRESENCE_REPORT_VERSION,
  reportBinding,
  reportDifference,
  reportInputs,
  summarizeReport,
  type PresenceReportInputs,
} from "./presenceReport";
import type { VesselPresence } from "./vesselPresence";
import type { VesselSegments } from "./vesselSegments";

const single = parseSavedRegistration(currentAnswer(), identity),
  pair = parseSavedRegistration(currentPairAnswer(), identity);
const SEGMENTS = [
  { length_mm: 12.5, mean_radius_mm: 2, sample_count: 13, run: 0 },
  { length_mm: 12.5, mean_radius_mm: 1.5, sample_count: 12, run: 0 },
  { length_mm: 7.25, mean_radius_mm: 1, sample_count: 8, run: 1 },
];
const SEEN = [
  { presence: "supported", in_field: 13, clear: 10, supported: 9 },
  { presence: "no_2d_support", in_field: 12, clear: 10, supported: 1 },
  { presence: "outside_field", in_field: 3, clear: 3, supported: 3 },
];
const OTHER = [
  { presence: "indeterminate", in_field: 13, clear: 2, supported: 2 },
  { presence: "supported", in_field: 12, clear: 12, supported: 12 },
  { presence: "indeterminate", in_field: 8, clear: 8, supported: 4 },
];
/** Confirmed report inputs for a registration, as plain data. */
function inputs(
  registration = single,
  change: Record<string, unknown> = {},
): Record<string, any> {
  const binding = reportBinding(registration)!;
  return {
    confirmed: true,
    registration_id: binding.registration_id,
    registration_revision: binding.registration_revision,
    registration_input_sha256: binding.registration_input_sha256,
    method: "segment_centerline_support_v1",
    segment_method: "mask_band_sweep_v1",
    pooling: 1,
    unassigned_fraction: 0.0125,
    segments: structuredClone(SEGMENTS),
    planes: binding.planes.map((plane, k) => ({
      ...plane,
      segments: structuredClone(k ? OTHER : SEEN),
      unmatched_mm: k ? [] : [21.5, 6],
    })),
    ...change,
  };
}
const plane = (change: Record<string, unknown>, registration = single) => {
  const planes = inputs(registration).planes;
  planes[0] = { ...planes[0], ...change };
  return { planes };
};
const entry = (index: number, change: Record<string, unknown>) => {
  const segments = structuredClone(SEEN) as Record<string, unknown>[];
  segments[index] = { ...segments[index], ...change };
  return plane({ segments });
};
const parse = (
  value: unknown,
  registration = single,
  mine: typeof identity = identity,
) => parseSavedPresence(value, mine, registration);

describe("what a report must name", () => {
  it("is the registration's id, revision, input digest and frames", () => {
    expect(reportBinding(single)).toEqual({
      registration_id: "registration-1",
      registration_revision: 1,
      registration_input_sha256: "f".repeat(64),
      planes: [
        {
          plane: "single",
          frame_sha256: (single.current as any).inputs.frame_sha256,
        },
      ],
    });
    const two = reportBinding(pair)!;
    expect(two.registration_id).toBe("registration-2");
    expect(two.planes.map((p) => p.plane)).toEqual(["a", "b"]);
    expect(two.planes.map((p) => p.frame_sha256)).toEqual(
      (pair.current as any).inputs.planes.map((p: any) => p.frame_sha256),
    );
  });
  it("is nothing when the registration is not current", () => {
    for (const answer of [
      registrationAnswer(),
      registrationAnswer({ status: "stale", registration_id: "r-0" }, 3),
    ])
      expect(reportBinding(parseSavedRegistration(answer, identity))).toBe(
        null,
      );
  });
});

describe("reading a saved report", () => {
  it("reads no report, a stale report and a current one", () => {
    expect(parse(presenceAnswer(1))).toEqual({
      report_revision: 0,
      current: { status: "not_confirmed" },
    });
    expect(
      parse(presenceAnswer(1, { status: "stale", report_id: "report-0" }, 4)),
    ).toEqual({
      report_revision: 4,
      current: { status: "stale", report_id: "report-0" },
    });
    const read = parse(presenceCurrent(inputs()));
    expect(read).toEqual({
      report_revision: 1,
      current: { status: "current", report_id: "report-1", inputs: inputs() },
    });
    const two = parse(presenceCurrent(inputs(pair), {}, 3), pair);
    expect(two.report_revision).toBe(3);
    expect(
      two.current.status === "current" &&
        two.current.inputs.planes.map((p) => p.plane),
    ).toEqual(["a", "b"]);
  });

  it("refuses a report for another case or registration revision", () => {
    const other = "Report belongs to another case or registration revision";
    expect(() => parse(presenceAnswer(2))).toThrow(other);
    expect(() =>
      parse(presenceAnswer(1), single, { ...identity, artifact_version: "8" }),
    ).toThrow(other);
    expect(() => parse({ ...presenceAnswer(1), case_id: "another" })).toThrow(
      other,
    );
  });

  it("refuses a current report that does not name the registration", () => {
    for (const change of [
      { registration_id: "registration-9" },
      { registration_input_sha256: "0".repeat(64) },
      plane({ plane: "a" }),
      plane({ frame_sha256: "0".repeat(64) }),
    ])
      expect(() => parse(presenceCurrent(inputs(single, change)))).toThrow(
        "Invalid vessel presence report",
      );
    // A report of one plane is not a report on a two-plane registration.
    const one = inputs(pair);
    one.planes = one.planes.slice(0, 1);
    expect(() => parse(presenceCurrent(one), pair)).toThrow();
    const swapped = inputs(pair);
    swapped.planes.reverse();
    expect(() => parse(presenceCurrent(swapped), pair)).toThrow();
    // A current report against a registration that is not current.
    const stale = parseSavedRegistration(
      registrationAnswer({ status: "stale", registration_id: "r-0" }, 1),
      identity,
    );
    expect(() => parse(presenceCurrent(inputs()), stale)).toThrow();
  });

  const refused: [string, Record<string, unknown>][] = [
    ["unconfirmed", { confirmed: false }],
    ["another method", { method: "other" }],
    ["another segment method", { segment_method: "named_arteries" }],
    ["pooling of zero", { pooling: 0 }],
    ["pooling over eight", { pooling: 9 }],
    ["a fraction over one", { unassigned_fraction: 1.5 }],
    ["a fraction that is not finite", { unassigned_fraction: null }],
    ["no segments", { segments: [] }],
    [
      "a named segment",
      { segments: [{ ...SEGMENTS[0], name: "M1" }, ...SEGMENTS.slice(1)] },
    ],
    [
      "a segment of no length",
      { segments: [{ ...SEGMENTS[0], length_mm: 0 }, ...SEGMENTS.slice(1)] },
    ],
    [
      "a segment of no radius",
      {
        segments: [{ ...SEGMENTS[0], mean_radius_mm: 0 }, ...SEGMENTS.slice(1)],
      },
    ],
    [
      "a fractional sample count",
      {
        segments: [
          { ...SEGMENTS[0], sample_count: 13.5 },
          ...SEGMENTS.slice(1),
        ],
      },
    ],
    [
      "runs that do not start at zero",
      { segments: [{ ...SEGMENTS[0], run: 1 }, ...SEGMENTS.slice(1)] },
    ],
    [
      "a run that skips",
      { segments: [...SEGMENTS.slice(0, 2), { ...SEGMENTS[2], run: 2 }] },
    ],
    [
      "a run that goes back",
      {
        segments: [
          SEGMENTS[0],
          { ...SEGMENTS[1], run: 1 },
          { ...SEGMENTS[2], run: 0 },
        ],
      },
    ],
    [
      "fewer segments than the plane classes",
      { segments: SEGMENTS.slice(0, 2) },
    ],
    ["no planes", { planes: [] }],
    ["a plane with pixels", plane({ pixels: [1, 2, 3] })],
    ["unmatched pieces not longest first", plane({ unmatched_mm: [6, 21.5] })],
    ["an unmatched piece too short to list", plane({ unmatched_mm: [4.9] })],
    ["a class that is not one", entry(0, { presence: "occluded" })],
    ["a cause", entry(0, { cause: "occlusion" })],
    ["more supported than clear", entry(0, { supported: 11 })],
    ["more clear than in the field", entry(0, { clear: 14 })],
    ["more in the field than samples", entry(0, { in_field: 14 })],
    ["a negative count", entry(0, { in_field: -1 })],
    ["a class its counts do not give", entry(0, { presence: "no_2d_support" })],
    ["counts that give another class", entry(0, { supported: 6 })],
    ["an outside class with enough in the field", entry(2, { in_field: 4 })],
    ["a pose", { volume_to_carm_ras: [[1, 0, 0, 0]] }],
  ];
  it.each(refused)("refuses %s", (_name, change) => {
    const changed = inputs(single, change);
    let answer: unknown;
    try {
      answer = presenceCurrent(changed);
    } catch {
      // The fixture cannot summarize it; the summary is not what is tested.
      answer = presenceCurrent(inputs(), { inputs: changed });
    }
    expect(() => parse(answer)).toThrow("Invalid vessel presence report");
  });

  it("refuses a summary that is not the report's own", () => {
    const good = inputs(),
      result = presenceResult(good) as Record<string, any>;
    const changes: ((r: Record<string, any>) => void)[] = [
      (r) => (r.validated = true),
      (r) => (r.cause = "occlusion"),
      (r) => (r.status = "validated_report"),
      (r) => (r.counts_source = "server_recomputed"),
      (r) => (r.version = "step-c3-vessel-presence-v2"),
      (r) => r.segment_count++,
      (r) => (r.segment_length_mm += 0.01),
      (r) => (r.unassigned_fraction = 0.5),
      (r) => r.planes[0].classes.supported.count++,
      (r) => (r.planes[0].classes.supported.length_mm += 0.01),
      (r) => r.planes[0].unmatched_count++,
      (r) => (r.planes[0].unmatched_length_mm += 0.01),
      (r) => (r.planes[0].plane = "a"),
      (r) => delete r.planes[0].classes.indeterminate,
      (r) => (r.planes[0].classes.occluded = { count: 0, length_mm: 0 }),
      (r) => (r.accuracy_mm = 1),
      (r) => r.planes.push(r.planes[0]),
    ];
    for (const change of changes) {
      const mine = structuredClone(result);
      change(mine);
      expect(() => parse(presenceCurrent(good, { result: mine }))).toThrow(
        "Invalid vessel presence report",
      );
    }
    // The server's rounding to a micrometer is accepted.
    const rounded = structuredClone(result);
    rounded.segment_length_mm += 0.0005;
    expect(() =>
      parse(presenceCurrent(good, { result: rounded })),
    ).not.toThrow();
  });

  it("refuses unknown keys, wrong revisions and wrong dependencies", () => {
    const good = presenceCurrent(inputs());
    for (const answer of [
      { ...good, extra: 1 },
      { ...good, report_revision: 0 },
      { ...good, report_revision: 1.5 },
      { ...good, current: { ...good.current, extra: 1 } },
      { ...good, current: { ...good.current, report_id: "" } },
      { ...good, current: { ...good.current, input_sha256: "F".repeat(64) } },
      { ...good, current: { ...good.current, status: "validated" } },
      { ...good, current: null },
      {
        ...good,
        current: {
          ...good.current,
          dependencies: {
            ...(good.current as any).dependencies,
            version: "step-c2-biplane-registration-v2",
          },
        },
      },
      {
        ...good,
        current: {
          ...good.current,
          dependencies: {
            ...(good.current as any).dependencies,
            registration_revision: 2,
          },
        },
      },
      { ...presenceAnswer(1), report_revision: 1 },
      presenceAnswer(1, { status: "stale", report_id: "r" }, 0),
      presenceAnswer(
        1,
        { status: "stale", report_id: "r", inputs: inputs() },
        1,
      ),
      presenceAnswer(1, { status: "not_confirmed", report_id: "r" }),
      null,
      [],
    ])
      expect(() => parse(answer)).toThrow();
    expect(PRESENCE_REPORT_VERSION).toBe("step-c3-vessel-presence-v1");
  });

  it("holds the same bounds as the server", () => {
    expect(PRESENCE_REPORT_LIMITS).toEqual({
      max_segments: 2000,
      max_unmatched: 2000,
      max_samples: 100_000,
    });
    const edges = inputs(single, {
      pooling: 8,
      unassigned_fraction: 1,
      ...plane({
        segments: [
          { presence: "supported", in_field: 13, clear: 10, supported: 7 },
          { presence: "no_2d_support", in_field: 12, clear: 10, supported: 3 },
          { presence: "supported", in_field: 4, clear: 4, supported: 4 },
        ],
        unmatched_mm: [5, 5],
      }),
    });
    expect(() => parse(presenceCurrent(edges))).not.toThrow();
    const many = inputs(single, {
      ...plane({ unmatched_mm: Array(2001).fill(6) }),
    });
    expect(() => parse(presenceCurrent(many))).toThrow();
  });
});

describe("the summary", () => {
  it("counts segments and lengths by class in each plane", () => {
    const summary = summarizeReport(inputs(pair) as PresenceReportInputs);
    expect(summary).toEqual([
      {
        plane: "a",
        classes: {
          supported: { count: 1, length_mm: 12.5 },
          no_2d_support: { count: 1, length_mm: 12.5 },
          outside_field: { count: 1, length_mm: 7.25 },
          indeterminate: { count: 0, length_mm: 0 },
        },
        unmatched_count: 2,
        unmatched_length_mm: 27.5,
      },
      {
        plane: "b",
        classes: {
          supported: { count: 1, length_mm: 12.5 },
          no_2d_support: { count: 0, length_mm: 0 },
          outside_field: { count: 0, length_mm: 0 },
          indeterminate: { count: 2, length_mm: 19.75 },
        },
        unmatched_count: 0,
        unmatched_length_mm: 0,
      },
    ]);
  });
});

describe("building the report to save", () => {
  const segments = {
    segments: SEGMENTS.map((segment, index) => ({ index, ...segment })),
    labels: new Int32Array(0),
    points: new Float32Array(0),
    pooling: 2,
    unassigned_fraction: 0.0125,
  } as unknown as VesselSegments;
  const presence = (planes: number): VesselPresence => ({
    method: "segment_centerline_support_v1",
    planes: [SEEN, OTHER].slice(0, planes).map((list, k) => ({
      segments: list.map(({ presence: found, ...counts }) => ({
        class: found as any,
        ...counts,
      })),
      unmatched: k
        ? []
        : [21.5, 6].map((length_mm) => ({
            length_mm,
            pixels: new Int32Array([1, 2]),
          })),
    })),
  });
  it("carries counts and lengths, and no pixels", () => {
    const built = reportInputs(pair, segments, presence(2));
    expect(built).toEqual(inputs(pair, { pooling: 2 }));
    expect(JSON.stringify(built)).not.toMatch(/pixels|index|points|labels/);
    // What is built is what the parser accepts.
    expect(() => parse(presenceCurrent(built), pair)).not.toThrow();
  });
  it("refuses a result for another number of planes or segments", () => {
    expect(() => reportInputs(pair, segments, presence(1))).toThrow(
      "The report does not belong to this registration",
    );
    expect(() => reportInputs(single, segments, presence(2))).toThrow();
    const stale = parseSavedRegistration(registrationAnswer(), identity);
    expect(() => reportInputs(stale, segments, presence(1))).toThrow();
    const short = presence(1);
    short.planes[0].segments.pop();
    expect(() => reportInputs(single, segments, short)).toThrow(
      "The report is too large to save",
    );
    const noisy = presence(1);
    noisy.planes[0].unmatched = Array(2001).fill(noisy.planes[0].unmatched[0]);
    expect(() => reportInputs(single, segments, noisy)).toThrow();
  });
});

describe("comparing a recomputed report with the saved one", () => {
  const saved = inputs(pair) as PresenceReportInputs;
  const differing = (change: (r: Record<string, any>) => void) => {
    const other = structuredClone(saved) as Record<string, any>;
    change(other);
    return reportDifference(saved, other as PresenceReportInputs);
  };
  it("agrees with itself, and with rounding noise in lengths", () => {
    expect(reportDifference(saved, structuredClone(saved))).toBe(null);
    expect(
      differing((r) => {
        r.segments[0].length_mm *= 1 + 1e-9;
        r.segments[1].mean_radius_mm *= 1 - 1e-9;
        r.planes[0].unmatched_mm[0] *= 1 + 1e-9;
        r.unassigned_fraction += 1e-9;
      }),
    ).toBe(null);
  });
  it("says what differs", () => {
    const registration = "it was computed for another registration",
      mask = "the vessel mask gives other segments";
    expect(differing((r) => (r.registration_id = "x"))).toBe(registration);
    expect(differing((r) => r.registration_revision++)).toBe(registration);
    expect(
      differing((r) => (r.registration_input_sha256 = "0".repeat(64))),
    ).toBe(registration);
    expect(differing((r) => (r.planes[1].frame_sha256 = "0".repeat(64)))).toBe(
      registration,
    );
    expect(differing((r) => r.planes.pop())).toBe(registration);
    expect(differing((r) => (r.pooling = 2))).toBe(mask);
    expect(differing((r) => (r.unassigned_fraction = 0.02))).toBe(mask);
    expect(differing((r) => (r.segments[0].length_mm = 12.6))).toBe(mask);
    expect(differing((r) => (r.segments[0].mean_radius_mm = 2.1))).toBe(mask);
    expect(differing((r) => r.segments[0].sample_count++)).toBe(mask);
    expect(differing((r) => (r.segments[2].run = 0))).toBe(mask);
    expect(
      differing((r) => {
        r.segments.pop();
        for (const p of r.planes) p.segments.pop();
      }),
    ).toBe(mask);
    expect(differing((r) => r.planes[0].segments[0].supported--)).toBe(
      "1 of 3 segments have other counts in plane a",
    );
    expect(
      differing((r) => {
        r.planes[1].segments[0].presence = "supported";
        r.planes[1].segments[2].clear--;
      }),
    ).toBe("2 of 3 segments have other counts in plane b");
    expect(differing((r) => r.planes[0].segments[1].in_field--)).toBe(
      "1 of 3 segments have other counts in plane a",
    );
    expect(differing((r) => r.planes[0].unmatched_mm.pop())).toBe(
      "the 2D vessel pieces with no segment near differ in plane a",
    );
    expect(differing((r) => (r.planes[0].unmatched_mm[1] = 6.5))).toBe(
      "the 2D vessel pieces with no segment near differ in plane a",
    );
  });
});
