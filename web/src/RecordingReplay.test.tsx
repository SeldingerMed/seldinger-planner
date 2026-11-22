import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { gray, pivot, SIDE, truth, VIEW } from "./__fixtures__/overlayCase";
import type { VerifiedFrame } from "./projectionFrames";
import { projectRegistered } from "./projectionRegistration";
import RecordingReplay, { type ReplaySource } from "./RecordingReplay";
import { REPLAY_LATENCY_METHOD } from "./replayLatency";
import { SIDECAR_LAYOUT, SIDECAR_LIMITS } from "./recordingSidecar";
import { REPLAY_OVERLAY_METHOD } from "./replayOverlay";

// The figures are worked out from every frame drawn so far: how often that is
// done is counted.
const worked = vi.hoisted(() => ({ out: 0 }));
vi.mock("./replayLatency", async (original) => {
  const real = await original<typeof import("./replayLatency")>();
  return {
    ...real,
    createLatencyLog: () => {
      const log = real.createLatencyLog();
      return {
        ...log,
        summary: () => {
          worked.out++;
          return log.summary();
        },
      };
    },
  };
});

// A recording of 300 frames in 10 s, decoded at 720 by 480; the saved frame
// is frame 12, admitted from the crop at (100, 50).
const FRAMES = 300,
  SECONDS = 10,
  size = { width: SIDE, height: SIDE },
  points = Float32Array.from([0, 0, 0, 12, -4, 9, -20, 6, 15]),
  saved: VerifiedFrame = {
    source_id: "s",
    manifest_revision: "r",
    plane: "single",
    index: 12,
    sha256: "a".repeat(64),
    ...size,
    gray,
  },
  source: ReplaySource = {
    frame: saved,
    view: VIEW,
    crop: [100, 50, SIDE, SIDE],
    source: { rows: 480, columns: 720 },
    redactions: [[110, 60, 30, 20]],
  },
  table = (angles: (k: number) => string, frames = FRAMES) =>
    new File(
      [
        "frame,frame_type,BottomLeft_1,BottomLeft_3\n" +
          Array.from(
            { length: frames },
            (_, k) =>
              `${k},${k < 100 ? "Roadmap" : "WC50"},cm32,"${angles(k)}"`,
          ).join("\n"),
      ],
      "frames.csv",
      { type: "text/csv" },
    ),
  // LAO 10 / CRAN 5 up to frame 149, then LAO 22 / CRAN 5.
  TABLE = table((k) => (k < 150 ? "LAO 10°/CRAN 5°" : "LAO 22°/CRAN 5°")),
  RECORDING = new File(["video"], "run.mp4", { type: "video/mp4" });

/** What the stand-in video element and canvas hold. */
let video: {
    time: number;
    paused: boolean;
    duration: number;
    callbacks: Map<number, VideoFrameRequestCallback>;
    next: number;
    presented: number;
    width: number;
    seeking: boolean;
    /** The media element's ready state: 2 and over has a picture. */
    state: number;
  },
  /** What reading the canvas back gives: the picture last drawn. */
  shown: Uint8Array,
  drawn: { image: number[][]; marks: number[][]; black: number[][] },
  clock: number;

beforeEach(() => {
  video = {
    time: 0,
    paused: true,
    duration: SECONDS,
    callbacks: new Map(),
    next: 1,
    presented: 0,
    width: 720,
    seeking: false,
    state: 4,
  };
  shown = gray;
  drawn = { image: [], marks: [], black: [] };
  clock = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const media = HTMLVideoElement.prototype as unknown as Record<
    string,
    unknown
  >;
  for (const [name, get, set] of [
    ["duration", () => video.duration],
    ["videoWidth", () => video.width],
    ["videoHeight", () => 480],
    ["paused", () => video.paused],
    ["seeking", () => video.seeking],
    ["readyState", () => video.state],
    [
      "currentTime",
      () => video.time,
      (value: number) => {
        video.time = value;
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
  media.requestVideoFrameCallback = (callback: VideoFrameRequestCallback) => {
    video.callbacks.set(video.next, callback);
    return video.next++;
  };
  media.cancelVideoFrameCallback = (handle: number) => {
    video.callbacks.delete(handle);
  };
  let style = "";
  const context = {
    get fillStyle() {
      return style;
    },
    set fillStyle(value: string) {
      style = value;
    },
    drawImage: (_source: unknown, ...numbers: number[]) =>
      drawn.image.push(numbers),
    fillRect: (...numbers: number[]) =>
      (style === "#000" ? drawn.black : drawn.marks).push(numbers),
    getImageData: () => ({
      data: Uint8ClampedArray.from(
        Array.from(shown).flatMap((value) => [value, value, value, 255]),
      ),
    }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  URL.createObjectURL = vi.fn(() => "blob:recording");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const element = () => document.querySelector("video") as HTMLVideoElement,
  button = (name: string | RegExp) =>
    screen.getByRole("button", { name }) as HTMLButtonElement,
  frameText = () =>
    screen.getByRole("status", { name: "Replayed frame" }).textContent,
  /** The browser presents the frame at a media time. */
  present = (frame: number, presentedMs = clock, work = 0) => {
    video.time = (frame + 0.5) / (FRAMES / SECONDS);
    video.presented++;
    const callbacks = [...video.callbacks.values()];
    video.callbacks.clear();
    drawn = { image: [], marks: [], black: [] };
    const start = clock;
    // The page's clock moves on while the frame is drawn.
    vi.spyOn(performance, "now")
      .mockImplementationOnce(() => start)
      .mockImplementation(() => (clock = start + work));
    for (const callback of callbacks)
      callback(start, {
        mediaTime: frame / (FRAMES / SECONDS),
        presentedFrames: video.presented,
        presentationTime: presentedMs,
        expectedDisplayTime: presentedMs + 10,
        width: 720,
        height: 480,
      } as VideoFrameCallbackMetadata);
  },
  open = async (
    table: File | null = TABLE,
    planes: ReplaySource[] = [source],
    disabled = false,
  ) => {
    const view = render(
      <RecordingReplay
        planes={planes}
        isocenter={pivot}
        matrix={truth}
        points={points}
        disabled={disabled}
      />,
    );
    fireEvent.change(screen.getByLabelText("Recording"), {
      target: { files: [RECORDING] },
    });
    if (table)
      fireEvent.change(screen.getByLabelText("Frame table"), {
        target: { files: [table] },
      });
    fireEvent(element(), new Event("loadedmetadata"));
    return view;
  },
  /** Opens both files and lets the check of the saved frame pass. */
  ready = async (table: File = TABLE, planes: ReplaySource[] = [source]) => {
    const view = await open(table, planes);
    await waitFor(() => expect(video.time).toBeCloseTo(12.5 / 30, 6));
    fireEvent(element(), new Event("seeked"));
    await waitFor(() => expect(button("Play").disabled).toBe(false));
    return view;
  },
  at = (view = VIEW) =>
    Array.from(projectRegistered(view, pivot, truth, points, size));

test("asks for a recording and its frame table, and replays nothing before both are open", async () => {
  await open(null);
  expect(button("Play").disabled).toBe(true);
  expect(button("Go to the saved frame").disabled).toBe(true);
  expect(element().src).toBe("blob:recording");
  expect(element().muted).toBe(true);
  expect(video.callbacks.size).toBe(0);
  expect(drawn.image).toEqual([]);
});

test("checks the recording against the saved frame before it replays", async () => {
  await open();
  // It goes to the middle of the saved frame and reads that picture.
  await waitFor(() => expect(video.time).toBeCloseTo(12.5 / 30, 6));
  expect(button("Play").disabled).toBe(true);
  shown = Uint8Array.from(gray).reverse();
  fireEvent(element(), new Event("seeked"));
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /^Frame 12 of this recording is not the saved frame \(likeness -?0\.\d\d, at least 0\.90 is needed\)\. Open the recording the frame was admitted from\.$/,
  );
  expect(button("Play").disabled).toBe(true);
  expect(video.callbacks.size).toBe(0);
  // The admitted part of the picture was drawn at the frame's size, with
  // its redaction.
  expect(drawn.image).toEqual([[100, 50, SIDE, SIDE, 0, 0, SIDE, SIDE]]);
  expect(drawn.black).toEqual([[10, 10, 30, 20]]);
  expect(drawn.marks).toEqual([]);
});

test("draws the saved proposal's axis over the saved frame once the recording is checked", async () => {
  await ready();
  expect(screen.queryByRole("alert")).toBeNull();
  const places = at();
  expect(drawn.marks).toHaveLength(points.length / 3);
  drawn.marks.forEach(([x, y, w, h], k) => {
    expect(x + w / 2).toBeCloseTo(places[2 * k], 3);
    expect(y + h / 2).toBeCloseTo(places[2 * k + 1], 3);
  });
  expect(frameText()).toBe(
    "Frame 12 of 300 · Roadmap · LAO 10° / CRAN 5° · field 32 cm · the saved frame",
  );
  expect(video.callbacks.size).toBe(1);
});

test("turns the axis with the C-arm as the recording plays, and leaves it out when asked", async () => {
  await ready();
  fireEvent.click(button("Play"));
  expect(video.paused).toBe(false);
  expect(button("Pause")).toBeTruthy();
  present(149);
  expect(drawn.image).toEqual([[100, 50, SIDE, SIDE, 0, 0, SIDE, SIDE]]);
  expect(drawn.black).toEqual([[10, 10, 30, 20]]);
  expect(drawn.marks.map(([x, , w]) => x + w / 2)[1]).toBeCloseTo(at()[2], 3);
  expect(frameText()).toBe(
    "Frame 149 of 300 · WC50 · LAO 10° / CRAN 5° · field 32 cm",
  );
  present(150);
  const turned = at({ ...VIEW, primary_deg: VIEW.primary_deg + 12 });
  drawn.marks.forEach(([x, y, w, h], k) => {
    expect(x + w / 2).toBeCloseTo(turned[2 * k], 3);
    expect(y + h / 2).toBeCloseTo(turned[2 * k + 1], 3);
  });
  expect(frameText()).toBe(
    "Frame 150 of 300 · WC50 · LAO 22° / CRAN 5° · field 32 cm",
  );
  // Every presented frame asks for the next.
  expect(video.callbacks.size).toBe(1);
  fireEvent.click(screen.getByLabelText("Vessel axis"));
  present(151);
  expect(drawn.image).toHaveLength(1);
  expect(drawn.marks).toEqual([]);
});

test("measures the latency of the stretch played, and saves the figures", async () => {
  await ready();
  expect(screen.queryByRole("table", { name: "Overlay latency" })).toBeNull();
  // A frame drawn while paused is not measured.
  present(40, clock - 500, 2);
  const slider = screen.getByLabelText("Frame") as HTMLInputElement;
  expect(slider.disabled).toBe(false);
  expect(button("Go to the saved frame").disabled).toBe(false);
  fireEvent.click(button("Play"));
  // The stretch measured is one run of play: the slider and the way back to
  // the saved frame are held during it.
  expect(slider.disabled).toBe(true);
  expect(button("Go to the saved frame").disabled).toBe(true);
  // Three frames, drawn 8, 20 and 12 ms after they were presented; the
  // browser presented two more between the second and the third.
  present(41, clock - 6, 2);
  present(42, clock - 17, 3);
  video.presented += 2;
  present(45, clock - 11, 1);
  fireEvent.click(button("Pause"));
  expect(slider.disabled).toBe(false);
  expect(button("Go to the saved frame").disabled).toBe(false);
  const cells = Array.from(
    within(screen.getByRole("table", { name: "Overlay latency" })).getAllByRole(
      "row",
    ),
    (row) => Array.from(row.querySelectorAll("th,td"), (c) => c.textContent),
  );
  expect(cells).toEqual([
    ["", "Median", "95th percentile", "Worst"],
    ["Frame presented to overlay drawn (ms)", "12.0", "20.0", "20.0"],
    ["Of that, placing and drawing (ms)", "2.0", "3.0", "3.0"],
  ]);
  expect(screen.getByRole("status", { name: "Frames drawn" }).textContent).toBe(
    "3 of the 5 frames the browser presented were drawn, frames 41 to 45.",
  );
  // Saved as a small file.
  let saved = "";
  const blobs: Blob[] = [];
  vi.mocked(URL.createObjectURL).mockImplementation((blob) => {
    blobs.push(blob as Blob);
    return "blob:figures";
  });
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      saved = `${this.download} ${this.href}`;
    });
  fireEvent.click(button("Save latency figures"));
  expect(click).toHaveBeenCalledTimes(1);
  expect(saved).toBe("replay-latency.json blob:figures");
  const text = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(blobs[0]);
  });
  expect(JSON.parse(text)).toEqual({
    method: REPLAY_LATENCY_METHOD,
    overlay_method: REPLAY_OVERLAY_METHOD,
    // The layout the frame table was read as.
    frame_table_layout: SIDECAR_LAYOUT,
    // The plane and the saved frame the figures were measured under.
    plane: "single",
    saved_frame: {
      source_id: "s",
      manifest_revision: "r",
      index: 12,
      sha256: "a".repeat(64),
    },
    recording: { frames: 300, seconds: 10, frames_per_second: 30 },
    frame_size: [SIDE, SIDE],
    axis_points: 3,
    played: { from_frame: 41, to_frame: 45 },
    frames_presented: 5,
    frames_drawn: 3,
    frames_not_drawn: 2,
    latency_ms: { median: 12, p95: 20, worst: 20 },
    work_ms: { median: 2, p95: 3, worst: 3 },
  });
  // Playing again starts the figures again.
  fireEvent.click(button("Play"));
  present(46, clock - 3, 1);
  fireEvent(element(), new Event("ended"));
  expect(screen.getByRole("status", { name: "Frames drawn" }).textContent).toBe(
    "1 of the 1 frames the browser presented were drawn, frames 46 to 46.",
  );
});

test("shows the figures again every 30 frames drawn, and works them out only then", async () => {
  await ready();
  fireEvent.click(button("Play"));
  worked.out = 0;
  for (let frame = 13; frame < 42; frame++) present(frame, clock - 5, 1);
  expect(worked.out).toBe(0);
  expect(screen.queryByRole("table", { name: "Overlay latency" })).toBeNull();
  present(42, clock - 5, 1);
  expect(worked.out).toBe(1);
  expect(
    (await screen.findByRole("status", { name: "Frames drawn" })).textContent,
  ).toBe(
    "30 of the 30 frames the browser presented were drawn, frames 13 to 42.",
  );
  for (let frame = 43; frame < 73; frame++) present(frame, clock - 5, 1);
  expect(worked.out).toBe(2);
});

test("goes to a frame by the slider and back to the saved frame", async () => {
  await ready();
  fireEvent.change(screen.getByLabelText("Frame"), {
    target: { value: "200" },
  });
  expect(video.time).toBeCloseTo(200.5 / 30, 6);
  present(200);
  expect(frameText()).toBe(
    "Frame 200 of 300 · WC50 · LAO 22° / CRAN 5° · field 32 cm",
  );
  expect((screen.getByLabelText("Frame") as HTMLInputElement).value).toBe(
    "200",
  );
  fireEvent.click(button("Go to the saved frame"));
  expect(video.time).toBeCloseTo(12.5 / 30, 6);
});

test("refuses a frame table that does not fit the recording or the saved frame", async () => {
  const view = await open(new File(["frame,kind\n0,a"], "frames.csv"));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "The frame table has no column frame_type.",
  );
  expect(button("Play").disabled).toBe(true);
  view.unmount();
  // A file with more bytes than any table within the limit can have (three
  // to a character) is refused by its size, without being read.
  const sized = (bytes: number) => {
      const file = new File(["frame"], "run.mp4");
      Object.defineProperty(file, "size", { value: bytes });
      return file;
    },
    read = vi.spyOn(FileReader.prototype, "readAsText");
  await open(sized(3 * SIDECAR_LIMITS.max_chars + 1));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "The frame table is too large.",
  );
  expect(read).not.toHaveBeenCalled();
  cleanup();
  // One of fewer bytes may be within the limit, and is read to tell.
  await open(sized(3 * SIDECAR_LIMITS.max_chars));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "The frame table is empty.",
  );
  expect(read).toHaveBeenCalledTimes(1);
  cleanup();
  // The saved frame is frame 12; this table ends at frame 9.
  await open(table(() => "0°/0°", 10));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "The saved frame is not in the recording.",
  );
});

test("says when the recording cannot be played", async () => {
  await open();
  fireEvent(element(), new Event("error"));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "The browser cannot play this recording.",
  );
  expect(button("Play").disabled).toBe(true);
});

test("says so when the file opened has no picture", async () => {
  video.width = 0;
  await open();
  expect((await screen.findByRole("alert")).textContent).toBe(
    "The browser cannot play this recording.",
  );
  expect(video.time).toBe(0);
  expect(button("Play").disabled).toBe(true);
});

test("replays the plane that is chosen, and checks the recording again for the other", async () => {
  const other: ReplaySource = {
    ...source,
    frame: { ...saved, plane: "b", index: 30 },
    view: { ...VIEW, primary_deg: VIEW.primary_deg - 90 },
  };
  await ready(TABLE, [{ ...source, frame: { ...saved, plane: "a" } }, other]);
  drawn = { image: [], marks: [], black: [] };
  fireEvent.click(screen.getByRole("radio", { name: "Plane B" }));
  expect(button("Play").disabled).toBe(true);
  await waitFor(() => expect(video.time).toBeCloseTo(30.5 / 30, 6));
  fireEvent(element(), new Event("seeked"));
  await waitFor(() => expect(button("Play").disabled).toBe(false));
  const places = at(other.view);
  expect(drawn.marks[1][0] + drawn.marks[1][2] / 2).toBeCloseTo(places[2], 3);
});

test("checks a recording that already stands at the saved frame, and passes over a seek that ended elsewhere", async () => {
  const other: ReplaySource = {
    ...source,
    frame: { ...saved, plane: "b" },
    view: { ...VIEW, primary_deg: VIEW.primary_deg - 90 },
  };
  await open(TABLE, [{ ...source, frame: { ...saved, plane: "a" } }, other]);
  await waitFor(() => expect(video.time).toBeCloseTo(12.5 / 30, 6));
  // An older seek ends at another frame: its picture is not the one to check.
  video.time = 3;
  fireEvent(element(), new Event("seeked"));
  expect(button("Play").disabled).toBe(true);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(drawn.image).toEqual([]);
  video.time = 12.5 / 30;
  fireEvent(element(), new Event("seeked"));
  await waitFor(() => expect(button("Play").disabled).toBe(false));
  // The other plane's saved frame is where the recording stands: no seek
  // ends, and the recording is checked all the same.
  drawn = { image: [], marks: [], black: [] };
  fireEvent.click(screen.getByRole("radio", { name: "Plane B" }));
  await waitFor(() => expect(button("Play").disabled).toBe(false));
  const places = at(other.view);
  expect(drawn.marks[1][0] + drawn.marks[1][2] / 2).toBeCloseTo(places[2], 3);
  // While the recording is still seeking, the check waits for the seek.
  video.seeking = true;
  fireEvent.click(screen.getByRole("radio", { name: "Plane A" }));
  expect(button("Play").disabled).toBe(true);
  // So does the end of an older seek that comes while it is under way.
  fireEvent(element(), new Event("seeked"));
  expect(button("Play").disabled).toBe(true);
  video.seeking = false;
  fireEvent(element(), new Event("seeked"));
  await waitFor(() => expect(button("Play").disabled).toBe(false));
});

test("checks the recording when its picture at the saved frame comes after the seek has ended", async () => {
  const other: ReplaySource = { ...source, frame: { ...saved, plane: "b" } };
  video.state = 1;
  await open(TABLE, [{ ...source, frame: { ...saved, plane: "a" } }, other]);
  await waitFor(() => expect(video.time).toBeCloseTo(12.5 / 30, 6));
  // The seek has ended and the picture there is not decoded yet.
  fireEvent(element(), new Event("seeked"));
  expect(button("Play").disabled).toBe(true);
  expect(drawn.image).toEqual([]);
  video.state = 2;
  fireEvent(element(), new Event("loadeddata"));
  await waitFor(() => expect(button("Play").disabled).toBe(false));
  // The same where the recording already stands at the saved frame.
  video.state = 1;
  fireEvent.click(screen.getByRole("radio", { name: "Plane B" }));
  expect(button("Play").disabled).toBe(true);
  video.state = 3;
  fireEvent(element(), new Event("canplay"));
  await waitFor(() => expect(button("Play").disabled).toBe(false));
  expect(screen.queryByRole("alert")).toBeNull();
});

test("says so when the recording cannot be taken to the saved frame", async () => {
  const other: ReplaySource = {
    ...source,
    frame: { ...saved, plane: "b", index: 30 },
  };
  await open(TABLE, [{ ...source, frame: { ...saved, plane: "a" } }, other]);
  await waitFor(() => expect(video.time).toBeCloseTo(12.5 / 30, 6));
  // The end of another seek, while one is under way, is waited out.
  video.seeking = true;
  video.time = 3;
  fireEvent(element(), new Event("seeked"));
  expect(video.time).toBe(3);
  video.seeking = false;
  // Each seek ends at another frame. The recording is taken to the saved
  // frame three times in all, and no more.
  for (const tried of [1, 2]) {
    video.time = 3;
    fireEvent(element(), new Event("seeked"));
    expect(video.time, String(tried)).toBeCloseTo(12.5 / 30, 6);
    expect(screen.queryByRole("alert")).toBeNull();
  }
  video.time = 3;
  fireEvent(element(), new Event("seeked"));
  expect(video.time).toBe(3);
  expect((await screen.findByRole("alert")).textContent).toBe(
    "The recording could not be taken to the saved frame.",
  );
  expect(button("Play").disabled).toBe(true);
  expect(screen.queryByText("Checking the recording…")).toBeNull();
  expect(drawn.image).toEqual([]);
  // Another plane is tried afresh, and is taken to its own saved frame even
  // while a seek is under way.
  video.seeking = true;
  fireEvent.click(screen.getByRole("radio", { name: "Plane B" }));
  await waitFor(() => expect(video.time).toBeCloseTo(30.5 / 30, 6));
  expect(screen.queryByRole("alert")).toBeNull();
  video.seeking = false;
  fireEvent(element(), new Event("seeked"));
  await waitFor(() => expect(button("Play").disabled).toBe(false));
  // So is the first plane with the recording opened again.
  fireEvent.click(screen.getByRole("radio", { name: "Plane A" }));
  await waitFor(() => expect(video.time).toBeCloseTo(12.5 / 30, 6));
  for (let tried = 0; tried < 3; tried++) {
    video.time = 3;
    fireEvent(element(), new Event("seeked"));
  }
  await screen.findByRole("alert");
  fireEvent.change(screen.getByLabelText("Recording"), {
    target: { files: [RECORDING] },
  });
  fireEvent(element(), new Event("loadedmetadata"));
  await waitFor(() => expect(video.time).toBeCloseTo(12.5 / 30, 6));
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent(element(), new Event("seeked"));
  await waitFor(() => expect(button("Play").disabled).toBe(false));
});

test("forgets the latency figures of one plane when the other is chosen, and leaves out a frame shown while paused", async () => {
  const other: ReplaySource = {
    ...source,
    frame: { ...saved, plane: "b", index: 30 },
  };
  await ready(TABLE, [{ ...source, frame: { ...saved, plane: "a" } }, other]);
  const rows = () =>
    within(screen.getByRole("table", { name: "Overlay latency" }))
      .getAllByRole("row")
      .map((row) => row.textContent);
  fireEvent.click(button("Play"));
  present(41, clock - 6, 2);
  fireEvent.click(button("Pause"));
  const measured = rows();
  // The slider shows another frame, and the recording is stopped once more.
  present(90, clock - 400, 1);
  fireEvent(element(), new Event("pause"));
  expect(rows()).toEqual(measured);
  fireEvent.click(button("Play"));
  present(42, clock - 6, 2);
  fireEvent.click(screen.getByRole("radio", { name: "Plane B" }));
  expect(video.paused).toBe(true);
  expect(screen.queryByRole("table", { name: "Overlay latency" })).toBeNull();
});

test("stays stopped when the browser does not start the recording", async () => {
  await ready();
  let refused = 0;
  (
    HTMLVideoElement.prototype as unknown as { play: () => Promise<void> }
  ).play = () =>
    Promise.reject(new DOMException("no", "NotAllowedError")).finally(
      () => refused++,
    );
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  fireEvent.click(button("Play"));
  await waitFor(() => expect(refused).toBe(1));
  await new Promise((done) => setTimeout(done, 0));
  process.off("unhandledRejection", unhandled);
  expect(unhandled).not.toHaveBeenCalled();
  expect(button("Play")).toBeTruthy();
});

test("stops and holds its controls while the studio is busy, and lets go of the recording when it goes", async () => {
  const view = await ready();
  fireEvent.click(button("Play"));
  view.rerender(
    <RecordingReplay
      planes={[source]}
      isocenter={pivot}
      matrix={truth}
      points={points}
      disabled
    />,
  );
  expect(video.paused).toBe(true);
  expect(button("Play").disabled).toBe(true);
  expect(
    (screen.getByLabelText("Recording") as HTMLInputElement).disabled,
  ).toBe(true);
  view.unmount();
  expect(video.callbacks.size).toBe(0);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:recording");
});
