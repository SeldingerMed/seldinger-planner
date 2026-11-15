import { expect, it } from "vitest";
import {
  pairGray,
  pairTruth,
  phantom,
  pivot,
  SIDE,
  VIEW,
  VIEW_B,
} from "./__fixtures__/overlayCase";
import { vesselTarget } from "./vesselness2d";
import { vesselPresence } from "./vesselPresence";
import { createPresenceJob, type PresenceJobInput } from "./vesselPresenceJob";
import { vesselSegments } from "./vesselSegments";

const input: PresenceJobInput = {
  mask: phantom.mask,
  shape: phantom.shape,
  affine: phantom.affine,
  matrix: pairTruth,
  isocenter: pivot,
  planes: [VIEW, VIEW_B].map((view, k) => ({
    frame: { gray: pairGray[k], width: SIDE, height: SIDE },
    view,
    polarity: "dark" as const,
    sensitivity: k ? 0.35 : 0.5,
  })),
};

it("gives the result of the three steps run one after another, however it is sliced", () => {
  const segments = vesselSegments(phantom.mask, phantom.shape, phantom.affine),
    targets = input.planes.map((plane) =>
      vesselTarget(
        pairGray[plane.view === VIEW ? 0 : 1],
        SIDE,
        SIDE,
        "dark",
        plane.sensitivity,
      ),
    ),
    presence = vesselPresence({
      segments,
      isocenter: pivot,
      matrix: pairTruth,
      planes: input.planes.map((plane, k) => ({
        view: plane.view,
        frame: { width: SIDE, height: SIDE },
        target: targets[k],
      })),
    });
  // One step per call, then all at once.
  const sliced = createPresenceJob(input);
  let calls = 0;
  expect(() => sliced.result()).toThrow();
  while (!sliced.advance(() => true)) calls++;
  expect(calls).toBeGreaterThan(3);
  const whole = createPresenceJob(input);
  expect(whole.advance(() => false)).toBe(true);
  for (const job of [sliced, whole]) {
    const found = job.result();
    expect(found.segments).toEqual(segments);
    expect(found.targets).toEqual(targets);
    expect(found.presence).toEqual(presence);
    expect(found.presence.planes).toHaveLength(2);
  }
  // A finished job stays finished.
  expect(sliced.advance(() => true)).toBe(true);
});

it("throws the same failure again on every later call", () => {
  const job = createPresenceJob({
    ...input,
    planes: [
      {
        ...input.planes[0],
        frame: {
          gray: new Uint8Array(SIDE * SIDE).fill(128),
          width: SIDE,
          height: SIDE,
        },
      },
    ],
  });
  const message = /No line-like vessels were found/;
  expect(() => job.advance(() => false)).toThrow(message);
  expect(() => job.advance(() => false)).toThrow(message);
  expect(() => job.result()).toThrow();
});
