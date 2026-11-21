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
import ComparisonPanel, { framePixel, narrowestRows } from "./ComparisonPanel";
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
  devices?: () => Response;
  mask?: () => Response;
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
  onRequests,
  onComputing,
}: {
  mask?: SegmentationEntry | null;
  disabled?: boolean;
  onRequests?: (open: boolean) => void;
  onComputing?: (computing: boolean) => void;
}) {
  return (
    <ComparisonPanel
      identity={identity}
      binding={binding}
      registration={registration}
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
    expect(
      narrowestRows([plane([20, null, null, 30], mask)], 1).map(
        (row) => row.run,
      ),
    ).toEqual([3]);
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
}, 60000);

test("says when the saved frame cannot be read, and starts nothing while the studio is busy or the mask has changed", async () => {
  canvases();
  // The stored frame is not the one the proposal was confirmed on.
  server({ frames: { 8: early, 12: late } });
  const view = render(<Panel />);
  fireEvent.click(button("Compare 2D and 3D"));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe(
      "The frames and vessel mask of the saved proposal could not be read. Check their availability, then retry.",
    ),
  );
  expect(screen.queryByRole("table")).toBeNull();
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
}, 60000);

it("uses the saved inputs of the fixture this file assumes", () => {
  expect(savedInputs().frame_index).toBe(12);
  expect(savedInputs().polarity).toBe("dark");
});
