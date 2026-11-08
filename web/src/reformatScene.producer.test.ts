import { test, expect } from "vitest";
import fixtures from "./__fixtures__/phase4-reformat-scenes.json";
import { parseScene } from "./reformatScene";
import type { Identity } from "./territoryWorkflow";
const identity = (value: Identity): Identity => ({
  case_id: value.case_id,
  image_sha256: value.image_sha256,
  artifact_version: value.artifact_version,
  reference_revision: value.reference_revision,
});
test.each(Object.entries(fixtures))(
  "parses actual default API %s producer",
  (_, value) => {
    const scene = parseScene(value, identity(value));
    expect(scene.current.status).toBe(value.current.status);
    if (scene.current.status === "stale")
      expect(scene.current.result).toBeNull();
  },
);
test.each([
  [
    [8, 8, 8],
    [8, 8, 8],
  ],
  [
    [8, 8, 8],
    [8 + 1e-9, 8, 8],
  ],
  [
    [8, 8, 8],
    [10009, 8, 8],
  ],
])(
  "rejects a contradictory provider path even with matching result length %j",
  (...path) => {
    const value = structuredClone(fixtures.current);
    value.current.inputs.path = path;
    value.current.result.path_length_mm = Math.hypot(
      ...path[1].map((x, i) => x - path[0][i]),
    );
    expect(() => parseScene(value, identity(value))).toThrow();
  },
);
