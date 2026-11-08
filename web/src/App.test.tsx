import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import App from "./App";
test("opens with a real-volume file chooser and no invented case or measurements", () => {
  render(<App />);
  expect(
    screen.getByRole("heading", { name: "Seldinger Planner" }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Open CTA volume")).toHaveAttribute(
    "accept",
    ".nii,.nii.gz",
  );
  expect(screen.getByText("No volume loaded")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Cardiac and aortic" }),
  ).toBeDisabled();
  expect(screen.queryByText(/4\.5 mm/)).not.toBeInTheDocument();
});
