// Strict decoder for saved device-scenario envelopes served by the
// planner device-scenario API. Mirrors planner/device_scenarios.py
// exactwire contracts; throws on malformed or incoherent data instead
// of silently filtering. No clinical validity is inferred here.
import { validPlacement, type Placement } from "./devices/scenarios";

export type DeviceScenarioDependencyMask = {
  candidate_id: string;
  mask_sha256: string;
  segmentation_revision: number;
};

export type DeviceScenarioDependencies = {
  case_id: string;
  image_sha256: string;
  artifact_version: string;
  source_revision: string;
  operator_sha256: string;
  masks: { vessel: DeviceScenarioDependencyMask; aneurysm: DeviceScenarioDependencyMask };
  calculation_version: "native-mask-operator-plane-v1";
};

export type DeviceScenarioEntry = {
  id: string;
  name: string;
  placement: Placement;
};

export type DeviceScenarioCurrentNotComputed = { status: "not_computed" };
export type DeviceScenarioCurrentStale = {
  status: "stale";
  set_id: string;
  scenarios: null;
  stale_reasons: ["device_scenario_identity_changed" | "device_scenario_dependencies_changed"];
};
export type DeviceScenarioCurrentCurrent = {
  status: "current";
  set_id: string;
  dependencies: DeviceScenarioDependencies;
  scenarios_sha256: string;
  scenarios: DeviceScenarioEntry[];
};
export type DeviceScenarioCurrent =
  | DeviceScenarioCurrentNotComputed
  | DeviceScenarioCurrentStale
  | DeviceScenarioCurrentCurrent;

export type DeviceScenarioEnvelope = {
  case_id: string;
  image_sha256: string;
  artifact_version: string;
  reference_revision: string;
  geometry_result_id: string;
  catalog_version: string;
  scenario_revision: number;
  current: DeviceScenarioCurrent;
};

export type DeviceScenarioBinding = {
  case_id: string;
  image_sha256: string;
  artifact_version: string;
  reference_revision: string;
  geometry_result_id: string;
  catalog_version: string;
};

const _MAX_TEXT_ID = 100;
const _MAX_COORDINATE_TRIPLES = 2048;
const _MAX_BATCH = 12;
const _MAX_SCENARIO_BYTES = 128 * 1024;
const _SHA_PATTERN = /^[a-f0-9]{64}$/;
const _ID_PATTERN = /^[A-Za-z0-9_-]{10,80}$/;
const _VERSION_PATTERN = /^[1-9][0-9]{0,19}$/;
const _CONTROL_PATTERN = /[\x00-\x1f\x7f]/;
const _STALE_REASONS = new Set([
  "device_scenario_identity_changed",
  "device_scenario_dependencies_changed",
]);

function fail(message: string): never {
  throw new Error(`deviceScenarios: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function ownKeys(value: Record<string, unknown>): string[] {
  return Object.getOwnPropertyNames(value);
}

/** Deep independent parse: only plain data, finite numbers, no aliases,
 * no prototype pollution. Raw JSON key handling follows JSON.parse. */
function deepParse(value: unknown, depth = 0): unknown {
  if (depth > 64) fail("JSON nesting too deep");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("JSON contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return Array.from(value, (v) => deepParse(v, depth + 1));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of ownKeys(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        fail(`JSON object contains forbidden key ${key}`);
      }
      out[key] = deepParse(value[key], depth + 1);
    }
    return out;
  }
  fail("JSON contains a non-plain value");
}

/** Parse a raw payload (string or pre-parsed value) into plain finite
 * JSON with no retained aliases. */
export function parseScenarioJson(raw: unknown): unknown {
  if (typeof raw === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      fail(`invalid JSON: ${(error as Error).message}`);
    }
    return deepParse(parsed);
  }
  return deepParse(raw);
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  const present = ownKeys(value).sort();
  const expected = [...keys].sort();
  if (
    present.length !== expected.length ||
    present.some((key, index) => key !== expected[index])
  ) {
    fail(`${label} must have exactly keys ${keys.join(", ")}`);
  }
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function boundedText(value: unknown, label: string): string {
  const out = text(value, label);
  if (out.length > _MAX_TEXT_ID) fail(`${label} is too long`);
  return out;
}

function sha64(value: unknown, label: string): string {
  const out = text(value, label);
  if (_SHA_PATTERN.test(out) === false) {
    fail(`${label} must be lowercase 64-hex`);
  }
  return out;
}

function positiveInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail(`${label} must be a positive integer`);
  }
  return value;
}

function sameToken(actual: unknown, expected: string, label: string): void {
  if (actual !== expected) fail(`${label} does not match the expected binding`);
}

function validateDependencyMask(
  value: unknown,
  label: string,
): DeviceScenarioDependencyMask {
  const mask = exactObject(
    value,
    ["candidate_id", "mask_sha256", "segmentation_revision"],
    label,
  );
  return {
    candidate_id: boundedText(mask.candidate_id, `${label}.candidate_id`),
    mask_sha256: sha64(mask.mask_sha256, `${label}.mask_sha256`),
    segmentation_revision: positiveInt(
      mask.segmentation_revision,
      `${label}.segmentation_revision`,
    ),
  };
}

function validateDependencies(
  value: unknown,
  envelope: Record<string, unknown>,
): DeviceScenarioDependencies {
  const deps = exactObject(
    value,
    [
      "case_id",
      "image_sha256",
      "artifact_version",
      "source_revision",
      "operator_sha256",
      "masks",
      "calculation_version",
    ],
    "current.dependencies",
  );
  sameToken(deps.case_id, envelope.case_id as string, "dependencies.case_id");
  sameToken(
    deps.image_sha256,
    envelope.image_sha256 as string,
    "dependencies.image_sha256",
  );
  sameToken(
    deps.artifact_version,
    envelope.artifact_version as string,
    "dependencies.artifact_version",
  );
  sameToken(
    deps.source_revision,
    envelope.reference_revision as string,
    "dependencies.source_revision",
  );
  sha64(deps.operator_sha256, "dependencies.operator_sha256");
  if (deps.calculation_version !== "native-mask-operator-plane-v1") {
    fail("dependencies.calculation_version must be native-mask-operator-plane-v1");
  }
  const masks = exactObject(deps.masks, ["vessel", "aneurysm"], "dependencies.masks");
  return {
    case_id: deps.case_id as string,
    image_sha256: deps.image_sha256 as string,
    artifact_version: deps.artifact_version as string,
    source_revision: deps.source_revision as string,
    operator_sha256: deps.operator_sha256 as string,
    masks: {
      vessel: validateDependencyMask(masks.vessel, "dependencies.masks.vessel"),
      aneurysm: validateDependencyMask(masks.aneurysm, "dependencies.masks.aneurysm"),
    },
    calculation_version: "native-mask-operator-plane-v1",
  };
}

const REQUIRED_PLACEMENT_KEYS = [
  "deviceId",
  "diameter",
  "length",
  "height",
  "center",
  "axis",
  "path",
  "offset",
  "roll",
  "coilLength",
] as const;

function validatePlacement(value: unknown): Placement {
  if (!isPlainObject(value)) fail("placement must be an object");
  const present = ownKeys(value);
  const required = new Set<string>(REQUIRED_PLACEMENT_KEYS);
  for (const key of present) {
    if (key !== "braidAngle" && !required.has(key)) {
      fail(`placement has unexpected key ${key}`);
    }
    required.delete(key);
  }
  if (required.size > 0) {
    fail(`placement is missing required keys ${[...required].join(", ")}`);
  }
  if (!validPlacement(value) || value.deviceId.length === 0) fail("placement is invalid");
  return value as Placement;
}

function validateScenarios(value: unknown): DeviceScenarioEntry[] {
  if (!Array.isArray(value)) fail("current.scenarios must be a list");
  if (value.length > _MAX_BATCH) {
    fail(`at most ${_MAX_BATCH} scenarios per batch`);
  }
  const seen = new Set<string>();
  let tripleCount = 0;
  const entries: DeviceScenarioEntry[] = [];
  for (const raw of value) {
    const entry = exactObject(raw, ["id", "name", "placement"], "scenario");
    const id = text(entry.id, "scenario.id");
    if (_ID_PATTERN.test(id) === false) {
      fail("scenario id must match [A-Za-z0-9_-]{10,80}");
    }
    if (seen.has(id)) fail("scenario ids must be unique per batch");
    seen.add(id);
    const name = text(entry.name, "scenario.name");
    if (Array.from(name).length > 80) fail("scenario name must be 1..80 characters");
    if (_CONTROL_PATTERN.test(name)) {
      fail("scenario name must not contain control characters");
    }
    const placement = validatePlacement(entry.placement);
    tripleCount += 2 + placement.path.length;
    entries.push({ id, name, placement });
  }
  if (tripleCount > _MAX_COORDINATE_TRIPLES) {
    fail(`at most ${_MAX_COORDINATE_TRIPLES} coordinate triples per batch`);
  }
  const payload = JSON.stringify(entries);
  if (new TextEncoder().encode(payload).byteLength > _MAX_SCENARIO_BYTES) {
    fail(`scenarios exceed ${_MAX_SCENARIO_BYTES / 1024}KiB`);
  }
  return entries;
}

function parseCurrent(
  value: unknown,
  envelope: Record<string, unknown>,
): DeviceScenarioCurrent {
  if (!isPlainObject(value)) fail("current must be an object");
  const status = value.status;
  if (status === "not_computed") {
    exactObject(value, ["status"], "current");
    if (envelope.scenario_revision !== 0) {
      fail("not_computed requires scenario_revision 0");
    }
    return { status: "not_computed" };
  }
  if (status === "stale") {
    exactObject(
      value,
      ["status", "set_id", "scenarios", "stale_reasons"],
      "current",
    );
    if (value.scenarios !== null) fail("stale requires scenarios null");
    const reasons = value.stale_reasons;
    if (
      !Array.isArray(reasons) ||
      reasons.length !== 1 ||
      typeof reasons[0] !== "string" ||
      !_STALE_REASONS.has(reasons[0])
    ) {
      fail("stale_reasons must be a single recognized reason");
    }
    if (
      typeof envelope.scenario_revision !== "number" ||
      envelope.scenario_revision <= 0
    ) {
      fail("stale requires a positive scenario_revision");
    }
    return {
      status: "stale",
      set_id: boundedText(value.set_id, "current.set_id"),
      scenarios: null,
      stale_reasons: [
        reasons[0] as "device_scenario_identity_changed" | "device_scenario_dependencies_changed",
      ],
    };
  }
  if (status === "current") {
    exactObject(
      value,
      ["status", "set_id", "dependencies", "scenarios_sha256", "scenarios"],
      "current",
    );
    if (
      typeof envelope.scenario_revision !== "number" ||
      envelope.scenario_revision <= 0
    ) {
      fail("current requires a positive scenario_revision");
    }
    const scenarios = validateScenarios(value.scenarios);
    return {
      status: "current",
      set_id: boundedText(value.set_id, "current.set_id"),
      dependencies: validateDependencies(value.dependencies, envelope),
      scenarios_sha256: sha64(value.scenarios_sha256, "current.scenarios_sha256"),
      scenarios,
    };
  }
  fail("current.status must be not_computed, stale or current");
}

export function parseDeviceScenarios(
  raw: unknown,
  binding: DeviceScenarioBinding,
): DeviceScenarioEnvelope {
  const data = parseScenarioJson(raw);
  const envelope = exactObject(
    data,
    [
      "case_id",
      "image_sha256",
      "artifact_version",
      "reference_revision",
      "geometry_result_id",
      "catalog_version",
      "current",
      "scenario_revision",
    ],
    "envelope",
  );
  sameToken(envelope.case_id, binding.case_id, "case_id");
  sameToken(envelope.image_sha256, binding.image_sha256, "image_sha256");
  sameToken(
    envelope.artifact_version,
    binding.artifact_version,
    "artifact_version",
  );
  sameToken(
    envelope.reference_revision,
    binding.reference_revision,
    "reference_revision",
  );
  sameToken(
    envelope.geometry_result_id,
    binding.geometry_result_id,
    "geometry_result_id",
  );
  sameToken(envelope.catalog_version, binding.catalog_version, "catalog_version");
  sha64(envelope.image_sha256, "image_sha256");
  sha64(envelope.reference_revision, "reference_revision");
  sha64(envelope.catalog_version, "catalog_version");
  if (
    typeof envelope.artifact_version !== "string" ||
    _VERSION_PATTERN.test(envelope.artifact_version) === false
  ) {
    fail("artifact_version must be a bounded positive numeric string");
  }
  boundedText(envelope.case_id, "case_id");
  boundedText(envelope.geometry_result_id, "geometry_result_id");
  if (
    typeof envelope.scenario_revision !== "number" ||
    !Number.isSafeInteger(envelope.scenario_revision) ||
    envelope.scenario_revision < 0
  ) {
    fail("scenario_revision must be a non-negative integer");
  }
  return {
    case_id: envelope.case_id as string,
    image_sha256: envelope.image_sha256 as string,
    artifact_version: envelope.artifact_version as string,
    reference_revision: envelope.reference_revision as string,
    geometry_result_id: envelope.geometry_result_id as string,
    catalog_version: envelope.catalog_version as string,
    scenario_revision: envelope.scenario_revision as number,
    current: parseCurrent(envelope.current, envelope),
  };
}
