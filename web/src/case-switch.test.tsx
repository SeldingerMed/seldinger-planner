import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
vi.mock("./Viewer", () => ({
  default: (props: {
    onLoaded: (info: {
      dimensions: number[];
      spacing_mm: number[];
      spatial_units: "mm";
    }) => void;
  }) => (
    <button
      onClick={() =>
        props.onLoaded({
          dimensions: [10, 10, 10],
          spacing_mm: [1, 1, 1],
          spatial_units: "mm",
        })
      }
    >
      Load synthetic geometry fixture
    </button>
  ),
}));
import App from "./App";
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});
test("switching volumes clears confirmation and inherited source provenance", async () => {
  vi.stubGlobal("crypto", {
    subtle: { digest: vi.fn().mockResolvedValue(new Uint8Array(32).buffer) },
  });
  const source = "https://example.org/public-fixture";
  const state = {
    case_id: "fixture-case",
    title: "Synthetic fixture",
    image_sha256: "0".repeat(64),
    source_url: source,
    dimensions: [10, 10, 10],
    spacing_mm: [1, 1, 1],
    spatial_units: "mm",
    artifact_version: "1",
    notes: "",
    measurements: [],
  };
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(state), { status: 200 })),
  );
  render(<App />);
  fireEvent.change(screen.getByLabelText("Public source URL"), {
    target: { value: source },
  });
  const makeFile = (name: string) =>
    Object.assign(new File(["synthetic-test-only"], name), {
      arrayBuffer: async () => new ArrayBuffer(1),
    });
  fireEvent.change(screen.getByLabelText("Open CTA volume"), {
    target: { files: [makeFile("first.nii")] },
  });
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Load synthetic geometry fixture",
    }),
  );
  await screen.findByText("Workspace connected");
  fireEvent.click(screen.getByLabelText("Public or synthetic data only"));
  expect(screen.getByLabelText("Public or synthetic data only")).toBeChecked();
  fireEvent.change(screen.getByLabelText("Open CTA volume"), {
    target: { files: [makeFile("second.nii")] },
  });
  await waitFor(() =>
    expect(
      screen.getByLabelText("Public or synthetic data only"),
    ).not.toBeChecked(),
  );
  expect(screen.getByLabelText("Public source URL")).toHaveValue("");
});
