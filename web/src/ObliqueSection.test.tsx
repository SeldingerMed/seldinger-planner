import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { NVImage } from "@niivue/niivue";
const harness = vi.hoisted(() => ({ sample: vi.fn() }));
vi.mock("./obliqueSlice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./obliqueSlice")>()),
  sampleObliqueSlice: harness.sample,
}));
import ObliqueSection from "./ObliqueSection";
const section = {
  plane_origin: [0, 0, 0] as [number, number, number],
  plane_normal: [0, 0, 1] as [number, number, number],
  contour_world: [
    [2, 0, 0],
    [-2, 0, 0],
    [0, -2, 0],
  ] as [number, number, number][],
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  harness.sample.mockReset();
});
test("failed window resampling suppresses the old successful PNG", async () => {
  harness.sample.mockReturnValue({
    width: 2,
    height: 2,
    rgba: new Uint8ClampedArray(16),
    outside: 0,
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    createImageData: () => ({ data: new Uint8ClampedArray(16) }),
    putImageData: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
    "data:image/png;base64,old-unit-image",
  );
  const image = {} as NVImage;
  const view = render(
    <ObliqueSection section={section} volume={image} windowRange={[0, 600]} />,
  );
  await screen.findByLabelText("Oblique CTA with accepted mask contour");
  harness.sample.mockImplementation(() => {
    throw new Error("Nonfinite sample");
  });
  view.rerender(
    <ObliqueSection section={section} volume={image} windowRange={[0, 100]} />,
  );
  expect(document.querySelector("svg image")).toBeNull();
  expect(
    screen.queryByLabelText("Oblique CTA with accepted mask contour"),
  ).toBeNull();
  expect(
    screen.getByText("CTA plane unavailable · contour only"),
  ).toBeInTheDocument();
  expect(harness.sample).toHaveBeenLastCalledWith(
    image,
    section.plane_origin,
    section.plane_normal,
    expect.anything(),
    [0, 100],
  );
});

test("actual native volume and current window paint under the same projected contour", async () => {
  harness.sample.mockReturnValue({
    width: 2,
    height: 2,
    rgba: new Uint8ClampedArray(16).fill(127),
    outside: 0,
  });
  const put = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    createImageData: () => ({ data: new Uint8ClampedArray(16) }),
    putImageData: put,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
    "data:image/png;base64,synthetic-unit-fixture",
  );
  const image = {} as NVImage;
  const view = render(
    <ObliqueSection section={section} volume={image} windowRange={[0, 600]} />,
  );
  await waitFor(() =>
    expect(
      screen.getByLabelText("Oblique CTA with accepted mask contour"),
    ).toBeInTheDocument(),
  );
  expect(harness.sample).toHaveBeenCalledWith(
    image,
    section.plane_origin,
    section.plane_normal,
    expect.anything(),
    [0, 600],
  );
  expect(put).toHaveBeenCalledOnce();
  expect(document.querySelector("svg image")?.getAttribute("href")).toBe(
    "data:image/png;base64,synthetic-unit-fixture",
  );
  expect(document.querySelector("svg path")?.getAttribute("d")).toBe(
    "M0,2 L0,-2 L2,0 Z",
  );
  view.rerender(
    <ObliqueSection section={section} volume={null} windowRange={[0, 600]} />,
  );
  expect(document.querySelector("svg image")).toBeNull();
  expect(
    screen.queryByLabelText("Oblique CTA with accepted mask contour"),
  ).toBeNull();
});
