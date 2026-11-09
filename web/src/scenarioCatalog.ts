import authoredCatalogRaw from "./devices/catalog.json?raw";
import { DEVICE_CATALOG } from "./devices/analysis";
import { sha256Hex } from "./browserCrypto";

/**
 * Frontend authored-catalogue handshake.
 *
 * The browser binds the exact bundled authored catalog bytes via the
 * visualization `source_sha256`. The root `catalog_version` is the server's
 * combined canonical hash (computed over Python-canonicalized catalog and rule
 * data, whose float lexemes cannot be reproduced with JS JSON.stringify), so it
 * is NOT recomputed here: it is only shape-checked as a SHA-64 hex digest and
 * returned. A differing but well-formed combined hash is the server's call to
 * reject via the scenario API binding comparison.
 *
 * The base catalog's sizing rules are intentionally treated as opaque and
 * extensible: only the owned provenance/metadata envelope is strictly
 * validated, not the clinical rules content.
 */

const DEFAULT_ROOT_KEYS: readonly string[] = [
  "authored_catalog",
  "catalog_version",
  "clinical_suitability_established",
  "device_checks_version",
  "pipeline",
  "procedural_model_version",
  "rules",
  "validated_sizing",
  "version_basis",
  "visualization",
  "web"
];

const EXPECTED_MODEL_VERSION = "procedural-device-v2";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  if (Object.keys(value).length !== expected.size) return false;
  for (const key of expected) {
    if (!(key in value)) return false;
  }
  return true;
}

function isSha64Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function structurallyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => structurallyEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    return (
      aKeys.length === Object.keys(b).length &&
      aKeys.every((key) => key in b && structurallyEqual(a[key], b[key]))
    );
  }
  return false;
}

/**
 * Validate the authored-catalogue handshake of a scenario-catalog payload and
 * return its combined catalog SHA-64 (the root `catalog_version`).
 */
export async function verifyScenarioCatalog(raw: unknown): Promise<string> {
  if (!isPlainObject(raw)) {
    throw new Error("scenario catalog: payload is not an object");
  }

  // Closed owned metadata envelope, derived from the actual default fixture.
  const rootKeys = Object.keys(raw);
  if (
    rootKeys.length !== DEFAULT_ROOT_KEYS.length ||
    !DEFAULT_ROOT_KEYS.every((key) => key in raw)
  ) {
    throw new Error("scenario catalog: unexpected root metadata key set");
  }

  if (raw.clinical_suitability_established !== false) {
    throw new Error("scenario catalog: clinical_suitability_established must be false");
  }
  if (raw.validated_sizing !== false) {
    throw new Error("scenario catalog: validated_sizing must be false");
  }
  if (raw.procedural_model_version !== EXPECTED_MODEL_VERSION) {
    throw new Error("scenario catalog: unexpected procedural model version");
  }
  if (!isSha64Hex(raw.catalog_version)) {
    throw new Error("scenario catalog: catalog_version is not a SHA-64 hex digest");
  }

  const visualization = raw.visualization;
  if (
    !isPlainObject(visualization) ||
    !hasExactKeys(visualization, [
      "catalog_version",
      "source_sha256",
      "procedural_model_version",
    ])
  ) {
    throw new Error("scenario catalog: invalid visualization metadata shape");
  }
  if (visualization.procedural_model_version !== EXPECTED_MODEL_VERSION) {
    throw new Error("scenario catalog: visualization model version mismatch");
  }

  const authored = raw.authored_catalog;
  if (
    !isPlainObject(authored) ||
    !hasExactKeys(authored, ["catalog_version", "source_sha256", "devices"])
  ) {
    throw new Error("scenario catalog: invalid authored catalog shape");
  }

  // Both headers must equal the bundled authored catalog version, and both
  // source hashes must equal the hash of the exact bundled catalog bytes.
  const bundledCatalogVersion = DEVICE_CATALOG.catalogVersion;
  const authoredBytes = new TextEncoder().encode(authoredCatalogRaw);
  const bundledSourceSha = await sha256Hex(authoredBytes.buffer.slice(authoredBytes.byteOffset, authoredBytes.byteOffset + authoredBytes.byteLength) as ArrayBuffer);
  if (authored.catalog_version !== bundledCatalogVersion) {
    throw new Error("scenario catalog: authored header does not match bundled catalog");
  }
  if (visualization.catalog_version !== bundledCatalogVersion) {
    throw new Error("scenario catalog: visualization header does not match authored header");
  }
  if (authored.source_sha256 !== bundledSourceSha) {
    throw new Error("scenario catalog: authored source hash does not match bundled bytes");
  }
  if (visualization.source_sha256 !== bundledSourceSha) {
    throw new Error("scenario catalog: visualization source hash does not match bundled bytes");
  }

  // Authored devices must structurally equal the devices parsed from the
  // bundled catalog bytes.
  let bundledDevices: unknown;
  try {
    bundledDevices = (JSON.parse(authoredCatalogRaw) as { devices: unknown }).devices;
  } catch {
    throw new Error("scenario catalog: bundled catalog bytes are not valid JSON");
  }
  if (!Array.isArray(authored.devices) || !structurallyEqual(authored.devices, bundledDevices)) {
    throw new Error("scenario catalog: authored devices do not match bundled catalog");
  }

  return raw.catalog_version;
}
