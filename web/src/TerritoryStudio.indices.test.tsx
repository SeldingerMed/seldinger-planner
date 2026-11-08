import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { NVImage } from "@niivue/niivue";
import captures from "./__fixtures__/territory-path-workflows.json";
import TerritoryStudio from "./TerritoryStudio";
import { pathIndexError } from "./territoryWorkflow";
vi.mock("./TerritorySectionEditor", () => ({
  default: () => <div>Section editor</div>,
}));
vi.mock("./TerritoryPathEditor", () => ({
  default: () => <div>Path editor</div>,
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
test.each([
  ["coronary_pci", "proximal_reference"],
  ["aortic_peripheral", "sac_index"],
] as const)(
  "%s preflight rejects invalid index ranges and types",
  (mode, field) => {
    const input = captures[mode].current.inputs;
    for (const value of [-1, input.path.length, 1.5, null])
      expect(
        pathIndexError(mode, { ...input, [field]: value }, input.path.length),
      ).toContain("within the current path");
    expect(pathIndexError(mode, input, input.path.length)).toBe("");
  },
);
const props = {
  caseState: {
    case_id: captures.tavr.case_id,
    image_sha256: captures.tavr.image_sha256,
    artifact_version: captures.tavr.artifact_version,
    spatial_units: "mm" as const,
  },
  binding: {
    case_id: captures.tavr.case_id,
    image_sha256: captures.tavr.image_sha256,
    reference_revision: captures.tavr.reference_revision,
  },
  volume: {} as NVImage,
  cursor: [5, 5, 15] as [number, number, number],
};
test.each([
  {
    mode: "coronary_pci",
    label: "Coronary PCI",
    metric: "lesion_length_mm",
    good: "lesion start",
    goodValue: "5",
    bad: "lesion end",
    badValue: "4",
    message:
      "proximal reference ≤ lesion start < lesion end ≤ distal reference",
  },
  {
    mode: "aortic_peripheral",
    label: "Aortic / peripheral",
    metric: "neck_length_mm",
    good: "neck start",
    goodValue: "4",
    bad: "neck end",
    badValue: "3",
    message: "suprarenal index < neck start < neck end < sac index",
  },
])(
  "$mode disables a newly out-of-order draft after an admitted ordering",
  async (entry) => {
    const fetcher = vi.fn((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            captures[url.split("/").at(-1) as keyof typeof captures],
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    render(<TerritoryStudio {...props} />);
    await screen.findByTestId("metric-left_coronary_height_mm");
    fireEvent.click(screen.getByRole("button", { name: entry.label }));
    await screen.findByTestId(`metric-${entry.metric}`);
    fireEvent.change(screen.getByLabelText(entry.good), {
      target: { value: entry.goodValue },
    });
    expect(
      screen.getByRole("button", { name: "Save and calculate" }),
    ).toBeEnabled();
    fireEvent.change(screen.getByLabelText(entry.bad), {
      target: { value: entry.badValue },
    });
    expect(
      screen.getByRole("button", { name: "Save and calculate" }),
    ).toBeDisabled();
    expect(
      screen
        .getAllByRole("status")
        .some((el) => el.textContent?.includes(entry.message)),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save and calculate" }));
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);
