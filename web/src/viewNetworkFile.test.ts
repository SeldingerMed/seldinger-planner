import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import fixture from "./__fixtures__/view-network-forward.json";
import {
  loadViewNetwork,
  VIEW_NETWORK_ABSENT,
  VIEW_NETWORK_FILE,
  VIEW_NETWORK_UNREADABLE,
} from "./viewNetworkFile";

afterEach(() => vi.unstubAllGlobals());

const file = new Uint8Array(Buffer.from(fixture.file, "base64")),
  expected = {
    size_bytes: file.byteLength,
    sha256: createHash("sha256").update(file).digest("hex"),
  };
const answer = (data: Uint8Array, status = 200) =>
  new Response(
    data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer,
    { status },
  );
function serve(response: () => Response) {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => response());
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

it("fetches the one route, uncached, and parses bytes of the fixed size and hash", async () => {
  const fetch = serve(() => answer(file)),
    control = new AbortController(),
    network = await loadViewNetwork(control.signal, expected);
  expect(network.record).toEqual({
    purpose: "forward pass fixture, random weights",
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe("/api/view-network");
  expect(fetch.mock.calls[0][1]).toEqual({
    cache: "no-store",
    signal: control.signal,
  });
});

it("says the network is not installed when the server has none", async () => {
  serve(() => new Response("{}", { status: 404 }));
  await expect(loadViewNetwork(undefined, expected)).rejects.toThrow(
    VIEW_NETWORK_ABSENT,
  );
});

it.each([
  [
    "the server refuses its own file",
    () => new Response("{}", { status: 503 }),
  ],
  ["a byte is missing", () => answer(file.slice(0, -1))],
  [
    "a byte is changed",
    () => {
      const changed = file.slice();
      changed[changed.length - 1] ^= 1;
      return answer(changed);
    },
  ],
  ["nothing is sent", () => answer(new Uint8Array(0))],
])("does not parse the bytes when %s", async (_name, response) => {
  serve(response);
  await expect(loadViewNetwork(undefined, expected)).rejects.toThrow(
    VIEW_NETWORK_UNREADABLE,
  );
});

it("does not parse a file that is not the one fixed here, however well formed", async () => {
  // The fixture network is a valid file, and it is not the fixed one.
  serve(() => answer(file));
  await expect(loadViewNetwork()).rejects.toThrow(VIEW_NETWORK_UNREADABLE);
});

it("refuses bytes with the right size and hash that are not a network", async () => {
  const junk = new Uint8Array(64).fill(7);
  serve(() => answer(junk));
  await expect(
    loadViewNetwork(undefined, {
      size_bytes: junk.byteLength,
      sha256: createHash("sha256").update(junk).digest("hex"),
    }),
  ).rejects.toThrow(VIEW_NETWORK_UNREADABLE);
});

it("fixes one size and one lower-case SHA-256", () => {
  expect(Number.isInteger(VIEW_NETWORK_FILE.size_bytes)).toBe(true);
  expect(VIEW_NETWORK_FILE.sha256).toMatch(/^[a-f0-9]{64}$/);
});

it("does not read a body that declares another size", async () => {
  // As for an admitted frame: a declared length that is not the fixed size
  // is refused before any of the body is read.
  const read = vi.fn(async () => new ArrayBuffer(0));
  for (const declared of [file.byteLength + 1, file.byteLength - 1, 0]) {
    const response = new Response(null, {
      status: 200,
      headers: { "Content-Length": String(declared) },
    });
    response.arrayBuffer = read;
    serve(() => response);
    await expect(loadViewNetwork(undefined, expected)).rejects.toThrow(
      VIEW_NETWORK_UNREADABLE,
    );
  }
  expect(read).not.toHaveBeenCalled();
});

it("reads a body that declares the fixed size, or none", async () => {
  const declared = (length: string | null) => {
    const response = answer(file);
    if (length !== null) response.headers.set("Content-Length", length);
    return response;
  };
  serve(() => declared(String(file.byteLength)));
  await expect(loadViewNetwork(undefined, expected)).resolves.toBeTruthy();
  serve(() => declared(null));
  await expect(loadViewNetwork(undefined, expected)).resolves.toBeTruthy();
});
