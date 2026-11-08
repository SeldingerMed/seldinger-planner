/** Strict client-side parser for GET/PUT /api/cases/{id}/reformat-scene envelopes.
 * Mirrors planner/reformat_scene.py. Geometry admission stays server-authoritative;
 * this only validates the DTO before the UI renders numbers from it. */
import type { Identity } from "./territoryWorkflow";
import { record, stable } from "./territoryWorkflow";
import { validateRigid } from "./rigidFusion";

export const SCENE_VERSION = "phase4-native-scene-v1";
export type SceneSecondary = {
  source_id: string;
  image_sha256: string;
  reference_revision: string;
  secondary_to_primary_ras: number[][];
};
export type SceneInputs = {
  confirmed: true;
  path: number[][];
  secondary: SceneSecondary | null;
};
export type SceneCurrent =
  | { status: "not_confirmed" }
  | { status: "stale"; scene_id: string; inputs: null; result: null }
  | {
      status: "current";
      scene_id: string;
      dependencies: Identity & { version: string };
      input_sha256: string;
      inputs: SceneInputs;
      result: {
        version: string;
        path_source: "operator_confirmed";
        path_point_count: number;
        path_length_mm: number;
        registration_method: null | "operator_confirmed_rigid_ras";
      };
    };
export type Scene = Identity & {
  scene_revision: number;
  current: SceneCurrent;
  secondary_metadata:
    | null
    | ({
        source_id: string;
        image_sha256: string;
        reference_revision: string;
        image_url: string;
      } & Record<string, unknown>);
};
const fail = (): never => {
  throw new Error("Saved scene could not be confirmed. Reload saved state.");
};
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const hex64 = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const point = (value: unknown) =>
  Array.isArray(value) &&
  value.length === 3 &&
  value.every((v) => finite(v) && Math.abs(v) <= 1e6);
const sceneId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{10,64}$/.test(value);

function inputsValid(value: unknown): value is SceneInputs {
  if (
    !record(value) ||
    value.confirmed !== true ||
    value.secondary === undefined
  )
    return false;
  if (
    !Array.isArray(value.path) ||
    value.path.length < 2 ||
    value.path.length > 128 ||
    !value.path.every(point)
  )
    return false;
  let length = 0;
  for (let i = 1; i < value.path.length; i++) {
    const p = value.path[i],
      q = value.path[i - 1];
    const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    if (d <= 1e-8) return false;
    length += d;
  }
  if (length > 10000) return false;
  const secondary = value.secondary;
  if (secondary === null) return true;
  if (!record(secondary)) return false;
  try {
    validateRigid(secondary.secondary_to_primary_ras);
  } catch {
    return false;
  }
  return (
    record(secondary) &&
    typeof secondary.source_id === "string" &&
    /^[a-z0-9][a-z0-9_-]{1,63}$/.test(secondary.source_id) &&
    hex64(secondary.image_sha256) &&
    hex64(secondary.reference_revision) &&
    validateRigid(secondary.secondary_to_primary_ras).length === 4
  );
}

function resultValid(result: unknown, inputs: SceneInputs): boolean {
  if (!record(result)) return false;
  const derived = inputs.path.reduce(
    (sum, p, i) =>
      i === 0
        ? 0
        : sum +
          Math.hypot(
            p[0] - inputs.path[i - 1][0],
            p[1] - inputs.path[i - 1][1],
            p[2] - inputs.path[i - 1][2],
          ),
    0,
  );
  return (
    result.version === SCENE_VERSION &&
    result.path_source === "operator_confirmed" &&
    Number.isSafeInteger(result.path_point_count) &&
    result.path_point_count === inputs.path.length &&
    finite(result.path_length_mm) &&
    Math.abs((result.path_length_mm as number) - derived) <=
      1e-6 + 1e-9 * Math.max(1, derived) &&
    result.registration_method ===
      (inputs.secondary === null ? null : "operator_confirmed_rigid_ras")
  );
}

function metadataValid(
  metadata: unknown,
  secondary: SceneSecondary,
): metadata is NonNullable<Scene["secondary_metadata"]> {
  if (!record(metadata)) return false;
  return (
    metadata.source_id === secondary.source_id &&
    metadata.image_sha256 === secondary.image_sha256 &&
    metadata.reference_revision === secondary.reference_revision &&
    metadata.image_url === `/api/image-sources/${secondary.source_id}/volume`
  );
}

export function parseScene(value: unknown, identity: Identity): Scene {
  if (
    !record(value) ||
    !Object.entries(identity).every(([k, v]) => value[k] === v) ||
    !Number.isSafeInteger(value.scene_revision) ||
    (value.scene_revision as number) < 0 ||
    (value.scene_revision as number) > 1e9 ||
    !record(value.current)
  )
    return fail();
  const current = value.current,
    revision = value.scene_revision as number;
  if (current.status === "not_confirmed") {
    if (revision !== 0 || Object.keys(current).length !== 1) return fail();
    if (value.secondary_metadata !== null) return fail();
    return {
      ...identity,
      scene_revision: revision,
      current: { status: "not_confirmed" },
      secondary_metadata: null,
    };
  }
  if (!sceneId(current.scene_id) || revision < 1) return fail();
  if (current.status === "stale") {
    if (current.inputs !== null || current.result !== null) return fail();
    if (value.secondary_metadata !== null) return fail();
    return {
      ...identity,
      scene_revision: revision,
      current: {
        status: "stale",
        scene_id: current.scene_id,
        inputs: null,
        result: null,
      },
      secondary_metadata: null,
    };
  }
  if (
    current.status !== "current" ||
    !record(current.dependencies) ||
    stable(current.dependencies) !==
      stable({ ...identity, version: SCENE_VERSION }) ||
    !hex64(current.input_sha256) ||
    !inputsValid(current.inputs) ||
    !record(current.result)
  )
    return fail();
  const inputs = current.inputs;
  if (!resultValid(current.result, inputs)) return fail();
  if (
    inputs.secondary !== null &&
    !metadataValid(value.secondary_metadata, inputs.secondary)
  )
    return fail();
  if (inputs.secondary === null && value.secondary_metadata !== null)
    return fail();
  return {
    ...identity,
    scene_revision: revision,
    current: current as SceneCurrent,
    secondary_metadata: value.secondary_metadata as Scene["secondary_metadata"],
  };
}
