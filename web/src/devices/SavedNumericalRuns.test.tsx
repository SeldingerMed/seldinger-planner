import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import actual from "../fixtures/phase5-public-case013-numerical.json";
import syntheticFlow from "../fixtures/phase5-synthetic-flow-brief.json";
import SavedNumericalRuns, {
  parseSavedNumericalRuns,
} from "./SavedNumericalRuns";

const binding = {
  case_id: actual.case_id,
  image_sha256: actual.image_sha256,
  artifact_version: actual.artifact_version,
  reference_revision: actual.reference_revision,
  geometry_result_id: actual.planning.morphometry_summary.result_id,
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("reads the actual public straight-rest run without attributing it to a selected device", async () => {
  const read = vi.fn(async () => Response.json(actual));
  vi.stubGlobal("fetch", read);
  render(<SavedNumericalRuns binding={binding} refreshKey="0" />);
  await screen.findByText("103");
  expect(screen.getByText("uKv33XZ4elgGi9li3wYSpA")).toBeInTheDocument();
  expect(screen.getByText("Converged")).toBeInTheDocument();
  expect(screen.getByText("0.3752 mm")).toBeInTheDocument();
  expect(
    screen.getByText(/No result is assigned to a device alternative/),
  ).toBeInTheDocument();
  expect(read.mock.calls).toHaveLength(1);
});
it("admits the separate declared synthetic flow HTTP producer", async () => {
  const scope = {
    case_id: syntheticFlow.case_id,
    image_sha256: syntheticFlow.image_sha256,
    artifact_version: syntheticFlow.artifact_version,
    reference_revision: syntheticFlow.reference_revision,
    geometry_result_id: syntheticFlow.planning.morphometry_summary.result_id,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(syntheticFlow)),
  );
  render(<SavedNumericalRuns binding={scope} refreshKey="0" />);
  await screen.findByText("0.8 mm/s");
  expect(screen.getByText("-20%")).toBeInTheDocument();
});
it("hides scalar diagnostics for both actual projector stale-status variants", async () => {
  // Projector status-only shape, not invented current data with a stale badge.
  const stale = {...actual,numerical_runs:["rod-deployment","stokes-flow"].map(kind=>({scope:"anatomy_operator_parameters",kind,status:"stale"}))};
  vi.stubGlobal("fetch",vi.fn(async()=>Response.json(stale)));
  render(<SavedNumericalRuns binding={binding} refreshKey="stale"/>);
  expect(await screen.findAllByText("Stale run; values hidden")).toHaveLength(2);
  expect(screen.queryByText("103")).not.toBeInTheDocument();
  const contradictory = {...stale,numerical_runs:[{...stale.numerical_runs[0],iterations:103},stale.numerical_runs[1]]};
  expect(()=>parseSavedNumericalRuns(contradictory,binding)).toThrow();
});
it("rejects contradictory nested planning identity", () => {
  const bad = structuredClone(actual);
  bad.planning.artifact_version = "6";
  expect(() => parseSavedNumericalRuns(bad, binding)).toThrow();
});
it("hides loaded results synchronously when source eligibility is lost", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(actual)),
  );
  const view = render(<SavedNumericalRuns binding={binding} refreshKey="0" />);
  await screen.findByText("103");
  view.rerender(<SavedNumericalRuns binding={null} refreshKey="0" />);
  expect(screen.queryByText("103")).not.toBeInTheDocument();
  expect(
    screen.getByText("Current saved anatomy is required."),
  ).toBeInTheDocument();
});
it("does not promote an old response after source eligibility changes", async () => {
  let resolve!: (r: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    ),
  );
  const view = render(<SavedNumericalRuns binding={binding} refreshKey="0" />);
  view.rerender(<SavedNumericalRuns binding={null} refreshKey="0" />);
  resolve(Response.json(actual));
  await waitFor(() =>
    expect(
      screen.getByText("Current saved anatomy is required."),
    ).toBeInTheDocument(),
  );
  expect(screen.queryByText("103")).not.toBeInTheDocument();
});
it("clears old values when an explicit reload fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(Response.json(actual))
      .mockResolvedValueOnce(
        Response.json({ detail: "unavailable" }, { status: 503 }),
      ),
  );
  render(<SavedNumericalRuns binding={binding} refreshKey="0" />);
  await screen.findByText("103");
  fireEvent.click(
    screen.getByRole("button", { name: "Reload saved numerical runs" }),
  );
  await screen.findByRole("alert");
  expect(screen.queryByText("103")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Reload saved numerical runs" }),
  ).toBeEnabled();
});
