import { afterEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  fireEvent,
} from "@testing-library/react";
import type { NVImage } from "@niivue/niivue";
import producer from "./__fixtures__/territory-tavr.json";
import TerritoryStudio from "./TerritoryStudio";

// Only the canvas/SVG slice renderer is mocked (jsdom has no canvas).
// TerritoryStudio and TerritorySectionEditor are the REAL implementations.
vi.mock("./ObliqueSection", () => ({
  default: () => <div data-testid="oblique-mock" />,
}));
vi.mock("./TerritoryPathEditor", () => ({
  default: () => <div />,
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
  onDirtyChange: () => {},
};

const ok = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

test("explicit reload after 503 with unchanged stored revision remounts a fresh editor (no stale plane draft)", async () => {
  // GET 1: saved revision 1 (origin 5,5,10, 4-point contour).
  // PUT: 503 ambiguous -> locked.
  // GET 2 (reload): EXACT SAME fixture, EXACT SAME revision 1.
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(ok(producer))
    .mockResolvedValueOnce(new Response("", { status: 503 }))
    .mockResolvedValueOnce(ok(producer));
  vi.stubGlobal("fetch", fetcher);
  render(<TerritoryStudio {...props} />);
  const originInput = await screen.findByLabelText("Plane origin");
  // Saved origin is 5,5,10; editor drafts it locally as text.
  expect((originInput as HTMLInputElement).value).toBe("5, 5, 10");

  // Local, unapplied plane-origin edit: 7,8,9 (never applied to parent).
  fireEvent.change(originInput, { target: { value: "7, 8, 9" } });
  expect(
    (screen.getByLabelText("Plane origin") as HTMLInputElement).value,
  ).toBe("7, 8, 9");

  // Make the parent dirty: set right ostium to cursor 5,5,15.
  fireEvent.click(
    screen.getByRole("button", { name: "Set right coronary ostium" }),
  );
  expect(screen.getByText(/Unsaved annotations/)).toBeTruthy();

  // Save -> 503 -> locked with ambiguous-commit error.
  fireEvent.click(screen.getByRole("button", { name: "Save and calculate" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("may have been stored");
  expect(
    (
      screen.getByRole("button", {
        name: "Save and calculate",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);

  // Explicit reload.
  fireEvent.click(
    screen.getByRole("button", {
      name: "Discard draft and reload saved workflow",
    }),
  );
  await screen.findByRole("button", { name: "Save and calculate" });
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls[2][0]).toContain("/territory-workflows/tavr");

  // Assert the reloaded state is the saved truth, not the stale draft.
  const reloadedOrigin = screen.getByLabelText(
    "Plane origin",
  ) as HTMLInputElement;
  expect(reloadedOrigin.value).toBe("5, 5, 10");
  expect(reloadedOrigin.disabled).toBe(false);
  expect(screen.getByText(/Contour points: 4/)).toBeTruthy();
  expect(screen.getByTestId("metric-area_mm2").textContent).toContain("6.000");
  expect(screen.getByText(/Workflow revision 1/)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBe(null);
  expect(screen.queryByText(/Unsaved annotations/)).toBe(null);
  // Right ostium restored to saved 5,5,8 (display), not cursor 5,5,15.
  const row = screen
    .getByRole("button", { name: "Set right coronary ostium" })
    .closest("div")!;
  expect(row.textContent).toContain("5.00 / 5.00 / 8.00");
});

test("deferred reload: editors fully unmount while GET is pending, so remount reinitializes the local plane draft", async () => {
  let resolveGet2: ((r: Response) => void) | null = null;
  const fetcher = vi
    .fn<() => Promise<Response>>()
    .mockResolvedValueOnce(ok(producer))
    .mockResolvedValueOnce(new Response("", { status: 503 }))
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveGet2 = resolve;
        }),
    );
  vi.stubGlobal("fetch", fetcher);
  render(<TerritoryStudio {...props} />);
  const originInput = (await screen.findByLabelText(
    "Plane origin",
  )) as HTMLInputElement;
  expect(originInput.value).toBe("5, 5, 10");
  fireEvent.change(originInput, { target: { value: "7, 8, 9" } });
  fireEvent.click(
    screen.getByRole("button", { name: "Set right coronary ostium" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save and calculate" }));
  await screen.findByRole("alert");

  fireEvent.click(
    screen.getByRole("button", {
      name: "Discard draft and reload saved workflow",
    }),
  );
  // While GET 2 is pending: setSnapshot(null) has flushed, editors unmounted.
  await screen.findByRole("status", { name: undefined });
  expect(screen.getByText(/Loading saved workflow/)).toBeTruthy();
  expect(screen.queryByLabelText("Plane origin")).toBe(null);

  // GET 2 resolves with the EXACT original fixture / same revision 1.
  await act(async () => {
    resolveGet2!(ok(producer));
  });
  await screen.findByRole("button", { name: "Save and calculate" });
  const reloaded = screen.getByLabelText("Plane origin") as HTMLInputElement;
  // Fresh mount: local draft "7, 8, 9" died with the unmount.
  expect(reloaded.value).toBe("5, 5, 10");
  expect(screen.getByText(/Contour points: 4/)).toBeTruthy();
  expect(screen.getByTestId("metric-area_mm2").textContent).toContain("6.000");
  expect(screen.queryByText(/Unsaved annotations/)).toBe(null);
});
