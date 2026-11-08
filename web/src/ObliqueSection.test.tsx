import { useLayoutEffect } from "react";
import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import type { NVImage } from "@niivue/niivue";
import type { Vec3 } from "./obliqueSlice";
const harness = vi.hoisted(() => {
  // jsdom has no DOMPoint; provide the minimal DOMPoint.matrixTransform used
  // by the SVG pick path.
  class DOMPointPolyfill {
    x: number;
    y: number;
    constructor(x = 0, y = 0) {
      this.x = x;
      this.y = y;
    }
    matrixTransform(m: {
      a: number;
      b: number;
      c: number;
      d: number;
      e: number;
      f: number;
    }) {
      return new DOMPointPolyfill(
        m.a * this.x + m.c * this.y + m.e,
        m.b * this.x + m.d * this.y + m.f,
      );
    }
  }
  (globalThis as Record<string, unknown>).DOMPoint ??= DOMPointPolyfill;
  return { sample: vi.fn() };
});
vi.mock("./obliqueSlice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./obliqueSlice")>()),
  sampleObliqueSlice: harness.sample,
}));
import ObliqueSection, { screenToPlane } from "./ObliqueSection";
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

function stubCanvasPaint() {
  harness.sample.mockReturnValue({
    width: 2,
    height: 2,
    rgba: new Uint8ClampedArray(16).fill(127),
    outside: 0,
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    createImageData: () => ({ data: new Uint8ClampedArray(16) }),
    putImageData: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
    "data:image/png;base64,synthetic-unit-fixture",
  );
}

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

test("changing viewport hides the previous raster before passive resampling", () => {
  stubCanvasPaint();
  const image = {} as NVImage;
  const seen: boolean[] = [];
  function Probe({ span }: { span: number }) {
    useLayoutEffect(() => {
      seen.push(document.querySelector("svg image") !== null);
    }, [span]);
    return (
      <ObliqueSection
        section={section}
        volume={image}
        bounds={{ minX: -span, maxX: span, minY: -span, maxY: span }}
      />
    );
  }
  const { rerender } = render(<Probe span={10} />);
  expect(document.querySelector("svg image")).not.toBeNull();
  rerender(<Probe span={20} />);
  expect(seen.at(-1)).toBe(false);
});

test("explicit bounds allow an image-only plane with empty contour", async () => {
  stubCanvasPaint();
  const image = {} as NVImage;
  const imageOnly = {
    plane_origin: [1, 2, 3] as [number, number, number],
    plane_normal: [0, 0, 1] as [number, number, number],
    contour_world: [] as number[][],
  };
  render(
    <ObliqueSection
      section={imageOnly}
      volume={image}
      bounds={{ minX: -20, maxX: 20, minY: -20, maxY: 20 }}
    />,
  );
  await waitFor(() =>
    expect(
      screen.getByLabelText("Oblique CTA with accepted mask contour"),
    ).toBeInTheDocument(),
  );
  expect(harness.sample).toHaveBeenCalledWith(
    image,
    imageOnly.plane_origin,
    imageOnly.plane_normal,
    { minX: -20, maxX: 20, minY: -20, maxY: 20 },
    [0, 600],
  );
  expect(document.querySelector("svg path")).toBeNull();
  const svg = document.querySelector("svg")!;
  expect(svg.getAttribute("viewBox")).toBe("-20 -20 40 40");
});

test("changed section reference hides stale paint until resampled", async () => {
  stubCanvasPaint();
  const image = {} as NVImage;
  const view = render(
    <ObliqueSection
      section={section}
      volume={image}
      bounds={{ minX: -10, maxX: 10, minY: -10, maxY: 10 }}
    />,
  );
  await screen.findByLabelText("Oblique CTA with accepted mask contour");
  const moved = {
    ...section,
    plane_origin: [5, 0, 0] as [number, number, number],
  };
  harness.sample.mockImplementation(() => {
    throw new Error("resample failure");
  });
  view.rerender(
    <ObliqueSection
      section={moved}
      volume={image}
      bounds={{ minX: -10, maxX: 10, minY: -10, maxY: 10 }}
    />,
  );
  // The old paint (different section) must not render while the new one fails.
  expect(document.querySelector("svg image")).toBeNull();
  expect(
    screen.getByText("CTA plane unavailable · contour only"),
  ).toBeInTheDocument();
});

test("contourLabel overrides both aria-label and caption text", async () => {
  stubCanvasPaint();
  const image = {} as NVImage;
  render(
    <ObliqueSection
      section={section}
      volume={image}
      contourLabel="annulus contour"
    />,
  );
  await waitFor(() =>
    expect(
      screen.getByLabelText("Oblique CTA with annulus contour"),
    ).toBeInTheDocument(),
  );
  expect(screen.getByText("Native CTA · annulus contour")).toBeInTheDocument();
});

test("nontrivial SVG transform maps a click to true RAS plane coordinates", () => {
  // Screen-to-plane: rotate 90°, scale 2, translate so that screen
  // (clientX=110, clientY=60) lands on plane coordinates (x=30, y=-5)
  // under the inverse of [2*s -90° + t] applied forward on (30,-5).
  // Forward: scale (60,-10), rotate 90° -> (10, 60), translate +(-40, -80)
  // gives screen (−30, −20) in screen-space origin terms; we build the
  // matrix so inverse() inverts it exactly.
  // matrix m = [[0,-2, 40],[2, 0, 80]] applied to (30,-5):
  //   a*x + c*y + e = 0*30 + (-2)*(-5) + 40 = 50
  //   b*x + d*y + f = 2*30 + 0*(-5) + 80 = 140
  const forward = { a: 0, b: 2, c: -2, d: 0, e: 40, f: 80 };
  const inverse = { a: 0, b: -0.5, c: 0.5, d: 0, e: -40, f: 20 };
  // verify: inverse ∘ forward = identity
  expect(inverse.a * forward.a + inverse.c * forward.b).toBeCloseTo(1);
  expect(inverse.b * forward.a + inverse.d * forward.b).toBeCloseTo(0);
  expect(inverse.a * forward.c + inverse.c * forward.d).toBeCloseTo(0);
  expect(inverse.b * forward.c + inverse.d * forward.d).toBeCloseTo(1);
  expect(inverse.a * forward.e + inverse.c * forward.f + inverse.e).toBeCloseTo(
    0,
  );
  expect(inverse.b * forward.e + inverse.d * forward.f + inverse.f).toBeCloseTo(
    0,
  );

  const fakeInverse = vi.fn(() => inverse);
  const svg = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "svg",
  ) as SVGSVGElement;
  // jsdom lacks getScreenCTM; a nontrivial affine (90° rotation, scale 2,
  // translation) whose inverse maps screen (50,140) to plane (30,-5).
  Object.defineProperty(svg, "getScreenCTM", {
    configurable: true,
    value: () => ({ ...forward, inverse: fakeInverse }),
  });
  Object.defineProperty(svg, "createSVGPoint", {
    configurable: true,
    value: () => {
      throw new Error("force DOMPoint path");
    },
  });
  const plane = screenToPlane(svg, 50, 140);
  expect(plane).toEqual({ x: 30, y: -5 });
  expect(fakeInverse).toHaveBeenCalled();
});

test("SVG click pick reports RAS via origin + u*x + v*y through onPick", async () => {
  stubCanvasPaint();
  const onPick = vi.fn();
  const image = {} as NVImage;
  const forward = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const inverse = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  Object.defineProperty(SVGSVGElement.prototype, "getScreenCTM", {
    configurable: true,
    value: function () {
      return { ...forward, inverse: () => inverse };
    },
  });
  Object.defineProperty(SVGSVGElement.prototype, "createSVGPoint", {
    configurable: true,
    value: function () {
      throw new Error("use DOMPoint");
    },
  });
  const view = render(
    <ObliqueSection
      section={{
        plane_origin: [10, 20, 30] as [number, number, number],
        plane_normal: [0, 0, 1] as [number, number, number],
        contour_world: [] as number[][],
      }}
      volume={image}
      bounds={{ minX: -20, maxX: 20, minY: -20, maxY: 20 }}
      onPick={onPick}
    />,
  );
  await screen.findByLabelText("Oblique CTA with accepted mask contour");
  const svg = document.querySelector("svg")!;
  fireEvent.click(svg, { clientX: 7, clientY: -3 });
  // plane coords (7, -3); normal [0,0,1] -> u=[0,-1,0], v=[1,0,0]
  expect(onPick).toHaveBeenCalledOnce();
  const ras = onPick.mock.calls[0][0] as Vec3;
  expect(ras[0]).toBeCloseTo(10 - 3);
  expect(ras[1]).toBeCloseTo(20 - 7);
  expect(ras[2]).toBeCloseTo(30);
});
