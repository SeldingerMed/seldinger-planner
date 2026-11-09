import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
const h = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("./api", () => ({ api: h.api }));
import SegmentationPanel from "./SegmentationPanel";

afterEach(() => { cleanup(); h.api.mockReset(); });

test("original RSNA vessel output uses its actual kind and remains a reviewable preview", async () => {
  const candidate = {
    case_id: "case-a", image_sha256: "a".repeat(64), reference_revision: "b".repeat(64),
    candidate_id: "rsna-vessel-a", role: "vessel", producer: "rsna_vessel_model", status: "preview",
    produced_artifact_version: "1", mask_url: "/api/cases/case-a/segmentations/rsna-vessel-a/mask",
    mask_sha256: "c".repeat(64), segmentation_revision: null, provenance: {},
  };
  h.api.mockResolvedValueOnce({current: {vessel: null, aneurysm: null}}).mockResolvedValueOnce(candidate);
  const onAccepted = vi.fn();
  render(<SegmentationPanel caseState={{case_id: "case-a", image_sha256: "a".repeat(64), artifact_version: "1"} as never}
    reference={{case_id: "case-a", image_sha256: "a".repeat(64), reference_revision: "b".repeat(64)}}
    location={null} windowRange={[0, 600]} disabled={false} onOverlay={vi.fn()} onAccepted={onAccepted} onError={vi.fn()} />);
  const button = screen.getByRole("button", {name: "Run RSNA vessel model"});
  await waitFor(() => expect(button).not.toBeDisabled());
  fireEvent.click(button);
  await screen.findByText("Trained RSNA vessel candidate (3D context)");
  expect(h.api.mock.calls[1][1]).toMatchObject({kind: "rsna-vessel", role: "vessel", artifact_version: "1", reference_revision: "b".repeat(64)});
  expect(onAccepted).not.toHaveBeenCalled();
  expect(screen.getByRole("button", {name: "Accept candidate"})).toBeEnabled();
});
