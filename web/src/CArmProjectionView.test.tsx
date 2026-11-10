import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { NVImage } from "@niivue/niivue";
import CArmProjectionView from "./CArmProjectionView";
import type { ViewNumbers } from "./carmGeometry";
import type { Vec3 } from "./obliqueSlice";

const n = 16;
const volume = {
  img: new Float32Array(n ** 3).fill(400),
  hdr: {
    dims: [3, n, n, n, 1, 1, 1, 1],
    xyzt_units: 2,
    datatypeCode: 16,
    scl_slope: 1,
    scl_inter: 0,
  },
  getAffine: () => [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ],
} as unknown as NVImage;
const view: ViewNumbers = {
  primary_deg: 30,
  secondary_deg: -20,
  source_detector_mm: 1200,
  source_isocenter_mm: 750,
  detector_width_mm: 100,
  detector_height_mm: 50,
};
const props = {
  identityKey: "case",
  volume,
  view,
  isocenter: [8, 8, 8] as Vec3,
  path: [
    [6, 8, 8],
    [10, 8, 8],
  ] as Vec3[],
  threshold: 100,
};
function stubCanvas() {
  const calls: string[] = [];
  const context = {
    createImageData: (width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4),
      width,
      height,
    }),
    putImageData: (image: { width: number; height: number }) =>
      calls.push(`put ${image.width}x${image.height}`),
    beginPath: () => calls.push("begin"),
    moveTo: (x: number, y: number) =>
      calls.push(`move ${x.toFixed(2)},${y.toFixed(2)}`),
    lineTo: (x: number, y: number) =>
      calls.push(`line ${x.toFixed(2)},${y.toFixed(2)}`),
    stroke: () => calls.push("stroke"),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  return calls;
}
afterEach(() => {
  cleanup();
  // Spies first: one of them wraps the fake setTimeout.
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("paints the simulated projection, the target path and the isocenter", async () => {
  const calls = stubCanvas();
  render(<CArmProjectionView {...props} />);
  const canvas = await screen.findByLabelText(/Simulated projection/);
  // A 100 x 50 mm detector keeps its aspect ratio at 160 px on the long side.
  expect(canvas).toHaveAttribute("width", "160");
  expect(canvas).toHaveAttribute("height", "80");
  expect(calls[0]).toBe("put 160x80");
  // The isocenter is on the central ray: the image center.
  expect(calls).toContain("move 76.00,40.00");
  expect(calls).toContain("line 84.00,40.00");
  expect(calls.filter((call) => call === "stroke")).toHaveLength(2);
  const caption = screen.getByText(/Not an acquired angiogram/);
  expect(caption).toHaveTextContent("LAO 30.0 / CAU 20.0");
  expect(caption).toHaveTextContent("bone and calcium are not removed");
  expect(caption).not.toHaveTextContent("cannot be projected");
});

test("an unprojectable target keeps the image and says the path is not drawn", async () => {
  stubCanvas();
  render(
    <CArmProjectionView
      {...props}
      view={{ ...view, primary_deg: 0, secondary_deg: 0 }}
      path={[
        [8, -800, 8],
        [8, 8, 8],
      ]}
    />,
  );
  expect(
    await screen.findByText(/cannot be projected in this view/),
  ).toBeInTheDocument();
  expect(screen.getByLabelText(/Simulated projection/)).toBeInTheDocument();
});

test.each([
  [{ volume: null }, "No verified source volume is loaded."],
  [{ isocenter: null }, "Set an isocenter to preview a simulated projection."],
  [
    { view: null },
    "Enter valid view values to preview a simulated projection.",
  ],
  [
    { threshold: null },
    "Enter a valid projection threshold to preview a simulated projection.",
  ],
  [{ disabled: true }, "Simulated projection paused."],
])("explains why nothing is shown %#", async (change, message) => {
  stubCanvas();
  render(<CArmProjectionView {...props} {...change} />);
  expect(await screen.findByText(message)).toBeInTheDocument();
  expect(screen.queryByLabelText(/Simulated projection/)).toBeNull();
});

test("canvas and source failures are reported instead of a stale image", async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const first = render(<CArmProjectionView {...props} />);
  expect(
    await screen.findByText("Simulated projection canvas could not be painted"),
  ).toBeInTheDocument();
  first.unmount();
  stubCanvas();
  const poisoned = {
    ...volume,
    img: new Float32Array(n ** 3).fill(Number.NaN),
  } as unknown as NVImage;
  render(<CArmProjectionView {...props} volume={poisoned} />);
  expect(
    await screen.findByText(/Nonfinite source sample/),
  ).toBeInTheDocument();
  expect(screen.queryByLabelText(/Simulated projection/)).toBeNull();
});

test("a superseded view is dropped between slices and never replaces the newer image", async () => {
  const calls = stubCanvas();
  vi.useFakeTimers();
  // Every deadline check reports an expired slice, so each timer turn renders
  // exactly one detector row and no view can finish in one turn.
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (clock += 1000));
  const timers = vi.spyOn(globalThis, "setTimeout");
  const turn = () => act(async () => void vi.advanceTimersToNextTimer());
  // The first view is 160 rows tall. Left running, it would finish after the
  // 80-row view that replaces it and wipe that newer image.
  const tall = { ...view, detector_width_mm: 50, detector_height_mm: 100 };
  const first = render(<CArmProjectionView {...props} view={tall} />);
  for (let row = 0; row < 4; row++) await turn();
  expect(screen.getByText("Computing simulated projection…")).toBeVisible();
  expect(screen.queryByLabelText(/Simulated projection/)).toBeNull();
  expect(vi.getTimerCount()).toBe(1);
  const before = timers.mock.calls.length;
  first.rerender(
    <CArmProjectionView {...props} view={{ ...view, primary_deg: -40 }} />,
  );
  // The dropped view's pending slice is gone; only the newer view is queued.
  expect(vi.getTimerCount()).toBe(1);
  await act(async () => void vi.runAllTimers());
  // One timer turn per row of the newer 80-row view and none for the old one.
  expect(timers.mock.calls.length - before).toBe(80);
  expect(vi.getTimerCount()).toBe(0);
  expect(screen.getByLabelText(/Simulated projection/)).toHaveAttribute(
    "height",
    "80",
  );
  expect(screen.getByText(/Not an acquired angiogram/)).toHaveTextContent(
    "RAO 40.0 / CAU 20.0",
  );
  expect(calls.filter((call) => call.startsWith("put"))).toEqual([
    "put 160x80",
  ]);
  // A further edit withdraws the painted image at once: the caption names
  // the edited view, so the previous view's pixels must not stay under it.
  first.rerender(
    <CArmProjectionView {...props} view={{ ...view, primary_deg: 10 }} />,
  );
  await turn();
  expect(screen.queryByLabelText(/Simulated projection/)).toBeNull();
  expect(screen.getByText("Computing simulated projection…")).toBeVisible();
  await act(async () => void vi.runAllTimers());
  expect(screen.getByLabelText(/Simulated projection/)).toBeInTheDocument();
  // A replaced volume object under the same identity is not trusted either.
  first.rerender(
    <CArmProjectionView
      {...props}
      view={{ ...view, primary_deg: 10 }}
      volume={{ ...volume } as unknown as NVImage}
    />,
  );
  await turn();
  expect(screen.queryByLabelText(/Simulated projection/)).toBeNull();
  first.unmount();
  expect(vi.getTimerCount()).toBe(0);
  // Unmounting mid-render stops the remaining slices as well.
  const again = render(<CArmProjectionView {...props} view={tall} />);
  for (let row = 0; row < 3; row++) await turn();
  expect(vi.getTimerCount()).toBe(1);
  again.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test("a failure in a later slice is reported and clears the image", async () => {
  stubCanvas();
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (clock += 1000));
  const slices = vi.spyOn(globalThis, "setTimeout");
  // Only the caudal end of the volume is poisoned, so the first rows succeed.
  const img = new Float32Array(n ** 3).fill(400);
  img.fill(Number.NaN, 0, n * n);
  render(
    <CArmProjectionView
      {...props}
      volume={{ ...volume, img } as unknown as NVImage}
    />,
  );
  expect(
    await screen.findByText(/Nonfinite source sample/),
  ).toBeInTheDocument();
  expect(slices.mock.calls.length).toBeGreaterThan(5);
  expect(screen.queryByLabelText(/Simulated projection/)).toBeNull();
});

test("a failure message does not outlive the render that produced it", async () => {
  stubCanvas();
  vi.useFakeTimers();
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (clock += 1000));
  const img = new Float32Array(n ** 3).fill(Number.NaN);
  const view = render(
    <CArmProjectionView
      {...props}
      volume={{ ...volume, img } as unknown as NVImage}
    />,
  );
  await act(async () => void vi.runAllTimers());
  expect(screen.getByText(/Nonfinite source sample/)).toBeVisible();
  // A sound volume replaces the failed one and is still rendering.
  view.rerender(<CArmProjectionView {...props} />);
  await act(async () => void vi.advanceTimersToNextTimer());
  expect(vi.getTimerCount()).toBe(1);
  expect(screen.queryByText(/Nonfinite source sample/)).toBeNull();
  expect(screen.getByText("Computing simulated projection…")).toBeVisible();
  await act(async () => void vi.runAllTimers());
  expect(screen.getByLabelText(/Simulated projection/)).toBeInTheDocument();
});
