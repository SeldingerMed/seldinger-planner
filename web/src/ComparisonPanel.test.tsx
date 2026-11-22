import { afterEach, describe, expect, it, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { renderFrame, TREE } from "./__fixtures__/angioPhantom";
import {
  binding,
  bundleAnswer,
  currentAnswer,
  gray,
  hex,
  identity,
  maskBlob,
  maskEntry,
  phantom,
  pivot,
  REVISION,
  savedInputs,
  SIDE,
  truth,
  VIEW,
} from "./__fixtures__/overlayCase";
import { axisCuts } from "./axisDiameter";
import ComparisonPanel, {
  COMPARISON_REQUEST_TIMEOUT_MS,
  framePixel,
  narrowestRows,
} from "./ComparisonPanel";
import { compareDiameters } from "./diameterComparison";
import { frameDiameters } from "./frameDiameter";
import { placedSamples } from "./framePlacement";
import { parseSavedRegistration } from "./projectionFrames";
import type { SegmentationEntry } from "./segmentation";
import { vesselSegments } from "./vesselSegments";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const FRAME = { width: SIDE, height: SIDE },
  grid = { shape: phantom.shape, affine: phantom.affine },
  segments = vesselSegments(phantom.mask, phantom.shape, phantom.affine),
  placed = placedSamples(VIEW, pivot, truth, segments.points, FRAME),
  registration = parseSavedRegistration(currentAnswer(), identity),
  /** The same proposal saved again: another registration revision. */
  later = {
    ...registration,
    registration_revision: registration.registration_revision + 1,
  },
  // A run of four frames: no contrast, the trunk alone, then the saved
  // frame with the whole tree, then the whole tree again.
  before = renderFrame(VIEW, pivot, truth, {
    ...FRAME,
    polarity: "dark",
    noise: 12,
    seed: 2,
    tree: [],
    contrast_of: TREE,
  }),
  early = renderFrame(VIEW, pivot, truth, {
    ...FRAME,
    polarity: "dark",
    noise: 12,
    seed: 3,
    tree: [TREE[0]],
    contrast_of: TREE,
  }),
  late = renderFrame(VIEW, pivot, truth, {
    ...FRAME,
    polarity: "dark",
    noise: 12,
    seed: 4,
  }),
  RUN: Record<number, Uint8Array> = { 4: before, 8: early, 12: gray, 16: late },
  // A device planned along the trunk: 20 mm, from 10 mm along it.
  trunk = TREE[0].path,
  scenarios = (current: unknown, revision = 1) => ({
    ...identity,
    geometry_result_id: "884HLtGETdmppB7wPMEqSg",
    catalog_version: "c".repeat(64),
    scenario_revision: revision,
    current,
  }),
  planned = scenarios({
    status: "current",
    set_id: "d25Yl-vBDci5Q3HzKZ0vTw",
    dependencies: {
      case_id: identity.case_id,
      image_sha256: identity.image_sha256,
      artifact_version: identity.artifact_version,
      source_revision: identity.reference_revision,
      operator_sha256: "d".repeat(64),
      masks: {
        vessel: {
          candidate_id: "wdFxcxZzfP3sASHxsnDmqw",
          mask_sha256: "c".repeat(64),
          segmentation_revision: 1,
        },
        aneurysm: {
          candidate_id: "aR9gj2VyCgkVgAQXETJsmA",
          mask_sha256: "d".repeat(64),
          segmentation_revision: 2,
        },
      },
      calculation_version: "native-mask-operator-plane-v1",
    },
    scenarios_sha256: "a".repeat(64),
    scenarios: [
      {
        id: "trunk-device-1",
        name: "Trunk device",
        placement: {
          deviceId: "surpass-elite",
          diameter: 4.5,
          length: 20,
          height: 18,
          center: [0, 0, 0],
          axis: [0, 0, 1],
          path: trunk,
          offset: 10,
          roll: 0,
          coilLength: 30,
        },
      },
      {
        id: "long-device-1",
        name: "Longer than its path",
        placement: {
          deviceId: "surpass-elite",
          diameter: 4.5,
          length: 80,
          height: 18,
          center: [0, 0, 0],
          axis: [0, 0, 1],
          path: trunk,
          offset: 0,
          roll: 0,
          coilLength: 30,
        },
      },
      {
        id: "sac-device-01",
        name: "In the sac",
        placement: {
          deviceId: "web-sl",
          diameter: 7,
          length: 5,
          height: 5,
          center: [0, 0, 0],
          axis: [0, 0, 1],
          path: trunk,
          offset: 0,
          roll: 0,
          coilLength: 30,
        },
      },
    ],
  });

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const bytes = (value: Uint8Array, headers: Record<string, string> = {}) =>
  new Response(
    value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    ) as ArrayBuffer,
    { headers },
  );
type Routes = {
  frames?: Record<number, Uint8Array>;
  /** Frames are not answered until their request is given up. */
  held?: boolean;
  devices?: () => Response;
  mask?: () => Response;
  /** A frame whose stored bytes are not the ones its manifest names. */
  spoiled?: number;
};
function server(routes: Routes = {}) {
  const frames = routes.frames ?? RUN,
    calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === `/api/cases/${identity.case_id}/device-scenarios`)
        return (routes.devices ?? (() => json(planned)))();
      if (url === maskEntry.mask_url)
        return (routes.mask ?? (() => bytes(maskBlob)))();
      if (url === "/api/projection-frames/phantom-run")
        return json(
          bundleAnswer({
            planes: [
              {
                ...bundleAnswer().manifest.planes[0],
                frames: Object.entries(frames).map(([index, one]) => ({
                  index: Number(index),
                  sha256: hex(one),
                  input_sha256: "c".repeat(64),
                })),
              },
            ],
          }),
        );
      const frame =
        /^\/api\/projection-frames\/phantom-run\/planes\/single\/frames\/(\d+)$/.exec(
          url,
        );
      if (frame && routes.held)
        return new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          ),
        );
      if (frame && Number(frame[1]) === routes.spoiled)
        return bytes(Uint8Array.from(frames[routes.spoiled]).reverse(), {
          "X-Frame-Manifest-Revision": REVISION,
        });
      if (frame)
        return bytes(frames[Number(frame[1])], {
          "X-Frame-Manifest-Revision": REVISION,
        });
      return json({}, 404);
    }),
  );
  return calls;
}
/** A canvas that draws nothing and is shown at twice the frame's size. */
function canvases() {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(
    HTMLCanvasElement.prototype,
    "getBoundingClientRect",
  ).mockReturnValue({
    left: 40,
    top: 10,
    width: 2 * SIDE,
    height: 2 * SIDE,
  } as DOMRect);
}
function Panel({
  mask = maskEntry as unknown as SegmentationEntry | null,
  disabled = false,
  saved = registration,
  onRequests,
  onComputing,
}: {
  mask?: SegmentationEntry | null;
  disabled?: boolean;
  saved?: typeof registration;
  onRequests?: (open: boolean) => void;
  onComputing?: (computing: boolean) => void;
}) {
  return (
    <ComparisonPanel
      identity={identity}
      binding={binding}
      registration={saved}
      mask={mask}
      grid={grid}
      disabled={disabled}
      onRequests={onRequests}
      onComputing={onComputing}
    />
  );
}
const button = (name: string | RegExp) =>
    screen.getByRole("button", { name }) as HTMLButtonElement,
  rows = (name: string) =>
    within(screen.getByRole("table", { name }))
      .getAllByRole("row")
      .map((row) =>
        Array.from(row.querySelectorAll("th,td")).map(
          (cell) => cell.textContent,
        ),
      ),
  compared = () =>
    waitFor(() => screen.getByRole("table", { name: "Segment comparison" }), {
      timeout: 30000,
    }),
  /** Click the frame where an axis sample lies. */
  clickSample = (k: number) =>
    fireEvent.click(screen.getByRole("img"), {
      clientX: 40 + 2 * placed.pixels[2 * k],
      clientY: 10 + 2 * placed.pixels[2 * k + 1],
    }),
  /** The axis sample nearest a point of the volume. */
  sampleAt = (p: readonly number[]) => {
    let best = 0,
      least = Infinity;
    for (let k = 0; k < segments.labels.length; k++) {
      const off = Math.hypot(
        segments.points[3 * k] - p[0],
        segments.points[3 * k + 1] - p[1],
        segments.points[3 * k + 2] - p[2],
      );
      if (off < least) {
        least = off;
        best = k;
      }
    }
    return best;
  };

describe("the narrowest places listed", () => {
  const place = (percent: number) => ({
      sample: 1,
      narrowest_mm: 4 * (1 - percent / 100),
      reference_mm: 4,
      percent,
    }),
    plane = (frame: (number | null)[], mask: (number | null)[]) => ({
      diameters: {
        segments: [],
        runs: frame.map((percent, run) => ({
          run,
          samples: 20,
          mask: mask[run] === null ? null : place(mask[run]!),
          frame: percent === null ? null : place(percent),
        })),
      },
    });
  it("puts the largest narrowing of the mask or of any frame first, and leaves out runs measured nowhere", () => {
    const mask = [10, null, 5, null],
      found = narrowestRows([
        plane([20, null, null, 30], mask),
        plane([null, null, 60, 12], mask),
      ]);
    expect(found.map((row) => row.run)).toEqual([2, 3, 0]);
    expect(found[0].mask!.percent).toBe(5);
    expect(found[0].frames.map((one) => one?.percent ?? null)).toEqual([
      null,
      60,
    ]);
    // Every run with a narrowest place is listed.
    const many = Array.from({ length: 12 }, (_, run) => 5 + run);
    expect(narrowestRows([plane(many, many)]).map((row) => row.run)).toEqual(
      many.map((_, run) => 11 - run),
    );
  });
});

describe("the pixel under a pointer", () => {
  it("scales with the size the canvas is shown at", () => {
    const box = { left: 40, top: 10, width: 600, height: 300 };
    expect(framePixel(box, { width: 300, height: 300 }, 340, 160)).toEqual({
      x: 150,
      y: 150,
    });
    expect(framePixel(box, { width: 300, height: 300 }, 39, 160)).toBeNull();
    expect(framePixel(box, { width: 300, height: 300 }, 340, 311)).toBeNull();
    expect(
      framePixel({ ...box, width: 0 }, { width: 300, height: 300 }, 340, 160),
    ).toBeNull();
  });
});

test("compares the saved proposal's frame with the mask: a row per segment with both diameters and the frame contrast arrives in", async () => {
  canvases();
  const calls = server(),
    requests: boolean[] = [],
    computing: boolean[] = [];
  render(
    <Panel
      onRequests={(open) => requests.push(open)}
      onComputing={(now) => computing.push(now)}
    />,
  );
  fireEvent.click(button("Compare 2D and 3D"));
  await compared();
  const table = rows("Segment comparison");
  expect(table[0]).toEqual([
    "Segment",
    "Length (mm)",
    "3D diameter (mm)",
    "Plane single diameter (mm)",
    "Plane single contrast arrives (frame)",
  ]);
  expect(table).toHaveLength(segments.segments.length + 1);
  // Both diameters of a trunk segment are near the 5 mm it was drawn at.
  const trunkSample = sampleAt([1, -2.5, -22]),
    row = table[segments.labels[trunkSample] + 1];
  expect(Math.abs(Number(row[2]) - 5)).toBeLessThan(0.8);
  expect(Math.abs(Number(row[3]) - 5)).toBeLessThan(0.8);
  // Each row holds the mask's diameter and the saved frame's.
  const cuts = axisCuts(phantom.mask, phantom.shape, phantom.affine, segments),
    expected = compareDiameters(
      segments,
      cuts.mm,
      frameDiameters({ ...FRAME, gray, polarity: "dark" }, placed, segments, {
        ...cuts,
        pixels: placedSamples(VIEW, pivot, truth, cuts.centers, FRAME).pixels,
      }),
    ).segments,
    said = (value: number | null) => (value === null ? "–" : value.toFixed(1));
  expected.forEach((one, index) => {
    expect(table[index + 1][2]).toBe(said(one.mask_mm));
    expect(table[index + 1][3]).toBe(said(one.frame_mm));
  });
  expect(table.some((cells) => cells[2] !== cells[3])).toBe(true);
  // Contrast reaches the trunk between the first two frames, and a branch
  // between the next two.
  expect(Number(row[4])).toBeGreaterThan(4);
  expect(Number(row[4])).toBeLessThan(8);
  const branch = table[segments.labels[sampleAt([27, 3, 18])] + 1];
  expect(Number(branch[4])).toBeGreaterThan(8);
  expect(Number(branch[4])).toBeLessThan(12);
  expect(button("Compare again").disabled).toBe(false);
  // Every frame of the plane was read, and nothing was sent.
  expect(calls.filter((call) => call.includes("/frames/"))).toHaveLength(4);
  expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
  expect(requests.at(-1)).toBe(false);
  expect(requests).toContain(true);
  expect(computing).toContain(true);
  expect(computing.at(-1)).toBe(false);
}, 60000);

test("carries a clicked place to the 3D model, and measures a planned device against its two marked ends", async () => {
  canvases();
  server();
  render(<Panel />);
  fireEvent.click(button("Compare 2D and 3D"));
  await compared();
  const k = sampleAt([27, 3, 18]);
  clickSample(k);
  const said = screen.getByRole("status", {
    name: "Carried place",
  }).textContent!;
  expect(said).toContain(`Segment ${segments.labels[k] + 1},`);
  expect(said).toContain(
    `R ${segments.points[3 * k].toFixed(1)}, A ${segments.points[3 * k + 1].toFixed(1)}, S ${segments.points[3 * k + 2].toFixed(1)} mm`,
  );
  // Only the device that lies along a vessel is offered.
  expect(
    within(screen.getByRole("combobox", { name: /Planned device/ }))
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["Trunk device"]);
  expect(
    screen.queryByRole("table", { name: /Planned and deployed/ }),
  ).toBeNull();
  // The ends are marked 4 mm late and 2 mm short along the trunk, whose
  // first leg is 25.6 mm long.
  const along = (mm: number) => {
    const leg = Math.hypot(2, 5, 25);
    return [0, 1, 2].map(
      (j) => trunk[0][j] + ((trunk[1][j] - trunk[0][j]) * mm) / leg,
    );
  };
  fireEvent.click(screen.getByRole("radio", { name: "Device end 2" }));
  clickSample(sampleAt(along(14)));
  fireEvent.click(screen.getByRole("radio", { name: "Device end 1" }));
  clickSample(sampleAt(along(28)));
  const device = rows("Planned and deployed device");
  expect(device[0]).toEqual(["Planned length (mm)", "20.0"]);
  expect(Math.abs(Number(device[1][1]) - 14)).toBeLessThan(1.2);
  expect(device[2][0]).toBe("Near end against the plan, along the vessel (mm)");
  expect(Math.abs(Number(device[2][1]) - 4)).toBeLessThan(1.2);
  expect(device[3][1]!.startsWith("−")).toBe(true);
  expect(Math.abs(Number(device[3][1]!.slice(1)) - 2)).toBeLessThan(1.2);
  fireEvent.click(button("Clear marks"));
  expect(screen.queryByRole("status", { name: "Carried place" })).toBeNull();
  expect(
    screen.queryByRole("table", { name: /Planned and deployed/ }),
  ).toBeNull();
  // A click off every vessel carries nothing.
  fireEvent.click(screen.getByRole("radio", { name: "A place" }));
  fireEvent.click(screen.getByRole("img"), { clientX: 44, clientY: 14 });
  expect(
    screen.getByRole("status", { name: "Carried place" }).textContent,
  ).toBe("No vessel of the 3D model lies under the mark.");
  // A new comparison starts without the marks of the last.
  fireEvent.click(button("Compare again"));
  expect(screen.queryByRole("table")).toBeNull();
  await compared();
  expect(screen.queryByRole("status", { name: "Carried place" })).toBeNull();
}, 60000);

test("compares without a planned device, and with one frame leaves contrast arrival out", async () => {
  canvases();
  server({
    frames: { 12: gray },
    devices: () => json(scenarios({ status: "not_computed" }, 0)),
  });
  render(<Panel />);
  fireEvent.click(button("Compare 2D and 3D"));
  await compared();
  expect(rows("Segment comparison")[0]).toHaveLength(4);
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByRole("status", { name: "Planned devices" })).toBeNull();
}, 60000);

test("tells a case without measurements from device plans that could not be read", async () => {
  canvases();
  // No current measurements, as the server says with its refusal: the case
  // has no device plans to compare, and they are not asked for again.
  const asked = (calls: string[]) =>
      calls.filter((call) => call.endsWith("/device-scenarios")).length,
    none = () =>
      new Response("{}", {
        status: 409,
        headers: { "X-Conflict-Reason": "measurements-not-current" },
      }),
    calls = server({ frames: { 12: gray }, devices: none });
  render(<Panel />);
  fireEvent.click(button("Compare 2D and 3D"));
  await compared();
  expect(screen.queryByRole("status", { name: "Planned devices" })).toBeNull();
  expect(asked(calls)).toBe(1);
  // The same where the measurements stopped being current between a first
  // read refused for another reason and the second.
  let reads = 0;
  const between = server({
    frames: { 12: gray },
    devices: () => (reads++ ? none() : json({}, 409)),
  });
  fireEvent.click(button("Compare again"));
  await waitFor(() => expect(asked(between)).toBe(2));
  await compared();
  expect(screen.queryByRole("status", { name: "Planned devices" })).toBeNull();
  // A refusal for another reason is a source the server could not read as
  // one: it is asked once more, and a refusal that stands is plans not read.
  for (const [unread, reads] of [
    [() => json({}, 409), 2],
    [() => json({}, 503), 1],
    [() => json({ case_id: "another" }), 1],
  ] as const) {
    const again = server({ frames: { 12: gray }, devices: unread });
    fireEvent.click(button("Compare again"));
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Planned devices" }).textContent,
      ).toBe(
        "The saved device plans could not be read, so no planned device is compared.",
      ),
    );
    expect(rows("Segment comparison").length).toBeGreaterThan(1);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(asked(again)).toBe(reads);
  }
}, 60000);

test("reads the device plans again where they changed while they were read", async () => {
  canvases();
  let asked = 0;
  server({ devices: () => (asked++ ? json(planned) : json({}, 409)) });
  render(<Panel />);
  fireEvent.click(button("Compare 2D and 3D"));
  await compared();
  expect(asked).toBe(2);
  expect(screen.getByRole("combobox", { name: /Planned device/ })).toBeTruthy();
  expect(screen.queryByRole("status", { name: "Planned devices" })).toBeNull();
}, 60000);

test("says why the saved proposal's frames or mask were not used: not the confirmed ones, spoiled, or not to be had", async () => {
  canvases();
  const said = async (text: string) => {
    fireEvent.click(button(/^Compare/));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(text),
    );
    expect(screen.queryByRole("table")).toBeNull();
  };
  // The stored frame is not the one the proposal was confirmed on.
  server({ frames: { 8: early, 12: late } });
  render(<Panel />);
  await said(
    "The stored frames are not the ones this proposal was confirmed on. Save a new proposal to compare.",
  );
  // Stored bytes that are not what the manifest names.
  server({ spoiled: 8 });
  await said(
    "A frame or the vessel mask of the saved proposal failed its integrity check and is not used.",
  );
  server({ mask: () => bytes(Uint8Array.from(maskBlob).reverse()) });
  await said(
    "A frame or the vessel mask of the saved proposal failed its integrity check and is not used.",
  );
  // A mask that cannot be fetched is not called an integrity failure.
  server({ mask: () => json({}, 503) });
  await said(
    "The frames and vessel mask of the saved proposal could not be read. Check their availability, then retry.",
  );
}, 60000);

test("starts nothing while the studio is busy or the mask has changed", async () => {
  canvases();
  server();
  const view = render(<Panel />);
  view.rerender(<Panel disabled />);
  expect(button("Compare 2D and 3D").disabled).toBe(true);
  view.rerender(
    <Panel
      mask={
        {
          ...maskEntry,
          mask_sha256: "0".repeat(64),
        } as unknown as SegmentationEntry
      }
    />,
  );
  expect(button("Compare 2D and 3D").disabled).toBe(true);
  view.rerender(<Panel mask={null} />);
  expect(button("Compare 2D and 3D").disabled).toBe(true);
  // Another candidate with the same voxels is not the mask of the proposal.
  view.rerender(
    <Panel
      mask={
        {
          ...maskEntry,
          candidate_id: "aR9gj2VyCgkVgAQXETJsmA",
        } as unknown as SegmentationEntry
      }
    />,
  );
  expect(button("Compare 2D and 3D").disabled).toBe(true);
  // Nor is a proposal compared whose frame the server could not check.
  view.rerender(
    <Panel
      saved={
        {
          ...registration,
          current: { ...registration.current, evidence: "unavailable" },
        } as typeof registration
      }
    />,
  );
  expect(button("Compare 2D and 3D").disabled).toBe(true);
  view.rerender(<Panel />);
  expect(button("Compare 2D and 3D").disabled).toBe(false);
}, 60000);

test("shows nothing of a comparison once the saved proposal is another", async () => {
  canvases();
  server();
  const view = render(<Panel />);
  fireEvent.click(button("Compare 2D and 3D"));
  await compared();
  clickSample(sampleAt([27, 3, 18]));
  expect(screen.getByRole("status", { name: "Carried place" })).toBeTruthy();
  view.rerender(<Panel saved={later} />);
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.queryByRole("status", { name: "Carried place" })).toBeNull();
  expect(button("Compare 2D and 3D").disabled).toBe(false);
}, 60000);

test("gives up the reading of a saved proposal that is replaced while it is read", async () => {
  canvases();
  const calls = server({ held: true }),
    requests: boolean[] = [],
    open = (now: boolean) => requests.push(now),
    view = render(<Panel onRequests={open} />);
  fireEvent.click(button("Compare 2D and 3D"));
  await waitFor(() =>
    expect(calls.some((call) => call.includes("/frames/"))).toBe(true),
  );
  expect(requests.at(-1)).toBe(true);
  view.rerender(<Panel saved={later} onRequests={open} />);
  await waitFor(() => expect(requests.at(-1)).toBe(false));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(button("Compare 2D and 3D").disabled).toBe(false);
}, 60000);

test("says when the reading took too long", async () => {
  canvases();
  server({ held: true });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    render(<Panel />);
    fireEvent.click(button("Compare 2D and 3D"));
    await vi.advanceTimersByTimeAsync(COMPARISON_REQUEST_TIMEOUT_MS - 1);
    expect(screen.queryByRole("alert")).toBeNull();
    await vi.advanceTimersByTimeAsync(2);
  } finally {
    vi.useRealTimers();
  }
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Reading the frames and vessel mask of the saved proposal took longer than 30 seconds. Retry.",
  );
  expect(button("Compare 2D and 3D").disabled).toBe(false);
}, 60000);

test("builds a frame's picture once, and draws the cursor over it again as it moves", async () => {
  canvases();
  let built = 0,
    put = 0;
  const context = {
    createImageData: (width: number, height: number) => {
      built++;
      return { data: new Uint8ClampedArray(4 * width * height), width, height };
    },
    putImageData: () => put++,
    fillRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    arc() {},
  };
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  server({ frames: { 12: gray } });
  render(<Panel />);
  fireEvent.click(button("Compare 2D and 3D"));
  await compared();
  expect(built).toBe(1);
  const before = put,
    frame = screen.getByRole("img");
  for (let k = 0; k < 3; k++) fireEvent.keyDown(frame, { key: "ArrowRight" });
  expect(put).toBe(before + 3);
  expect(built).toBe(1);
}, 60000);

test("marks a place from the keyboard: the arrow keys move a cursor over the frame and Enter marks", async () => {
  canvases();
  server();
  render(<Panel />);
  fireEvent.click(button("Compare 2D and 3D"));
  await compared();
  const k = sampleAt([27, 3, 18]),
    frame = screen.getByRole("img"),
    press = (key: string, times: number, shiftKey = false) => {
      for (let i = 0; i < times; i++)
        fireEvent.keyDown(frame, { key, shiftKey });
    },
    dx = Math.round(placed.pixels[2 * k] - SIDE / 2),
    dy = Math.round(placed.pixels[2 * k + 1] - SIDE / 2);
  expect(frame.tabIndex).toBe(0);
  expect(frame.getAttribute("aria-label")).toMatch(
    /Arrow keys move a cursor, Enter marks\.$/,
  );
  // The cursor starts at the frame's middle; Shift moves it ten pixels.
  press(
    dx < 0 ? "ArrowLeft" : "ArrowRight",
    Math.floor(Math.abs(dx) / 10),
    true,
  );
  press(dx < 0 ? "ArrowLeft" : "ArrowRight", Math.abs(dx) % 10);
  press(dy < 0 ? "ArrowUp" : "ArrowDown", Math.floor(Math.abs(dy) / 10), true);
  press(dy < 0 ? "ArrowUp" : "ArrowDown", Math.abs(dy) % 10);
  expect(screen.queryByRole("status", { name: "Carried place" })).toBeNull();
  press("Enter", 1);
  expect(
    screen.getByRole("status", { name: "Carried place" }).textContent,
  ).toContain(`Segment ${segments.labels[k] + 1},`);
  // It stays inside the frame.
  press("ArrowLeft", 40, true);
  press("ArrowUp", 40, true);
  press(" ", 1);
  expect(
    screen.getByRole("status", { name: "Carried place" }).textContent,
  ).toBe("No vessel of the 3D model lies under the mark.");
}, 60000);

it("uses the saved inputs of the fixture this file assumes", () => {
  expect(savedInputs().frame_index).toBe(12);
  expect(savedInputs().polarity).toBe("dark");
});
