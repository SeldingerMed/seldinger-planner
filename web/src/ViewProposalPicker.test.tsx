import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { VerifiedFrame } from "./projectionFrames";
import ViewProposalPicker, {
  shareWords,
  type StartPick,
} from "./ViewProposalPicker";
import * as viewProposals from "./viewProposals";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const frame = { sha256: "a".repeat(64), plane: "a" } as VerifiedFrame;
const view = { primary_deg: 10, secondary_deg: -5, turn_deg: 2 };
const elsewhere: StartPick = {
  frame_sha256: "b".repeat(64),
  plane: "b",
  polarity: "dark",
  rank: 2,
  view: { primary_deg: -90, secondary_deg: 1, turn_deg: 0 },
  share: 0.2,
};
const checked = () =>
  screen
    .getAllByRole("radio")
    .map((item) => (item as HTMLInputElement).checked);

it("does not show a small share as none", () => {
  expect(shareWords(0.41)).toBe("41%");
  expect(shareWords(0.005)).toBe("1%");
  expect(shareWords(0.0049)).toBe("under 1%");
  expect(shareWords(0.0001)).toBe("under 1%");
  expect(shareWords(0)).toBe("0%");
});

it("lists each view with its share in those words", async () => {
  vi.spyOn(viewProposals, "proposeFrameViews").mockResolvedValue([
    { ...view, share: 0.27 },
    { ...view, primary_deg: 40, share: 0.002 },
  ]);
  render(
    <ViewProposalPicker
      frame={frame}
      polarity="dark"
      disabled={false}
      picked={null}
      elsewhere={null}
      onPick={() => {}}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Propose views for this frame" }),
  );
  await screen.findByRole("radio", {
    name: /Proposed view 1: .*\(share 27%\)/,
  });
  screen.getByRole("radio", { name: /Proposed view 2: .*\(share under 1%\)/ });
  expect(checked()).toEqual([true, false, false]);
});

it("shows a start picked for the other plane's frame as the choice in force", async () => {
  vi.spyOn(viewProposals, "proposeFrameViews").mockResolvedValue([
    { ...view, share: 0.27 },
  ]);
  const onPick = vi.fn();
  render(
    <ViewProposalPicker
      frame={frame}
      polarity="dark"
      disabled={false}
      picked={null}
      elsewhere={elsewhere}
      onPick={onPick}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Propose views for this frame" }),
  );
  const inForce = await screen.findByRole("radio", {
    name: "Proposed view 3 for plane B's frame: primary -90°, secondary 1°, turned 0° in the image",
  });
  expect((inForce as HTMLInputElement).checked).toBe(true);
  // The volume's own position is not the start, and is not shown as it.
  expect(checked()).toEqual([false, true, false]);
  fireEvent.click(
    screen.getByRole("radio", { name: "The volume's own position" }),
  );
  expect(onPick).toHaveBeenLastCalledWith(null);
  fireEvent.click(screen.getByRole("radio", { name: /^Proposed view 1: / }));
  expect(onPick).toHaveBeenLastCalledWith(
    expect.objectContaining({
      frame_sha256: frame.sha256,
      plane: "a",
      rank: 0,
    }),
  );
});
