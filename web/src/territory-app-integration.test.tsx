import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import source from "./__fixtures__/territory-native-source.json";
vi.mock("./Viewer", () => ({
  default: (p: {
    file: File;
    onNativeVolume: (v: unknown) => void;
    onLoaded: (v: unknown) => void;
    onLocation: (point: [number, number, number]) => void;
  }) => (
    <>
      <button
        onClick={() => {
          p.onNativeVolume({
            file: p.file,
            image: { synthetic: "UI fixture only" },
          });
          p.onLoaded({
            dimensions: source.dimensions,
            spacing_mm: source.spacing_mm,
            spatial_units: "mm",
          });
        }}
      >
        Load synthetic installed volume
      </button>
      <button onClick={() => p.onLocation([16, 16, 16])}>
        Pick native point
      </button>
    </>
  ),
}));
import App from "./App";
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});
test("actual App enables territory workflows for an operator-opened, server-installed native source, without aneurysm geometry", async () => {
  vi.stubGlobal("crypto", {
    subtle: {
      digest: async () =>
        Uint8Array.from(
          source.image_sha256.match(/../g)!.map((x) => parseInt(x, 16)),
        ).buffer,
    },
  });
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/cases")
      return new Response(
        JSON.stringify({
          ...JSON.parse(String(init?.body)),
          case_id: source.case_id,
          artifact_version: "1",
          notes: "",
          measurements: [],
          aneurysm_plan: null,
        }),
      );
    if (url.endsWith("/image-source"))
      return new Response(JSON.stringify(source));
    if (url.includes("/territory-workflows/"))
      return new Response(
        JSON.stringify({
          case_id: source.case_id,
          image_sha256: source.image_sha256,
          artifact_version: "1",
          reference_revision: source.reference_revision,
          mode: url.split("/").at(-1),
          workflow_revision: 0,
          current: { status: "not_computed" },
        }),
      );
    if (url.endsWith("/segmentations"))
      return new Response(
        JSON.stringify({ current: { vessel: null, aneurysm: null } }),
      );
    return new Response("", { status: 404 });
  });
  vi.stubGlobal("fetch", fetcher);
  const file = Object.assign(
    new File(["synthetic UI bytes"], "synthetic.nii.gz"),
    { arrayBuffer: async () => new ArrayBuffer(1) },
  );
  render(<App />);
  fireEvent.change(screen.getByLabelText("Open CTA volume"), {
    target: { files: [file] },
  });
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Load synthetic installed volume",
    }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Cardiac and aortic" }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Cardiac and aortic" }));
  await screen.findByRole("button", { name: "Set left coronary ostium" });
  expect(
    screen.getByRole("button", { name: "Save and calculate" }),
  ).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Run aneurysm model" }),
  ).not.toBeInTheDocument();
  // Dedicated mode/dirty feedback tracer, separate from the long public-neuro test.
  fireEvent.click(screen.getByRole("button", { name: "Pick native point" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Set left coronary ostium" }),
  );
  expect(screen.getByRole("button", { name: "Neurovascular" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Open calibrated CTA" }),
  ).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Discard draft and reload saved workflow",
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Neurovascular" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Neurovascular" }));
  expect(
    await screen.findByRole("heading", { name: /^Aneurysm worksheet/ }),
  ).toBeInTheDocument();
});
