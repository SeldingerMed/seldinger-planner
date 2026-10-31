import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
const harness = vi.hoisted(() => ({
  image: {
    hdr: {
      dims: [3, 10, 10, 10],
      pixDims: [1, 1, 1, 1],
      xyzt_units: 2,
      sform_code: 1,
    },
    cal_min: 0,
    cal_max: 0,
  },
  instances: [] as Array<{
    frac2mm: ReturnType<typeof vi.fn>;
    mm2frac: ReturnType<typeof vi.fn>;
    loadFromFile: ReturnType<typeof vi.fn>;
  }>,
  attachFails: false,
}));
vi.mock("@niivue/niivue", () => ({
  SLICE_TYPE: { MULTIPLANAR: 3, AXIAL: 0, CORONAL: 1, SAGITTAL: 2, RENDER: 4 },
  SHOW_RENDER: { ALWAYS: 1 },
  Niivue: class {
    volumes: (typeof harness.image)[] = [];
    scene = { crosshairPos: [0.5, 0.5, 0.5] };
    gl = { getExtension: () => null };
    onLocationChange = () => {};
    constructor() {
      harness.instances.push(this);
    }
    async attachToCanvas() {
      if (harness.attachFails) throw new Error("No WebGL");
      return this;
    }
    setSliceType = vi.fn();
    updateGLVolume = vi.fn();
    drawScene = vi.fn();
    removeVolume() {
      this.volumes = [];
    }
    loadFromFile = vi.fn(async (file: File) => {
      if (file.name.startsWith("broken")) throw new Error("Bad image");
      this.volumes = [harness.image];
    });
    frac2mm = vi.fn(() => [1, 2, 3, 1]);
    mm2frac = vi.fn(() => [0.5, 0.5, 0.5]);
  },
}));
import Viewer from "./Viewer";
afterEach(() => {
  cleanup();
  harness.instances.length = 0;
  harness.attachFails = false;
});
const callbacks = () => ({
  onLocation: vi.fn(),
  onLoaded: vi.fn(),
  onError: vi.fn(),
});
test("applies the selected preset after asynchronous volume loading without reloading on preset change", async () => {
  const handlers = callbacks();
  const file = new File(["synthetic"], "fixture.nii");
  const view = render(
    <Viewer
      file={file}
      mode="linked"
      windowRange={[200, 1800]}
      focus={null}
      {...handlers}
    />,
  );
  await waitFor(() => expect(handlers.onLoaded).toHaveBeenCalledOnce());
  expect(harness.image.cal_min).toBe(200);
  expect(harness.image.cal_max).toBe(1800);
  view.rerender(
    <Viewer
      file={file}
      mode="linked"
      windowRange={[0, 100]}
      focus={null}
      {...handlers}
    />,
  );
  expect(harness.image.cal_max).toBe(100);
  expect(harness.instances[0].loadFromFile).toHaveBeenCalledOnce();
});

test("reports a WebGL startup failure once without mislabeling it as an image failure", async () => {
  harness.attachFails = true;
  const handlers = callbacks();
  render(
    <Viewer
      file={new File(["synthetic"], "fixture.nii")}
      mode="linked"
      windowRange={[0, 600]}
      focus={null}
      {...handlers}
    />,
  );
  await waitFor(() => expect(handlers.onError).toHaveBeenCalled());
  expect(handlers.onError).toHaveBeenCalledOnce();
  expect(handlers.onError).toHaveBeenCalledWith(
    expect.stringContaining("WebGL 2"),
  );
  expect(handlers.onLoaded).not.toHaveBeenCalled();
});

test("initial location and evidence focus use the same physical-affine space as NiiVue callbacks", async () => {
  const handlers = callbacks();
  const file = new File(["synthetic"], "fixture.nii");
  const view = render(
    <Viewer
      file={file}
      mode="linked"
      windowRange={[0, 600]}
      focus={null}
      {...handlers}
    />,
  );
  await waitFor(() => expect(handlers.onLoaded).toHaveBeenCalledOnce());
  const nv = harness.instances[0];
  expect(nv.frac2mm).toHaveBeenCalledWith(expect.anything(), 0, true);
  const focus: [number, number, number] = [5, 6, 7];
  view.rerender(
    <Viewer
      file={file}
      mode="linked"
      windowRange={[0, 600]}
      focus={focus}
      {...handlers}
    />,
  );
  expect(nv.mm2frac).toHaveBeenCalledWith(focus, 0, true);
});
