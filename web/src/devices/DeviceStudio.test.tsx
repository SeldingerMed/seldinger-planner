import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { flowDiverter } from "./geometry";
it("moves a flow diverter along the picked curved path without translating or extrapolating the path", () => {
  const g = flowDiverter({
    path: [
      [0, 0, 0],
      [0, 0, 10],
      [10, 0, 10],
    ],
    diameterMm: 2,
    lengthMm: 5,
    wireCount: 8,
    turns: 1,
    startMm: 12,
  });
  expect(g.bounds.min[0]).toBeCloseTo(2);
  expect(g.bounds.max[0]).toBeCloseTo(7);
  expect(() =>
    flowDiverter({
      path: [
        [0, 0, 0],
        [0, 0, 10],
      ],
      diameterMm: 2,
      lengthMm: 5,
      wireCount: 8,
      turns: 1,
      startMm: 7,
    }),
  ).toThrow();
});
import { afterEach, expect, it, vi } from "vitest";
afterEach(cleanup);
vi.mock("./DeviceScene", () => ({
  default: () => <div data-testid="scene" />,
}));
import DeviceStudio from "./DeviceStudio";
it("restores the actual visual braid state with a saved alternative", () => {
  localStorage.clear();
  render(
    <DeviceStudio
      file={null}
      caseState={null}
      sourceRevision={null}
      onClose={() => {}}
    />,
  );
  fireEvent.change(
    screen.getByRole("slider", { name: "Illustrative braid angle (degrees)" }),
    { target: { value: "60" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Save placement" }));
  fireEvent.change(
    screen.getByRole("slider", { name: "Illustrative braid angle (degrees)" }),
    { target: { value: "45" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  expect(
    screen.getByRole("slider", { name: "Illustrative braid angle (degrees)" }),
  ).toHaveValue("60");
});
it("never shows a measured-looking coil volume for a coil with no captured SKU data", () => {
  localStorage.clear();
  render(
    <DeviceStudio
      file={null}
      caseState={null}
      sourceRevision={null}
      onClose={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Target 360/ }));
  expect(screen.getByRole("heading", { name: "Target 360" })).toBeInTheDocument();
  // No per-SKU primary diameter is captured for the coil families, so the
  // volume/density metrics must be absent entirely rather than shown from a
  // visualization default.
  expect(screen.queryByText("Coil wire volume")).not.toBeInTheDocument();
  expect(
    screen.queryByText("Packing volume density"),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("slider", { name: "Secondary coil length (mm)" })).toBeInTheDocument();
});

it("exposes manufacturer-specific models without a CTA and keeps recalled devices out of normal choices", async () => {
  render(
    <DeviceStudio
      file={null}
      caseState={null}
      sourceRevision={null}
      onClose={() => {}}
    />,
  );
  expect(
    screen.getByRole("heading", { name: "Device planning studio" }),
  ).toBeInTheDocument();
  expect(
    screen.getByText("Captured subset, not a complete catalog"),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Saved bench examples" }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("CTA volume")).toBeDisabled();
  expect(
    screen.getByRole("button", { name: /Surpass Elite/ }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /WEB SLS/ }));
  expect(screen.getByRole("heading", { name: "WEB SLS" })).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /Vantage 027/ }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByLabelText("Show research and recalled references"),
  );
  expect(
    screen.getByRole("button", { name: /Vantage 027/ }),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/No clinical outcome probability is calculated/),
  ).toBeInTheDocument();
});
