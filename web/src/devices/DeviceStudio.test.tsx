import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { flowDiverter } from "./geometry";
import type { CaseState } from "../api";
import { sha256Hex } from "../browserCrypto";
it("moves a flow diverter along the picked curved path without translating or extrapolating the path", () => {
  const g = flowDiverter({
    path: [
      [0, 0, 0],
      [0, 0, 10],
      [10, 0, 10],
    ],
    diameterMm: 2,
    lengthMm: 5,
    wireCount: 8,
    turns: 1,
    startMm: 12,
  });
  expect(g.bounds.min[0]).toBeCloseTo(2);
  expect(g.bounds.max[0]).toBeCloseTo(7);
  expect(() =>
    flowDiverter({
      path: [
        [0, 0, 0],
        [0, 0, 10],
      ],
      diameterMm: 2,
      lengthMm: 5,
      wireCount: 8,
      turns: 1,
      startMm: 7,
    }),
  ).toThrow();
});
import { afterEach, expect, it, vi } from "vitest";
afterEach(cleanup);
vi.mock("./DeviceScene", () => ({
  default: () => <div data-testid="scene" />,
}));
import DeviceStudio from "./DeviceStudio";
it("mounts solved numerics beside the analytic bench but disables native execution without anatomy", () => {
  render(
    <DeviceStudio
      file={null}
      caseState={null}
      sourceRevision={null}
      onClose={() => {}}
    />,
  );
  expect(screen.getByLabelText("Rod radius (mm)")).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Compute solved numerics" }),
  ).toBeDisabled();
});

it("restores the actual visual braid state with a saved alternative", () => {
  localStorage.clear();
  render(
    <DeviceStudio
      file={null}
      caseState={null}
      sourceRevision={null}
      onClose={() => {}}
    />,
  );
  fireEvent.change(
    screen.getByRole("slider", { name: "Illustrative braid angle (degrees)" }),
    { target: { value: "60" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Save placement" }));
  fireEvent.change(
    screen.getByRole("slider", { name: "Illustrative braid angle (degrees)" }),
    { target: { value: "45" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  expect(
    screen.getByRole("slider", { name: "Illustrative braid angle (degrees)" }),
  ).toHaveValue("60");
});
it("never shows a measured-looking coil volume for a coil with no captured SKU data", () => {
  localStorage.clear();
  render(
    <DeviceStudio
      file={null}
      caseState={null}
      sourceRevision={null}
      onClose={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Target 360/ }));
  expect(
    screen.getByRole("heading", { name: "Target 360" }),
  ).toBeInTheDocument();
  // No per-SKU primary diameter is captured for the coil families, so the
  // volume/density metrics must be absent entirely rather than shown from a
  // visualization default.
  expect(screen.queryByText("Coil wire volume")).not.toBeInTheDocument();
  expect(screen.queryByText("Packing volume density")).not.toBeInTheDocument();
  expect(
    screen.getByRole("slider", { name: "Secondary coil length (mm)" }),
  ).toBeInTheDocument();
});

it("exposes manufacturer-specific models without a CTA and keeps recalled devices out of normal choices", async () => {
  render(
    <DeviceStudio
      file={null}
      caseState={null}
      sourceRevision={null}
      onClose={() => {}}
    />,
  );
  expect(
    screen.getByRole("heading", { name: "Device planning studio" }),
  ).toBeInTheDocument();
  expect(
    screen.getByText("Captured subset, not a complete catalog"),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Saved bench examples" }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("CTA volume")).toBeDisabled();
  expect(
    screen.getByRole("button", { name: /Surpass Elite/ }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /WEB SLS/ }));
  expect(screen.getByRole("heading", { name: "WEB SLS" })).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /Vantage 027/ }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByLabelText("Show research and recalled references"),
  );
  expect(
    screen.getByRole("button", { name: /Vantage 027/ }),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/No clinical outcome probability is calculated/),
  ).toBeInTheDocument();
});

it("keeps anatomy controls eligible when a save fails after anatomy has loaded", async () => {
  localStorage.clear();
  const IMG = "b".repeat(64);
  const REV = "rev-1";
  const maskSha = "a".repeat(64);
  const surface = new Uint8Array(200);
  const surfaceSha = await sha256Hex(surface.buffer);
  const caseState: CaseState = {
    case_id: "case-1",
    title: "Case 1",
    image_sha256: IMG,
    source_url: null,
    dimensions: [10, 10, 40],
    spacing_mm: [1, 1, 1],
    spatial_units: "mm",
    artifact_version: "v1",
    notes: "",
    measurements: [],
  };
  const env = {
    case_id: "case-1",
    image_sha256: IMG,
    artifact_version: "v1",
    reference_revision: REV,
    current: {
      status: "current",
      result_id: "res-1",
      dependencies: {
        artifact_version: "v1",
        image_sha256: IMG,
        source_revision: REV,
        masks: {
          vessel: { mask_sha256: maskSha },
          aneurysm: { mask_sha256: maskSha },
        },
      },
      result: {
        spatial_units: "mm",
        sac: {},
        neck: {},
        proximal_parent: {},
        distal_parent: {},
      },
    },
    operator_inputs: {
      parent_path: [
        [0, 0, 0],
        [0, 0, 10],
        [0, 0, 20],
        [0, 0, 30],
      ],
      aneurysm_seed: [1, 2, 3],
      neck_normal: [0, 1, 0],
      neck_origin: [0, 0, 0],
    },
  };
  const entries = {
    current: {
      vessel: {
        status: "accepted",
        case_id: "case-1",
        image_sha256: IMG,
        reference_revision: REV,
        candidate_id: "cand-v",
        mask_sha256: maskSha,
      },
      aneurysm: {
        status: "accepted",
        case_id: "case-1",
        image_sha256: IMG,
        reference_revision: REV,
        candidate_id: "cand-a",
        mask_sha256: maskSha,
      },
    },
  };
  const okResponse = (body: unknown, headers: Record<string, string>) => ({
    ok: true,
    json: async () => body,
    arrayBuffer: async () => surface.buffer,
    headers: { get: (k: string) => headers[k] ?? null },
  });
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const u = String(input);
    if (u.endsWith("/morphometry")) return okResponse(env, {});
    if (u.endsWith("/segmentations")) return okResponse(entries, {});
    if (u.includes("/surface"))
      return okResponse(null, {
        "X-Mask-Sha256": maskSha,
        "X-Surface-Sha256": surfaceSha,
        "content-length": "200",
      });
    throw new Error("unexpected fetch " + u);
  });
  vi.stubGlobal("fetch", fetchMock);
  try {
    const view = render(
      <DeviceStudio
        file={new File([""], "cta.nii")}
        caseState={caseState}
        sourceRevision={REV}
        onClose={() => {}}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Place in CTA" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Place in CTA" }));
    for (const [label, value] of [
      ["Rod radius (mm)", "0.2"],
      ["Rod elastic axial stiffness EA (N)", "8"],
      ["Rod bending stiffness EI (N·mm2)", "0.02"],
      ["Lumen contact stiffness (N per mm)", "1000"],
    ]) fireEvent.change(screen.getByLabelText(label), { target: { value } });
    expect(screen.getByRole("button",{name:"Compute solved numerics"})).toBeEnabled();
    const setItemSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota exceeded");
      });
    try {
      // Only bench examples use browser storage. Anatomy alternatives now use
      // the authoritative server set, so exercise the storage failure in bench.
      fireEvent.click(screen.getByRole("button", { name: "Device bench" }));
      fireEvent.click(screen.getByRole("button", { name: "Save placement" }));
      expect(screen.getByRole("alert")).toHaveTextContent("quota exceeded");
    } finally {
      setItemSpy.mockRestore();
    }
    expect(
      screen.getByRole("button", { name: "Place in CTA" }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("button", {name:"Place in CTA"}));
    expect(screen.getByRole("button",{name:"Compute solved numerics"})).toBeEnabled();
    expect(screen.getByLabelText("Rod radius (mm)")).toBeEnabled();
    vi.stubGlobal("fetch",vi.fn(async()=>{throw new Error("anatomy load failed");}));
    view.rerender(<DeviceStudio file={new File([""],"cta.nii")} caseState={caseState}
      sourceRevision="rev-2" onClose={()=>{}} />);
    expect(screen.getByRole("button",{name:"Place in CTA"})).toBeDisabled();
    await waitFor(()=>expect(screen.getByRole("alert")).toHaveTextContent("anatomy load failed"));
    expect(screen.getByRole("button",{name:"Place in CTA"})).toBeDisabled();
    expect(screen.getByRole("button",{name:"Compute solved numerics"})).toBeDisabled();
    expect(screen.getByLabelText("Rod radius (mm)")).toBeDisabled();
  } finally {
    vi.unstubAllGlobals();
  }
});
