import { useEffect } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { restoreOrCreateCase, type CaseState } from "./api";
import deviceWorkflow from "./fixtures/phase5-public-case013-device-workflow.json";
import workflowBrief from "./fixtures/phase5-public-case013-workflow-brief.json";
import evidence from "./fixtures/phase5-public-case013-source.json";

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  restoreOrCreateCase: vi.fn(async () => evidence.case),
}));
vi.mock("./Viewer", () => ({
  default: ({
    file,
    onLoaded,
  }: {
    file: File;
    onLoaded: (value: unknown) => void;
  }) => {
    useEffect(() => {
      onLoaded({
        dimensions: evidence.case.dimensions,
        spacing_mm: evidence.case.spacing_mm,
        spatial_units: "mm",
      });
    }, [file]);
    return <div>Declared viewer stub; metadata admission test only</div>;
  },
}));
vi.mock("./MorphometryResults", () => ({ default: () => null }));
vi.mock("./DeviceReference", () => ({ default: () => null }));
vi.mock("./DeviceSizingInputs", () => ({ default: () => null }));
vi.mock("./DeviceSizingPanel", () => ({ default: () => null }));
vi.mock("./ReformatStudio", () => ({ default: () => null }));
vi.mock("./TerritoryStudio", () => ({ default: () => <div>Declared territory editor stub</div> }));
vi.mock("./devices/DeviceStudio", () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="Declared studio stub">
      <button onClick={onClose}>Close declared studio</button>
    </div>
  ),
}));
import App from "./App";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

// The buttons are enabled after the file is read, hashed and checked against
// three requests. Under full-suite load on a CI runner that has taken more
// than the default second, so each wait is given its time explicitly.
const SLOW_RUNNER_WAIT_MS = 5000;
it("offers original-model anatomy and geometry editing for a verified installed CTA, not only the case006 demo", async () => {
  vi.stubGlobal("crypto", {
    subtle: {
      digest: async () =>
        Uint8Array.from(
          evidence.case.image_sha256
            .match(/../g)!
            .map((hex) => parseInt(hex, 16)),
        ).buffer,
    },
  });
  const read = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/image-source")) return Response.json(evidence.source);
    if (url.endsWith("/segmentations"))
      return Response.json({ current: { vessel: null, aneurysm: null } });
    if (url.endsWith("/morphometry"))
      return Response.json({
        case_id: evidence.case.case_id,
        image_sha256: evidence.case.image_sha256,
        artifact_version: evidence.case.artifact_version,
        reference_revision: evidence.source.reference_revision,
        operator_inputs: null,
        current: { status: "not_computed", result: null },
      });
    throw new Error(`Unexpected native-source endpoint ${url}`);
  });
  vi.stubGlobal("fetch", read);
  render(<App />);
  const file = new File(["declared synthetic viewer bytes"], "source.nii.gz");
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new ArrayBuffer(1),
  });
  fireEvent.change(screen.getByLabelText("Open CTA volume"), {
    target: { files: [file] },
  });
  await waitFor(
    () =>
      expect(
        screen.getByRole("button", { name: "Run RSNA vessel model" }),
      ).toBeEnabled(),
    { timeout: SLOW_RUNNER_WAIT_MS },
  );
  await waitFor(
    () =>
      expect(
        screen.getByRole("button", {
          name: "Propose geometry from accepted anatomy",
        }),
      ).toBeEnabled(),
    { timeout: SLOW_RUNNER_WAIT_MS },
  );
  expect(
    read.mock.calls.some(([url]) => String(url).endsWith("/image-source")),
  ).toBe(true);
}, 3 * SLOW_RUNNER_WAIT_MS);

it("integrates saved-state workflow guidance and makes the background inert while the studio is open", async () => {
  vi.mocked(restoreOrCreateCase).mockResolvedValueOnce(
    deviceWorkflow.case as unknown as CaseState,
  );
  vi.stubGlobal("crypto", {
    subtle: {
      digest: async () =>
        Uint8Array.from(
          evidence.case.image_sha256.match(/../g)!.map((h) => parseInt(h, 16)),
        ).buffer,
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/image-source")) return Response.json(evidence.source);
      if (url.endsWith("/local-brief")) return Response.json(workflowBrief);
      if (url.endsWith("/segmentations"))
        return Response.json({ current: { vessel: null, aneurysm: null } });
      if (url.endsWith("/morphometry"))
        return Response.json(deviceWorkflow.geometry);
      throw new Error(`Unexpected endpoint ${url}`);
    }),
  );
  render(<App />);
  const file = new File(["declared viewer fixture"], "source.nii.gz");
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new ArrayBuffer(1),
  });
  fireEvent.change(screen.getByLabelText("Open CTA volume"), {
    target: { files: [file] },
  });
  await screen.findByText("3 saved alternatives");
  expect(screen.queryByRole("link", {name:"Export brief ↗"})).not.toBeInTheDocument();
  const notes=screen.getByRole("textbox", {name:"Case planning notes"});
  fireEvent.change(notes,{target:{value:"Unsaved audit note"}});
  expect(screen.getByRole("button", {name:"Device studio"})).toBeDisabled();
  for(const name of ["Open calibrated CTA","Open reference CTA","Open public CTA"])
    expect(screen.getByRole("button", {name})).toBeDisabled();
  expect(screen.getByLabelText("Open CTA volume")).toBeDisabled();
  expect(screen.getByLabelText("Open CTA volume").closest("label")).toHaveAttribute("aria-disabled","true");
  expect(screen.getByRole("button", {name:"4 Device scenarios"})).toBeDisabled();
  expect(screen.getByRole("button", {name:"Download planning brief"})).toBeDisabled();
  fireEvent.change(notes,{target:{value:deviceWorkflow.case.notes}});
  expect(screen.getByRole("button", {name:"Device studio"})).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Cardiac and aortic" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Download planning brief" })).toBeEnabled());
  fireEvent.change(notes, { target: { value: "Unsaved territory note" } });
  expect(screen.getByRole("button", { name: "Download planning brief" })).toBeDisabled();
  fireEvent.change(notes, { target: { value: deviceWorkflow.case.notes } });
  fireEvent.click(screen.getByRole("button", { name: "Neurovascular" }));
  await screen.findByText("3 saved alternatives");
  fireEvent.click(screen.getByRole("button", { name: "4 Device scenarios" }));
  await screen.findByRole("dialog", { name: "Declared studio stub" });
  expect(
    screen
      .getByRole("heading", { name: "Seldinger Planner" })
      .closest("header"),
  ).toHaveAttribute("inert");
  expect(
    screen
      .getByRole("navigation", { name: "Planning workflow" })
      .closest(".workspace-grid"),
  ).toHaveAttribute("inert");
  fireEvent.click(
    screen.getByRole("button", { name: "Close declared studio" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(
    screen
      .getByRole("heading", { name: "Seldinger Planner" })
      .closest("header"),
  ).not.toHaveAttribute("inert");
});
