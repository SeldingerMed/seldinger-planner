import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { VerifiedFrame } from "./projectionFrames";
import ViewProposalPicker, {
  shareWords,
  type StartPick,
  viewWords,
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

it("writes an angle that rounds to nothing as 0 and not as -0", () => {
  expect(
    viewWords({ primary_deg: -0.3, secondary_deg: -0.4, turn_deg: 0.2 }),
  ).toBe("primary 0°, secondary 0°, turned 0° in the image");
  expect(
    viewWords({ primary_deg: -35.2, secondary_deg: 12.4, turn_deg: -0.6 }),
  ).toBe("primary -35°, secondary 12°, turned -1° in the image");
});

it("stops a running request when its frame or polarity is no longer the one shown", async () => {
  let arrive!: (views: []) => void;
  const propose = vi.spyOn(viewProposals, "proposeFrameViews").mockReturnValue(
    new Promise((resolve) => {
      arrive = resolve;
    }),
  );
  const picker = (polarity: "dark" | "bright", shown = frame) => (
    <ViewProposalPicker
      frame={shown}
      polarity={polarity}
      disabled={false}
      picked={null}
      elsewhere={null}
      onPick={() => {}}
    />
  );
  const { rerender } = render(picker("dark"));
  fireEvent.click(
    screen.getByRole("button", { name: "Propose views for this frame" }),
  );
  const first = propose.mock.calls[0][2]!;
  screen.getByRole("button", { name: "Proposing views…" });
  expect(first.aborted).toBe(false);
  // The same frame and polarity drawn again is still the one asked about.
  rerender(picker("dark"));
  expect(first.aborted).toBe(false);
  rerender(picker("bright"));
  expect(first.aborted).toBe(true);

  // Another frame of the plane ends a request the same way.
  fireEvent.click(
    screen.getByRole("button", { name: "Propose views for this frame" }),
  );
  const second = propose.mock.calls[1][2]!;
  expect(second.aborted).toBe(false);
  rerender(
    picker("bright", { sha256: "c".repeat(64), plane: "a" } as VerifiedFrame),
  );
  expect(second.aborted).toBe(true);
  // What arrives for a request that was stopped is not listed.
  arrive([]);
  await Promise.resolve();
  rerender(picker("dark"));
  expect(screen.queryByRole("radio")).toBeNull();
});

it("does not bring back an old failure when its frame is shown again", async () => {
  vi.spyOn(viewProposals, "proposeFrameViews").mockRejectedValue(
    new Error("The view network did not arrive in time"),
  );
  const picker = (shown: VerifiedFrame) => (
    <ViewProposalPicker
      frame={shown}
      polarity="dark"
      disabled={false}
      picked={null}
      elsewhere={null}
      onPick={() => {}}
    />
  );
  const { rerender } = render(picker(frame));
  fireEvent.click(
    screen.getByRole("button", { name: "Propose views for this frame" }),
  );
  expect((await screen.findByRole("alert")).textContent).toBe(
    "No views were proposed: The view network did not arrive in time.",
  );
  // Drawn again for the same frame, the failure of its request stands.
  rerender(picker(frame));
  screen.getByRole("alert");
  rerender(picker({ sha256: "c".repeat(64), plane: "a" } as VerifiedFrame));
  expect(screen.queryByRole("alert")).toBeNull();
  rerender(picker(frame));
  expect(screen.queryByRole("alert")).toBeNull();
});
