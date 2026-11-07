import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
const h = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("./api", () => ({ api: h.api }));
import SegmentationPanel from "./SegmentationPanel";
afterEach(() => {
  cleanup();
  h.api.mockReset();
});
const caseState = {
  case_id: "case-a",
  image_sha256: "a".repeat(64),
  artifact_version: "1",
} as never;
const reference = {
  case_id: "case-a",
  image_sha256: "a".repeat(64),
  reference_revision: "b".repeat(64),
} as never;
const candidate = {
  case_id: "case-a",
  image_sha256: "a".repeat(64),
  reference_revision: "b".repeat(64),
  candidate_id: "candidate-a",
  mask_url: "/api/cases/case-a/segmentations/candidate-a/mask",
  mask_sha256: "c".repeat(64),
  role: "vessel",
  producer: "owned_vessel",
  status: "preview",
  produced_artifact_version: "1",
  provenance: {},
  segmentation_revision: null,
};
test("runs real API contract and keeps preview separate from acceptance", async () => {
  h.api
    .mockResolvedValueOnce({ current: { vessel: null, aneurysm: null } })
    .mockResolvedValueOnce(candidate)
    .mockResolvedValueOnce({
      ...candidate,
      status: "accepted",
      artifact_version: "2",
      segmentation_revision: 1,
    });
  const onOverlay = vi.fn(),
    onAccepted = vi.fn();
  render(
    <SegmentationPanel
      caseState={caseState}
      reference={reference}
      location={[1, 2, 3]}
      windowRange={[0, 600]}
      disabled={false}
      onOverlay={onOverlay}
      onAccepted={onAccepted}
      onError={vi.fn()}
    />,
  );
  await waitFor(() => expect(h.api).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Run vessel model" }));
  await screen.findByText("Unaccepted preview");
  expect(h.api.mock.calls[1][1]).toMatchObject({
    kind: "vessel",
    role: "vessel",
    artifact_version: "1",
    reference_revision: "b".repeat(64),
  });
  expect(onAccepted).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Accept candidate" }));
  await waitFor(() => expect(onAccepted).toHaveBeenCalledWith("2"));
});
test("malformed acceptance cannot replace the candidate or accepted overlay", async () => {
  h.api
    .mockResolvedValueOnce({ current: { vessel: null, aneurysm: null } })
    .mockResolvedValueOnce(candidate)
    .mockResolvedValueOnce({
      ...candidate,
      status: "accepted",
      segmentation_revision: 1,
    });
  const onOverlay = vi.fn(),
    onAccepted = vi.fn(),
    onError = vi.fn();
  render(
    <SegmentationPanel
      caseState={caseState}
      reference={reference}
      location={[1, 2, 3]}
      windowRange={[0, 600]}
      disabled={false}
      onOverlay={onOverlay}
      onAccepted={onAccepted}
      onError={onError}
    />,
  );
  await waitFor(() => expect(h.api).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Run vessel model" }));
  await screen.findByText("Unaccepted preview");
  onOverlay.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Accept candidate" }));
  await waitFor(() => expect(onError).toHaveBeenCalled());
  expect(onAccepted).not.toHaveBeenCalled();
  expect(onOverlay).not.toHaveBeenCalled();
  expect(screen.getByText("Unaccepted preview")).toBeTruthy();
});

test("runs trained aneurysm candidate without a SAM prompt and labels its provenance", async () => {
  h.api
    .mockResolvedValueOnce({ current: { vessel: null, aneurysm: null } })
    .mockResolvedValueOnce({
      ...candidate,
      producer: "aneurysm_model",
      role: "aneurysm",
    });
  const onOverlay = vi.fn();
  render(
    <SegmentationPanel
      caseState={caseState}
      reference={reference}
      location={null}
      windowRange={[0, 600]}
      disabled={false}
      onOverlay={onOverlay}
      onAccepted={vi.fn()}
      onError={vi.fn()}
    />,
  );
  await waitFor(() => expect(h.api).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Run aneurysm model" }));
  await screen.findByText("Trained aneurysm candidate (3D context)");
  expect(h.api.mock.calls[1][1]).toMatchObject({
    kind: "aneurysm",
    role: "aneurysm",
    artifact_version: "1",
    reference_revision: "b".repeat(64),
  });
  expect(h.api.mock.calls[1][1]).not.toHaveProperty("point_ras");
  expect(onOverlay.mock.calls.at(-1)?.[0].producer).toBe("aneurysm_model");
});

test("late inference cannot attach to a replacement case", async () => {
  let finish!: (value: unknown) => void;
  h.api
    .mockResolvedValueOnce({ current: { vessel: null, aneurysm: null } })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce({ current: { vessel: null, aneurysm: null } });
  const onOverlay = vi.fn();
  const props = {
    caseState,
    reference,
    location: [1, 2, 3] as [number, number, number],
    windowRange: [0, 600] as [number, number],
    disabled: false,
    onOverlay,
    onAccepted: vi.fn(),
    onError: vi.fn(),
  };
  const view = render(<SegmentationPanel {...props} />);
  await waitFor(() => expect(h.api).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Run vessel model" }));
  await waitFor(() => expect(h.api).toHaveBeenCalledTimes(2));
  view.rerender(
    <SegmentationPanel
      {...props}
      caseState={{ ...(props.caseState as object), case_id: "case-b" } as never}
      reference={null}
    />,
  );
  finish(candidate);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(
    onOverlay.mock.calls.some(
      ([entry]) => entry?.candidate_id === "candidate-a",
    ),
  ).toBe(false);
});
