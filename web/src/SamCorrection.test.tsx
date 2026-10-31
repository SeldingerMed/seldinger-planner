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
  artifact_version: "5",
} as never;
const reference = {
  case_id: "case-a",
  image_sha256: "a".repeat(64),
  reference_revision: "b".repeat(64),
} as never;
const base = {
  case_id: "case-a",
  image_sha256: "a".repeat(64),
  reference_revision: "b".repeat(64),
  candidate_id: "base-a",
  mask_url: "/api/cases/case-a/segmentations/base-a/mask",
  mask_sha256: "c".repeat(64),
  role: "aneurysm",
  producer: "aneurysm_model",
  status: "accepted",
  produced_artifact_version: "4",
  artifact_version: "5",
  provenance: {},
  segmentation_revision: 3,
};
const corrected = {
  ...base,
  candidate_id: "corrected-a",
  status: "preview",
  producer: "sam2_prompted_slice",
  produced_artifact_version: "5",
  provenance: {
    segmentation_extent: "single_slice_edit_of_existing_mask",
    point_label: 0,
    correction_base: { candidate_id: "base-a", mask_sha256: "c".repeat(64) },
  },
};

test("correction sends the current accepted base and exclusion polarity, keeps it an unaccepted preview", async () => {
  h.api
    .mockResolvedValueOnce({ current: { vessel: null, aneurysm: base } })
    .mockResolvedValueOnce(corrected);
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
  await screen.findByRole("button", { name: "Show accepted aneurysm" });
  expect(
    screen.getByRole("button", { name: "SAM at crosshair" }),
  ).toBeDisabled();
  fireEvent.change(screen.getByLabelText("SAM point action"), {
    target: { value: "0" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Refine accepted aneurysm" }),
  );
  await screen.findByText("SAM correction of accepted mask");
  expect(h.api.mock.calls[1][1]).toMatchObject({
    kind: "sam2",
    role: "aneurysm",
    artifact_version: "5",
    reference_revision: "b".repeat(64),
    base_candidate_id: "base-a",
    point_label: 0,
    point_ras: [1, 2, 3],
  });
  expect(h.api.mock.calls[1][1]).not.toHaveProperty("base_mask");
  expect(h.api.mock.calls[1][1]).not.toHaveProperty("mask_path");
  expect(onOverlay.mock.calls.at(-1)?.[0].candidate_id).toBe("corrected-a");
  expect(onAccepted).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "Refine accepted aneurysm" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Run aneurysm model" }),
  ).toBeDisabled();
});

test("inference waits for accepted-mask loading instead of racing a late overlay", async () => {
  let finish!: (value: unknown) => void;
  h.api.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <SegmentationPanel
      caseState={caseState}
      reference={reference}
      location={[1, 2, 3]}
      windowRange={[0, 600]}
      disabled={false}
      onOverlay={vi.fn()}
      onAccepted={vi.fn()}
      onError={vi.fn()}
    />,
  );
  await waitFor(() => expect(h.api).toHaveBeenCalledTimes(1));
  expect(
    screen.getByRole("button", { name: "Run aneurysm model" }),
  ).toBeDisabled();
  finish({ current: { vessel: null, aneurysm: base } });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Run aneurysm model" }),
    ).not.toBeDisabled(),
  );
});
