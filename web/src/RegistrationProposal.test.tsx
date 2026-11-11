import type { NVImage } from "@niivue/niivue";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import {
  makeVolume,
  phantomPair,
  transform,
} from "./__fixtures__/registrationPhantom";
import RegistrationProposal, { startScoreText } from "./RegistrationProposal";
import { validateRigid } from "./rigidFusion";

const grid = (origin: number) => [
  [1, 0, 0, origin],
  [0, 1, 0, origin],
  [0, 0, 1, origin],
  [0, 0, 0, 1],
];
const identity = JSON.stringify(grid(0));
const pair = phantomPair();
const windows = {
  primaryWindow: [0, 200] as [number, number],
  secondaryWindow: [0, 600] as [number, number],
  opacity: 0.5,
};
type Image = { data: Uint8ClampedArray; width: number; height: number };
function stubCanvas() {
  const images: Image[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    createImageData: (width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4),
      width,
      height,
    }),
    putImageData: (image: Image) => images.push(image),
  } as unknown as CanvasRenderingContext2D);
  return images;
}
afterEach(() => {
  cleanup();
  // Spies first: one of them may wrap the fake setTimeout.
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const button = (name: string) => screen.getByRole("button", { name });
const status = () =>
  screen.getAllByRole("status").map((node) => node.textContent);

function Owner({
  secondary = pair.secondary,
  onPropose,
}: {
  secondary?: NVImage;
  onPropose?: (text: string) => void;
}) {
  const [text, setText] = useState(identity);
  return (
    <>
      <textarea
        aria-label="matrix"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <RegistrationProposal
        {...windows}
        primary={pair.primary}
        secondary={secondary}
        matrixText={text}
        disabled={false}
        onPropose={(proposed) => {
          onPropose?.(proposed);
          setText(proposed);
        }}
      />
    </>
  );
}

test("a proposal is computed in slices, entered as the draft and described", async () => {
  stubCanvas();
  const slices = vi.spyOn(globalThis, "setTimeout");
  render(<Owner />);
  fireEvent.click(button("Propose rigid registration"));
  expect(status()).toContain(
    "Computing registration proposal… This waits while the tab is in the background.",
  );
  expect(button("Cancel registration proposal")).toBeEnabled();
  const summary = await screen.findByText(
    /Proposed matrix entered above/,
    {},
    { timeout: 30000 },
  );
  expect(slices.mock.calls.length).toBeGreaterThan(5);
  const matrix = validateRigid(
    JSON.parse((screen.getByLabelText("matrix") as HTMLTextAreaElement).value),
  );
  for (const q of pair.corners) {
    const u = transform(matrix, q),
      v = transform(pair.truth, q);
    expect(Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2])).toBeLessThan(1.5);
  }
  expect(summary).toHaveTextContent(
    /moved 11\d\.\d mm and 1[34]\.\d° from the starting matrix\. Normalized mutual information 1\.\d{3} \(the starting matrix put only \d{1,2}% of the secondary inside the primary and was not scored\), with 100% of the secondary inside the primary\. The score is not an accuracy measure\. The secondary was compared in 1\.2 mm blocks\. Review the draft preview before confirming\./,
  );
  expect(button("Propose rigid registration")).toBeEnabled();
  // The description belongs to that exact matrix: an edit withdraws it.
  fireEvent.change(screen.getByLabelText("matrix"), {
    target: { value: identity },
  });
  expect(screen.queryByText(/Proposed matrix entered above/)).toBeNull();
}, 40000);

test("a start under the overlap floor is described, not given a score of zero", () => {
  // Zero is what the search returns for a position it does not score.
  expect(startScoreText({ start_score: 0, start_overlap: 0.7499 })).toBe(
    "the starting matrix put only 74% of the secondary inside the primary and was not scored",
  );
  // 0.29 × 100 is 28.999999999999996, and 0.2951 is nearer 30 than 29.
  expect(startScoreText({ start_score: 0, start_overlap: 0.29 })).toContain(
    "only 29% of",
  );
  expect(startScoreText({ start_score: 0, start_overlap: 0.2951 })).toContain(
    "only 30% of",
  );
  expect(startScoreText({ start_score: 0, start_overlap: 0 })).toBe(
    "the starting matrix put only 0% of the secondary inside the primary and was not scored",
  );
  expect(startScoreText({ start_score: 1.0384, start_overlap: 0.75 })).toBe(
    "starting matrix 1.038",
  );
  // Enough overlap and nothing to compare is a measured zero.
  expect(startScoreText({ start_score: 0, start_overlap: 0.9 })).toBe(
    "starting matrix 0.000",
  );
});

test("a hidden tab works in long slices, because its timers are throttled", async () => {
  stubCanvas();
  // A clock that advances 1 ms per reading makes the slice counts exact.
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now++);
  const slices = vi.spyOn(globalThis, "setTimeout");
  const finish = async () => {
    fireEvent.click(button("Propose rigid registration"));
    await screen.findByText(
      /Proposed matrix entered above/,
      {},
      { timeout: 30000 },
    );
    const count = slices.mock.calls.length;
    slices.mockClear();
    cleanup();
    return count;
  };
  render(<Owner />);
  const visible = await finish();
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  render(<Owner />);
  const hidden = await finish();
  expect(visible).toBeGreaterThan(50);
  expect(hidden).toBeLessThan(visible / 20);
}, 60000);

const controlled = (
  onPropose: (text: string) => void,
  change: Partial<Parameters<typeof RegistrationProposal>[0]> = {},
) => (
  <RegistrationProposal
    {...windows}
    primary={pair.primary}
    secondary={pair.secondary}
    matrixText={identity}
    disabled={false}
    onPropose={onPropose}
    {...change}
  />
);
test.each([
  ["cancelled", null],
  ["given an edited matrix", { matrixText: JSON.stringify(grid(1)) }],
  ["given a replaced secondary", { secondary: { ...pair.secondary } }],
  ["given a replaced primary", { primary: { ...pair.primary } }],
  ["disabled by its owner", { disabled: true }],
  ["unmounted", "unmount"],
] as const)(
  "a running proposal that is %s never reports",
  async (_n, change) => {
    stubCanvas();
    // The clock stays real, so a slice ends on its deadline and yields.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onPropose = vi.fn();
    const view = render(controlled(onPropose));
    fireEvent.click(button("Propose rigid registration"));
    await act(async () => void vi.advanceTimersToNextTimer());
    expect(vi.getTimerCount()).toBe(1);
    if (change === null)
      fireEvent.click(button("Cancel registration proposal"));
    else if (change === "unmount") view.unmount();
    else view.rerender(controlled(onPropose, change as never));
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => void vi.runAllTimers());
    expect(onPropose).not.toHaveBeenCalled();
    if (change === "unmount") return;
    expect(status()).not.toContain(
      "Computing registration proposal… This waits while the tab is in the background.",
    );
    expect(screen.queryByText(/Proposed matrix entered above/)).toBeNull();
    // Restoring the original inputs does not resurrect the dropped run.
    view.rerender(controlled(onPropose));
    expect(vi.getTimerCount()).toBe(0);
    expect(button("Propose rigid registration")).toBeEnabled();
  },
);

test("a failed proposal says why and leaves the matrix alone", async () => {
  stubCanvas();
  const onPropose = vi.fn();
  render(
    <Owner
      secondary={makeVolume(16, grid(0), () => 7)}
      onPropose={onPropose}
    />,
  );
  fireEvent.click(button("Propose rigid registration"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Registration proposal failed: Source has no usable intensity variation. The matrix is unchanged.",
  );
  expect(onPropose).not.toHaveBeenCalled();
  expect(status()).not.toContain(
    "Computing registration proposal… This waits while the tab is in the background.",
  );
  // The failure describes that attempt only.
  fireEvent.change(screen.getByLabelText("matrix"), {
    target: { value: JSON.stringify(grid(2)) },
  });
  expect(screen.queryByRole("alert")).toBeNull();
});

test.each([
  "not json",
  "[[1,0,0,0]]",
  JSON.stringify(grid(0)).replace("1", "2"),
])(
  "an invalid draft matrix %s gets no proposal and no preview",
  (matrixText) => {
    const images = stubCanvas();
    const onPropose = vi.fn();
    render(controlled(onPropose, { matrixText }));
    expect(button("Propose rigid registration")).toBeDisabled();
    expect(status()).toContain(
      "Enter a valid rigid matrix to preview or propose a registration.",
    );
    expect(screen.queryByRole("img")).toBeNull();
    expect(images).toHaveLength(0);
  },
);

test("the draft preview fuses the secondary where the draft matrix puts it", () => {
  const images = stubCanvas();
  const shifted = [
    [1, 0, 0, 4],
    [0, 1, 0, 8],
    [0, 0, 1, 8],
    [0, 0, 0, 1],
  ];
  // Primary 32 mm cube of 50; secondary 16 mm cube of 300 placed at
  // x 4..19, y 8..23, z 8..23 in the primary frame. 0.3125 mm pixels.
  const props = {
    primary: makeVolume(32, grid(0), () => 50),
    secondary: makeVolume(16, grid(0), () => 300),
    matrixText: JSON.stringify(shifted),
  };
  const view = render(controlled(vi.fn(), props));
  expect(
    screen.getAllByRole("img").map((node) => node.getAttribute("aria-label")),
  ).toEqual(
    ["axial", "coronal", "sagittal"].map(
      (plane) => `Draft registration preview, ${plane}`,
    ),
  );
  expect(images.map((image) => `${image.width}x${image.height}`)).toEqual([
    "128x128",
    "128x128",
    "128x128",
  ]);
  const pixel = (image: Image, row: number, column: number) =>
    Array.from(
      image.data.slice(4 * (128 * row + column), 4 * (128 * row + column) + 4),
    );
  const [axial, coronal, sagittal] = images,
    fused = [32, 96, 96, 255],
    primaryOnly = [64, 64, 64, 255],
    outside = [0, 0, 0, 0];
  for (const image of images) expect(pixel(image, 64, 64)).toEqual(fused);
  // Axial: image left is patient right (+x), image top is anterior (+y).
  expect(pixel(axial, 64, 20)).toEqual(primaryOnly); // x 25.1: past the secondary
  expect(pixel(axial, 64, 107)).toEqual(outside); // x -2.1: outside the primary
  expect(pixel(axial, 20, 64)).toEqual(primaryOnly); // y 29.1
  expect(pixel(axial, 127, 64)).toEqual(outside); // y -4.3
  // Coronal: image top is superior (+z).
  expect(pixel(coronal, 64, 107)).toEqual(outside);
  expect(pixel(coronal, 20, 64)).toEqual(primaryOnly); // z 29.1
  // Sagittal: image left is anterior (+y), image top is superior (+z).
  expect(pixel(sagittal, 64, 20)).toEqual(primaryOnly); // y 29.1
  expect(pixel(sagittal, 64, 127)).toEqual(outside); // y -4.3
  expect(screen.getByText(/not saved or confirmed/)).toBeVisible();

  // Equal windows in fresh arrays do not redraw; a real change does.
  view.rerender(
    controlled(vi.fn(), {
      ...props,
      primaryWindow: [0, 200],
      secondaryWindow: [0, 600],
    }),
  );
  expect(images).toHaveLength(3);
  view.rerender(controlled(vi.fn(), { ...props, opacity: 1 }));
  expect(images).toHaveLength(6);
  expect(pixel(images[3], 64, 64)).toEqual([0, 128, 128, 255]);
});

test("the preview is drawn again once a source it could not sample is replaced", () => {
  const images = stubCanvas();
  const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
  const primary = makeVolume(32, grid(0), () => 50),
    unavailable =
      "Draft registration preview is unavailable for these sources.";
  const view = render(
    controlled(vi.fn(), {
      primary,
      secondary: makeVolume(16, grid(0), () => Number.NaN),
    }),
  );
  expect(status()).toContain(unavailable);
  expect(images).toHaveLength(0);
  view.rerender(
    controlled(vi.fn(), {
      primary,
      secondary: makeVolume(16, grid(0), () => 300),
    }),
  );
  expect(status()).not.toContain(unavailable);
  expect(screen.getAllByRole("img")).toHaveLength(3);
  expect(images).toHaveLength(3);
  expect(warned).toHaveBeenCalledTimes(1);
});

test("the preview keeps the corners of a turned secondary in frame", () => {
  const images = stubCanvas();
  // A 64 mm cube turned 45° about the superior axis spans 90.5 mm across,
  // more than the 80 mm that 1.25 times its edge would show.
  const turn = Math.SQRT1_2,
    centered = (mm: number, n: number) => [
      [mm, 0, 0, (-mm * (n - 1)) / 2],
      [0, mm, 0, (-mm * (n - 1)) / 2],
      [0, 0, mm, (-mm * (n - 1)) / 2],
      [0, 0, 0, 1],
    ];
  render(
    controlled(vi.fn(), {
      primary: makeVolume(40, centered(4, 40), () => 50),
      secondary: makeVolume(16, centered(4, 16), () => 300),
      matrixText: JSON.stringify([
        [turn, -turn, 0, 0],
        [turn, turn, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ]),
    }),
  );
  expect(images).toHaveLength(3);
  const pixel = (image: Image, row: number, column: number) =>
    Array.from(
      image.data.slice(4 * (128 * row + column), 4 * (128 * row + column) + 4),
    );
  for (const image of images) {
    expect(pixel(image, 64, 64)).toEqual([32, 96, 96, 255]);
    // Primary alone at both ends of the middle row: the secondary ends
    // inside the frame.
    expect(pixel(image, 64, 0)).toEqual([64, 64, 64, 255]);
    expect(pixel(image, 64, 127)).toEqual([64, 64, 64, 255]);
  }
});

test("a source the preview cannot sample is reported, not drawn", () => {
  const images = stubCanvas();
  const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
  render(
    controlled(vi.fn(), {
      secondary: makeVolume(16, grid(0), () => Number.NaN),
      primary: makeVolume(32, grid(0), () => 50),
    }),
  );
  expect(status()).toContain(
    "Draft registration preview is unavailable for these sources.",
  );
  expect(images).toHaveLength(0);
  expect(screen.queryByRole("img")).toBeNull();
  // The cause goes to the console, since the status line cannot name it.
  expect(warned).toHaveBeenCalledWith(
    "Draft registration preview failed",
    expect.any(Error),
  );
});
