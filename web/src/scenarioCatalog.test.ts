import { describe, expect, it } from "vitest";
import catalogRaw from "./devices/catalog.json?raw";
import { verifyScenarioCatalog } from "./scenarioCatalog";
import fixtureJson from "./fixtures/phase5-device-scenario-catalog.json";

const COMBINED_HASH = "e013eb679aa7efdbe8787c280bb2d40ddf9ffa035e93bc54f138c32f4d62a6bd";
const VISUAL_SHA = "76ea92e09c07f6cd28c0f98bab6826920c93aceb95565569afbcdcc1163234e3";
const VISUAL_HEADER = "device-appearance-research-2026-11-04-v2";
const MODEL_VERSION = "procedural-device-v2";

const fixture = fixtureJson as unknown;

function clone(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

async function expectRejected(raw: unknown): Promise<void> {
  await expect(verifyScenarioCatalog(raw)).rejects.toThrow(/scenario catalog/i);
}

describe("verifyScenarioCatalog", () => {
  it("accepts the actual default API fixture and returns the combined catalog SHA-64", async () => {
    await expect(verifyScenarioCatalog(fixture)).resolves.toBe(COMBINED_HASH);
  });

  it("hashes the bundled authored catalog bytes with real WebCrypto", async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(catalogRaw));
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe(VISUAL_SHA);
  });

  it("rejects unknown owned root keys", async () => {
    const raw = clone(fixture) as Record<string, unknown>;
    raw.extra_field = "injected";
    await expectRejected(raw);
  });

  it("rejects missing owned root keys", async () => {
    const raw = clone(fixture) as Record<string, unknown>;
    delete raw.device_checks_version;
    await expectRejected(raw);
  });

  it("rejects set clinical-suitability policy flag", async () => {
    const raw = clone(fixture) as Record<string, unknown>;
    raw.clinical_suitability_established = true;
    await expectRejected(raw);
  });

  it("rejects set validated-sizing policy flag", async () => {
    const raw = clone(fixture) as Record<string, unknown>;
    raw.validated_sizing = true;
    await expectRejected(raw);
  });

  it("rejects visualization header mismatch with authored header", async () => {
    const raw = clone(fixture) as Record<string, unknown>;
    const visualization = raw.visualization as Record<string, unknown>;
    visualization.catalog_version = "device-appearance-research-2026-01-01-v1";
    await expectRejected(raw);
  });

  it("rejects visualization source hash mismatch", async () => {
    const raw = clone(fixture) as Record<string, unknown>;
    const visualization = raw.visualization as Record<string, unknown>;
    visualization.source_sha256 = "0".repeat(64);
    await expectRejected(raw);
  });

  it("rejects visualization model-version mismatch", async () => {
    const raw = clone(fixture) as Record<string, unknown>;
    const visualization = raw.visualization as Record<string, unknown>;
    visualization.procedural_model_version = "procedural-device-v1";
    await expectRejected(raw);
  });

  it("rejects extra keys in the visualization block", async () => {
    const raw = clone(fixture) as Record<string, unknown>;
    raw.visualization = { ...(raw.visualization as object), note: "extra" };
    await expectRejected(raw);
  });

  it("rejects extra keys in the authored catalog block", async () => {
    const raw = clone(fixture) as Record<string, unknown>;
    raw.authored_catalog = { ...(raw.authored_catalog as object), revision: 2 };
    await expectRejected(raw);
  });

  it("rejects authored devices that do not match the bundled catalog bytes", async () => {
    const raw = clone(fixture) as Record<string, unknown>;
    const authored = raw.authored_catalog as Record<string, unknown>;
    const devices = authored.devices as { device_id: string }[];
    devices[0] = { ...devices[0], device_id: "tampered-device" };
    await expectRejected(raw);
  });

  it("rejects authored devices count mismatch", async () => {
    const raw = clone(fixture) as Record<string, unknown>;
    const authored = raw.authored_catalog as Record<string, unknown>;
    authored.devices = (authored.devices as unknown[]).slice(0, 9);
    await expectRejected(raw);
  });

  it("rejects authored source hash that is not the bundled catalog byte hash", async () => {
    const raw = clone(fixture) as Record<string, unknown>;
    const authored = raw.authored_catalog as Record<string, unknown>;
    authored.source_sha256 = VISUAL_SHA.slice(0, 63) + "0";
    await expectRejected(raw);
  });

  it("rejects a combined catalog version that is not a SHA-64 hex digest", async () => {
    const raw = clone(fixture) as Record<string, unknown>;
    raw.catalog_version = "not-a-hash";
    await expectRejected(raw);
  });

  it("rejects uppercase combined catalog versions", async () => {
    const raw = clone(fixture) as Record<string, unknown>;
    raw.catalog_version = COMBINED_HASH.toUpperCase();
    await expectRejected(raw);
  });

  it("rejects top-level procedural model version mismatch", async () => {
    const raw = clone(fixture) as Record<string, unknown>;
    raw.procedural_model_version = "procedural-device-v3";
    await expectRejected(raw);
  });

  it("rejects adversarial non-object inputs", async () => {
    await expectRejected(null);
    await expectRejected(undefined);
    await expectRejected("catalog");
    await expectRejected(42);
    await expectRejected([]);
    await expectRejected([fixture]);
  });
});
