import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { gray, SIDE } from "./__fixtures__/overlayCase";
import fixture from "./__fixtures__/view-network-forward.json";
import {
  networkInput,
  parseViewNetwork,
  proposeViews,
  runViewNetwork,
} from "./poseInitializer";
import { vesselEvidence } from "./vesselEvidence2d";
import * as files from "./viewNetworkFile";
import {
  evidenceViews,
  forgetViewNetwork,
  VIEW_NETWORK_LATE,
  VIEW_NETWORK_TIMEOUT_MS,
  viewNetwork,
} from "./viewProposals";

const network = parseViewNetwork(
  new Uint8Array(Buffer.from(fixture.file, "base64")),
);
/** The phantom's frame: dark vessels on a lighter field. */
const frame = { gray, width: SIDE, height: SIDE };

beforeEach(() => forgetViewNetwork());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("proposes what the network says of a frame's vessel evidence", () => {
  const map = (polarity: "dark" | "bright") =>
      vesselEvidence(frame.gray, SIDE, SIDE, polarity),
    found = evidenceViews(network, map("dark"));
  expect(found).toEqual(
    proposeViews(runViewNetwork(network, networkInput(network, map("dark")))),
  );
  expect(found.length).toBeGreaterThan(0);
  expect(found.length).toBeLessThanOrEqual(5);
  // Another evidence map is another input.
  expect(networkInput(network, map("bright"))).not.toEqual(
    networkInput(network, map("dark")),
  );
});

it("fetches the network once for the page", async () => {
  const load = vi.spyOn(files, "loadViewNetwork").mockResolvedValue(network);
  await expect(viewNetwork()).resolves.toBe(network);
  await expect(viewNetwork()).resolves.toBe(network);
  expect(load).toHaveBeenCalledTimes(1);
  // The fetch is under the page's own signal.
  expect(load.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
  expect(load.mock.calls[0][0]!.aborted).toBe(false);
});

it("does not keep a fetch that failed", async () => {
  const load = vi
    .spyOn(files, "loadViewNetwork")
    .mockRejectedValueOnce(new Error(files.VIEW_NETWORK_ABSENT))
    .mockResolvedValue(network);
  await expect(viewNetwork()).rejects.toThrow(files.VIEW_NETWORK_ABSENT);
  await expect(viewNetwork()).resolves.toBe(network);
  expect(load).toHaveBeenCalledTimes(2);
});

it("gives up on a fetch that does not arrive in time, says so, and tries again when asked", async () => {
  vi.useFakeTimers();
  const stuck = (signal?: AbortSignal) =>
    new Promise<typeof network>((_, reject) =>
      signal!.addEventListener("abort", () =>
        reject(new DOMException("The operation was aborted", "AbortError")),
      ),
    );
  const load = vi
    .spyOn(files, "loadViewNetwork")
    .mockImplementationOnce(stuck)
    .mockResolvedValue(network);
  expect(VIEW_NETWORK_TIMEOUT_MS).toBe(30_000);
  const pending = viewNetwork(),
    late = expect(pending).rejects.toThrow(VIEW_NETWORK_LATE);
  await vi.advanceTimersByTimeAsync(VIEW_NETWORK_TIMEOUT_MS - 1);
  expect(load.mock.calls[0][0]!.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await late;
  expect(load.mock.calls[0][0]!.aborted).toBe(true);
  await expect(viewNetwork()).resolves.toBe(network);
  expect(load).toHaveBeenCalledTimes(2);
  // A fetch that arrived leaves no deadline running.
  expect(vi.getTimerCount()).toBe(0);
});

it("reports a fetch that failed in time as what it was", async () => {
  vi.useFakeTimers();
  vi.spyOn(files, "loadViewNetwork").mockRejectedValue(
    new Error(files.VIEW_NETWORK_UNREADABLE),
  );
  await expect(viewNetwork()).rejects.toThrow(files.VIEW_NETWORK_UNREADABLE);
  expect(vi.getTimerCount()).toBe(0);
});

it("reports what the check found as that, even when it is found after the deadline", async () => {
  vi.useFakeTimers();
  // The bytes arrived in time and fail their check just after the deadline.
  vi.spyOn(files, "loadViewNetwork").mockImplementation(
    () =>
      new Promise<typeof network>((_, reject) =>
        setTimeout(
          () => reject(new Error(files.VIEW_NETWORK_UNREADABLE)),
          VIEW_NETWORK_TIMEOUT_MS + 5,
        ),
      ),
  );
  const pending = viewNetwork(),
    refused = expect(pending).rejects.toThrow(files.VIEW_NETWORK_UNREADABLE);
  await vi.advanceTimersByTimeAsync(VIEW_NETWORK_TIMEOUT_MS + 5);
  await refused;
});

it("reports as late only the stop it made itself", async () => {
  vi.useFakeTimers();
  // Something else goes wrong just after the deadline: it is not lateness
  // and is not told from lateness by its wording.
  const other = new TypeError("Failed to fetch");
  vi.spyOn(files, "loadViewNetwork").mockImplementation(
    () =>
      new Promise<typeof network>((_, reject) =>
        setTimeout(() => reject(other), VIEW_NETWORK_TIMEOUT_MS + 5),
      ),
  );
  const pending = viewNetwork(),
    refused = expect(pending).rejects.toBe(other);
  await vi.advanceTimersByTimeAsync(VIEW_NETWORK_TIMEOUT_MS + 5);
  await refused;
});

it("reports the stop as late when the fetch rejects with the signal's own reason", async () => {
  vi.useFakeTimers();
  vi.spyOn(files, "loadViewNetwork").mockImplementation(
    (signal?: AbortSignal) =>
      new Promise<typeof network>((_, reject) =>
        signal!.addEventListener("abort", () => reject(signal!.reason)),
      ),
  );
  const pending = viewNetwork(),
    late = expect(pending).rejects.toThrow(VIEW_NETWORK_LATE);
  await vi.advanceTimersByTimeAsync(VIEW_NETWORK_TIMEOUT_MS);
  await late;
});

it("does not call an abort it did not make lateness", async () => {
  const foreign = new DOMException("The operation was aborted", "AbortError");
  vi.spyOn(files, "loadViewNetwork").mockRejectedValue(foreign);
  await expect(viewNetwork()).rejects.toBe(foreign);
});
