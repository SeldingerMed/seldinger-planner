// Strict decoder tests against the actual synthetic API producer
// receipt envelopes (phase5 device-dto). Fixtures are literal; every
// negative test deep-copies before mutating.
import { describe, expect, it, vi } from "vitest";
import {
  parseDeviceScenarios,
  type DeviceScenarioBinding,
  type DeviceScenarioEnvelope,
} from "./deviceScenarios";

const binding: DeviceScenarioBinding = {
  case_id: "Zkscp5RtgTTwX9nbAbIxOA",
  image_sha256: "a".repeat(64),
  artifact_version: "4",
  reference_revision: "b".repeat(64),
  geometry_result_id: "884HLtGETdmppB7wPMEqSg",
  catalog_version: "c697cac424e72db7f60edc90e7c2a5c3547802fa89022cc1890527b48a8d21bf",
};

const notComputedEnvelope = {
  case_id: binding.case_id,
  image_sha256: binding.image_sha256,
  artifact_version: "4",
  reference_revision: binding.reference_revision,
  geometry_result_id: binding.geometry_result_id,
  catalog_version: binding.catalog_version,
  scenario_revision: 0,
  current: { status: "not_computed" },
};

const currentEnvelope = {
  case_id: binding.case_id,
  image_sha256: binding.image_sha256,
  artifact_version: "4",
  reference_revision: binding.reference_revision,
  geometry_result_id: binding.geometry_result_id,
  catalog_version: binding.catalog_version,
  scenario_revision: 1,
  current: {
    status: "current",
    set_id: "d25Yl-vBDci5Q3HzKZ0vTw",
    dependencies: {
      case_id: binding.case_id,
      image_sha256: binding.image_sha256,
      artifact_version: "4",
      source_revision: binding.reference_revision,
      operator_sha256:
        "dd6fd2a0d8e82d83108f236f2acd2a34b8f963e2b630b5cafb64e3075ebf18a5",
      masks: {
        vessel: {
          candidate_id: "wdFxcxZzfP3sASHxsnDmqw",
          mask_sha256: "c".repeat(64),
          segmentation_revision: 1,
        },
        aneurysm: {
          candidate_id: "aR9gj2VyCgkVgAQXETJsmA",
          mask_sha256: "d".repeat(64),
          segmentation_revision: 2,
        },
      },
      calculation_version: "native-mask-operator-plane-v1",
    },
    scenarios_sha256:
      "a282539ba6af48cb40d5507b98858938e96a090bc796d32759f776f6b97c5e7f",
    scenarios: [
      {
        id: "abcd1234ef",
        name: "Synthetic scenario",
        placement: {
          deviceId: "synthetic-device-01",
          diameter: 7.5,
          length: 20.0,
          height: 18.0,
          center: [1.0, 2.0, 3.0],
          axis: [0.0, 0.0, 1.0],
          path: [
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 10.0],
          ],
          offset: 1.0,
          roll: 45.0,
          coilLength: 30.0,
        },
      },
    ],
  },
};

const staleEnvelope = {
  case_id: binding.case_id,
  image_sha256: binding.image_sha256,
  artifact_version: "4",
  reference_revision: binding.reference_revision,
  geometry_result_id: binding.geometry_result_id,
  catalog_version: binding.catalog_version,
  scenario_revision: 3,
  current: {
    status: "stale",
    set_id: "d25Yl-vBDci5Q3HzKZ0vTw",
    scenarios: null,
    stale_reasons: ["device_scenario_dependencies_changed"],
  },
};

const clone = (value: unknown) => structuredClone(value);

describe("parseDeviceScenarios", () => {
  it("measures the scenario envelope using real UTF-8 bytes rather than UTF-16 units", () => {
    const raw = structuredClone(currentEnvelope);
    raw.current.scenarios[0].name = "測".repeat(80);
    const payload = JSON.stringify(raw.current.scenarios);
    const encoder = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      parseDeviceScenarios(raw, binding);
      expect(encoder).toHaveBeenCalledWith(payload);
      const call = encoder.mock.calls.findIndex(([text]) => text === payload);
      expect(encoder.mock.results[call].value.byteLength).toBe(new Blob([payload]).size);
      expect(new Blob([payload]).size).toBeGreaterThan(payload.length);
    } finally {
      encoder.mockRestore();
    }
  });

  it("admits a producer-valid eighty-codepoint non-BMP name", () => {
    const raw = structuredClone(currentEnvelope);
    raw.current.scenarios[0].name = "🫀".repeat(80);
    expect(parseDeviceScenarios(raw, binding).current.status).toBe("current");
  });

  it("rejects sparse placement coordinates during the finite JSON snapshot", () => {
    const raw = structuredClone(currentEnvelope);
    raw.current.scenarios[0].placement.center = new Array(3);
    expect(() => parseDeviceScenarios(raw, binding)).toThrow();
  });

  it("rejects empty device identities admitted by the legacy visual placement helper", () => {
    const raw = structuredClone(currentEnvelope);
    raw.current.scenarios[0].placement.deviceId = "";
    expect(() => parseDeviceScenarios(raw, binding)).toThrow();
  });

  it("rejects unsafe revisions that cannot survive exact JSON CAS identity", () => {
    const raw = structuredClone(currentEnvelope);
    raw.scenario_revision = Number.MAX_VALUE;
    expect(() => parseDeviceScenarios(raw, binding)).toThrow();
  });

  it("admits the actual producer current envelope", () => {
    const parsed: DeviceScenarioEnvelope = parseDeviceScenarios(
      currentEnvelope,
      binding,
    );
    expect(parsed.scenario_revision).toBe(1);
    expect(parsed.current.status).toBe("current");
    if (parsed.current.status !== "current") throw new Error("Expected current producer envelope");
    expect(parsed.current.scenarios).toHaveLength(1);
    expect(parsed.current.dependencies.masks.vessel.candidate_id).toBe(
      "wdFxcxZzfP3sASHxsnDmqw",
    );
    expect(parsed.current.scenarios[0].placement.path).toHaveLength(2);
  });

  it("admits the producer current envelope as JSON string", () => {
    const parsed = parseDeviceScenarios(JSON.stringify(currentEnvelope), binding);
    expect(parsed.current.status).toBe("current");
  });

  it("admits the producer not_computed envelope", () => {
    const parsed = parseDeviceScenarios(notComputedEnvelope, binding);
    expect(parsed.scenario_revision).toBe(0);
    expect(parsed.current).toEqual({ status: "not_computed" });
  });

  it("admits a stale envelope with the single recognized reason", () => {
    const parsed = parseDeviceScenarios(staleEnvelope, binding);
    expect(parsed.current.status).toBe("stale");
    expect(
      (parsed.current as { scenarios: null }).scenarios,
    ).toBeNull();
    expect(
      (parsed.current as { stale_reasons: string[] }).stale_reasons,
    ).toEqual(["device_scenario_dependencies_changed"]);
  });

  it("rejects malformed JSON strings", () => {
    expect(() => parseDeviceScenarios("{not json", binding)).toThrow();
    expect(() => parseDeviceScenarios(undefined, binding)).toThrow();
    expect(() => parseDeviceScenarios(null, binding)).toThrow();
    expect(() => parseDeviceScenarios(42, binding)).toThrow();
    expect(() => parseDeviceScenarios([], binding)).toThrow();
  });

  it("rejects non-finite numbers and prototype pollution", () => {
    expect(() =>
      parseDeviceScenarios('{"a":NaN}', binding),
    ).toThrow();
    const polluted = clone(currentEnvelope);
    (polluted as Record<string, unknown>)["__proto__"] = { evil: 1 };
    expect(() => parseDeviceScenarios(polluted, binding)).toThrow();
  });

  it("rejects envelope key drift", () => {
    const extra = clone(notComputedEnvelope) as Record<string, unknown>;
    extra.extra = 1;
    expect(() => parseDeviceScenarios(extra, binding)).toThrow(/exactly keys/);
    const missing = clone(notComputedEnvelope);
    delete (missing as Record<string, unknown>).catalog_version;
    expect(() => parseDeviceScenarios(missing, binding)).toThrow();
  });

  it("rejects identity token mismatch against the binding", () => {
    for (const key of Object.keys(binding) as (keyof DeviceScenarioBinding)[]) {
      const wrong = clone(currentEnvelope) as Record<string, unknown>;
      wrong[key] = key === "artifact_version" ? "5" : "zz-mismatch";
      expect(() => parseDeviceScenarios(wrong, binding)).toThrow(/binding/);
    }
  });

  it("rejects bad sha/identity formats", () => {
    const badSha = clone(notComputedEnvelope) as Record<string, unknown>;
    badSha.image_sha256 = "A".repeat(64);
    expect(() =>
      parseDeviceScenarios(badSha, {
        ...binding,
        image_sha256: "A".repeat(64),
      }),
    ).toThrow(/lowercase 64-hex/);
    const badVersion = clone(notComputedEnvelope) as Record<string, unknown>;
    badVersion.artifact_version = "0";
    expect(() =>
      parseDeviceScenarios(badVersion, {
        ...binding,
        artifact_version: "0",
      }),
    ).toThrow(/artifact_version/);
  });

  it("rejects incoherent not_computed revisions", () => {
    const bad = clone(notComputedEnvelope) as typeof notComputedEnvelope;
    bad.scenario_revision = 2;
    expect(() => parseDeviceScenarios(bad, binding)).toThrow(/scenario_revision 0/);
  });

  it("rejects stale shape violations", () => {
    const badReason = clone(staleEnvelope) as { current: Record<string, unknown> };
    badReason.current.stale_reasons = ["something_else"];
    expect(() => parseDeviceScenarios(badReason, binding)).toThrow(/stale_reasons/);
    const extraReason = clone(staleEnvelope) as { current: Record<string, unknown> };
    extraReason.current.stale_reasons = [
      "device_scenario_dependencies_changed",
      "device_scenario_identity_changed",
    ];
    expect(() => parseDeviceScenarios(extraReason, binding)).toThrow();
    const nonNull = clone(staleEnvelope) as { current: Record<string, unknown> };
    nonNull.current.scenarios = [];
    expect(() => parseDeviceScenarios(nonNull, binding)).toThrow(/null/);
    const rev0 = clone(staleEnvelope) as typeof staleEnvelope;
    rev0.scenario_revision = 0;
    expect(() => parseDeviceScenarios(rev0, binding)).toThrow(/positive/);
  });

  it("rejects current-shape violations", () => {
    const missingDeps = clone(currentEnvelope) as {
      current: Record<string, unknown>;
    };
    delete missingDeps.current.dependencies;
    expect(() => parseDeviceScenarios(missingDeps, binding)).toThrow();
    const badSha = clone(currentEnvelope) as {
      current: Record<string, unknown>;
    };
    badSha.current.scenarios_sha256 = "deadbeef";
    expect(() => parseDeviceScenarios(badSha, binding)).toThrow(/scenarios_sha256/);
    const badCalc = clone(currentEnvelope) as {
      current: { dependencies: Record<string, unknown> };
    };
    badCalc.current.dependencies.calculation_version = "other-v1";
    expect(() => parseDeviceScenarios(badCalc, binding)).toThrow(
      /calculation_version/,
    );
  });

  it("rejects dependencies that drift from the outer identity", () => {
    const drift = clone(currentEnvelope) as {
      current: { dependencies: Record<string, unknown> };
    };
    drift.current.dependencies.source_revision = "b".repeat(63);
    expect(() => parseDeviceScenarios(drift, binding)).toThrow(/binding/);
  });

  it("rejects invalid masks", () => {
    const badMask = clone(currentEnvelope) as {
      current: { dependencies: Record<string, unknown> };
    };
    delete (badMask.current.dependencies.masks as Record<string, unknown>).vessel;
    expect(() => parseDeviceScenarios(badMask, binding)).toThrow(/masks/);
    const badRev = clone(currentEnvelope) as {
      current: { dependencies: { masks: Record<string, Record<string, unknown>> } };
    };
    badRev.current.dependencies.masks.aneurysm.segmentation_revision = 0;
    expect(() => parseDeviceScenarios(badRev, binding)).toThrow(
      /segmentation_revision/,
    );
  });

  it("rejects bad scenario entries", () => {
    const dupId = clone(currentEnvelope) as typeof currentEnvelope;
    dupId.current.scenarios.push({ ...dupId.current.scenarios[0] });
    expect(() => parseDeviceScenarios(dupId, binding)).toThrow(/unique/);
    const shortId = clone(currentEnvelope) as typeof currentEnvelope;
    shortId.current.scenarios[0].id = "short";
    expect(() => parseDeviceScenarios(shortId, binding)).toThrow(/id/);
    const control = clone(currentEnvelope) as typeof currentEnvelope;
    control.current.scenarios[0].name = "bad\x01name";
    expect(() => parseDeviceScenarios(control, binding)).toThrow(/control/);
    const emptyName = clone(currentEnvelope) as typeof currentEnvelope;
    emptyName.current.scenarios[0].name = "";
    expect(() => parseDeviceScenarios(emptyName, binding)).toThrow(/name/);
    const over12 = clone(currentEnvelope) as typeof currentEnvelope;
    while (over12.current.scenarios.length < 13) {
      over12.current.scenarios.push({
        ...over12.current.scenarios[0],
        id: `id${over12.current.scenarios.length}xxxxxxx`,
      });
    }
    expect(() => parseDeviceScenarios(over12, binding)).toThrow(/12 scenarios/);
  });

  it("rejects invalid placements", () => {
    const extraKey = clone(currentEnvelope) as typeof currentEnvelope;
    (extraKey.current.scenarios[0].placement as unknown as Record<string, unknown>)
      .surprise = 1;
    expect(() => parseDeviceScenarios(extraKey, binding)).toThrow(/unexpected key/);
    const missingKey = clone(currentEnvelope) as typeof currentEnvelope;
    const p: Record<string, unknown> = {
      ...missingKey.current.scenarios[0].placement,
    };
    delete p.coilLength;
    missingKey.current.scenarios[0].placement = p as never;
    expect(() => parseDeviceScenarios(missingKey, binding)).toThrow(/missing/);
    const shortPath = clone(currentEnvelope) as typeof currentEnvelope;
    shortPath.current.scenarios[0].placement.path = [[0, 0, 0]];
    expect(() => parseDeviceScenarios(shortPath, binding)).toThrow(/placement/);
    const nullAxis = clone(currentEnvelope) as typeof currentEnvelope;
    nullAxis.current.scenarios[0].placement.axis = [0, 0, 0];
    expect(() => parseDeviceScenarios(nullAxis, binding)).toThrow(/placement/);
    const nullBraid = clone(currentEnvelope) as {
      current: { scenarios: Record<string, unknown>[] };
    };
    nullBraid.current.scenarios[0].placement = {
      ...(nullBraid.current.scenarios[0].placement as object),
      braidAngle: null,
    };
    expect(() => parseDeviceScenarios(nullBraid, binding)).toThrow(/invalid/);
    const braidRange = clone(currentEnvelope) as {
      current: { scenarios: Record<string, unknown>[] };
    };
    braidRange.current.scenarios[0].placement = {
      ...(braidRange.current.scenarios[0].placement as object),
      braidAngle: 30,
    };
    expect(() => parseDeviceScenarios(braidRange, binding)).toThrow(/invalid/);
    const longDeviceId = clone(currentEnvelope) as {
      current: { scenarios: Record<string, unknown>[] };
    };
    longDeviceId.current.scenarios[0].placement = {
      ...(longDeviceId.current.scenarios[0].placement as object),
      deviceId: "x".repeat(100),
    };
    expect(() => parseDeviceScenarios(longDeviceId, binding)).toThrow(/invalid/);
    const acceptsBraid = clone(currentEnvelope) as {
      current: { scenarios: Record<string, unknown>[] };
    };
    acceptsBraid.current.scenarios[0].placement = {
      ...(acceptsBraid.current.scenarios[0].placement as object),
      braidAngle: 45,
    };
    expect(parseDeviceScenarios(acceptsBraid, binding).current).toBeDefined();
  });

  it("preserves no aliases from the input", () => {
    const input = structuredClone(currentEnvelope);
    const parsed = parseDeviceScenarios(input, binding);
    if (parsed.current.status !== "current") throw new Error("expected current");
    parsed.current.scenarios[0].name = "mutated";
    expect(input.current.scenarios[0].name).toBe("Synthetic scenario");
  });
});
