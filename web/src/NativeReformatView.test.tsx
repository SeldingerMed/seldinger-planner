import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { NVImage } from "@niivue/niivue";
import type { RenderReceipt } from "./NativeReformatView";

function cube() {
  const data = new Float32Array(17 ** 3);
  for (let z = 2; z <= 13; z++)
    for (let y = 2; y <= 13; y++)
      for (let x = 2; x <= 13; x++) data[x + 17 * (y + 17 * z)] = 100;
  return {
    hdr: {
      dims: [3, 17, 17, 17, 1, 1, 1, 1],
      datatypeCode: 16,
      xyzt_units: 2,
      scl_slope: 1,
      scl_inter: 0,
      affine: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
    },
    getAffine: () => [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ],
    img: data,
  } as unknown as NVImage;
}
const options = {
  span_mm: 4,
  roll_degrees: 0,
  station_fraction: 0,
  threshold: 50,
  primary_window: [0, 100] as [number, number],
  secondary_window: [0, 100] as [number, number],
  opacity: 0.5,
};

type Ctx = {
  createImageData: (w: number, h: number) => { data: Uint8ClampedArray };
  putImageData: ReturnType<typeof vi.fn>;
};
let put: ReturnType<typeof vi.fn>;
function mockCanvasContexts() {
  put = vi.fn();
  const spy = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(function (this: HTMLCanvasElement) {
      const ctx: Ctx = {
        createImageData: (w: number, h: number) => ({
          data: new Uint8ClampedArray(w * h * 4),
        }),
        putImageData: put,
      };
      return ctx as unknown as CanvasRenderingContext2D;
    });
  return spy;
}

import NativeReformatView from "./NativeReformatView";

beforeEach(() => {
  vi.useFakeTimers();
  mockCanvasContexts();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanup();
});

function flush() {
  act(() => {
    vi.advanceTimersByTime(1);
  });
}

test("renders real producer rasters into CPR, endoluminal and registered canvases and publishes a receipt", () => {
  const volume = cube();
  const onReceipt = vi.fn();
  const { container } = render(
    <NativeReformatView
      identityKey="case-1"
      volume={volume}
      path={[
        [8, 8, 8],
        [8, 8, 10],
      ]}
      options={options}
      onReceipt={onReceipt}
    />,
  );
  flush();
  const labels = Array.from(container.querySelectorAll("canvas")).map((c) =>
    c.getAttribute("aria-label"),
  );
  expect(labels).toContain("Straightened planar reformat along path");
  expect(labels).toContain("Stretched planar reformat along path");
  expect(labels).toContain(
    "Endoluminal first-person intensity boundary flythrough",
  );
  const painted = put.mock.calls.length;
  expect(painted).toBe(3);
  // Pixels come from the real producer, not fabricated paint.
  const image = put.mock.calls[0][0] as { data: Uint8ClampedArray };
  expect(image.data.some((x) => x === 255)).toBe(true);
  expect(onReceipt).toHaveBeenCalledTimes(1);
  const receipt = onReceipt.mock.calls[0][0] as RenderReceipt;
  expect(receipt.identityKey).toBe("case-1");
  expect(receipt.volume).toBe(volume);
  expect(receipt.secondaryVolume).toBeNull();
  expect(receipt.optionsKey).toContain('"span_mm":4');
  expect(receipt.pathKey).toBe("[[8,8,8],[8,8,10]]");
  expect(receipt.provenance.endoluminal_method).toBe(
    "first_person_intensity_boundary_raycast",
  );
  expect(receipt.provenance.endoluminal_status).toBe("rendered");
});

test("a threshold miss shows only a caption, keeping valid CPR canvases", () => {
  render(
    <NativeReformatView
      identityKey="case-1"
      volume={cube()}
      path={[
        [8, 8, 8],
        [8, 8, 10],
      ]}
      options={{ ...options, threshold: 101 }}
    />,
  );
  flush();
  const labels = Array.from(document.querySelectorAll("canvas")).map((c) =>
    c.getAttribute("aria-label"),
  );
  expect(labels).toContain("Straightened planar reformat along path");
  expect(labels).not.toContain(
    "Endoluminal first-person intensity boundary flythrough",
  );
});

test("disable hides previous canvases immediately and publishes no receipt", () => {
  const volume = cube();
  const onReceipt = vi.fn();
  const { rerender } = render(
    <NativeReformatView
      identityKey="case-1"
      volume={volume}
      path={[
        [8, 8, 8],
        [8, 8, 10],
      ]}
      options={options}
      onReceipt={onReceipt}
    />,
  );
  flush();
  expect(onReceipt).toHaveBeenCalledTimes(1);
  rerender(
    <NativeReformatView
      identityKey="case-1"
      volume={volume}
      path={[
        [8, 8, 8],
        [8, 8, 10],
      ]}
      options={options}
      disabled={true}
      onReceipt={onReceipt}
    />,
  );
  // Synchronous gate: before any timer runs, the old paint is hidden.
  expect(document.querySelectorAll("canvas").length).toBe(0);
  flush();
  expect(document.querySelectorAll("canvas").length).toBe(0);
  expect(onReceipt).toHaveBeenLastCalledWith(null);
});

test("registered cross-section canvas appears only when a secondary source is present", () => {
  const volume = cube();
  const { rerender } = render(
    <NativeReformatView
      identityKey="case-1"
      volume={volume}
      path={[
        [8, 8, 8],
        [8, 8, 10],
      ]}
      options={options}
    />,
  );
  flush();
  expect(
    document.querySelector('[aria-label="Registered secondary cross-section"]'),
  ).toBeNull();
  rerender(
    <NativeReformatView
      identityKey="case-1"
      volume={volume}
      path={[
        [8, 8, 8],
        [8, 8, 10],
      ]}
      options={options}
      secondary={{
        volume,
        transform: [
          [1, 0, 0, 0],
          [0, 1, 0, 0],
          [0, 0, 1, 0],
          [0, 0, 0, 1],
        ],
      }}
    />,
  );
  flush();
  expect(
    document.querySelector('[aria-label="Registered secondary cross-section"]'),
  ).not.toBeNull();
});

test("changed options hide the previous canvas immediately and stale timers never repaint or publish", () => {
  const volume = cube();
  const onReceipt = vi.fn();
  const { rerender } = render(
    <NativeReformatView
      identityKey="case-1"
      volume={volume}
      path={[
        [8, 8, 8],
        [8, 8, 10],
      ]}
      options={options}
      onReceipt={onReceipt}
    />,
  );
  flush();
  const firstPaints = put.mock.calls.length;
  rerender(
    <NativeReformatView
      identityKey="case-1"
      volume={volume}
      path={[
        [8, 8, 8],
        [8, 8, 10],
      ]}
      options={{ ...options, station_fraction: 0.5 }}
      onReceipt={onReceipt}
    />,
  );
  expect(document.querySelectorAll("canvas").length).toBe(0);
  flush();
  expect(document.querySelectorAll("canvas").length).toBe(3);
  expect(put.mock.calls.length).toBeGreaterThan(firstPaints);
  expect(onReceipt).toHaveBeenCalledTimes(2);
  expect(onReceipt.mock.calls[1][0].provenance.station_mm).toBe(1);
});

test("a replaced source object with identical binding gets its own fresh receipt", () => {
  const volume = cube(),
    replacement = cube(),
    onReceipt = vi.fn();
  const path: [number, number, number][] = [
    [8, 8, 8],
    [8, 8, 10],
  ];
  const view = render(
    <NativeReformatView
      identityKey="same-binding"
      volume={volume}
      path={path}
      options={options}
      onReceipt={onReceipt}
    />,
  );
  flush();
  view.rerender(
    <NativeReformatView
      identityKey="same-binding"
      volume={replacement}
      path={path}
      options={options}
      onReceipt={onReceipt}
    />,
  );
  expect(view.container.querySelector("canvas")).toBeNull();
  flush();
  expect(onReceipt.mock.lastCall?.[0].volume).toBe(replacement);
});
test("failed canvas painting suppresses the display and revokes its receipt", () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const onReceipt = vi.fn();
  const view = render(
    <NativeReformatView
      identityKey="paint-failure"
      volume={cube()}
      path={[
        [8, 8, 8],
        [8, 8, 10],
      ]}
      options={options}
      onReceipt={onReceipt}
    />,
  );
  flush();
  expect(view.container.querySelector("canvas")).toBeNull();
  expect(onReceipt.mock.lastCall?.[0]).toBeNull();
});
