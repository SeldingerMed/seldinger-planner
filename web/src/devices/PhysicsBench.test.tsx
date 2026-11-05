import { render, screen, fireEvent } from "@testing-library/react";
import { expect, it } from "vitest";
import PhysicsBench from "./PhysicsBench";
it("keeps uncalibrated local flow calculations explicitly opt-in and never shows patient efficacy", () => {
  render(
    <PhysicsBench
      category="flow-diverter"
      diameter={4}
      length={20}
      coilLength={100}
    />,
  );
  expect(screen.queryByText(/16.62 Pa/)).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByLabelText("Explore hypothetical screen parameters"),
  );
  expect(screen.getByText(/16.62 Pa/)).toBeInTheDocument();
  expect(
    screen.getByText(/Not a patient-specific CFD solution/),
  ).toBeInTheDocument();
});
