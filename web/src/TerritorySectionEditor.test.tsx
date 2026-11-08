import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import type { NVImage } from "@niivue/niivue";
import type { Vec3 } from "./obliqueSlice";

vi.hoisted(() => {
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
});

const harness = vi.hoisted(() => ({ sample: vi.fn() }));
vi.mock("./obliqueSlice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./obliqueSlice")>()),
  sampleObliqueSlice: harness.sample,
}));
import TerritorySectionEditor from "./TerritorySectionEditor";

const initial: {
  origin: Vec3;
  normal: Vec3;
  contour: Vec3[];
} = {
  origin: [10, 20, 30],
  normal: [0, 0, 1],
  contour: [],
};
const image = {} as NVImage;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  harness.sample.mockReset();
});

function setup(
  onChange: (s: typeof initial) => void,
  overrides?: Partial<Parameters<typeof TerritorySectionEditor>[0]>,
) {
  return render(
    <TerritorySectionEditor
      value={initial}
      onChange={onChange}
      volume={image}
      cursor={[-1, -2, -3]}
      {...overrides}
    />,
  );
}

test("the 129th contour pick is bounded without discarding the existing trace", () => {
  const onChange = vi.fn();
  const contour: Array<Vec3> = Array.from({ length: 127 }, (_, i) => [
    Math.cos((i * 2 * Math.PI) / 128),
    Math.sin((i * 2 * Math.PI) / 128),
    30,
  ]);
  const { rerender } = setup(onChange, { value: { ...initial, contour } });
  Object.defineProperty(SVGSVGElement.prototype, "getScreenCTM", {
    configurable: true,
    value: () => ({
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      e: 0,
      f: 0,
      inverse: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    }),
  });
  fireEvent.click(document.querySelector("svg")!, { clientX: 2, clientY: 3 });
  expect(onChange).toHaveBeenCalledOnce();
  const atLimit = onChange.mock.calls[0][0];
  expect(atLimit.contour).toHaveLength(128);
  rerender(
    <TerritorySectionEditor
      value={atLimit}
      onChange={onChange}
      volume={image}
      cursor={null}
    />,
  );
  onChange.mockClear();
  fireEvent.click(document.querySelector("svg")!, { clientX: 4, clientY: 5 });
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Contour limit 128 reached",
  );
});

test("unchanged applied geometry does not resample on unrelated cursor updates", () => {
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
    "data:image/png;base64,test",
  );
  const onChange = vi.fn();
  const { rerender } = setup(onChange);
  expect(harness.sample).toHaveBeenCalledOnce();
  rerender(
    <TerritorySectionEditor
      value={initial}
      onChange={onChange}
      volume={image}
      cursor={[4, 5, 6]}
    />,
  );
  expect(harness.sample).toHaveBeenCalledOnce();
});

test("positive typing: Use cursor fills origin draft, Apply plane emits new plane with cleared contour", () => {
  const onChange = vi.fn();
  setup(onChange, {
    value: { ...initial, contour: [[1, 1, 1]] },
  });
  fireEvent.click(screen.getByRole("button", { name: "Use cursor" }));
  expect(screen.getByLabelText("Plane origin")).toHaveValue("-1, -2, -3");
  fireEvent.change(screen.getByLabelText("Plane normal"), {
    target: { value: "0, 1, 0" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply plane" }));
  expect(onChange).toHaveBeenCalledOnce();
  expect(onChange).toHaveBeenCalledWith({
    origin: [-1, -2, -3],
    normal: [0, 1, 0],
    contour: [],
  });
});

test("apply plane does not mutate prior contour when input invalid", () => {
  const onChange = vi.fn();
  setup(onChange);
  fireEvent.change(screen.getByLabelText("Plane origin"), {
    target: { value: "1, 2, abc" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply plane" }));
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Origin and normal must be three finite numbers",
  );
  fireEvent.change(screen.getByLabelText("Plane origin"), {
    target: { value: "1, 2, 3" },
  });
  fireEvent.change(screen.getByLabelText("Plane normal"), {
    target: { value: "0, 0, 0" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply plane" }));
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("Normal must be nonzero");
});

test("field of view span drives the explicit viewport bounds", async () => {
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
    "data:image/png;base64,x",
  );
  setup(vi.fn());
  expect(document.querySelector("svg")!.getAttribute("viewBox")).toBe(
    "-20 -20 40 40",
  );
  fireEvent.change(screen.getByLabelText("Field of view span"), {
    target: { value: "120" },
  });
  expect(document.querySelector("svg")!.getAttribute("viewBox")).toBe(
    "-60 -60 120 120",
  );
  // out-of-range span falls back to default 40
  fireEvent.change(screen.getByLabelText("Field of view span"), {
    target: { value: "500" },
  });
  expect(document.querySelector("svg")!.getAttribute("viewBox")).toBe(
    "-20 -20 40 40",
  );
});

test("SVG picks append controlled contour points; Undo and Clear go through onChange", async () => {
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
    "data:image/png;base64,x",
  );
  Object.defineProperty(SVGSVGElement.prototype, "getScreenCTM", {
    configurable: true,
    value: function () {
      return {
        a: 1,
        b: 0,
        c: 0,
        d: 1,
        e: 0,
        f: 0,
        inverse: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
      };
    },
  });
  Object.defineProperty(SVGSVGElement.prototype, "createSVGPoint", {
    configurable: true,
    value: function () {
      throw new Error("use DOMPoint");
    },
  });
  const states: unknown[] = [];
  const onChange = vi.fn((s: typeof initial) => states.push(s));
  const { rerender } = setup(onChange, {
    value: { ...initial, contour: [[12, 22, 30]] },
  });
  expect(screen.getByText("Contour points: 1")).toBeInTheDocument();
  fireEvent.click(document.querySelector("svg")!, { clientX: 4, clientY: -2 });
  expect(onChange).toHaveBeenCalledOnce();
  const picked = onChange.mock.calls[0][0].contour;
  expect(picked).toHaveLength(2);
  expect(picked[1][0]).toBeCloseTo(10 - 2);
  expect(picked[1][1]).toBeCloseTo(20 - 4);
  expect(picked[1][2]).toBeCloseTo(30);

  rerender(
    <TerritorySectionEditor
      value={{ ...initial, contour: picked }}
      onChange={onChange}
      volume={image}
      cursor={null}
    />,
  );
  // Undo point removes the last point
  fireEvent.click(screen.getByRole("button", { name: "Undo point" }));
  expect(onChange).toHaveBeenCalledTimes(2);
  expect(onChange.mock.calls[1][0].contour).toEqual([[12, 22, 30]]);

  // Clear contour empties it
  fireEvent.click(screen.getByRole("button", { name: "Clear contour" }));
  expect(onChange).toHaveBeenCalledTimes(3);
  expect(onChange.mock.calls[2][0].contour).toEqual([]);
});

test("disabled suppresses every callback and disables controls", () => {
  const onChange = vi.fn();
  render(
    <TerritorySectionEditor
      value={{ ...initial, contour: [[1, 2, 3]] }}
      onChange={onChange}
      volume={image}
      cursor={[9, 9, 9]}
      disabled
    />,
  );
  for (const name of [
    "Use cursor",
    "Apply plane",
    "Undo point",
    "Clear contour",
  ]) {
    expect(screen.getByRole("button", { name })).toBeDisabled();
  }
  for (const name of ["Plane origin", "Plane normal", "Field of view span"]) {
    expect(screen.getByLabelText(name)).toBeDisabled();
  }
  fireEvent.click(document.querySelector("svg")!, { clientX: 1, clientY: 1 });
  fireEvent.click(screen.getByRole("button", { name: "Apply plane" }));
  fireEvent.click(screen.getByRole("button", { name: "Use cursor" }));
  fireEvent.click(screen.getByRole("button", { name: "Undo point" }));
  fireEvent.click(screen.getByRole("button", { name: "Clear contour" }));
  expect(onChange).not.toHaveBeenCalled();
});

test("label prop names the editor region", () => {
  setup(vi.fn(), { label: "Annulus section editor" });
  expect(
    screen.getByRole("region", { name: "Annulus section editor" }),
  ).toBeInTheDocument();
});
