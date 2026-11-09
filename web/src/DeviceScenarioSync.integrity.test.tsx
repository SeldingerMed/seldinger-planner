import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, RevisionConflictError } from "./api";
import DeviceScenarioSync from "./DeviceScenarioSync";
import { parseDeviceScenarios, type DeviceScenarioBinding, type DeviceScenarioEntry } from "./deviceScenarios";
import producer from "./fixtures/phase5-device-scenario-lifecycle.json";

vi.mock("./api", async (original) => ({ ...await original<typeof import("./api")>(), api: vi.fn() }));
const request = vi.mocked(api);
const binding: DeviceScenarioBinding = {
  case_id: producer.initial.case_id, image_sha256: producer.initial.image_sha256,
  artifact_version: producer.initial.artifact_version, reference_revision: producer.initial.reference_revision,
  geometry_result_id: producer.initial.geometry_result_id, catalog_version: producer.initial.catalog_version,
};
const parsed = parseDeviceScenarios(producer.first, binding);
if (parsed.current.status !== "current") throw new Error("Actual producer fixture is not current");
const originalRows = parsed.current.scenarios;
const busySpy = vi.fn<(busy: boolean) => void>();
const dirtySpy = vi.fn<(dirty: boolean) => void>();
const conflictSpy = vi.fn<() => void>();

function Parent({ source = binding, initial = originalRows }: { source?: DeviceScenarioBinding; initial?: DeviceScenarioEntry[] }) {
  const [draft, setDraft] = useState({ source: source.case_id, rows: structuredClone(initial) });
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const rows = draft.source === source.case_id ? draft.rows : [];
  return <>
    <output data-testid="rows">{JSON.stringify(rows)}</output>
    <button disabled={busy || dirty}>Downstream</button>
    <DeviceScenarioSync binding={source} eligible rows={rows} disabled={busy}
      onRowsChange={(next) => setDraft({ source: source.case_id, rows: next })}
      onDirtyChange={(next) => { dirtySpy(next); setDirty(next); }}
      onBusy={(next) => { busySpy(next); setBusy(next); }} onConflict={conflictSpy} />
  </>;
}
function deferred() {
  let resolve!: (raw: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

afterEach(cleanup);
beforeEach(() => { request.mockReset(); busySpy.mockClear(); dirtySpy.mockClear(); conflictSpy.mockClear(); });

it("reports editor readiness only after an authoritative read and releases it on failure until reload", async () => {
  const read = deferred(), ready = vi.fn();
  request.mockReturnValueOnce(read.promise).mockRejectedValueOnce(new Error("lost acknowledgement")).mockResolvedValueOnce(producer.first);
  render(<DeviceScenarioSync binding={binding} eligible rows={originalRows} onRowsChange={() => {}} onReadyChange={ready} />);
  expect(ready).not.toHaveBeenCalledWith(true);
  await act(async () => read.resolve(producer.first));
  await waitFor(() => expect(ready).toHaveBeenLastCalledWith(true));
  fireEvent.click(screen.getByRole("button", {name:"Save scenario set"}));
  await screen.findByText(/save request failed/i);
  expect(ready).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByRole("button", {name:"Reload saved scenarios"}));
  await waitFor(() => expect(ready).toHaveBeenLastCalledWith(true));
});

it("admits the literal actual API lifecycle with real parent busy/dirty feedback", async () => {
  request.mockResolvedValueOnce(producer.initial).mockResolvedValueOnce(producer.first);
  render(<Parent />);
  await screen.findByText(/No saved scenario set yet/);
  await waitFor(() => expect(screen.getByRole("button", { name: "Save scenario set" })).toBeEnabled());
  expect(screen.getByRole("button", { name: "Downstream" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Save scenario set" }));
  await screen.findByText(/Saved revision 1/);
  expect(request).toHaveBeenLastCalledWith(`/cases/${binding.case_id}/device-scenarios`, producer.request, "PUT");
  await waitFor(() => expect(screen.getByRole("button", { name: "Downstream" })).toBeEnabled());
  expect(conflictSpy).not.toHaveBeenCalled();
  expect(JSON.parse(screen.getByTestId("rows").textContent!)).toEqual(originalRows);
});

it("does not reset a source merely because binding keys have a different insertion order", async () => {
  request.mockResolvedValueOnce(producer.first);
  const view = render(<Parent />);
  await screen.findByText(/Saved revision 1/);
  const reordered = Object.fromEntries(Object.entries(binding).reverse()) as DeviceScenarioBinding;
  view.rerender(<Parent source={reordered} />);
  expect(request).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Save scenario set" })).toBeEnabled();
});

it("compares acknowledgement rows structurally, not by object insertion order", async () => {
  const reorder = (value: unknown): unknown => Array.isArray(value) ? value.map(reorder)
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;
  const reordered = reorder(originalRows) as DeviceScenarioEntry[];
  request.mockResolvedValueOnce(producer.initial).mockResolvedValueOnce(producer.first);
  render(<Parent initial={reordered} />);
  await screen.findByText(/No saved scenario set yet/);
  fireEvent.click(screen.getByRole("button", { name: "Save scenario set" }));
  await screen.findByText(/Saved revision 1/);
  expect(conflictSpy).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole("button", { name: "Downstream" })).toBeEnabled());
});

it("does not let an old source release the newer read's busy lock", async () => {
  const oldRead = deferred(), newRead = deferred();
  request.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
  const view = render(<Parent />);
  const newer = { ...binding, case_id: "OtherCaseId00", geometry_result_id: "OtherGeometryId00" };
  view.rerender(<Parent source={newer} />);
  expect(request).toHaveBeenCalledTimes(2);
  expect(busySpy.mock.calls.map(([value]) => value)).toEqual([true, false, true]);
  await act(async () => oldRead.reject(new RevisionConflictError()));
  expect(busySpy.mock.calls.map(([value]) => value)).toEqual([true, false, true]);
  expect(conflictSpy).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Downstream" })).toBeDisabled();
  const current = structuredClone(producer.first);
  Object.assign(current, newer);
  Object.assign(current.current.dependencies, { case_id: newer.case_id });
  await act(async () => newRead.resolve(current));
  expect(busySpy.mock.calls.map(([value]) => value)).toEqual([true, false, true, false]);
  expect(JSON.parse(screen.getByTestId("rows").textContent!)).toEqual(originalRows);
});

it("releases the captured busy owner immediately on unmount, once only", async () => {
  const read = deferred(); request.mockReturnValueOnce(read.promise);
  const view = render(<Parent />);
  expect(busySpy.mock.calls.map(([value]) => value)).toEqual([true]);
  view.unmount();
  expect(busySpy.mock.calls.map(([value]) => value)).toEqual([true, false]);
  await act(async () => read.reject(new RevisionConflictError()));
  expect(busySpy.mock.calls.map(([value]) => value)).toEqual([true, false]);
  expect(conflictSpy).not.toHaveBeenCalled();
});
