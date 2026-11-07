import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import AneurysmWorksheet from "./AneurysmWorksheet";
afterEach(cleanup);

test("saves operator-marked aneurysm context without inventing measured evidence", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  const dirty = vi.fn();
  render(
    <AneurysmWorksheet
      caseId="public-case"
      plan={null}
      measurements={[]}
      spatialUnits="unknown"
      location={[-12, 8, 32]}
      disabled={false}
      onSave={save}
      onFocus={vi.fn()}
      onDirtyChange={dirty}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Save aneurysm plan" }),
  ).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Aneurysm label"), {
    target: { value: "Operator-marked target" },
  });
  fireEvent.change(screen.getByLabelText("Location / segment"), {
    target: { value: "Location needs confirmation" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Use crosshair as target" }),
  );
  fireEvent.click(screen.getByLabelText("Coiling"));
  fireEvent.click(screen.getByRole("button", { name: "Save aneurysm plan" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        lesion_label: "Operator-marked target",
        location_note: "Location needs confirmation",
        focus_ras: [-12, 8, 32],
        rupture_status: "unknown",
        measurement_links: {},
        options: ["coiling"],
      }),
    ),
  );
  expect(dirty).toHaveBeenCalledWith(true);
  expect(screen.getByLabelText("Neck width evidence")).toBeDisabled();
  expect(screen.getByText(/RAS source units/)).toBeInTheDocument();
});

test("keeps clinical context explicitly operator-entered and links manual evidence", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  render(
    <AneurysmWorksheet
      caseId="synthetic-case"
      plan={null}
      measurements={[
        {
          measurement_id: "m1",
          label: "Manual point pair",
          coordinate_system: "RAS",
          point_a_mm: [0, 0, 0],
          point_b_mm: [0, 3, 4],
          distance_mm: 5,
        },
      ]}
      spatialUnits="mm"
      location={null}
      disabled={false}
      onSave={save}
      onFocus={vi.fn()}
      onDirtyChange={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText("Rupture status"), {
    target: { value: "unruptured" },
  });
  fireEvent.change(screen.getByLabelText("Clinical context"), {
    target: {
      value: "Synthetic context only; clinical history not established.",
    },
  });
  fireEvent.change(screen.getByLabelText("Planning questions"), {
    target: { value: "What needs verification before comparing the options?" },
  });
  fireEvent.change(screen.getByLabelText("Neck width evidence"), {
    target: { value: "m1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save aneurysm plan" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        rupture_status: "unruptured",
        clinical_context:
          "Synthetic context only; clinical history not established.",
        questions: "What needs verification before comparing the options?",
        measurement_links: { neck_width: "m1" },
      }),
    ),
  );
});
