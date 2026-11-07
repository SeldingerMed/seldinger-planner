import { sha256 } from "@noble/hashes/sha2.js";
/** Integrity hashing also works on an IP-address HTTP origin inside the tailnet.
 * This is not a substitute for transport authentication or permission checks.
 */
export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = globalThis.crypto?.subtle
    ? new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", buffer))
    : sha256(new Uint8Array(buffer));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
export function newRandomId(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  b[6] = (b[6] & 15) | 64;
  b[8] = (b[8] & 63) | 128;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
