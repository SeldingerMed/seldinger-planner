import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
vi.mock("./Viewer", () => ({ default: () => <div>Imaging canvas</div> }));
import App from "./App";
test("requires explicit public-case confirmation before enabling Muse", async () => {
  render(<App />);
  expect(screen.getByRole("button", { name: "Ask Muse" })).toBeDisabled();
  expect(
    screen.getByLabelText("Public or synthetic data only"),
  ).not.toBeChecked();
  fireEvent.change(screen.getByLabelText("Question for Muse"), {
    target: { value: "Summarize measurements" },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Ask Muse" })).toBeDisabled(),
  );
});
