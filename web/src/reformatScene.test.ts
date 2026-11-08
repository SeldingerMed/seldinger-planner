/** Parser tests for the reformat-scene DTO, against shapes captured from the
 * real FastAPI producer (tests/test_reformat_server.py fixture protocol). */
import { describe, expect, it } from "vitest";
import type { Identity } from "./territoryWorkflow";
import {
  parseScene,
  SCENE_VERSION,
  type SceneInputs,
  type SceneCurrent,
} from "./reformatScene";

const identity: Identity = {
  case_id: "yBj34QkbHssi4S2Oh_gAkA",
  image_sha256:
    "96aeccf6c593f81638a9010fb28fc4116099223296a5782f1edb11add52f711e",
  artifact_version: "1",
  reference_revision:
    "53b52a45cd5f44b88ddd39c54b21a113bab96d337c4dbeb5a9ca23b0f7bfe6a1",
};
const SHA = "9314cb9f60a91461250df480525eae57e08413a89f174c04347850b78623bca7";
const deps = { ...identity, version: SCENE_VERSION };
const inputs: SceneInputs = {
  confirmed: true,
  path: [
    [5, 16, 16],
    [10, 16, 16],
    [10, 21, 16],
  ],
  secondary: null,
};
const result: Extract<SceneCurrent, { status: "current" }>["result"] = {
  version: SCENE_VERSION,
  path_source: "operator_confirmed",
  path_point_count: 3,
  path_length_mm: 10,
  registration_method: null,
};
const matrix = [
  [0, 1, 0, 2],
  [0, 0, 1, 0],
  [1, 0, 0, 0],
  [0, 0, 0, 1],
];
const secondary = {
  source_id: "phase3-synthetic",
  image_sha256: identity.image_sha256,
  reference_revision: identity.reference_revision,
  secondary_to_primary_ras: matrix,
};
const secondaryMetadata = {
  source_id: "phase3-synthetic",
  image_sha256: identity.image_sha256,
  reference_revision: identity.reference_revision,
  image_url: "/api/image-sources/phase3-synthetic/volume",
  spacing_mm: [1, 1, 1],
};
const sceneId = "GlVOoxDUw3n-HC9YuduZPw";

const notConfirmed = {
  ...identity,
  scene_revision: 0,
  current: { status: "not_confirmed" },
  secondary_metadata: null,
};
const stale = {
  ...identity,
  scene_revision: 1,
  current: { status: "stale", scene_id: sceneId, inputs: null, result: null },
  secondary_metadata: null,
};
const current = (
  overrides: Record<string, unknown> = {},
  inputsOverride = inputs,
  resultOverride = result,
) => ({
  ...identity,
  scene_revision: 2,
  current: {
    status: "current",
    scene_id: sceneId,
    dependencies: deps,
    input_sha256: SHA,
    inputs: inputsOverride,
    result: resultOverride,
    ...overrides,
  },
  secondary_metadata:
    inputsOverride.secondary === null ? null : secondaryMetadata,
});
const valid = [
  notConfirmed,
  stale,
  current(),
  current(
    {},
    { ...inputs, secondary },
    { ...result, registration_method: "operator_confirmed_rigid_ras" },
  ),
] as const;

const expectThrows = (value: unknown, id: Identity = identity) =>
  expect(() => parseScene(value, id)).toThrow(/could not be confirmed/);

describe("parseScene", () => {
  it("accepts the real protocol envelopes", () => {
    for (const scene of valid) {
      const parsed = parseScene(structuredClone(scene), identity);
      expect(parsed.current.status).toBe(scene.current.status);
      expect(parsed.scene_revision).toBe(scene.scene_revision);
    }
  });

  it("rejects identity binding mismatches", () => {
    for (const key of Object.keys(identity) as (keyof Identity)[])
      expectThrows(valid[2], {
        ...identity,
        [key]:
          "96aeccf6c593f81638a9010fb28fc4116099223296a5782f1edb11add52f7110",
      });
  });

  it("rejects scalar and NaN payloads", () => {
    for (const value of [null, undefined, 5, "x", [], {}, NaN])
      expectThrows(value);
  });

  it("requires exact current-status shape and revision consistency", () => {
    expectThrows({ ...notConfirmed, scene_revision: 1 });
    expectThrows({
      ...notConfirmed,
      current: { status: "not_confirmed", scene_id: sceneId },
    });
    expectThrows({
      ...stale,
      current: { ...stale.current, inputs: null, result: { fake: true } },
    });
    expectThrows({ ...stale, current: { ...stale.current, scene_id: 7 } });
    expect(
      parseScene({ ...current(), scene_revision: 1 }, identity).scene_revision,
    ).toBe(1);
    expectThrows({ ...current(), scene_revision: 2.5 });
    expectThrows({ ...current(), scene_revision: 1e10 });
    expectThrows({
      ...current(),
      current: { ...current().current, input_sha256: SHA.slice(1) },
    });
  });

  it("rejects contradictory dependency bindings", () => {
    expectThrows(
      current({
        dependencies: { ...deps, version: "territory-traced-geometry-v1" },
      }),
    );
    expectThrows(
      current({
        dependencies: { ...identity, version: SCENE_VERSION, extra: 1 },
      }),
    );
    expectThrows(current({ dependencies: { ...deps, case_id: "other" } }));
  });

  it("rejects fake or mismatched results and inputs", () => {
    expectThrows(
      current({
        inputs: { confirmed: false, path: inputs.path, secondary: null },
      }),
    );
    expectThrows(current({ inputs: { ...inputs, confirmed: 1 } }));
    expectThrows(current({}, { ...inputs, path: [[5, 16, 16]] }));
    expectThrows(
      current(
        {},
        {
          ...inputs,
          path: [
            [5, 16, 16],
            [10, 16, 16],
            [Infinity, 0, 0],
          ],
        },
      ),
    );
    expectThrows(
      current(
        {},
        {
          ...inputs,
          path: [
            [5, 16, 16],
            [10, 16, 16],
            [NaN, 0, 0],
          ],
        },
      ),
    );
    expectThrows(current({ result: { ...result, path_point_count: 2 } }));
    expectThrows(current({ result: { ...result, path_length_mm: 99 } }));
    expectThrows(
      current({ result: { ...result, version: "phase3-scene-v0" } }),
    );
    expectThrows(current({ result: { ...result, path_source: "inferred" } }));
    expectThrows(
      current({
        result: {
          ...result,
          registration_method: "operator_confirmed_rigid_ras",
        },
      }),
    );
    expectThrows(
      current(
        {},
        { ...inputs, secondary },
        { ...result, registration_method: null },
      ),
    );
    expectThrows(current({ result: "short" }));
  });

  it("rejects reflected or malformed rigid registrations", () => {
    const reflected = {
      ...secondary,
      secondary_to_primary_ras: [
        [0, 1, 0, 2],
        [1, 0, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
    };
    expectThrows(
      current(
        {},
        { ...inputs, secondary: reflected },
        { ...result, registration_method: "operator_confirmed_rigid_ras" },
      ),
    );
    expectThrows(
      current(
        {},
        { ...inputs, secondary: { ...secondary, source_id: "Bad_ID" } },
        { ...result, registration_method: "operator_confirmed_rigid_ras" },
      ),
    );
  });

  it("requires secondary_metadata to match the selected secondary", () => {
    const withSecondary = current(
      {},
      { ...inputs, secondary },
      { ...result, registration_method: "operator_confirmed_rigid_ras" },
    );
    expectThrows({ ...withSecondary, secondary_metadata: null });
    expectThrows({
      ...withSecondary,
      secondary_metadata: { ...secondaryMetadata, image_sha256: SHA },
    });
    expectThrows({
      ...withSecondary,
      secondary_metadata: { ...secondaryMetadata, image_url: "/evil/volume" },
    });
    expectThrows({
      ...withSecondary,
      secondary_metadata: { ...secondaryMetadata, source_id: "other" },
    });
    expectThrows({ ...current(), secondary_metadata: secondaryMetadata });
  });
});

it.each(["current", "stale"])(
  "rejects unknown %s-status envelope keys",
  (status) => {
    const envelope = status === "current" ? current() : structuredClone(stale);
    expect(() =>
      parseScene(
        {
          ...envelope,
          current: { ...envelope.current, unexpected: "not admitted" },
        },
        identity,
      ),
    ).toThrow();
  },
);

it.each(["envelope", "inputs", "secondary", "result"])(
  "rejects unknown keys at %s while admitting the actual baseline",
  (where) => {
    const envelope = structuredClone(
      where === "secondary"
        ? current(
            {},
            { ...inputs, secondary },
            { ...result, registration_method: "operator_confirmed_rigid_ras" },
          )
        : current(),
    );
    expect(() => parseScene(envelope, identity)).not.toThrow();
    const target =
      where === "envelope"
        ? envelope
        : where === "inputs"
          ? envelope.current.inputs
          : where === "secondary"
            ? envelope.current.inputs.secondary
            : envelope.current.result;
    Object.assign(target!, { unexpected: "not part of the bounded DTO" });
    expect(() => parseScene(envelope, identity)).toThrow();
  },
);
