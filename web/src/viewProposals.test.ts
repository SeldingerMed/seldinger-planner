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
  forgetViewNetwork,
  frameViews,
  proposeFrameViews,
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

it("proposes what the network says of the frame's vessel evidence", () => {
  const found = frameViews(network, frame, "dark");
  expect(found).toEqual(
    proposeViews(
      runViewNetwork(
        network,
        networkInput(network, vesselEvidence(frame.gray, SIDE, SIDE, "dark")),
      ),
    ),
  );
  expect(found.length).toBeGreaterThan(0);
  expect(found.length).toBeLessThanOrEqual(5);
  // The polarity is read: as bright vessels the frame is another input.
  const input = (polarity: "dark" | "bright") =>
    networkInput(network, vesselEvidence(frame.gray, SIDE, SIDE, polarity));
  expect(input("bright")).not.toEqual(input("dark"));
  expect(frameViews(network, frame, "bright")).toEqual(
    proposeViews(runViewNetwork(network, input("bright"))),
  );
});

it("fetches the network once and uses it for every frame", async () => {
  const load = vi.spyOn(files, "loadViewNetwork").mockResolvedValue(network);
  const first = await proposeFrameViews(frame, "dark"),
    second = await proposeFrameViews(frame, "dark");
  expect(load).toHaveBeenCalledTimes(1);
  expect(first).toEqual(frameViews(network, frame, "dark"));
  expect(second).toEqual(first);
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

it("stops before computing when it was abandoned", async () => {
  vi.spyOn(files, "loadViewNetwork").mockResolvedValue(network);
  const control = new AbortController(),
    pending = proposeFrameViews(frame, "dark", control.signal);
  control.abort();
  await expect(pending).rejects.toThrow();
});

it("a caller that gives up does not take the fetch from the next one", async () => {
  let arrive!: (value: typeof network) => void;
  const load = vi.spyOn(files, "loadViewNetwork").mockReturnValue(
    new Promise((resolve) => {
      arrive = resolve;
    }),
  );
  const first = new AbortController(),
    second = new AbortController(),
    gaveUp = proposeFrameViews(frame, "dark", first.signal),
    refused = expect(gaveUp).rejects.toThrow();
  first.abort();
  const waiting = proposeFrameViews(frame, "dark", second.signal);
  await refused;
  arrive(network);
  await expect(waiting).resolves.toEqual(frameViews(network, frame, "dark"));
  // One fetch served both, and it was neither caller's to stop.
  expect(load).toHaveBeenCalledTimes(1);
  const held = load.mock.calls[0][0];
  expect(held).toBeInstanceOf(AbortSignal);
  expect(held).not.toBe(first.signal);
  expect(held!.aborted).toBe(false);
  await expect(viewNetwork()).resolves.toBe(network);
  expect(load).toHaveBeenCalledTimes(1);
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
