import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DeviceReference from "./DeviceReference";
import type { MorphometryBinding } from "./MorphometryInputs";
import type { CaseState } from "./api";
import catalogFixture from "./fixtures/device-catalog-metadata.json";
import checksFixture from "./fixtures/device-checks-current-metadata.json";
import sourceMetadata from "./fixtures/planning-source-metadata.json";

const catalog = catalogFixture as unknown as DeviceCatalogShape;
const checks = checksFixture as unknown as Record<string, unknown>;

type DeviceCatalogShape = Record<string, unknown>;

const caseState: CaseState = {
  case_id: checksFixture.case_id,
  title: "Case 006",
  image_sha256: checksFixture.image_sha256,
  source_url: null,
  dimensions: sourceMetadata.dimensions,
  spacing_mm: sourceMetadata.spacing_mm,
  spatial_units: "mm",
  artifact_version: checksFixture.artifact_version,
  notes: "",
  measurements: [],
};

const binding: MorphometryBinding = {
  case_id: checksFixture.case_id,
  image_sha256: checksFixture.image_sha256,
  reference_revision: checksFixture.reference_revision,
};

type FetchCall = { url: string; init?: RequestInit };

function stubFetch(
  catalogBody: unknown = catalog,
  checksBody: unknown = checks,
) {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const body = String(url).includes("/device-catalog")
        ? catalogBody
        : checksBody;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => body,
      } as Response);
    }),
  );
  return calls;
}

beforeEach(() => {
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderComp(b: MorphometryBinding = binding, disabled = false) {
  return render(
    <DeviceReference caseState={caseState} binding={b} disabled={disabled} />,
  );
}

describe("DeviceReference", () => {
  it.each([
    "calculation version",
    "device version",
    "missing parent",
    "source link",
    "WEB availability",
    "missing dimension",
  ])(
    "rejects inconsistent %s metadata before showing comparisons",
    async (field) => {
      const c = structuredClone(catalogFixture),
        v = structuredClone(checksFixture);
      if (field === "calculation version")
        v.dependencies.geometry.calculation_version = "other";
      if (field === "device version")
        v.dependencies.device_checks_version = "other";
      if (field === "missing parent")
        delete (v.checks.pipeline.parent_sections as Record<string, unknown>)
          .proximal_parent;
      if (field === "source link")
        c.pipeline.source.url = "javascript:alert(1)";
      if (field === "WEB availability")
        v.checks.web.catalog_rows_available = true;
      if (field === "missing dimension")
        delete (v.missing_dimensions as Record<string, unknown>)
          .neck_coverage_length;
      stubFetch(c, v);
      renderComp();
      await screen.findByText("Unavailable");
      expect(screen.queryByTestId("dr-badge")).not.toBeInTheDocument();
      expect(screen.queryByText(/3\.453–5\.151 mm/)).not.toBeInTheDocument();
    },
  );
  it.each(["case", "image"])(
    "does not request metadata for a mismatched %s binding",
    async (field) => {
      const calls = stubFetch();
      render(
        <DeviceReference
          caseState={
            field === "case"
              ? { ...caseState, case_id: "different" }
              : { ...caseState, image_sha256: "0".repeat(64) }
          }
          binding={binding}
        />,
      );
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(calls).toHaveLength(0);
      expect(screen.getByText("Unavailable")).toBeInTheDocument();
    },
  );
  it.each(["disabled", "unknown units"])(
    "immediately hides loaded case numbers when %s",
    async (mode) => {
      const view = renderComp();
      await screen.findByTestId("dr-badge");
      view.rerender(
        <DeviceReference
          caseState={
            mode === "unknown units"
              ? { ...caseState, spatial_units: "unknown" }
              : caseState
          }
          binding={binding}
          disabled={mode === "disabled"}
        />,
      );
      expect(screen.queryByText(/3\.453–5\.151 mm/)).not.toBeInTheDocument();
      expect(screen.queryByTestId("dr-badge")).not.toBeInTheDocument();
      expect(screen.getByText("Unavailable")).toBeInTheDocument();
    },
  );
  it("renders real-fixture data with exactly two GET paths and no write methods", async () => {
    const calls = stubFetch();
    renderComp();
    await waitFor(() => expect(screen.getByTestId("dr-badge")).toBeDefined());
    expect(
      calls.filter((c) => c.url.endsWith("/api/device-catalog")),
    ).toHaveLength(1);
    expect(
      calls.filter(
        (c) =>
          c.url ===
          `/api/cases/${encodeURIComponent(binding.case_id)}/device-checks`,
      ),
    ).toHaveLength(1);
    expect(
      calls.every(
        (c) => !c.init || (!c.init.body && c.init?.method !== "POST"),
      ),
    ).toBe(true);
    expect(screen.getByText("Missing sizing inputs")).toBeDefined();
    expect(screen.getByText(/3\.453–5\.151 mm/)).toBeDefined();
    expect(screen.getByText(/3\.453–5\.057 mm/)).toBeDefined();
    expect(screen.getAllByText(/outside historical interval/)).toHaveLength(2);
    expect(screen.getByText(/not clinical eligibility/i)).toBeDefined();
    expect(screen.getByText(/longitudinal neck extent/i)).toBeDefined();
    fireEvent.click(screen.getByText("Historical Pipeline size rows"));
    expect(screen.getByText("PIPELINE-HIST-3_00")).toBeDefined();
    expect(screen.getByText(/not manufacturer SKUs/i)).toBeDefined();
    expect(screen.getByText("71012-001 Rev. 5 (12/2018)")).toBeDefined();
    expect(screen.getByText(/WEB catalog is unavailable/i)).toBeDefined();
  });

  it("shows Stale for the real stale producer shape with no case numbers", async () => {
    const stale = {
      ...checks,
      status: "stale",
      geometry_status: "stale",
      checks: null,
      dependencies: null,
    };
    stubFetch(catalog, stale);
    renderComp();
    await waitFor(() => expect(screen.getByText("Stale")).toBeDefined());
    expect(screen.queryByText(/3\.453/)).toBeNull();
    expect(screen.queryByText(/Feret extrema/)).toBeNull();
    expect(screen.queryByText("Missing sizing inputs")).toBeNull();
  });

  it("fails closed on catalog version mismatch between the two GETs", async () => {
    const mismatched = {
      ...checks,
      catalog_version:
        "0000000000000000000000000000000000000000000000000000000000000000",
    };
    stubFetch(catalog, mismatched);
    renderComp();
    await waitFor(() => expect(screen.getByText("Unavailable")).toBeDefined());
    expect(screen.queryByText(/3\.453/)).toBeNull();
    expect(screen.queryByText("PIPELINE-HIST-3_00")).toBeNull();
  });

  it("issues no GETs for unknown spatial units", async () => {
    const calls = stubFetch();
    render(
      <DeviceReference
        caseState={{ ...caseState, spatial_units: "unknown" }}
        binding={binding}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(calls).toHaveLength(0);
    expect(screen.getByText("Unavailable")).toBeDefined();
  });

  it("discards an actual late old-case response after a valid scope switch", async () => {
    let finishOld!: (r: Response) => void;
    const next = structuredClone(checksFixture);
    next.case_id = "other-case-id";
    next.dependencies.geometry.case_id = "other-case-id";
    next.checks.pipeline.parent_sections.proximal_parent = {
      min_diameter_mm: 2,
      max_diameter_mm: 3,
      equivalent_diameter_mm: 2.5,
      area_mm2: 4.9,
      comparison: "within_historical_range",
    };
    const response = (body: unknown) =>
      ({ ok: true, status: 200, json: async () => body }) as Response;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        String(url).includes("/device-catalog")
          ? Promise.resolve(response(catalog))
          : String(url).includes("other-case-id")
            ? Promise.resolve(response(next))
            : new Promise<Response>((resolve) => {
                finishOld = resolve;
              }),
      ),
    );
    const view = renderComp();
    await waitFor(() => expect(finishOld).toBeTypeOf("function"));
    view.rerender(
      <DeviceReference
        caseState={{ ...caseState, case_id: "other-case-id" }}
        binding={{ ...binding, case_id: "other-case-id" }}
      />,
    );
    await screen.findByText(/2–3 mm/);
    await act(async () => {
      finishOld(response(checks));
      await Promise.resolve();
    });
    expect(screen.getByText(/2–3 mm/)).toBeInTheDocument();
    expect(screen.queryByText(/3\.453–5\.151 mm/)).not.toBeInTheDocument();
  });
});
