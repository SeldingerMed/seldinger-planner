import { afterEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import type { NVImage } from "@niivue/niivue";
import producer from "./__fixtures__/territory-tavr.json";
import TerritoryStudio from "./TerritoryStudio";
vi.mock("./TerritorySectionEditor", () => ({
  default: () => <div>Section editor</div>,
}));
vi.mock("./TerritoryPathEditor", () => ({
  default: () => <div>Path editor</div>,
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const props = {
  caseState: {
    case_id: producer.case_id,
    image_sha256: producer.image_sha256,
    artifact_version: producer.artifact_version,
    spatial_units: "mm" as const,
  },
  binding: {
    case_id: producer.case_id,
    image_sha256: producer.image_sha256,
    reference_revision: producer.reference_revision,
  },
  volume: {} as NVImage,
  cursor: [5, 5, 15] as [number, number, number],
};
const ok = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
test("a definitive 422 rejection preserves an editable draft without claiming a possible commit", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(ok(producer))
    .mockResolvedValueOnce(new Response("", { status: 422 }));
  vi.stubGlobal("fetch", fetcher);
  render(<TerritoryStudio {...props} />);
  await screen.findByTestId("metric-left_coronary_height_mm");
  fireEvent.click(
    screen.getByRole("button", { name: "Set left coronary ostium" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save and calculate" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("alert")).toHaveTextContent("nothing was stored");
  expect(
    screen.getByRole("button", { name: "Save and calculate" }),
  ).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "Set left coronary ostium" }),
  ).toBeEnabled();
  expect(
    screen.queryByTestId("metric-left_coronary_height_mm"),
  ).not.toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
test("a 409 acknowledgement can follow a commit and must still lock retries", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(ok(producer))
      .mockResolvedValueOnce(new Response("", { status: 409 })),
  );
  render(<TerritoryStudio {...props} />);
  await screen.findByTestId("metric-left_coronary_height_mm");
  fireEvent.click(
    screen.getByRole("button", { name: "Set left coronary ostium" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save and calculate" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "may have been stored",
  );
  expect(
    screen.getByRole("button", { name: "Save and calculate" }),
  ).toBeDisabled();
});

test("a genuinely deferred old response cannot repopulate a changed-source workspace", async () => {
  const pending: Array<(value: Response) => void> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve))),
  );
  const { rerender } = render(<TerritoryStudio {...props} />);
  await waitFor(() => expect(pending).toHaveLength(1));
  rerender(
    <TerritoryStudio
      {...props}
      caseState={{ ...props.caseState, artifact_version: "2" }}
    />,
  );
  await waitFor(() => expect(pending).toHaveLength(2));
  const identity = {
    case_id: producer.case_id,
    image_sha256: producer.image_sha256,
    artifact_version: "2",
    reference_revision: producer.reference_revision,
  };
  await act(async () => {
    pending[1](
      ok({
        ...identity,
        mode: "tavr",
        workflow_revision: 0,
        current: { status: "not_computed" },
      }),
    );
  });
  await screen.findByRole("button", { name: "Set left coronary ostium" });
  await act(async () => {
    pending[0](ok(producer));
  });
  expect(
    screen.queryByTestId("metric-left_coronary_height_mm"),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Save and calculate" }),
  ).toBeDisabled();
});

test("loads actual producer and hides retained numbers immediately when source becomes ineligible", async () => {
  const fetcher = vi.fn().mockResolvedValue(ok(producer));
  vi.stubGlobal("fetch", fetcher);
  const { rerender } = render(<TerritoryStudio {...props} />);
  await screen.findByTestId("metric-left_coronary_height_mm");
  expect(
    screen.getByTestId("metric-left_coronary_height_mm"),
  ).toHaveTextContent("5.000");
  rerender(<TerritoryStudio {...props} disabled />);
  expect(
    screen.queryByTestId("metric-left_coronary_height_mm"),
  ).not.toBeInTheDocument();
  rerender(
    <TerritoryStudio
      {...props}
      caseState={{ ...props.caseState, spatial_units: "unknown" }}
    />,
  );
  expect(
    screen.queryByTestId("metric-left_coronary_height_mm"),
  ).not.toBeInTheDocument();
});
test("a failed mutation locks retries until explicit reload, preserving ambiguous commit semantics", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(ok(producer))
    .mockResolvedValueOnce(new Response("", { status: 503 }))
    .mockResolvedValueOnce(ok(producer));
  vi.stubGlobal("fetch", fetcher);
  render(<TerritoryStudio {...props} />);
  await screen.findByTestId("metric-left_coronary_height_mm");
  fireEvent.click(
    screen.getByRole("button", { name: "Set left coronary ostium" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save and calculate" }));
  await screen.findByRole("alert");
  expect(
    screen.getByRole("button", { name: "Save and calculate" }),
  ).toBeDisabled();
  expect(
    screen.queryByTestId("metric-left_coronary_height_mm"),
  ).not.toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledTimes(2);
  fireEvent.click(
    screen.getByRole("button", {
      name: "Discard draft and reload saved workflow",
    }),
  );
  await screen.findByTestId("metric-left_coronary_height_mm");
  expect(fetcher).toHaveBeenCalledTimes(3);
});
test("successful write survives parent's busy feedback and confirms exact inputs/revision/result", async () => {
  const changed = structuredClone(producer);
  changed.workflow_revision = 2;
  changed.current.result_id = "B".repeat(22);
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(ok(producer))
    .mockResolvedValueOnce(ok(changed));
  vi.stubGlobal("fetch", fetcher);
  let rerender: ReturnType<typeof render>["rerender"];
  const onBusy = (busy: boolean) =>
    rerender(<TerritoryStudio {...props} disabled={busy} onBusy={onBusy} />);
  ({ rerender } = render(<TerritoryStudio {...props} onBusy={onBusy} />));
  await screen.findByTestId("metric-left_coronary_height_mm");
  fireEvent.click(
    screen.getByRole("button", { name: "Set left coronary ostium" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save and calculate" }));
  await waitFor(() =>
    expect(screen.getByText(/Workflow revision 2/)).toBeInTheDocument(),
  );
  expect(fetcher.mock.calls[1][1].method).toBe("PUT");
  expect(JSON.parse(fetcher.mock.calls[1][1].body).workflow_revision).toBe(1);
});
