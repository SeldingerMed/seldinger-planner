import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import OcclusionTable, { type OcclusionEstimates } from "./OcclusionTable";

const estimates: OcclusionEstimates = {
  months_after_treatment: 12,
  set_to_published_average: ["circulation"],
  estimates: [
    {
      treatment: "clipping",
      technique: "Microsurgical clipping",
      complete_occlusion: 0.912,
      ci95: [0.88, 0.94],
      between_centre_range95: [0.8, 0.97],
      published_studies: 35,
      published_aneurysms: 4000,
    },
    {
      treatment: "flow_diversion",
      technique: "Flow diverter",
      complete_occlusion: 0.784,
      between_centre_range95: [0.6, 0.9],
      published_studies: 120,
      published_aneurysms: 9000,
    },
  ],
  model: {
    basis: "Random-effects meta-regression of 300 published clinical series",
    not_modelled:
      "Procedural complications, rupture risk and retreatment burden",
  },
};

describe("OcclusionTable", () => {
  afterEach(cleanup);

  it("shows each treatment's expected occlusion, interval and evidence", () => {
    render(<OcclusionTable estimates={estimates} />);
    expect(screen.getByText("Complete occlusion at 12 months")).toBeTruthy();
    const clip = screen.getByRole("row", { name: /Microsurgical clipping/ });
    expect(within(clip).getByText("91%")).toBeTruthy();
    expect(within(clip).getByText("88%–94%")).toBeTruthy();
    expect(within(clip).getByText("35")).toBeTruthy();
    const fd = screen.getByRole("row", { name: /Flow diverter/ });
    expect(within(fd).getByText("78%")).toBeTruthy();
    expect(within(fd).getByText("–")).toBeTruthy();
    expect(
      screen.getByText(/Published average used for: circulation/),
    ).toBeTruthy();
    expect(screen.getByText(/procedural complications/)).toBeTruthy();
  });

  it("uses the singular for one month", () => {
    render(
      <OcclusionTable
        estimates={{ ...estimates, months_after_treatment: 1 }}
      />,
    );
    expect(screen.getByText("Complete occlusion at 1 month")).toBeTruthy();
  });

  it("labels the end-of-procedure result", () => {
    render(
      <OcclusionTable
        estimates={{
          ...estimates,
          months_after_treatment: 0,
          set_to_published_average: [],
        }}
      />,
    );
    expect(
      screen.getByText("Complete occlusion at end of procedure"),
    ).toBeTruthy();
    expect(screen.queryByText(/Published average used for/)).toBeNull();
  });
});
