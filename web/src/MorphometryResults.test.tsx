import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import MorphometryResults, {
  type MorphometryBinding,
} from "./MorphometryResults";
import type { CaseState } from "./api";
import type { Point3 } from "./geometry";
import fixture from "./fixtures/geometry-current-metadata.json";
import sourceMetadata from "./fixtures/planning-source-metadata.json";

const caseState: CaseState = {
  case_id: fixture.case_id,
  title: "Case 006",
  image_sha256: fixture.image_sha256,
  source_url: null,
  dimensions: sourceMetadata.dimensions,
  spacing_mm: sourceMetadata.spacing_mm,
  spatial_units: "mm",
  artifact_version: fixture.artifact_version,
  notes: "",
  measurements: [],
};

const binding: MorphometryBinding = {
  case_id: fixture.case_id,
  image_sha256: fixture.image_sha256,
  reference_revision: fixture.reference_revision,
};

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string) => Promise.resolve(okResponse(fixture))),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderWith(binding_ = binding) {
  const onFocus = vi.fn<(point: Point3) => void>();
  render(
    <MorphometryResults
      caseState={caseState}
      binding={binding_}
      onFocus={onFocus}
    />,
  );
  return { onFocus };
}

describe("MorphometryResults", () => {
  it("states the geometry provenance without repetitive draft boilerplate", async () => {
    await renderWith();
    await screen.findByText("Operator-defined planes · source mm");
    expect(screen.getByText("Current estimate")).toBeInTheDocument();
    expect(screen.queryByText("Draft UI · not clinically validated")).not.toBeInTheDocument();
  });
  it("renders an explicitly computed sac volume in cubic millimeters", async () => {
    const enriched = {
      ...fixture,
      current: {
        ...fixture.current,
        result: {
          ...fixture.current.result,
          sac: { ...fixture.current.result.sac, volume: 24 },
        },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(okResponse(enriched))),
    );
    await renderWith();
    expect(await screen.findByText("Sac volume")).toBeInTheDocument();
    expect(screen.getByText("24.00 mm³")).toBeInTheDocument();
  });

  it.each([Infinity, Number.NaN, -1, 0])(
    "rejects a supplied invalid volume %s without retaining other current numbers",
    async (volume) => {
      const enriched = {
        ...fixture,
        current: {
          ...fixture.current,
          result: {
            ...fixture.current.result,
            sac: { ...fixture.current.result.sac, volume },
          },
        },
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(okResponse(enriched))),
      );
      await renderWith();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.queryByText("Current estimate")).not.toBeInTheDocument();
      expect(screen.queryByText("Sac volume")).not.toBeInTheDocument();
    },
  );

  it("accepts the actual stale producer shape without old numbers", async () => {
    const stale = {
      ...fixture,
      current: {
        status: "stale",
        result_id: "historical",
        result: null,
        stale_reasons: ["geometry_dependencies_changed"],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(okResponse(stale))),
    );
    await renderWith();
    expect(await screen.findByText("Stale")).toBeInTheDocument();
    expect(screen.queryByText("10.08 mm")).not.toBeInTheDocument();
  });

  it("never displays millimeters for an unknown-unit case", async () => {
    render(
      <MorphometryResults
        caseState={{ ...caseState, spatial_units: "unknown" }}
        binding={binding}
        onFocus={() => {}}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText("Current estimate")).not.toBeInTheDocument();
    expect(screen.queryByText("10.08 mm")).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a finite normal whose norm overflows", async () => {
    const bad = structuredClone(fixture);
    bad.current.result.neck.plane_normal = [
      Number.MAX_VALUE,
      Number.MAX_VALUE,
      Number.MAX_VALUE,
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(okResponse(bad))),
    );
    await renderWith();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText("Current estimate")).not.toBeInTheDocument();
    expect(document.querySelectorAll("svg.morphometry-contour")).toHaveLength(
      0,
    );
  });

  it("renders real fixture scalars, contours and focus buttons", async () => {
    await renderWith();
    expect(await screen.findByText("Current estimate")).toBeInTheDocument();
    expect(screen.getByText("Mask geometry")).toBeInTheDocument();
    expect(
      screen.getByText("Operator-defined planes · source mm"),
    ).toBeInTheDocument();
    // Real fixture values, 2-dp formatting only.
    expect(screen.getByText("10.08 mm")).toBeInTheDocument(); // sac height
    expect(screen.getByText("17.45 mm")).toBeInTheDocument(); // sac width
    expect(screen.getByText("14.34 mm")).toBeInTheDocument(); // neck max
    expect(screen.getByText("8.08 mm")).toBeInTheDocument(); // neck min
    expect(screen.getByText("9.97 mm")).toBeInTheDocument(); // neck equivalent
    expect(screen.getByText("78.04 mm²")).toBeInTheDocument(); // neck area
    expect(screen.getByText("5.15 mm")).toBeInTheDocument(); // proximal max
    expect(screen.getByText("5.06 mm")).toBeInTheDocument(); // distal max
    const svgs = document.querySelectorAll("svg.morphometry-contour");
    expect(svgs.length).toBe(3);
    // Equal aspect: each contour SVG has a square viewport and a real path.
    for (const svg of svgs) {
      const vb = svg.getAttribute("viewBox")!.split(/\s+/).map(Number);
      expect(vb[2]).toBeGreaterThan(0);
      expect(vb[3]).toBeGreaterThan(0);
      expect(svg.querySelector("path")).not.toBeNull();
    }
    expect(screen.getByText("Locate neck origin")).toBeInTheDocument();
  });

  it("fails closed on reference_revision mismatch", async () => {
    await renderWith({
      ...binding,
      reference_revision: "0".repeat(64),
    });
    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Not computed")).toBeInTheDocument();
    expect(screen.queryByText("10.08 mm")).not.toBeInTheDocument();
    expect(document.querySelectorAll("svg.morphometry-contour").length).toBe(0);
  });

  it("hides old scope synchronously and discards a delayed stale response", async () => {
    let resolveA: (r: Response) => void = () => {};
    const firstFetch = new Promise<Response>((res) => {
      resolveA = res;
    });
    vi.mocked(fetch).mockImplementationOnce(() => firstFetch);
    const { rerender } = render(
      <MorphometryResults
        caseState={caseState}
        binding={binding}
        onFocus={() => {}}
      />,
    );
    // Case A is still loading: no numbers on screen.
    expect(screen.queryByText("Current estimate")).not.toBeInTheDocument();

    // Switch to case B (different reference revision) while A is in flight.
    const bindingB = {
      ...binding,
      reference_revision: "b".repeat(64),
    };
    const envelopeB = JSON.parse(JSON.stringify(fixture));
    envelopeB.reference_revision = bindingB.reference_revision;
    envelopeB.current.dependencies.source_revision =
      bindingB.reference_revision;
    envelopeB.current.result.sac.height = 5.5;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(okResponse(envelopeB))),
    );
    rerender(
      <MorphometryResults
        caseState={caseState}
        binding={bindingB}
        onFocus={() => {}}
      />,
    );
    // Old scope must be hidden synchronously at this render.
    expect(screen.queryByText("Current estimate")).not.toBeInTheDocument();

    // Case B loads.
    expect(await screen.findByText("Current estimate")).toBeInTheDocument();

    // Late case A response must be discarded.
    await act(async () => {
      resolveA(okResponse(fixture));
      await firstFetch;
    });
    expect(screen.getByText("Current estimate")).toBeInTheDocument();
    expect(screen.getByText("5.50 mm")).toBeInTheDocument(); // B's sac
    expect(screen.queryByText("10.08 mm")).not.toBeInTheDocument(); // A's stale sac
  });

  it("shows Stale with no numeric results when status is not current", async () => {
    const stale = { ...fixture, current: { status: "stale", result: null } };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(okResponse(stale))),
    );
    await renderWith();
    expect(await screen.findByText("Stale")).toBeInTheDocument();
    expect(screen.queryByText("10.08 mm")).not.toBeInTheDocument();
    expect(document.querySelectorAll("svg.morphometry-contour").length).toBe(0);
  });

  it("calls onFocus with the section plane origin", async () => {
    const { onFocus } = await renderWith();
    await screen.findByText("Current estimate");
    fireEvent.click(screen.getByText("Locate neck origin"));
    expect(onFocus).toHaveBeenCalledTimes(1);
    const arg = onFocus.mock.calls[0][0];
    const origin = fixture.current.result.neck.plane_origin;
    expect(arg).toEqual([origin[0], origin[1], origin[2]]);
  });

  it("rejects non-positive or non-finite scalars (fail closed)", async () => {
    const bad = JSON.parse(JSON.stringify(fixture));
    bad.current.result.neck.max_diameter = -1;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(okResponse(bad))),
    );
    await renderWith();
    await waitFor(() => {
      expect(screen.getByText("Not computed")).toBeInTheDocument();
    });
    expect(screen.queryByText("Current estimate")).not.toBeInTheDocument();
  });
});
