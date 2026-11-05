import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import DeviceSizingInputs from "./DeviceSizingInputs";
import type { CaseState } from "./api";
import type { MorphometryBinding } from "./MorphometryInputs";
// ACTUAL GET from the public CTA at case v8; all six measurement values are
// intentionally null. Synthetic edits below are test data only, never evidence
// about this real case.
import fixture from "./fixtures/device-inputs-current-metadata.json";
import sourceMetadata from "./fixtures/planning-source-metadata.json";

const caseState: CaseState = {
  case_id: fixture.case_id,
  title: "CTA v8 test case",
  image_sha256: fixture.image_sha256,
  source_url: null,
  dimensions: sourceMetadata.dimensions,
  spacing_mm: sourceMetadata.spacing_mm,
  spatial_units: "mm",
  artifact_version: fixture.artifact_version,
  notes: "",
  measurements: [],
  aneurysm_plan: null,
};

const binding: MorphometryBinding = {
  case_id: fixture.case_id,
  image_sha256: fixture.image_sha256,
  reference_revision: fixture.reference_revision,
};

const URI = `/cases/${fixture.case_id}/device-sizing-inputs`;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockGet(payload: unknown = fixture) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function currentInputs(
  note = "Technical persistence smoke test on approved public case. No independent measurement values supplied.",
  input_revision = "xEasu4qG5t5OVe0iqmP33A",
  measurements: Record<string, number | null> = {
    proximal_parent: null,
    distal_parent: null,
    neck_coverage_length: null,
    average_sac_diameter: null,
    smallest_sac_height: null,
    dome_diameter: null,
  },
) {
  return {
    status: "current",
    input_revision,
    inputs_sha256:
      "92d2e4f9683fcbd118cc9fe5eac8d3f35236a828b90716c81b1f4db0e9fdae69",
    geometry_dependencies: fixture.inputs.geometry_dependencies,
    measurements,
    provenance: { kind: "operator_reported", note },
    inputs_version: "operator-reported-device-inputs-v1",
  };
}

describe("DeviceSizingInputs", () => {
  it("treats a stale-geometry PUT echo as unconfirmed, not successful", async () => {
    const fetch = mockGet(),
      saved = vi.fn(),
      conflict = vi.fn();
    render(
      <DeviceSizingInputs
        caseState={caseState}
        binding={binding}
        onSaved={saved}
        onConflict={conflict}
      />,
    );
    fireEvent.change(await screen.findByTestId("sizing-provenance-note"), {
      target: { value: "SYNTHETIC changed note" },
    });
    fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          ...fixture,
          geometry_status: "stale",
          inputs: currentInputs("SYNTHETIC changed note", "NEWREVISION"),
        }),
      ),
    );
    fireEvent.click(screen.getByTestId("sizing-save"));
    await waitFor(() => expect(conflict).toHaveBeenCalledOnce());
    expect(saved).not.toHaveBeenCalled();
    expect(screen.getByTestId("sizing-save")).toBeDisabled();
    expect(screen.getByText(/Save is locked/)).toBeInTheDocument();
  });
  it("preserves the exact provenance note while saving and in its PUT", async () => {
    const fetch = mockGet(),
      saved = vi.fn();
    render(
      <DeviceSizingInputs
        caseState={caseState}
        binding={binding}
        onSaved={saved}
      />,
    );
    const area = await screen.findByTestId("sizing-provenance-note");
    const note = "  SYNTHETIC provenance with intentional whitespace  ";
    fireEvent.change(area, { target: { value: note } });
    fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          ...fixture,
          inputs: currentInputs(note, "NEWREVISION"),
        }),
      ),
    );
    fireEvent.click(screen.getByTestId("sizing-save"));
    expect(area).toHaveValue(note);
    const sent = JSON.parse(
      fetch.mock.calls.find(([, init]) => init?.method === "PUT")![1]!
        .body as string,
    );
    expect(sent.provenance.note).toBe(note);
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  });
  it.each(["0x10", "Infinity", "-3", "101", "abc"])(
    "does not enable save for invalid decimal %s",
    async (value) => {
      mockGet();
      render(<DeviceSizingInputs caseState={caseState} binding={binding} />);
      fireEvent.change(
        await screen.findByTestId("sizing-input-dome_diameter"),
        { target: { value } },
      );
      expect(screen.getByTestId("sizing-save")).toBeDisabled();
    },
  );
  it("does not GET while initially disabled and loads once enabled", async () => {
    const fetch = mockGet();
    const view = render(
      <DeviceSizingInputs caseState={caseState} binding={binding} disabled />,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch).not.toHaveBeenCalled();
    view.rerender(
      <DeviceSizingInputs caseState={caseState} binding={binding} />,
    );
    await screen.findByTestId("sizing-input-dome_diameter");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    "nested case",
    "null dependencies",
    "unknown geometry",
    "extra measurement",
    "blank note",
    "empty revision",
  ])("rejects %s producer metadata", async (mode) => {
    const payload = structuredClone(fixture) as unknown as Record<string, any>;
    if (mode === "nested case")
      payload.inputs.geometry_dependencies.case_id = "other";
    if (mode === "null dependencies")
      payload.inputs.geometry_dependencies = null;
    if (mode === "unknown geometry") payload.geometry_status = "unsupported";
    if (mode === "extra measurement") payload.inputs.measurements.extra = 10;
    if (mode === "blank note") payload.inputs.provenance.note = " ";
    if (mode === "empty revision") payload.inputs.input_revision = "";
    mockGet(payload);
    render(<DeviceSizingInputs caseState={caseState} binding={binding} />);
    await screen.findByText("Sizing inputs could not be loaded.");
    expect(screen.queryByTestId("sizing-input-dome_diameter")).toBeNull();
  });
  it.each(["not_saved", "stale"])(
    "allows new values when inputs are %s but geometry is current",
    async (status) => {
      const payload = {
        ...fixture,
        inputs: {
          status,
          input_revision:
            status === "stale" ? fixture.inputs.input_revision : null,
          inputs_sha256: null,
          measurements: null,
          provenance: null,
          inputs_version: fixture.inputs.inputs_version,
        },
      };
      mockGet(payload);
      render(<DeviceSizingInputs caseState={caseState} binding={binding} />);
      const field = await screen.findByTestId(
        "sizing-input-neck_coverage_length",
      );
      expect(field).toBeEnabled();
      expect(field).toHaveValue("");
      fireEvent.change(field, { target: { value: "7.5" } });
      fireEvent.change(screen.getByTestId("sizing-provenance-note"), {
        target: { value: "SYNTHETIC new operator input" },
      });
      expect(screen.getByTestId("sizing-save")).toBeEnabled();
    },
  );
  it("does not permit saving when materialized geometry is stale", async () => {
    mockGet({ ...fixture, geometry_status: "stale" });
    render(<DeviceSizingInputs caseState={caseState} binding={binding} />);
    const field = await screen.findByTestId(
      "sizing-input-neck_coverage_length",
    );
    expect(field).toBeDisabled();
    expect(screen.getByTestId("sizing-save")).toBeDisabled();
  });
  it("renders the actual fixture GET with all-null values and help text", async () => {
    mockGet();
    render(<DeviceSizingInputs caseState={caseState} binding={binding} />);
    await waitFor(() =>
      expect(screen.getByTestId("sizing-input-proximal_parent")).toHaveValue(
        "",
      ),
    );
    // All six values are null in the real fixture: no fabricated numbers.
    for (const key of [
      "proximal_parent",
      "distal_parent",
      "neck_coverage_length",
      "average_sac_diameter",
      "smallest_sac_height",
      "dome_diameter",
    ]) {
      expect(screen.getByTestId(`sizing-input-${key}`)).toHaveValue("");
    }
    expect(screen.getByTestId("sizing-provenance-note")).toHaveValue(
      "Technical persistence smoke test on approved public case. No independent measurement values supplied.",
    );
    expect(screen.getAllByText(/not image-derived/).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/Longitudinal neck extent/).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/not an existing single-plane maximum/).length,
    ).toBeGreaterThan(0);
  });

  it("PUTs an explicit numeric-or-null CAS body and treats the confirmed echo", async () => {
    const fetchMock = mockGet();
    const saved = vi.fn();
    render(
      <DeviceSizingInputs
        caseState={caseState}
        binding={binding}
        onSaved={saved}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("sizing-input-neck_coverage_length"),
      ).toBeTruthy(),
    );
    const input = screen.getByTestId("sizing-input-neck_coverage_length");
    // SYNTHETIC TEST VALUE — not a measurement of the real case.
    fireEvent.change(input, { target: { value: "7.5" } });
    await waitFor(() =>
      expect(screen.getByTestId("sizing-save")).toBeEnabled(),
    );
    const echoed = {
      ...fixture,
      inputs: currentInputs(undefined, "NEWREVISION000000000000000000000x", {
        proximal_parent: null,
        distal_parent: null,
        neck_coverage_length: 7.5,
        average_sac_diameter: null,
        smallest_sac_height: null,
        dome_diameter: null,
      }),
    };
    fetchMock.mockImplementation((url, init) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(init.body as string);
        expect(body).toEqual({
          artifact_version: "8",
          reference_revision: fixture.reference_revision,
          expected_input_revision: "xEasu4qG5t5OVe0iqmP33A",
          measurements: {
            proximal_parent: null,
            distal_parent: null,
            neck_coverage_length: 7.5,
            average_sac_diameter: null,
            smallest_sac_height: null,
            dome_diameter: null,
          },
          provenance: {
            kind: "operator_reported",
            note: "Technical persistence smoke test on approved public case. No independent measurement values supplied.",
          },
        });
        return Promise.resolve(
          new Response(JSON.stringify(echoed), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(fixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    fireEvent.click(screen.getByTestId("sizing-save"));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(screen.getByTestId("sizing-save")).toBeDisabled();
  });

  it("discard restores the saved snapshot without a write", async () => {
    const fetchMock = mockGet();
    render(<DeviceSizingInputs caseState={caseState} binding={binding} />);
    await waitFor(() =>
      expect(screen.getByTestId("sizing-provenance-note")).toBeTruthy(),
    );
    const before = (
      screen.getByTestId("sizing-provenance-note") as HTMLTextAreaElement
    ).value;
    fireEvent.change(screen.getByTestId("sizing-input-dome_diameter"), {
      target: { value: "9" }, // SYNTHETIC TEST VALUE
    });
    await waitFor(() =>
      expect(screen.getByTestId("sizing-save")).toBeEnabled(),
    );
    fireEvent.click(screen.getByTestId("sizing-discard"));
    expect(screen.getByTestId("sizing-input-dome_diameter")).toHaveValue("");
    expect(screen.getByTestId("sizing-provenance-note")).toHaveValue(before);
    expect(fetchMock).toHaveBeenCalledTimes(1); // GET only, no PUT
  });

  it("reports own busy scope: onBusy(true) during save does not block its own completion", async () => {
    const fetchMock = mockGet();
    const saved = vi.fn();
    function Owner() {
      const [busy, setBusy] = useState(false);
      return (
        <DeviceSizingInputs
          caseState={caseState}
          binding={binding}
          disabled={busy}
          onBusy={setBusy}
          onSaved={saved}
        />
      );
    }
    render(<Owner />);
    await screen.findByTestId("sizing-input-dome_diameter");
    // SYNTHETIC TEST VALUE
    fireEvent.change(screen.getByTestId("sizing-input-dome_diameter"), {
      target: { value: "9" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("sizing-save")).toBeEnabled(),
    );
    const echoed = {
      ...fixture,
      inputs: currentInputs(undefined, "NEWREVISION000000000000000000000x", {
        proximal_parent: null,
        distal_parent: null,
        neck_coverage_length: null,
        average_sac_diameter: null,
        smallest_sac_height: null,
        dome_diameter: 9,
      }),
    };
    fetchMock.mockImplementation((url, init) =>
      Promise.resolve(
        new Response(
          JSON.stringify(init?.method === "PUT" ? echoed : fixture),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );
    fireEvent.click(screen.getByTestId("sizing-save"));
    expect(screen.getByTestId("sizing-save")).toBeDisabled();
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(screen.queryByText(/Save is locked/)).toBeNull();
  });

  it("ignores a genuinely late GET after a new valid version has loaded", async () => {
    let finishOld!: (value: Response) => void;
    const next = structuredClone(fixture);
    next.artifact_version = "9";
    next.inputs.geometry_dependencies.artifact_version = "9";
    // SYNTHETIC response-shape edit only.
    const newer = {
      ...next,
      inputs: {
        ...next.inputs,
        measurements: { ...next.inputs.measurements, dome_diameter: 9 },
      },
    };
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockResolvedValue(new Response(JSON.stringify(newer)));
    const view = render(
      <DeviceSizingInputs caseState={caseState} binding={binding} />,
    );
    await waitFor(() => expect(finishOld).toBeTypeOf("function"));
    view.rerender(
      <DeviceSizingInputs
        caseState={{ ...caseState, artifact_version: "9" }}
        binding={binding}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("sizing-input-dome_diameter")).toHaveValue("9"),
    );
    finishOld(new Response(JSON.stringify(fixture)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByTestId("sizing-input-dome_diameter")).toHaveValue("9");
  });

  it("does not GET with unknown units or a mismatched binding", async () => {
    const fetchMock = mockGet();
    const { rerender } = render(
      <DeviceSizingInputs
        caseState={{ ...caseState, spatial_units: "unknown" }}
        binding={binding}
      />,
    );
    expect(screen.queryByTestId("sizing-input-dome_diameter")).toBeNull();
    rerender(
      <DeviceSizingInputs
        caseState={caseState}
        binding={{ ...binding, case_id: "OTHER-CASE" }}
      />,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("locks retries after an unconfirmed PUT and surfaces reload-required", async () => {
    const fetchMock = mockGet();
    const onConflict = vi.fn();
    render(
      <DeviceSizingInputs
        caseState={caseState}
        binding={binding}
        onConflict={onConflict}
      />,
    );
    await screen.findByTestId("sizing-input-dome_diameter");
    // SYNTHETIC TEST VALUE
    fireEvent.change(screen.getByTestId("sizing-input-dome_diameter"), {
      target: { value: "9" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("sizing-save")).toBeEnabled(),
    );
    // Malformed echo (matches nothing): a committed write cannot be ruled out.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ unexpected: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fireEvent.click(screen.getByTestId("sizing-save"));
    await waitFor(() => expect(onConflict).toHaveBeenCalled());
    expect(screen.getByText(/Save is locked/)).toBeTruthy();
    expect(screen.getByTestId("sizing-save")).toBeDisabled();
    const calls = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByTestId("sizing-save"));
    expect(fetchMock.mock.calls.length).toBe(calls);
  });
});
