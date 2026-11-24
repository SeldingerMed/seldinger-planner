import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CINE, renderCine } from "./__fixtures__/coronaryCine";
import { pivot, truth, VIEW } from "./__fixtures__/overlayCase";
import type { VerifiedFrame } from "./projectionFrames";
import RecordingReplay, { type ReplaySource } from "./RecordingReplay";

// The synthetic cine with a known answer stands in for the recording; the
// vessels leave it in the last six frames.
const WASHOUT = [42, 43, 44, 45, 46, 47];
const { frames: CINE_FRAMES, truth: TRUTH } = renderCine({ washout: WASHOUT });
const SAVED = 12,
  SIDE = CINE.size,
  FRAMES = CINE.frames,
  SECONDS = (FRAMES * CINE.frame_ms) / 1000;

// The saved proposal's axis falls on the saved frame where the synthetic
// vessels lie at that frame: the overlay's placing is not what is tested.
vi.mock("./replayOverlay", async (original) => {
  const real = await original<typeof import("./replayOverlay")>();
  return {
    ...real,
    createReplayOverlay: (
      ...args: Parameters<typeof real.createReplayOverlay>
    ) => {
      const overlay = real.createReplayOverlay(...args);
      const drawn = Float32Array.from(
        TRUTH[SAVED].flatMap((b) => b.points.flat()),
      );
      return { ...overlay, pixels: () => drawn };
    },
  };
});

const saved: VerifiedFrame = {
    source_id: "s",
    manifest_revision: "r",
    plane: "single",
    index: SAVED,
    sha256: "a".repeat(64),
    width: SIDE,
    height: SIDE,
    gray: CINE_FRAMES[SAVED].pixels,
  },
  source: ReplaySource = {
    frame: saved,
    view: VIEW,
    crop: [0, 0, SIDE, SIDE],
    source: { rows: SIDE, columns: SIDE },
    redactions: [],
  },
  TABLE = new File(
    [
      "frame,frame_type,BottomLeft_1,BottomLeft_3\n" +
        Array.from(
          { length: FRAMES },
          (_, k) => `${k},Cine,cm17,"LAO 30°/CRAN 20°"`,
        ).join("\n"),
    ],
    "frames.csv",
    { type: "text/csv" },
  ),
  RECORDING = new File(["video"], "cine.mp4", { type: "video/mp4" });

let video: { time: number; paused: boolean; stalls: boolean },
  marks: number[][],
  seeks: number;

/** The frame the stand-in recording shows at its time. */
const frameNow = () =>
  Math.min(FRAMES - 1, Math.floor((video.time * FRAMES) / SECONDS + 0.01));

beforeEach(() => {
  video = { time: 0, paused: true, stalls: false };
  marks = [];
  seeks = 0;
  const media = HTMLVideoElement.prototype as unknown as Record<
    string,
    unknown
  >;
  for (const [name, get, set] of [
    ["duration", () => SECONDS],
    ["videoWidth", () => SIDE],
    ["videoHeight", () => SIDE],
    ["paused", () => video.paused],
    ["seeking", () => false],
    ["readyState", () => 4],
    [
      "currentTime",
      () => video.time,
      function (this: HTMLVideoElement, value: number) {
        video.time = value;
        seeks++;
        // The picture is there at once; the seek ends after this turn,
        // unless the recording stalls.
        if (!video.stalls)
          queueMicrotask(() => this.dispatchEvent(new Event("seeked")));
      },
    ],
  ] as [string, () => unknown, ((value: number) => void)?][])
    Object.defineProperty(media, name, { configurable: true, get, set });
  media.play = function (this: HTMLMediaElement) {
    video.paused = false;
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  };
  media.pause = function (this: HTMLMediaElement) {
    video.paused = true;
    this.dispatchEvent(new Event("pause"));
  };
  media.requestVideoFrameCallback = () => 1;
  media.cancelVideoFrameCallback = () => {};
  let style = "";
  const context = {
    get fillStyle() {
      return style;
    },
    set fillStyle(value: string) {
      style = value;
    },
    drawImage: () => {
      marks = [];
    },
    fillRect: (...numbers: number[]) => marks.push(numbers),
    getImageData: () => ({
      data: Uint8ClampedArray.from(
        Array.from(CINE_FRAMES[frameNow()].pixels).flatMap((v) => [
          v,
          v,
          v,
          255,
        ]),
      ),
    }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  URL.createObjectURL = vi.fn(() => "blob:cine");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const button = (name: string) =>
    screen.getByRole("button", { name }) as HTMLButtonElement,
  element = () => document.querySelector("video") as HTMLVideoElement,
  frameText = () =>
    screen.getByRole("status", { name: "Replayed frame" }).textContent;

async function ready(planes: ReplaySource[] = [source]) {
  render(
    <RecordingReplay
      planes={planes}
      isocenter={pivot}
      matrix={truth}
      points={Float32Array.from([0, 0, 0, 1, 1, 1])}
      disabled={false}
    />,
  );
  fireEvent.change(screen.getByLabelText("Recording"), {
    target: { files: [RECORDING] },
  });
  fireEvent.change(screen.getByLabelText("Frame table"), {
    target: { files: [TABLE] },
  });
  fireEvent(element(), new Event("loadedmetadata"));
  await waitFor(() => expect(button("Play").disabled).toBe(false));
}

/** Mean distance from each drawn mark to the true vessels at a frame. */
function offTruth(frame: number) {
  const centres = marks.map(([x, y, w, h]) => [x + w / 2, y + h / 2]);
  expect(centres.length).toBeGreaterThan(20);
  const segment = (p: number[], a: number[], b: number[]) => {
    const dx = b[0] - a[0],
      dy = b[1] - a[1],
      t = Math.max(
        0,
        Math.min(
          1,
          ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy),
        ),
      );
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  };
  return (
    centres.reduce((s, c) => {
      let best = Infinity;
      for (const branch of TRUTH[frame])
        for (let i = 1; i < branch.points.length; i++)
          best = Math.min(
            best,
            segment(c, branch.points[i - 1], branch.points[i]),
          );
      return s + best;
    }, 0) / centres.length
  );
}

test("proposes the axis following the heart, and draws it only once confirmed", async () => {
  await ready();
  // Before: the still axis, off the vessels as the heart moves.
  video.time = (20.5 * SECONDS) / FRAMES;
  fireEvent(element(), new Event("seeked"));
  const still = offTruth(20);
  expect(still).toBeGreaterThan(1.5);

  fireEvent.click(button("Follow the heart"));
  const proposal = await screen.findByRole(
    "status",
    { name: "Heart motion proposal" },
    { timeout: 60_000 },
  );
  // Every frame of the cine was read, one seek each, and the recording
  // was taken back to the saved frame.
  expect(seeks).toBeGreaterThanOrEqual(FRAMES);
  expect(frameNow()).toBe(SAVED);
  expect(proposal.textContent).toMatch(
    /^Frames 0 to 47: the axis is followed on 41, and not found on 6, where no axis is drawn\. Heart period (7[6-9]\d|8[0-3]\d) ms; at the saved frame's phase: (\d+, ){2}\d+\.$/,
  );
  // Not confirmed: the replay still draws the still axis.
  video.time = (20.5 * SECONDS) / FRAMES;
  fireEvent(element(), new Event("seeked"));
  expect(offTruth(20)).toBeCloseTo(still, 6);
  expect(frameText()).not.toMatch(/heart/);

  fireEvent.click(button("Confirm heart motion"));
  expect(proposal.textContent).toMatch(/Confirmed\.$/);
  expect(
    screen.queryByRole("button", { name: "Confirm heart motion" }),
  ).toBeNull();
  fireEvent(element(), new Event("seeked"));
  expect(offTruth(20)).toBeLessThan(0.5 * still);
  expect(frameText()).toMatch(/· axis follows the heart$/);

  // Where the vessels have washed out, no axis is drawn.
  video.time = (44.5 * SECONDS) / FRAMES;
  fireEvent(element(), new Event("seeked"));
  expect(marks).toEqual([]);
  expect(frameText()).toMatch(/· vessels not found: no axis$/);

  // Discarded, the still axis is back.
  fireEvent.click(button("Discard heart motion"));
  video.time = (20.5 * SECONDS) / FRAMES;
  fireEvent(element(), new Event("seeked"));
  expect(offTruth(20)).toBeCloseTo(still, 6);
}, 120_000);

test("a new recording drops the proposal", async () => {
  await ready();
  fireEvent.click(button("Follow the heart"));
  await waitFor(() => screen.getByLabelText("Heart motion proposal"), {
    timeout: 60_000,
  });
  fireEvent.click(button("Confirm heart motion"));
  fireEvent.change(screen.getByLabelText("Recording"), {
    target: {
      files: [new File(["other"], "other.mp4", { type: "video/mp4" })],
    },
  });
  expect(
    screen.queryByRole("status", { name: "Heart motion proposal" }),
  ).toBeNull();
}, 120_000);

test("a new recording during the read ends it: no proposal from the old frames", async () => {
  await ready();
  fireEvent.click(button("Follow the heart"));
  await waitFor(() => expect(seeks).toBeGreaterThan(5));
  fireEvent.change(screen.getByLabelText("Recording"), {
    target: {
      files: [new File(["other"], "other.mp4", { type: "video/mp4" })],
    },
  });
  fireEvent(element(), new Event("loadedmetadata"));
  await waitFor(() => expect(button("Play").disabled).toBe(false));
  // Long enough for the old read to have finished, had it gone on.
  const settled = seeks;
  await new Promise((resolve) => setTimeout(resolve, 3000));
  expect(seeks - settled).toBeLessThan(3);
  expect(screen.queryByLabelText("Heart motion proposal")).toBeNull();
  expect(screen.queryByLabelText("Heart motion progress")).toBeNull();
}, 120_000);

test("a seek the recording never finishes fails the read and frees the controls", async () => {
  await ready();
  video.stalls = true;
  fireEvent.click(button("Follow the heart"));
  const alert = await screen.findByRole("alert", {}, { timeout: 20_000 });
  expect(alert.textContent).toBe("The recording does not reach this frame.");
  expect(button("Follow the heart").disabled).toBe(false);
}, 60_000);

test("another plane during the read ends it: no seeks after, no proposal", async () => {
  const plane = (name: "a" | "b"): ReplaySource => ({
    ...source,
    frame: { ...saved, plane: name },
  });
  await ready([plane("a"), plane("b")]);
  fireEvent.click(button("Follow the heart"));
  await waitFor(() => expect(seeks).toBeGreaterThan(5));
  fireEvent.click(screen.getByLabelText("Plane B"));
  const settled = seeks;
  await new Promise((resolve) => setTimeout(resolve, 3000));
  // Not even the old read's return to its saved frame.
  expect(seeks).toBe(settled);
  expect(screen.queryByLabelText("Heart motion proposal")).toBeNull();
  expect(screen.queryByLabelText("Heart motion progress")).toBeNull();
}, 120_000);

test("while the heart is read, playback and the frame slider wait", async () => {
  await ready();
  // The read holds at its first seek.
  video.stalls = true;
  fireEvent.click(button("Follow the heart"));
  await screen.findByLabelText("Heart motion progress");
  expect(button("Play").disabled).toBe(true);
  expect(button("Go to the saved frame").disabled).toBe(true);
  expect((screen.getByLabelText("Frame") as HTMLInputElement).disabled).toBe(
    true,
  );
  // The stalled seek fails the read, and the controls come back.
  await screen.findByRole("alert", {}, { timeout: 20_000 });
  expect(button("Play").disabled).toBe(false);
}, 60_000);
