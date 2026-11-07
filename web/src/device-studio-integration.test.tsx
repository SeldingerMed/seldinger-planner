import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
vi.mock("./devices/DeviceStudio", () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <section>
      <h2>Studio integration tracer</h2>
      <button onClick={onClose}>Close tracer</button>
    </section>
  ),
}));
import App from "./App";
it("opens device models from the actual app without requiring scan upload", async () => {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Device studio" }));
  expect(
    await screen.findByRole("heading", { name: "Studio integration tracer" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close tracer" }));
  expect(
    screen.queryByRole("heading", { name: "Studio integration tracer" }),
  ).not.toBeInTheDocument();
});
