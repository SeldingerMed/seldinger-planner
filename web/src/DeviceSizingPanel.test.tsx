import { afterEach, expect, test, vi } from "vitest";
import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import DeviceSizingPanel from "./DeviceSizingPanel";
import variants from "./fixtures/device-sizing-synthetic-variants.json";
import type { CaseState } from "./api";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
test.each(["409", "same_result", "stale_echo"])(
  "unconfirmed %s locks calculation and cannot blindly retry",
  async (mode) => {
    const bad = structuredClone(variants.partial);
    if (mode === "stale_echo") bad.geometry_status = "stale";
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(variants.partial))
      .mockResolvedValueOnce(
        mode === "409" ? new Response("{}", { status: 409 }) : response(bad),
      );
    vi.stubGlobal("fetch", fetch);
    const conflict = vi.fn();
    render(
      <DeviceSizingPanel
        caseState={caseState}
        binding={binding}
        onConflict={conflict}
      />,
    );
    const b = screen.getByRole("button", { name: "Calculate saved inputs" });
    await waitFor(() => expect(b).toBeEnabled());
    fireEvent.click(b);
    await waitFor(() => expect(conflict).toHaveBeenCalledOnce());
    expect(b).toBeDisabled();
    expect(screen.getByText(/Calculation is locked/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reload calculation" }),
    ).not.toBeInTheDocument();
    fireEvent.click(b);
    expect(fetch).toHaveBeenCalledTimes(2);
  },
);

test("own disabled busy feedback does not cancel POST and releases its owner", async () => {
  let finish!: (r: Response) => void;
  const saved = {
    ...variants.partial,
    current: { ...variants.partial.current, result_id: "saved-after-feedback" },
  };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response(variants.partial))
    .mockImplementationOnce(() => new Promise<Response>((r) => (finish = r)))
    .mockImplementation(() => Promise.resolve(response(saved)));
  vi.stubGlobal("fetch", fetch);
  const done = vi.fn(),
    busy = vi.fn();
  function Host() {
    const [disabled, setDisabled] = useState(false);
    return (
      <DeviceSizingPanel
        caseState={caseState}
        binding={binding}
        disabled={disabled}
        onCalculated={done}
        onBusy={(v) => {
          busy(v);
          setDisabled(v);
        }}
      />
    );
  }
  render(<Host />);
  const b = screen.getByRole("button", { name: "Calculate saved inputs" });
  await waitFor(() => expect(b).toBeEnabled());
  fireEvent.click(b);
  expect(b).toBeDisabled();
  await act(async () => finish(response(saved)));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(busy.mock.calls).toEqual([[true], [false]]);
  await waitFor(() => expect(b).toBeEnabled());
});

test("source change discards late POST but still releases original busy owner", async () => {
  let finish!: (r: Response) => void;
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response(variants.partial))
    .mockImplementationOnce(() => new Promise<Response>((r) => (finish = r)))
    .mockImplementation(() => Promise.resolve(response(variants.partial)));
  vi.stubGlobal("fetch", fetch);
  const oldBusy = vi.fn(),
    newBusy = vi.fn(),
    done = vi.fn();
  const view = render(
    <DeviceSizingPanel
      caseState={caseState}
      binding={binding}
      onBusy={oldBusy}
      onCalculated={done}
    />,
  );
  const b = screen.getByRole("button", { name: "Calculate saved inputs" });
  await waitFor(() => expect(b).toBeEnabled());
  fireEvent.click(b);
  view.rerender(
    <DeviceSizingPanel
      caseState={{ ...caseState, spatial_units: "unknown" }}
      binding={binding}
      onBusy={newBusy}
      onCalculated={done}
    />,
  );
  await act(async () =>
    finish(
      response({
        ...variants.partial,
        current: { ...variants.partial.current, result_id: "late-result" },
      }),
    ),
  );
  expect(done).not.toHaveBeenCalled();
  expect(oldBusy.mock.calls).toEqual([[true], [false]]);
  expect(newBusy).not.toHaveBeenCalled();
  view.rerender(
    <DeviceSizingPanel
      caseState={caseState}
      binding={binding}
      onBusy={newBusy}
    />,
  );
  await waitFor(() => expect(b).toBeEnabled());
});

const caseState = variants.caseState as CaseState;
const binding = {
  case_id: caseState.case_id,
  image_sha256: caseState.image_sha256,
  reference_revision: variants.partial.reference_revision,
};
const response = (value: unknown) => new Response(JSON.stringify(value));

test("GET then source-bound POST saves only pointer metadata and renders confirmed result", async () => {
  const saved = {
    ...variants.partial,
    current: { ...variants.partial.current, result_id: "new-synthetic-id" },
  };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response(variants.partial))
    .mockResolvedValueOnce(response(saved));
  vi.stubGlobal("fetch", fetch);
  const busy = vi.fn(),
    done = vi.fn();
  render(
    <DeviceSizingPanel
      caseState={caseState}
      binding={binding}
      onBusy={busy}
      onCalculated={done}
    />,
  );
  const button = await screen.findByRole("button", {
    name: "Calculate saved inputs",
  });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(busy.mock.calls).toEqual([[true], [false]]);
  const body = JSON.parse(fetch.mock.calls[1][1].body);
  expect(Object.keys(body).sort()).toEqual(
    [
      "artifact_version",
      "reference_revision",
      "geometry_result_id",
      "input_revision",
      "inputs_sha256",
      "catalog_version",
      "calculation_version",
    ].sort(),
  );
  expect(body.input_revision).toBe(variants.partial.inputs.input_revision);
  expect(screen.getByText(/new-synthetic-id/)).toBeInTheDocument();
});
