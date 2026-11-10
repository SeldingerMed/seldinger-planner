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
type StudioProps = {
  volume: NVImage | null;
  binding: { reference_revision: string };
  disabled?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
};
const studio = vi.hoisted(
  () => (label: string) =>
    function Studio({ volume, binding, disabled, onDirtyChange }: StudioProps) {
      return (
        <section
          aria-label={label}
          data-volume={volume === native ? "verified" : "missing"}
          data-revision={binding.reference_revision}
          data-disabled={String(!!disabled)}
        >
          <button onClick={() => onDirtyChange?.(true)}>{label} dirty</button>
          <button onClick={() => onDirtyChange?.(false)}>{label} clean</button>
        </section>
      );
    },
);
vi.mock("./ReformatStudio", () => ({ default: studio("Reformats") }));
vi.mock("./CArmStudio", () => ({ default: studio("C-arm") }));
afterEach(() => {
  cleanup();
  localStorage.clear();
});
test("the App binds C-arm planning to the verified source and isolates unsaved drafts", async () => {
  render(<App />);
  const bytes = Uint8Array.from(atob(fixture.nifti_base64), (c) =>
    c.charCodeAt(0),
  ).buffer;
  const file = new File([bytes], "synthetic-cta.nii.gz");
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes });
  fireEvent.change(screen.getByLabelText("Open CTA volume"), {
    target: { files: [file] },
  });
  const carm = await screen.findByRole("region", { name: "C-arm" });
  const reformats = screen.getByRole("region", { name: "Reformats" });
  expect(carm).toHaveAttribute("data-volume", "verified");
  expect(carm).toHaveAttribute("data-revision", source.reference_revision);
  expect(screen.getByRole("link", { name: "C-arm views" })).toHaveAttribute(
    "href",
    "#carm-views",
  );
  expect(carm).toHaveAttribute("data-disabled", "false");
  expect(reformats).toHaveAttribute("data-disabled", "false");
  // An unsaved C-arm draft pauses the reformat studio, and the reverse.
  fireEvent.click(screen.getByRole("button", { name: "C-arm dirty" }));
  expect(reformats).toHaveAttribute("data-disabled", "true");
  expect(carm).toHaveAttribute("data-disabled", "false");
  fireEvent.click(screen.getByRole("button", { name: "C-arm clean" }));
  expect(reformats).toHaveAttribute("data-disabled", "false");
  fireEvent.click(screen.getByRole("button", { name: "Reformats dirty" }));
  expect(carm).toHaveAttribute("data-disabled", "true");
  expect(reformats).toHaveAttribute("data-disabled", "false");
});
