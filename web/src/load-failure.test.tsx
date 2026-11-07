import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
vi.mock("./Viewer", () => ({
  default: (props: { onError: (message: string) => void }) => (
    <button onClick={() => props.onError("Synthetic decoder failure")}>
      Fail synthetic image load
    </button>
  ),
}));
import App from "./App";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
test("failed volume load clears the scan identity and offers a usable file retry", async () => {
  vi.stubGlobal("crypto", {
    subtle: { digest: vi.fn().mockResolvedValue(new Uint8Array(32).buffer) },
  });
  render(<App />);
  const file = Object.assign(new File(["synthetic"], "broken.nii"), {
    arrayBuffer: async () => new ArrayBuffer(1),
  });
  fireEvent.change(screen.getByLabelText("Open CTA volume"), {
    target: { files: [file] },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Fail synthetic image load" }),
  );
  await waitFor(() =>
    expect(screen.getByText("No volume loaded")).toBeInTheDocument(),
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Synthetic decoder failure",
  );
  expect(screen.getByLabelText("Open CTA volume")).toBeEnabled();
  expect(screen.getByRole("button", { name: "Ask Muse" })).toBeDisabled();
});
