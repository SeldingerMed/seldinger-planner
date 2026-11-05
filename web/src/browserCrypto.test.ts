import { createHash, webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { sha256Hex, newRandomId } from "./browserCrypto";
afterEach(() => vi.unstubAllGlobals());
it("verifies bytes over tailnet HTTP without requiring secure-context SubtleCrypto", async () => {
  vi.stubGlobal("crypto", {
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
  });
  for (const text of [
    "",
    "abc",
    "CTA geometry · source-bound",
    "a".repeat(1000000),
  ]) {
    const bytes = new TextEncoder().encode(text);
    expect(await sha256Hex(bytes.buffer)).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
  }
});
it("uses native SHA-256 when a secure-context implementation is available", async () => {
  const bytes = new TextEncoder().encode("native");
  const expected = createHash("sha256").update(bytes).digest();
  const digest = vi.fn(async () => Uint8Array.from(expected).buffer);
  vi.stubGlobal("crypto", { subtle: { digest } });
  expect(await sha256Hex(bytes.buffer)).toBe(expected.toString("hex"));
  expect(digest).toHaveBeenCalledWith("SHA-256", bytes.buffer);
});
it("creates random v4 identifiers without secure-context randomUUID", () => {
  vi.stubGlobal("crypto", {
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
  });
  const a = newRandomId(),
    b = newRandomId();
  expect(a).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(a).not.toBe(b);
});
