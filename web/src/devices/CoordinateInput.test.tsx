import { render, screen, fireEvent } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import CoordinateInput from "./CoordinateInput";
it("preserves a partially typed negative coordinate and commits only on blur", () => {
  const commit = vi.fn();
  render(
    <CoordinateInput label="Center S (mm)" value={-7.625} onCommit={commit} />,
  );
  const input = screen.getByRole("textbox", { name: "Center S (mm)" });
  fireEvent.change(input, { target: { value: "-" } });
  expect(input).toHaveValue("-");
  expect(commit).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "-15" } });
  expect(commit).not.toHaveBeenCalled();
  fireEvent.blur(input);
  expect(commit).toHaveBeenCalledWith(-15);
});
