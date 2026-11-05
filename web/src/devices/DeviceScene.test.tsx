import { render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({
  mesh: vi.fn(),
  clip: vi.fn(),
  opacity: vi.fn(),
  release: vi.fn(),
  scale: vi.fn(),
  volumes: [] as any[],
  options: null as any,
}));
vi.mock("@niivue/niivue", () => ({
  SLICE_TYPE: { RENDER: 4, MULTIPLANAR: 3 },
  MULTIPLANAR_TYPE: { GRID: 2 },
  SHOW_RENDER: { ALWAYS: 1 },
  Niivue: class {
    constructor(options: any) {
      calls.options = options;
    }
    volumes: any[] = [];
    meshes: any[] = [];
    scene = { crosshairPos: [0, 0, 0] };
    onLocationChange = () => {};
    attachToCanvas = async () => {};
    loadFromFile = async () => {
      this.volumes = [{ opacity: 1, cal_min: 0, cal_max: 600 }];
      calls.volumes = this.volumes;
    };
    addMeshesFromUrl = async (d: any[]) => {
      calls.mesh(d);
      const m = d.map((x) => ({ ...x, id: x.name }));
      this.meshes.push(...m);
      return m;
    };
    removeMesh(m: any) {
      this.meshes = this.meshes.filter((x) => x !== m);
    }
    setSliceType() {}
    setScale = calls.scale;
    setRenderAzimuthElevation() {}
    drawScene() {}
    updateGLVolume() {}
    setClipPlane = calls.clip;
    _gl = { getExtension: () => ({ loseContext: calls.release }) };
  },
}));
import DeviceScene from "./DeviceScene";
it("loads original CTA and device RAS mesh while clipping remains a display operation", async () => {
  const file = new File(["fixture"], "synthetic.nii");
  const mesh = {
    id: "one",
    buffer: new ArrayBuffer(134),
    color: [250, 180, 70, 255] as [number, number, number, number],
    opacity: 1,
  };
  const { unmount } = render(
    <DeviceScene
      file={file}
      meshes={[mesh]}
      clip={0.2}
      ctaOpacity={0.3}
      zoom={1.5}
      windowRange={[0, 600]}
      layout="linked"
      focus={null}
      onLocation={() => {}}
      onError={() => {}}
    />,
  );
  await waitFor(() => expect(calls.mesh).toHaveBeenCalled());
  expect(calls.mesh.mock.calls[0][0][0].buffer).toBe(mesh.buffer);
  expect(calls.mesh.mock.calls[0][0][0].name).toBe("one.stl");
  expect(calls.clip).toHaveBeenCalledWith([0.2, 270, 0]);
  expect(calls.volumes[0].opacity).toBe(1);
  expect(calls.options.multiplanarLayout).toBe(2);
  expect(calls.scale).toHaveBeenLastCalledWith(1.5);
  unmount();
  expect(calls.release).toHaveBeenCalled();
});
