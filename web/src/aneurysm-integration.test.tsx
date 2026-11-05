import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
vi.mock("./Viewer", () => ({
  default: (p: {
    onLoaded: (v: unknown) => void;
    onLocation: (v: number[]) => void;
    focus: number[] | null;
    file: File;
    reference?: { case_id: string } | null;
  }) => (
    <div>
      <button
        onClick={() =>
          p.onLoaded({
            dimensions: [16, 16, 16],
            spacing_mm: [1, 1, 1],
            spatial_units:
              p.file.name === "reference-cta.nii.gz" ? "unknown" : "mm",
          })
        }
      >
        Load geometry test
      </button>
      <button onClick={() => p.onLocation([1, 2, 3])}>
        Choose test target
      </button>
      {p.focus && <span>Focused {p.focus.join(",")}</span>}
      <span data-testid="reference-scope">
        {p.reference?.case_id ?? "none"}
      </span>
    </div>
  ),
}));
import App from "./App";
import * as referenceFunctions from "./reference";
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("opens a scoped curated reference and clears it on another volume", async () => {
  const metadata: referenceFunctions.ReferenceMetadata = {
    case_label: "CMHA AHMU1218001",
    source_url: "https://doi.org/10.6084/m9.figshare.26965450.v1",
    license_url: "https://creativecommons.org/licenses/by/4.0/",
    citation: "Synthetic contract test",
    image_sha256: "0".repeat(64),
    image_url: "/api/reference-volume",
    reference_revision: "a".repeat(64),
    spatial_units: "unknown",
    alignment_status: "candidate_image_consistent",
    method: "curated_dataset_annotation",
    focus_ras: [-1, 2, 3],
  };
  const file = Object.assign(new File(["synthetic"], "reference-cta.nii.gz"), {
    arrayBuffer: async () => new ArrayBuffer(1),
  });
  vi.spyOn(referenceFunctions, "loadReferenceVolume").mockResolvedValue({
    file,
    metadata,
  });
  vi.stubGlobal("crypto", {
    subtle: {
      digest: vi
        .fn()
        .mockResolvedValueOnce(new Uint8Array(32).buffer)
        .mockResolvedValueOnce(new Uint8Array(32).fill(1).buffer),
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/segmentations"))
        return new Response(
          JSON.stringify({ current: { vessel: null, aneurysm: null } }),
        );
      if (url.endsWith("/reference"))
        return new Response(
          JSON.stringify({
            ...metadata,
            case_id: "reference-case",
            annotations: ["aneurysm", "artery"].map((id) => ({
              id,
              sha256: "b".repeat(64),
              triangle_count: 1,
              url: `/api/cases/reference-case/reference/${"a".repeat(64)}/${id}.stl`,
            })),
          }),
        );
      const body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          ...body,
          case_id: body.image_sha256.startsWith("00")
            ? "reference-case"
            : "other-case",
          artifact_version: "1",
          notes: "",
          measurements: [],
          aneurysm_plan: null,
        }),
      );
    }),
  );
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Open reference CTA" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Load geometry test" }),
  );
  await waitFor(() =>
    expect(screen.getByTestId("reference-scope")).toHaveTextContent(
      "reference-case",
    ),
  );
  expect(screen.getByText("Curated dataset reference")).toBeInTheDocument();
  // Inference now waits for the accepted-mask snapshot, not only reference geometry.
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Run vessel model" }),
    ).toBeEnabled(),
  );
  expect(screen.getByRole("button", { name: "Set point A" })).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", { name: "Focus reference target" }),
  );
  expect(screen.getByText("Focused -1,2,3")).toBeInTheDocument();
  const other = Object.assign(new File(["synthetic"], "other.nii"), {
    arrayBuffer: async () => new ArrayBuffer(1),
  });
  fireEvent.change(screen.getByLabelText("Open CTA volume"), {
    target: { files: [other] },
  });
  await screen.findByText("other.nii");
  fireEvent.click(screen.getByRole("button", { name: "Load geometry test" }));
  await waitFor(() =>
    expect(screen.getByTestId("reference-scope")).toHaveTextContent("none"),
  );
  expect(
    screen.queryByText("Curated dataset reference"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Run vessel model" }),
  ).not.toBeInTheDocument();
});

test("saves an image-linked worksheet and gates Muse on the saved revision", async () => {
  vi.stubGlobal("crypto", {
    subtle: { digest: vi.fn().mockResolvedValue(new Uint8Array(32).buffer) },
  });
  let state: Record<string, unknown> = {
    case_id: "synthetic-plan-case",
    title: "Synthetic geometry",
    image_sha256: "0".repeat(64),
    source_url: null,
    dimensions: [16, 16, 16],
    spacing_mm: [1, 1, 1],
    spatial_units: "mm",
    artifact_version: "1",
    notes: "",
    measurements: [],
    aneurysm_plan: null,
  };
  const writes: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/aneurysm-plan")) {
        const body = JSON.parse(String(init?.body));
        writes.push(body);
        state = { ...state, artifact_version: "2", aneurysm_plan: body.plan };
      }
      return new Response(JSON.stringify(state), { status: 200 });
    }),
  );
  render(<App />);
  const file = Object.assign(
    new File(["analytic-test-only"], "synthetic.nii"),
    { arrayBuffer: async () => new ArrayBuffer(1) },
  );
  fireEvent.change(screen.getByLabelText("Open CTA volume"), {
    target: { files: [file] },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Load geometry test" }),
  );
  await screen.findByText("Workspace connected");
  fireEvent.click(screen.getByLabelText("Public or synthetic data only"));
  expect(screen.getByRole("button", { name: "Ask Muse" })).toBeEnabled();
  fireEvent.change(screen.getByLabelText("Aneurysm label"), {
    target: { value: "Operator target" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Choose test target" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Use crosshair as target" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Ask Muse" })).toBeDisabled(),
  );
  fireEvent.click(screen.getByLabelText("Flow diversion"));
  fireEvent.click(screen.getByRole("button", { name: "Save aneurysm plan" }));
  await waitFor(() =>
    expect(writes).toEqual([
      expect.objectContaining({
        artifact_version: "1",
        plan: expect.objectContaining({
          lesion_label: "Operator target",
          focus_ras: [1, 2, 3],
          options: ["flow_diversion"],
          measurement_links: {},
          rupture_status: "unknown",
        }),
      }),
    ]),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Ask Muse" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "View target" }));
  expect(screen.getByText("Focused 1,2,3")).toBeInTheDocument();
});

test("shows the fixed source receipt only after Muse reads it", async () => {
  vi.stubGlobal("crypto", {
    subtle: { digest: vi.fn().mockResolvedValue(new Uint8Array(32).buffer) },
  });
  const state = {
    case_id: "source-fixture",
    title: "Synthetic sources test",
    image_sha256: "0".repeat(64),
    source_url: null,
    dimensions: [16, 16, 16],
    spacing_mm: [1, 1, 1],
    spatial_units: "mm",
    artifact_version: "1",
    notes: "",
    measurements: [],
  };
  const source = {
    id: "ESO_UIA_2022",
    title: "ESO UIA guideline (2022)",
    url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC9446328/",
    population: "Unruptured intracranial aneurysms",
    section: "PICO 1 and 2",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("/agent")
              ? {
                  answer: "Evidence gaps remain.",
                  tool_names: ["read_case_plan", "read_planning_sources"],
                  artifact_version: "1",
                  sources: [source],
                }
              : state,
          ),
          { status: 200 },
        ),
    ),
  );
  render(<App />);
  const file = Object.assign(new File(["synthetic"], "source-fixture.nii"), {
    arrayBuffer: async () => new ArrayBuffer(1),
  });
  fireEvent.change(screen.getByLabelText("Open CTA volume"), {
    target: { files: [file] },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Load geometry test" }),
  );
  await screen.findByText("Workspace connected");
  expect(
    screen.queryByRole("link", { name: source.title }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("Public or synthetic data only"));
  fireEvent.click(screen.getByRole("button", { name: "Ask Muse" }));
  expect(
    await screen.findByRole("link", { name: source.title }),
  ).toHaveAttribute("href", source.url);
  expect(screen.getByText("Sources read")).toBeInTheDocument();
});

test("replacing a volume clears the unsaved worksheet, target and consent", async () => {
  vi.stubGlobal("crypto", {
    subtle: {
      digest: vi
        .fn()
        .mockResolvedValueOnce(new Uint8Array(32).buffer)
        .mockResolvedValueOnce(new Uint8Array(32).fill(1).buffer),
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const meta = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          ...meta,
          case_id: "case-" + meta.image_sha256.slice(0, 2),
          artifact_version: "1",
          notes: "",
          measurements: [],
          aneurysm_plan: null,
        }),
        { status: 200 },
      );
    }),
  );
  render(<App />);
  const file = (name: string) =>
    Object.assign(new File(["synthetic only"], name), {
      arrayBuffer: async () => new ArrayBuffer(1),
    });
  fireEvent.change(screen.getByLabelText("Open CTA volume"), {
    target: { files: [file("first.nii")] },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Load geometry test" }),
  );
  await screen.findByText("Workspace connected");
  fireEvent.change(screen.getByLabelText("Aneurysm label"), {
    target: { value: "Unsaved first-volume target" },
  });
  fireEvent.click(screen.getByLabelText("Coiling"));
  fireEvent.click(screen.getByRole("button", { name: "Choose test target" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Use crosshair as target" }),
  );
  fireEvent.click(screen.getByLabelText("Public or synthetic data only"));
  fireEvent.change(screen.getByLabelText("Open CTA volume"), {
    target: { files: [file("second.nii")] },
  });
  await screen.findByText("second.nii");
  fireEvent.click(screen.getByRole("button", { name: "Load geometry test" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Aneurysm label")).toHaveValue(
      "Target aneurysm",
    ),
  );
  expect(screen.getByLabelText("Coiling")).not.toBeChecked();
  expect(
    screen.getByLabelText("Public or synthetic data only"),
  ).not.toBeChecked();
  expect(document.querySelector(".target-coordinate")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Save aneurysm plan" }),
  ).toBeDisabled();
});

test("requires explicit saved-state reload after a revision conflict before another save", async () => {
  const { emptyPlan } = await import("./planning");
  vi.stubGlobal("crypto", {
    subtle: { digest: vi.fn().mockResolvedValue(new Uint8Array(32).buffer) },
  });
  const initial = {
    case_id: "conflict-case",
    title: "Synthetic conflict test",
    image_sha256: "0".repeat(64),
    source_url: null,
    dimensions: [16, 16, 16],
    spacing_mm: [1, 1, 1],
    spatial_units: "mm",
    artifact_version: "1",
    notes: "",
    measurements: [],
    aneurysm_plan: null,
  };
  let latest = {
    ...initial,
    artifact_version: "2",
    notes: "Latest persisted note",
    aneurysm_plan: { ...emptyPlan, lesion_label: "Server revision" },
  };
  const versions: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/aneurysm-plan")) {
        const body = JSON.parse(String(init?.body));
        versions.push(body.artifact_version);
        if (body.artifact_version === "1")
          return new Response(
            JSON.stringify({ detail: "stale artifact_version" }),
            { status: 409 },
          );
        latest = { ...latest, artifact_version: "3", aneurysm_plan: body.plan };
        return new Response(JSON.stringify(latest), { status: 200 });
      }
      return new Response(
        JSON.stringify(url.endsWith("/cases/conflict-case") ? latest : initial),
        { status: 200 },
      );
    }),
  );
  render(<App />);
  const file = Object.assign(new File(["synthetic"], "conflict.nii"), {
    arrayBuffer: async () => new ArrayBuffer(1),
  });
  fireEvent.change(screen.getByLabelText("Open CTA volume"), {
    target: { files: [file] },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Load geometry test" }),
  );
  await screen.findByText("Workspace connected");
  fireEvent.click(screen.getByLabelText("Public or synthetic data only"));
  fireEvent.change(screen.getByLabelText("Case planning notes"), {
    target: { value: "Unsaved local note" },
  });
  fireEvent.change(screen.getByLabelText("Aneurysm label"), {
    target: { value: "Draft must be explicitly discarded" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save aneurysm plan" }));
  const reload = await screen.findByRole("button", {
    name: "Reload saved state (discard edits)",
  });
  expect(
    screen.getByRole("button", { name: "Save aneurysm plan" }),
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save notes" })).toBeDisabled();
  expect(versions).toEqual(["1"]);
  expect(screen.getByLabelText("Aneurysm label")).toHaveValue(
    "Draft must be explicitly discarded",
  );
  fireEvent.click(reload);
  await waitFor(() =>
    expect(screen.getByLabelText("Aneurysm label")).toHaveValue(
      "Server revision",
    ),
  );
  expect(screen.getByLabelText("Case planning notes")).toHaveValue(
    "Latest persisted note",
  );
  expect(
    screen.getByLabelText("Public or synthetic data only"),
  ).not.toBeChecked();
  fireEvent.change(screen.getByLabelText("Aneurysm label"), {
    target: { value: "Reviewed latest" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save aneurysm plan" }));
  await waitFor(() => expect(versions).toEqual(["1", "2"]));
});
