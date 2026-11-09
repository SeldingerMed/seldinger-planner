import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import MorphometryInputs from "./MorphometryInputs";
import type { CaseState } from "./api";
import proposal from "./fixtures/phase5-anatomy-proposal.json";

const caseState: CaseState = {
  case_id: proposal.case_id, image_sha256: proposal.image_sha256,
  artifact_version: proposal.artifact_version, spatial_units: "mm",
  title: "Declared synthetic anatomy tracer", source_url: null,
  dimensions: proposal.proposal.diagnostics.grid_shape, spacing_mm: [1, 1, 1],
  notes: "", measurements: [],
};
const binding = {
  case_id: proposal.case_id, image_sha256: proposal.image_sha256,
  reference_revision: proposal.reference_revision,
};
const identity = { ...binding, artifact_version: proposal.artifact_version };
const response = (body: unknown) => new Response(JSON.stringify(body), {
  headers: { "Content-Type": "application/json" },
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("real editor applies the actual proposal only as an editable dirty draft and saves only on confirmation", async () => {
  const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    if (url.endsWith("/anatomy-proposal")) return response(proposal);
    if (url.endsWith("/morphometry-inputs") && method === "PUT") {
      return response({ ...identity, artifact_version: "4", operator_inputs: body.inputs });
    }
    if (url.endsWith("/morphometry") && method === "GET") {
      return response({ ...identity, operator_inputs: null, current: { status: "not_computed", result: null } });
    }
    throw new Error(`Unexpected endpoint ${method} ${url}`);
  }));
  const onRevision = vi.fn();
  const onError = vi.fn();
  function Parent() {
    const [busy, setBusy] = useState(false);
    const [dirty, setDirty] = useState(false);
    return <>
      <button disabled={busy || dirty}>Downstream export</button>
      <MorphometryInputs caseState={caseState} binding={binding} location={null}
        disabled={busy} onBusy={setBusy} onDirtyChange={setDirty}
        onRevision={onRevision} onError={onError} onComputed={vi.fn()} />
    </>;
  }
  render(<Parent />);
  await screen.findByTestId("parent-path-count");
  fireEvent.click(screen.getByRole("button", { name: /propose geometry from accepted anatomy/i }));
  fireEvent.click(await screen.findByRole("button", { name: /apply as editable draft/i }));
  expect(screen.getByTestId("value-sac seed")).toHaveTextContent("8.00, 4.00, 12.00");
  expect(screen.getByTestId("parent-path-count")).toHaveTextContent("9 points");
  expect(screen.getByRole("button", { name: "Downstream export" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Compute mask geometry" })).toBeDisabled();
  expect(calls.filter((c) => c.method !== "GET")).toHaveLength(1);
  expect(calls.find((c) => c.url.endsWith("/anatomy-proposal"))?.body).toEqual({
    artifact_version: proposal.artifact_version, reference_revision: proposal.reference_revision,
    target_ras: null,
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Proximal station index" }), { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: "Save geometry inputs" }));
  await waitFor(() => expect(onRevision).toHaveBeenCalledWith("4"));
  const saved = calls.find((c) => c.method === "PUT")!;
  expect(saved.body?.inputs).toEqual({ ...proposal.proposal.inputs, proximal_index: 2 });
  expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/morphometry"))).toHaveLength(0);
  expect(onError).not.toHaveBeenCalled();
});
