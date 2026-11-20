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
  viewNetwork,
} from "./viewProposals";

const network = parseViewNetwork(
  new Uint8Array(Buffer.from(fixture.file, "base64")),
);
/** The phantom's frame: dark vessels on a lighter field. */
const frame = { gray, width: SIDE, height: SIDE };

beforeEach(() => forgetViewNetwork());
afterEach(() => vi.restoreAllMocks());

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
