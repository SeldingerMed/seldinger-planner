/** Tests for the controlled path profile editor: real controlled callbacks,
 * path editing with profile clearing, path-tangent profile planes, lumen /
 * outer wall / thrombus / calcification layers, unknown vs explicitly-empty
 * classes, profile choice/removal, and the disabled gate.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useState } from "react";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import type { NVImage } from "@niivue/niivue";
import TerritoryPathEditor, { type PathProfiles } from "./TerritoryPathEditor";
import type { Vec3 } from "./obliqueSlice";

vi.hoisted(() => {
  // jsdom has no DOMPoint; provide the minimal DOMPoint.matrixTransform used
  // by the SVG pick path (same polyfill as TerritorySectionEditor tests).
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
  // jsdom lacks SVG/canvas APIs used by the pick and raster paths.
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
});

const harness = vi.hoisted(() => ({ sample: vi.fn() }));
vi.mock("./obliqueSlice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./obliqueSlice")>()),
  sampleObliqueSlice: harness.sample,
}));

const image = {} as NVImage;

const profile = (station: number, origin: Vec3, normal: Vec3) => ({
  station,
  section: { origin, normal, contour: [] },
  outer_wall: null,
  thrombus: null,
  calcification: null,
});

const base: PathProfiles = {
  path: [
    [0, 0, 0],
    [2, 0, 0],
    [4, 0, 0],
  ],
  profiles: [],
};

function setup(initial: PathProfiles, disabled = false) {
  const calls: PathProfiles[] = [];
  function Harness({ disabled: off }: { disabled: boolean }) {
    const [value, setValue] = useState(initial);
    return (
      <TerritoryPathEditor
        value={value}
        onChange={(v) => {
          calls.push(v);
          setValue(v);
        }}
        volume={image}
        cursor={[6, 0, 0]}
        disabled={off}
        label="Path profiles"
      />
    );
  }
  const view = render(<Harness disabled={disabled} />);
  return {
    calls,
    setDisabled: (off: boolean) => view.rerender(<Harness disabled={off} />),
  };
}

function click(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  harness.sample.mockReset();
});

beforeEach(() => {
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
});

test.each([false, true])(
  "removing the last annotation explicitly announces unknown, never invents observed zero (prior zero %s)",
  (priorZero) => {
    const { calls } = setup({
      ...base,
      profiles: [profile(0, [0, 0, 0], [1, 0, 0])],
    });
    click("Profile at station 0");
    if (priorZero) click("No thrombus observed");
    click("Add thrombus region");
    click("Remove thrombus region 1");
    expect(calls.at(-1)!.profiles[0].thrombus).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("class is unknown");
    click("No thrombus observed");
    expect(calls.at(-1)!.profiles[0].thrombus).toEqual([]);
    expect(screen.queryByText(/class is unknown/)).not.toBeInTheDocument();
  },
);

test("duplicate and blank station drafts never append an ambiguous profile", () => {
  const { calls } = setup({
    ...base,
    profiles: [profile(0, [0, 0, 0], [1, 0, 0])],
  });
  click("Add profile at station");
  expect(calls).toHaveLength(0);
  fireEvent.change(screen.getByLabelText("Profile station"), {
    target: { value: "" },
  });
  click("Add profile at station");
  expect(calls).toHaveLength(0);
});
test("switching profiles resets the plane drafts to the selected section", () => {
  setup({
    ...base,
    profiles: [
      profile(0, [0, 0, 0], [1, 0, 0]),
      profile(2, [4, 0, 0], [1, 0, 0]),
    ],
  });
  click("Profile at station 0");
  click("Profile at station 2");
  expect(screen.getByLabelText("Plane origin")).toHaveValue("4, 0, 0");
});
test("class annotations can return to unknown and individual regions can be removed", () => {
  const p = profile(0, [0, 0, 0], [1, 0, 0]);
  const { calls } = setup({ ...base, profiles: [p] });
  click("Profile at station 0");
  click("Add thrombus region");
  click("Add thrombus region");
  click("Remove thrombus region 1");
  expect(calls.at(-1)!.profiles[0].thrombus).toHaveLength(1);
  click("Mark thrombus unknown");
  expect(calls.at(-1)!.profiles[0].thrombus).toBeNull();
});

test("appends the cursor point to the path through onChange", () => {
  const { calls } = setup(base);
  click("Append cursor point");
  expect(calls).toHaveLength(1);
  expect(calls[0].path).toEqual([
    [0, 0, 0],
    [2, 0, 0],
    [4, 0, 0],
    [6, 0, 0],
  ]);
  expect(calls[0].profiles).toEqual([]);
  expect(screen.getByText("Path points: 4")).toBeTruthy();
});

test("changing the path clears profiles and says so explicitly", () => {
  const start: PathProfiles = {
    path: base.path,
    profiles: [profile(1, [2, 0, 0], [2, 0, 0])],
  };
  const { calls } = setup(start);
  click("Append cursor point");
  expect(calls).toHaveLength(1);
  expect(calls[0].profiles).toEqual([]);
  expect(screen.getByRole("status").textContent).toMatch(/profiles cleared/i);
});

test("undo path point removes the last point", () => {
  const { calls } = setup(base);
  click("Undo path point");
  expect(calls).toHaveLength(1);
  expect(calls[0].path).toEqual([
    [0, 0, 0],
    [2, 0, 0],
  ]);
});

test("path length is capped at 128 points", () => {
  const longPath = Array.from({ length: 128 }, (_, i) => [i, 0, 0] as Vec3);
  setup({ path: longPath, profiles: [] });
  expect(
    (
      screen.getByRole("button", {
        name: "Append cursor point",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

test("adds a profile whose plane origin is the path point and normal is the centered tangent", () => {
  const { calls } = setup(base);
  const station = screen.getByLabelText("Profile station");
  fireEvent.change(station, { target: { value: "1" } });
  click("Add profile at station");
  expect(calls).toHaveLength(1);
  expect(calls[0].profiles).toHaveLength(1);
  expect(calls[0].profiles[0]).toEqual({
    station: 1,
    section: { origin: [2, 0, 0], normal: [4, 0, 0], contour: [] },
    outer_wall: null,
    thrombus: null,
    calcification: null,
  });
});

test("uses a forward difference for the normal at path endpoints", () => {
  const { calls } = setup(base);
  const station = screen.getByLabelText("Profile station");
  fireEvent.change(station, { target: { value: "2" } });
  click("Add profile at station");
  expect(calls[0].profiles[0].section.normal).toEqual([2, 0, 0]);
  expect(calls[0].profiles[0].section.origin).toEqual([4, 0, 0]);
});

test("profiles stay sorted by station and the cap is 32", () => {
  const start: PathProfiles = {
    path: base.path,
    profiles: [profile(2, [4, 0, 0], [2, 0, 0])],
  };
  const { calls } = setup(start);
  const station = screen.getByLabelText("Profile station");
  fireEvent.change(station, { target: { value: "0" } });
  click("Add profile at station");
  expect(calls[0].profiles.map((p) => p.station)).toEqual([0, 2]);
  expect(screen.getByText("Profiles: 2 / 32")).toBeTruthy();
});

test("chooses a profile and traces its lumen through the section editor", () => {
  const start: PathProfiles = {
    path: base.path,
    profiles: [
      profile(0, [0, 0, 0], [2, 0, 0]),
      profile(1, [2, 0, 0], [4, 0, 0]),
    ],
  };
  const { calls } = setup(start);
  click("Profile at station 0");
  const origin = screen.getByLabelText("Plane origin") as HTMLInputElement;
  expect(origin.value).toBe("0, 0, 0");
  // A contour pick from the traced section editor updates the lumen section.
  harness.sample.mockReturnValueOnce({
    width: 2,
    height: 2,
    rgba: new Uint8ClampedArray(16).fill(255),
    outside: 0,
  });
  fireEvent.click(document.querySelector("svg")!, { clientX: 8, clientY: 8 });
  expect(calls.length).toBeGreaterThan(0);
  const last = calls[calls.length - 1];
  expect(last.profiles[0].section.contour).toHaveLength(1);
});

test("outer wall is optional: empty new region and clear back to null", () => {
  const start: PathProfiles = {
    path: base.path,
    profiles: [profile(1, [2, 0, 0], [4, 0, 0])],
  };
  const { calls } = setup(start);
  click("Profile at station 1");
  click("Add outer wall region");
  expect(calls[0].profiles[0].outer_wall).toEqual({
    origin: [2, 0, 0],
    normal: [4, 0, 0],
    contour: [],
  });
  click("Clear outer wall");
  expect(calls[calls.length - 1].profiles[0].outer_wall).toBeNull();
});

test("thrombus: unknown is null and explicit none-observed is empty", () => {
  const start: PathProfiles = {
    path: base.path,
    profiles: [profile(1, [2, 0, 0], [4, 0, 0])],
  };
  const { calls } = setup(start);
  click("Profile at station 1");
  click("No thrombus observed");
  expect(calls[0].profiles[0].thrombus).toEqual([]);
  click("Add thrombus region");
  const thrombus = calls[calls.length - 1].profiles[0].thrombus;
  expect(thrombus).toHaveLength(1);
  // Region starts EMPTY in the same plane as the lumen section.
  expect(thrombus![0]).toEqual({
    origin: [2, 0, 0],
    normal: [4, 0, 0],
    contour: [],
  });
});

test("calcification: unknown is null and regions are capped at 8 per class", () => {
  const start: PathProfiles = {
    path: base.path,
    profiles: [profile(1, [2, 0, 0], [4, 0, 0])],
  };
  const { calls } = setup(start);
  click("Profile at station 1");
  click("No calcification observed");
  expect(calls[0].profiles[0].calcification).toEqual([]);
  for (let i = 0; i < 8; i++) click("Add calcification region");
  const last = calls[calls.length - 1];
  expect(last.profiles[0].calcification).toHaveLength(8);
  const add = screen.getByRole("button", {
    name: "Add calcification region",
  }) as HTMLButtonElement;
  expect(add.disabled).toBe(true);
});

test("removes a chosen profile", () => {
  const start: PathProfiles = {
    path: base.path,
    profiles: [
      profile(0, [0, 0, 0], [2, 0, 0]),
      profile(1, [2, 0, 0], [4, 0, 0]),
    ],
  };
  const { calls } = setup(start);
  click("Profile at station 0");
  click("Remove profile at station 0");
  expect(calls[calls.length - 1].profiles.map((p) => p.station)).toEqual([1]);
});

test("disabled gates every mutation", () => {
  const start: PathProfiles = {
    path: base.path,
    profiles: [profile(1, [2, 0, 0], [4, 0, 0])],
  };
  const { calls, setDisabled } = setup(start);
  click("Profile at station 1");
  setDisabled(true);
  for (const name of [
    "Append cursor point",
    "Undo path point",
    "Add profile at station",
    "Add outer wall region",
    "No thrombus observed",
    "Add calcification region",
    "Remove profile at station 1",
  ]) {
    click(name);
  }
  expect(calls).toHaveLength(0);
});
