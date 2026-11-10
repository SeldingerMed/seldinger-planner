import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
  vi.restoreAllMocks();
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
    "Enter valid view values to preview a simulated projection.",
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
