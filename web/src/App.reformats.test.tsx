import { useEffect } from "react";
import { test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import fixture from "./__fixtures__/phase4-secondary-source.json";
import type { NVImage } from "@niivue/niivue";
import App from "./App";
const source = fixture.metadata;
const state = {
  case_id: source.case_id,
  title: "Synthetic app tracer",
  image_sha256: source.image_sha256,
  artifact_version: "1",
  spatial_units: "mm" as const,
  dimensions: source.dimensions,
  spacing_mm: source.spacing_mm,
  source_url: null,
  notes: "",
  measurements: [],
};
const native = {} as NVImage;
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  restoreOrCreateCase: vi.fn(async () => state),
}));
vi.mock("./nativeCaseSource", () => ({
  findNativeCaseSource: vi.fn(async () => source),
}));
vi.mock("./Viewer", () => ({
  default: ({
    file,
    onLoaded,
    onNativeVolume,
  }: {
    file: File;
    onLoaded: (info: unknown) => void;
    onNativeVolume: (v: unknown) => void;
  }) => {
    useEffect(() => {
      onNativeVolume({ file, image: native });
      onLoaded({
        dimensions: source.dimensions,
        spacing_mm: source.spacing_mm,
        spatial_units: "mm",
      });
    }, [file]);
    return <div>Native viewer ready</div>;
  },
}));
vi.mock("./ReformatStudio", () => ({
  default: ({
    volume,
    binding,
  }: {
    volume: NVImage | null;
    binding: { reference_revision: string };
  }) => (
    <section
      aria-label="Live native reformats"
      data-volume={volume === native ? "verified" : "missing"}
      data-revision={binding.reference_revision}
    />
  ),
}));
afterEach(() => {
  cleanup();
  localStorage.clear();
});
test("the actual App binds native reformats to its loaded file and server source", async () => {
  render(<App />);
  const bytes = Uint8Array.from(atob(fixture.nifti_base64), (c) =>
    c.charCodeAt(0),
  ).buffer;
  const file = new File([bytes], "synthetic-cta.nii.gz");
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes });
  fireEvent.change(screen.getByLabelText("Open CTA volume"), {
    target: { files: [file] },
  });
  const studio = await screen.findByRole("region", {
    name: "Live native reformats",
  });
  expect(studio).toHaveAttribute("data-volume", "verified");
  expect(studio).toHaveAttribute("data-revision", source.reference_revision);
});
