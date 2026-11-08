import { afterEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import metadata from "./fixtures/planning-source-metadata.json";
import tightMetadata from "./fixtures/calibrated-source-metadata.json";
import geometryMetadata from "./fixtures/geometry-current-metadata.json";
import deviceCatalog from "./fixtures/device-catalog-metadata.json";
import deviceChecks from "./fixtures/device-checks-current-metadata.json";
import deviceInputs from "./fixtures/device-inputs-current-metadata.json";
import sizingVariants from "./fixtures/device-sizing-synthetic-variants.json";
import * as calibrated from "./calibratedSource";
vi.mock("./ObliqueSection", () => ({
  default: (p: { volume: unknown }) => (
    <div data-testid="native-cta-binding">{p.volume ? "bound" : "none"}</div>
  ),
}));
vi.mock("./Viewer", () => ({
  default: (p: {
    file: File;
    onNativeVolume?: (value: unknown) => void;
    onLoaded: (v: unknown) => void;
    onLocation: (p: [number, number, number]) => void;
    onError: (message: string) => void;
    reference: unknown;
    segmentationBinding?: { reference_revision: string } | null;
    focus?: number[] | null;
  }) => (
    <div>
      <button
        onClick={() =>
          p.onNativeVolume?.({
            file: p.file,
            image: { synthetic: "not image proof" },
          })
        }
      >
        Bind current native fixture
      </button>
      <button
        onClick={() =>
          p.onNativeVolume?.({
            file: new File(["other"], "other.nii"),
            image: { synthetic: "not image proof" },
          })
        }
      >
        Bind wrong-file native fixture
      </button>
      <button
        onClick={() =>
          p.onLoaded({
            dimensions: metadata.dimensions,
            spacing_mm: metadata.spacing_mm,
            spatial_units: "mm",
          })
        }
      >
        Load calibrated geometry fixture
      </button>
      <span data-testid="curated-layer">
        {p.reference ? "curated" : "none"}
      </span>
      <span data-testid="model-source">
        {p.segmentationBinding?.reference_revision ?? "none"}
      </span>
      <span data-testid="viewer-focus">{p.focus?.join(",") ?? "none"}</span>
      <button onClick={() => p.onLocation([1, 2, 3])}>
        Pick geometry point
      </button>
      <button onClick={() => p.onError("Test renderer failure")}>
        Simulate viewer failure
      </button>
    </div>
  ),
}));
import App from "./App";
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("opens calibrated image-only source with mm evidence and model controls, no curated layer", async () => {
  // Real API metadata snapshot; synthetic file/viewer only, not image/model proof.
  const file = Object.assign(
    new File(["synthetic UI bytes"], "context-cta.nii.gz"),
    { arrayBuffer: async () => new ArrayBuffer(1) },
  );
  vi.spyOn(calibrated, "loadCalibratedVolume").mockResolvedValue({
    file,
    metadata: metadata as calibrated.CalibratedSourceMetadata,
  });
  vi.spyOn(calibrated, "findCaseImageSource").mockImplementation(
    async (id) => ({ ...metadata, case_id: id }) as calibrated.CaseImageSource,
  );
  vi.stubGlobal("crypto", {
    subtle: {
      digest: async () =>
        Uint8Array.from(
          metadata.image_sha256.match(/../g)!.map((x) => parseInt(x, 16)),
        ).buffer,
    },
  });
  let deferCompute = false;
  let finishCompute!: (r: Response) => void;
  let deferSizing = false;
  let finishSizing!: (r: Response) => void;
  let savedCase: unknown;
  // Synthetic UI rebinding only, not a ledger/hash or real-case measurement proof.
  const sizingReport = JSON.parse(
    JSON.stringify(sizingVariants.partial),
    (k, v) =>
      (
        ({
          case_id: "calibrated-ui-fixture",
          image_sha256: metadata.image_sha256,
          artifact_version: "1",
          reference_revision: metadata.reference_revision,
          source_revision: metadata.reference_revision,
        }) as Record<string, string>
      )[k] ?? v,
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (
        deferCompute &&
        url.endsWith("/morphometry") &&
        init?.method === "POST"
      )
        return new Promise<Response>((resolve) => {
          finishCompute = resolve;
        });
      if (url.includes("/territory-workflows/"))
        return new Response(
          JSON.stringify({
            case_id: "calibrated-ui-fixture",
            image_sha256: metadata.image_sha256,
            artifact_version: "1",
            reference_revision: metadata.reference_revision,
            mode: url.split("/").at(-1),
            workflow_revision: 0,
            current: { status: "not_computed" },
          }),
        );
      if (url.endsWith("/segmentations"))
        return new Response(
          JSON.stringify({ current: { vessel: null, aneurysm: null } }),
        );
      if (url.endsWith("/device-catalog"))
        return new Response(JSON.stringify(deviceCatalog));
      if (url.endsWith("/device-sizing")) {
        if (deferSizing && init?.method === "POST")
          return new Promise<Response>((resolve) => {
            finishSizing = resolve;
          });
        return new Response(JSON.stringify(sizingReport));
      }
      if (url.endsWith("/device-sizing-inputs"))
        return new Response(
          JSON.stringify({
            ...deviceInputs,
            case_id: "calibrated-ui-fixture",
            artifact_version: "1",
            inputs: {
              ...deviceInputs.inputs,
              geometry_dependencies: {
                ...deviceInputs.inputs.geometry_dependencies,
                case_id: "calibrated-ui-fixture",
                artifact_version: "1",
              },
            },
          }),
        );
      if (url.endsWith("/device-checks"))
        return new Response(
          JSON.stringify({
            ...deviceChecks,
            case_id: "calibrated-ui-fixture",
            artifact_version: "1",
            dependencies: {
              ...deviceChecks.dependencies,
              geometry: {
                ...deviceChecks.dependencies.geometry,
                case_id: "calibrated-ui-fixture",
                artifact_version: "1",
              },
            },
          }),
        );
      if (url.endsWith("/morphometry"))
        return new Response(
          JSON.stringify({
            ...geometryMetadata,
            case_id: "calibrated-ui-fixture",
            artifact_version: "1",
            current: {
              ...geometryMetadata.current,
              dependencies: {
                ...geometryMetadata.current.dependencies,
                case_id: "calibrated-ui-fixture",
                artifact_version: "1",
              },
            },
          }),
        );
      if (url === "/api/cases") {
        savedCase = {
          ...JSON.parse(String(init?.body)),
          case_id: "calibrated-ui-fixture",
          artifact_version: "1",
          notes: "",
          measurements: [],
          aneurysm_plan: null,
        };
        return new Response(JSON.stringify(savedCase));
      }
      if (url === "/api/cases/calibrated-ui-fixture")
        return new Response(JSON.stringify(savedCase));
      throw new Error("Unexpected fixture request: " + url);
    }),
  );
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Open calibrated CTA" }));
  expect(calibrated.loadCalibratedVolume).toHaveBeenCalledWith(
    "zenodo-case006-planning-context",
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Load calibrated geometry fixture",
    }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Run aneurysm model" }),
    ).toBeEnabled(),
  );
  expect(screen.getByTestId("curated-layer")).toHaveTextContent("none");
  expect(screen.getByTestId("model-source")).toHaveTextContent(
    metadata.reference_revision,
  );
  expect(
    screen.queryByText("Curated dataset reference"),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Calibrated public CTA context")).toBeInTheDocument();
  expect(
    screen.queryByText(/Millimeter measurements are disabled/),
  ).not.toBeInTheDocument();
  expect(calibrated.findCaseImageSource).toHaveBeenCalledWith(
    "calibrated-ui-fixture",
    metadata.image_sha256,
  );
  expect(await screen.findByText("Current estimate")).toBeInTheDocument();
  expect(
    screen
      .getAllByTestId("native-cta-binding")
      .every((e) => e.textContent === "none"),
  ).toBe(true);
  fireEvent.click(
    screen.getByRole("button", { name: "Bind wrong-file native fixture" }),
  );
  expect(
    screen
      .getAllByTestId("native-cta-binding")
      .every((e) => e.textContent === "none"),
  ).toBe(true);
  fireEvent.click(
    screen.getByRole("button", { name: "Bind current native fixture" }),
  );
  expect(
    screen
      .getAllByTestId("native-cta-binding")
      .every((e) => e.textContent === "bound"),
  ).toBe(true);
  // Real App mode routing and dirty feedback, with explicit synthetic UI bytes.
  fireEvent.click(screen.getByRole("button", { name: "Cardiac and aortic" }));
  await screen.findByRole("heading", { name: "Territory planning" });
  await screen.findByRole("button", { name: "Set left coronary ostium" });
  expect(
    screen.queryByRole("button", { name: "Run aneurysm model" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Pick geometry point" }));
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
  await screen.findByRole("button", { name: "Run aneurysm model" });
  fireEvent.click(
    screen.getByRole("button", { name: "Bind wrong-file native fixture" }),
  );
  expect(
    screen
      .getAllByTestId("native-cta-binding")
      .every((e) => e.textContent === "none"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Locate neck origin" }));
  expect(await screen.findByTestId("dr-badge")).toHaveTextContent(
    "Missing sizing inputs",
  );
  expect(screen.getByTestId("viewer-focus")).toHaveTextContent(
    geometryMetadata.current.result.neck.plane_origin.join(","),
  );
  expect(
    await screen.findByRole("button", { name: "Calculate saved inputs" }),
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Calculate saved inputs" }),
    ).toBeEnabled(),
  );
  deferSizing = true;
  fireEvent.click(
    screen.getByRole("button", { name: "Calculate saved inputs" }),
  );
  expect(
    screen.getByRole("button", { name: "Open calibrated CTA" }),
  ).toBeDisabled();
  await act(async () => {
    finishSizing(
      new Response(
        JSON.stringify({
          ...sizingReport,
          current: {
            ...sizingReport.current,
            result_id: "synthetic-calculated-result",
          },
        }),
      ),
    );
  });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Open calibrated CTA" }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByText("Enter independent sizing values"));
  const sizing = await screen.findByTestId("sizing-input-dome_diameter");
  fireEvent.change(sizing, { target: { value: "7" } }); // SYNTHETIC UI edit, not real-case measurement.
  expect(screen.getByTestId("sizing-save")).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "Calculate saved inputs" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Open calibrated CTA" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Run aneurysm model" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByTestId("sizing-discard"));
  expect(
    screen.getByRole("button", { name: "Open calibrated CTA" }),
  ).toBeEnabled();
  fireEvent.click(screen.getByText("Set geometry landmarks"));
  // A local key refresh is not the lock authority: root conflict disables input saves.
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Calculate saved inputs" }),
    ).toBeEnabled(),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Calculate saved inputs" }),
  );
  await act(async () =>
    finishSizing(
      new Response(
        JSON.stringify({ ...sizingReport, geometry_status: "stale" }),
      ),
    ),
  );
  expect(await screen.findByText(/Calculation is locked/)).toBeInTheDocument();
  expect(screen.getByTestId("sizing-input-dome_diameter")).toBeDisabled();
  fireEvent.change(screen.getByTestId("sizing-input-dome_diameter"), {
    target: { value: "9" },
  });
  fireEvent.click(screen.getByTestId("sizing-save"));
  expect(
    screen.getByRole("button", { name: "Calculate saved inputs" }),
  ).toBeDisabled();
  expect(
    vi
      .mocked(fetch)
      .mock.calls.filter(
        ([url, init]) =>
          String(url).endsWith("/device-sizing-inputs") &&
          init?.method === "PUT",
      ),
  ).toHaveLength(0);
  expect(screen.getByText(/Calculation is locked/)).toBeInTheDocument();
  sizingReport.current.result_id = "unconfirmed-synthetic-result";
  fireEvent.click(
    screen.getByRole("button", { name: "Reload saved state (discard edits)" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Calculate saved inputs" }),
    ).toBeEnabled(),
  );
  await screen.findByText("Geometry landmarks");
  fireEvent.click(screen.getByRole("button", { name: "Pick geometry point" }));
  fireEvent.click(screen.getByRole("button", { name: "Set neck origin" }));
  expect(screen.queryByText("Current estimate")).not.toBeInTheDocument();
  expect(screen.queryByTestId("dr-badge")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Open calibrated CTA" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Run aneurysm model" }),
  ).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", { name: "Discard geometry edits" }),
  );
  expect(await screen.findByText("Current estimate")).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Compute mask geometry" }),
  );
  await waitFor(() =>
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(
          ([url, init]) =>
            String(url).endsWith("/morphometry") && init?.method === "POST",
        ),
    ).toBe(true),
  );
  expect(await screen.findByText("Current estimate")).toBeInTheDocument();
  // A renderer reset must not forget a still-running geometry operation.
  deferCompute = true;
  fireEvent.click(
    screen.getByRole("button", { name: "Compute mask geometry" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Simulate viewer failure" }),
  );
  expect(
    screen.getByRole("button", { name: "Open calibrated CTA" }),
  ).toBeDisabled();
  await act(async () => {
    finishCompute(new Response(JSON.stringify(geometryMetadata)));
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Open calibrated CTA" }),
    ).toBeEnabled(),
  );
});

test.each([metadata, tightMetadata])(
  "actual API producer metadata satisfies case-source transport validator: $source_id",
  async (metadata) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ ...metadata, case_id: "producer-conformance" }),
          ),
      ),
    );
    const result = await calibrated.findCaseImageSource(
      "producer-conformance",
      metadata.image_sha256,
    );
    expect(result?.reference_revision).toBe(metadata.reference_revision);
    expect(result?.reference_revision).not.toBe(result?.image_sha256);
    expect(result?.clinical_validation).toBe(false);
  },
);
