import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import brief from "./fixtures/phase5-public-case013-workflow-brief.json";
import WorkflowGuide, { parseWorkflowBrief } from "./WorkflowGuide";

const identity = {
  case_id: brief.case_id,
  image_sha256: brief.image_sha256,
  artifact_version: brief.artifact_version,
  reference_revision: brief.reference_revision,
};
const props = {
  identity,
  imported: true,
  dirty: false,
  busy: false,
  conflict: false,
  refreshKey: "0",
  onImport: vi.fn(),
  onScenarios: vi.fn(),
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("shows guided stages from an actual coherent public-case brief, not a local compute counter", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(brief)),
  );
  render(<WorkflowGuide {...props} />);
  expect(
    screen.getByRole("navigation", { name: "Planning workflow" }),
  ).toBeInTheDocument();
  await screen.findByText("Vessel and sac accepted");
  expect(screen.getByText("Measurements current")).toBeInTheDocument();
  expect(screen.getByText("3 saved alternatives")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Download planning brief" }),
  ).toBeEnabled();
});

it("admits the backend's short candidate and geometry identifiers without widening set or scene IDs", () => {
  const short = structuredClone(brief);
  for (const segment of short.planning.segmentation_summary) {
    const id = segment.role === "vessel" ? "v" : "a";
    segment.candidate_id = id;
    short.device_scenarios.dependencies.masks[
      segment.role as "vessel" | "aneurysm"
    ].candidate_id = id;
  }
  short.planning.morphometry_summary.result_id = "g";
  short.device_scenarios.geometry_result_id = "g";
  expect(parseWorkflowBrief(short, identity)).toMatchObject({
    anatomy: true,
    geometry: true,
    count: 3,
  });
  short.device_scenarios.set_id = "s";
  expect(() => parseWorkflowBrief(short, identity)).toThrow();
});

it("rejects a scenario bound to different accepted masks", () => {
  const bad = structuredClone(brief);
  bad.device_scenarios.dependencies.masks.vessel.mask_sha256 = "a".repeat(64);
  expect(() => parseWorkflowBrief(bad, identity)).toThrow();
});

it("rejects malformed rows rather than counting them as saved alternatives", () => {
  const bad = structuredClone(brief);
  (bad.device_scenarios.scenarios as unknown[]) = [null];
  expect(() => parseWorkflowBrief(bad, identity)).toThrow();
});

it("keeps saved evidence separate from unsaved drafts and blocks export while dirty", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(brief)),
  );
  const view = render(<WorkflowGuide {...props} />);
  await screen.findByText("3 saved alternatives");
  view.rerender(<WorkflowGuide {...props} dirty />);
  expect(
    screen.getByRole("button", { name: "Download planning brief" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "4 Device scenarios" }),
  ).toBeDisabled();
  expect(screen.getByText(/Unsaved edits/)).toBeInTheDocument();
});

it("clears promoted readiness on a failed explicit refresh", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(Response.json(brief))
    .mockResolvedValueOnce(
      Response.json({ detail: "unavailable" }, { status: 503 }),
    );
  vi.stubGlobal("fetch", read);
  render(<WorkflowGuide {...props} />);
  await screen.findByText("3 saved alternatives");
  fireEvent.click(screen.getByRole("button", { name: "Refresh workflow" }));
  await screen.findByText(/Saved workflow evidence is unavailable/);
  expect(screen.queryByText("Measurements current")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Download planning brief" }),
  ).toBeDisabled();
});

it("exports freshly read evidence and never a cached brief", async () => {
  const fresh = structuredClone(brief);
  fresh.markdown += "\nFresh saved evidence";
  const read = vi
    .fn()
    .mockResolvedValueOnce(Response.json(brief))
    .mockResolvedValueOnce(Response.json(fresh));
  vi.stubGlobal("fetch", read);
  const create = vi.fn(() => "blob:workflow-test");
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = create;
      static revokeObjectURL = vi.fn();
    },
  );
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  render(<WorkflowGuide {...props} />);
  await screen.findByText("3 saved alternatives");
  fireEvent.click(
    screen.getByRole("button", { name: "Download planning brief" }),
  );
  await waitFor(() => expect(click).toHaveBeenCalledOnce());
  expect(read).toHaveBeenCalledTimes(2);
  expect((create.mock.calls[0] as unknown as [Blob])[0].size).toBe(
    new TextEncoder().encode(fresh.markdown + "\n").byteLength,
  );
});
