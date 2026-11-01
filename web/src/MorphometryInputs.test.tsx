import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import MorphometryInputs, {
  type MorphometryBinding,
} from "./MorphometryInputs";
import type { CaseState } from "./api";
import { RevisionConflictError } from "./api";
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

type Handler = (url: string, init?: RequestInit) => Response | undefined;

function routeFetch(handler: Handler) {
  const fn = vi.fn((url: string, init?: RequestInit) => {
    const response = handler(url, init);
    if (response) return Promise.resolve(response);
    return Promise.reject(new Error(`unrouted fetch ${url}`));
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const crosshair: Point3 = [-15.335871696472168, 13.529752254486084, -7.625];
const domeSpot: Point3 = [-15.335871696472168, 13.529752254486084, 2.375];

const baseProps = {
  caseState,
  binding,
  location: crosshair,
  disabled: false,
  onRevision: vi.fn(),
  onComputed: vi.fn(),
  onDirtyChange: vi.fn(),
  onBusy: vi.fn(),
  onError: vi.fn(),
};

function renderInputs(props: Partial<typeof baseProps> = {}) {
  const merged = { ...baseProps, ...props };
  const view = render(<MorphometryInputs {...merged} />);
  return { view, props: merged };
}

beforeEach(() => {
  vi.clearAllMocks();
  routeFetch(() => okResponse(fixture));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function waitReady() {
  await screen.findByText("Geometry landmarks");
  await waitFor(() =>
    expect(screen.getByTestId("parent-path-count")).toBeInTheDocument(),
  );
}

describe("MorphometryInputs", () => {
  it.each(["mismatched echo", "lost response"])(
    "locks an unconfirmed save after %s instead of retrying a possibly committed write",
    async (failure) => {
      const { props } = renderInputs({ location: [0, 0, 0] });
      await waitReady();
      fireEvent.click(screen.getByRole("button", { name: "Set sac seed" }));
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          if (failure === "lost response")
            throw new Error("connection dropped");
          return okResponse({ ...fixture, artifact_version: "6" });
        }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Save geometry inputs" }),
      );
      await waitFor(() => expect(props.onError).toHaveBeenCalled());
      expect(props.onError.mock.calls[0][0]).toBeInstanceOf(
        RevisionConflictError,
      );
      expect(
        screen.queryByRole("button", { name: "Save geometry inputs" }),
      ).not.toBeInTheDocument();
      expect(props.onRevision).not.toHaveBeenCalled();
      expect(props.onBusy).toHaveBeenLastCalledWith(false);
    },
  );
  it("explains origin/path resets and never displays an invented station index", async () => {
    const { view } = renderInputs();
    await waitReady();
    fireEvent.click(screen.getByRole("button", { name: "Set neck origin" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "capture dome direction again",
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear parent path" }));
    expect(screen.getByRole("alert")).toHaveTextContent("reselect stations");
    for (const z of [1, 2, 3]) {
      view.rerender(<MorphometryInputs {...baseProps} location={[1, 2, z]} />);
      fireEvent.click(screen.getByRole("button", { name: "Add parent point" }));
    }
    expect(
      screen.queryByRole("combobox", { name: "Distal station index" }),
    ).not.toBeInTheDocument();
    view.rerender(<MorphometryInputs {...baseProps} location={[1, 2, 4]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add parent point" }));
    expect(
      screen.getByRole("combobox", { name: "Distal station index" }),
    ).toHaveValue("2");
  });
  it("discards a late save but releases only the busy callback that acquired it", async () => {
    let finish!: (r: Response) => void;
    const ownerBusy = vi.fn(),
      nextBusy = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        init?.method === "PUT"
          ? new Promise<Response>((r) => {
              finish = r;
            })
          : Promise.resolve(okResponse(fixture)),
      ),
    );
    const { view } = renderInputs({ onBusy: ownerBusy, location: [0, 0, 0] });
    await waitReady();
    fireEvent.click(screen.getByRole("button", { name: "Set sac seed" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Save geometry inputs" }),
    );
    expect(ownerBusy).toHaveBeenCalledWith(true);
    view.rerender(
      <MorphometryInputs {...baseProps} binding={null} onBusy={nextBusy} />,
    );
    await act(async () => {
      finish(okResponse({ ...fixture, artifact_version: "6" }));
      await Promise.resolve();
    });
    expect(baseProps.onRevision).not.toHaveBeenCalled();
    expect(baseProps.onError).not.toHaveBeenCalled();
    expect(ownerBusy).toHaveBeenLastCalledWith(false);
    expect(nextBusy).not.toHaveBeenCalled();
  });
  it("focuses a saved source point without making edits", async () => {
    const onFocus = vi.fn();
    render(<MorphometryInputs {...baseProps} onFocus={onFocus} />);
    await waitReady();
    fireEvent.click(screen.getByRole("button", { name: "View sac seed" }));
    expect(onFocus).toHaveBeenCalledWith(fixture.operator_inputs.aneurysm_seed);
    expect(baseProps.onDirtyChange).toHaveBeenLastCalledWith(false);
  });
  it("accepts the actual producer's oblique-normal renormalization on save", async () => {
    const { view, props } = renderInputs({ location: [0, 0, 0] });
    await waitReady();
    fireEvent.click(screen.getByRole("button", { name: "Set neck origin" }));
    view.rerender(<MorphometryInputs {...baseProps} location={[1, 1, 1]} />);
    fireEvent.click(screen.getByRole("button", { name: "Set dome direction" }));
    routeFetch((_url, init) => {
      const sent = JSON.parse(String(init?.body));
      // Observed OperatorGeometryInputs.model_validate roundtrip using Python math.hypot.
      return okResponse({
        ...fixture,
        artifact_version: "6",
        operator_inputs: {
          ...sent.inputs,
          neck_normal: [
            0.5773502691896257, 0.5773502691896257, 0.5773502691896257,
          ],
        },
      });
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save geometry inputs" }),
    );
    await waitFor(() => expect(props.onRevision).toHaveBeenCalledWith("6"));
    expect(props.onError).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Compute mask geometry" }),
    ).not.toBeInTheDocument();
  });
  it("can discard incomplete edits without changing the saved case", async () => {
    const { props } = renderInputs();
    await waitReady();
    fireEvent.click(screen.getByRole("button", { name: "Clear parent path" }));
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Discard geometry edits" }),
    );
    expect(screen.getByTestId("parent-path-count")).toHaveTextContent(
      `${fixture.operator_inputs.parent_path.length} points`,
    );
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(props.onRevision).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
  });
  it("does not cancel its own computation when the parent propagates global busy", async () => {
    let finish!: (r: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? new Promise<Response>((resolve) => {
              finish = resolve;
            })
          : Promise.resolve(okResponse(fixture)),
      ),
    );
    function Parent() {
      const [busy, setBusy] = useState(false);
      return (
        <MorphometryInputs {...baseProps} disabled={busy} onBusy={setBusy} />
      );
    }
    render(<Parent />);
    await waitReady();
    fireEvent.click(
      screen.getByRole("button", { name: "Compute mask geometry" }),
    );
    await act(async () => {
      finish(okResponse(fixture));
      await Promise.resolve();
    });
    await waitFor(() => expect(baseProps.onComputed).toHaveBeenCalledTimes(1));
  });
  it("loads the real producer saved config and computes with the exact POST payload", async () => {
    // Compute does not bump the case version: the envelope keeps artifact_version.
    const post = { ...fixture };
    const fetchMock = routeFetch((url) => {
      if (url.endsWith("/morphometry")) return okResponse(fixture);
      return undefined;
    });
    const { props } = renderInputs();
    await waitReady();
    expect(screen.getByTestId("value-neck origin").textContent).toContain(
      "-14.36",
    );
    const compute = screen.getByRole("button", {
      name: "Compute mask geometry",
    });
    expect(compute).not.toBeDisabled();
    routeFetch((url) => {
      if (url.endsWith("/morphometry")) {
        expect(url).toContain(`/api/cases/${fixture.case_id}/morphometry`);
        return okResponse(post);
      }
      return undefined;
    });
    fireEvent.click(compute);
    await waitFor(() => expect(props.onComputed).toHaveBeenCalledTimes(1));
    const morphCalls = vi
      .mocked(fetch)
      .mock.calls.filter(
        ([u, init]) =>
          String(u).endsWith("/morphometry") &&
          (init as RequestInit | undefined)?.method === "POST",
      );
    expect(morphCalls).toHaveLength(1);
    expect(JSON.parse(String(morphCalls[0][1]?.body))).toEqual({
      artifact_version: fixture.artifact_version,
      reference_revision: fixture.reference_revision,
    });
    expect(props.onRevision).not.toHaveBeenCalled();
  });

  it("captures landmarks, PUTs the exact payload, and honors a new version", async () => {
    const { view, props } = renderInputs();
    await waitReady();
    fireEvent.click(screen.getByRole("button", { name: "Clear parent path" }));
    fireEvent.click(screen.getByRole("button", { name: "Set sac seed" }));
    fireEvent.click(screen.getByRole("button", { name: "Set neck origin" }));
    view.rerender(<MorphometryInputs {...baseProps} location={domeSpot} />);
    fireEvent.click(screen.getByRole("button", { name: "Set dome direction" }));
    const spots: Point3[] = [
      [-15.3, 13.0, -16.3],
      [-15.3, 13.0, -15.0],
      [-15.3, 13.0, -13.8],
      [-15.3, 16.4, -15.7],
    ];
    for (const spot of spots) {
      view.rerender(<MorphometryInputs {...baseProps} location={spot} />);
      fireEvent.click(screen.getByRole("button", { name: "Add parent point" }));
    }
    view.rerender(<MorphometryInputs {...baseProps} />);
    expect(screen.getByTestId("parent-path-count").textContent).toBe(
      "4 points",
    );
    expect(screen.getByTestId("value-dome direction").textContent).toBe(
      "0.00, 0.00, 1.00",
    );
    const save = screen.getByRole("button", { name: "Save geometry inputs" });
    expect(save).not.toBeDisabled();
    let putBody: unknown = null;
    routeFetch((url, init) => {
      if (url.endsWith("/morphometry-inputs")) {
        expect(init?.method).toBe("PUT");
        putBody = JSON.parse(String(init?.body));
        return okResponse({
          case_id: fixture.case_id,
          image_sha256: fixture.image_sha256,
          reference_revision: fixture.reference_revision,
          artifact_version: "v9",
          operator_inputs: (putBody as { inputs: unknown }).inputs,
        });
      }
      return undefined;
    });
    fireEvent.click(save);
    await waitFor(() => expect(props.onRevision).toHaveBeenCalledWith("v9"));
    expect(putBody).toEqual({
      artifact_version: fixture.artifact_version,
      reference_revision: fixture.reference_revision,
      inputs: {
        neck_origin: crosshair,
        neck_normal: [0, 0, 1],
        aneurysm_seed: crosshair,
        parent_path: spots,
        proximal_index: 1,
        distal_index: 2,
      },
    });
    expect(props.onBusy).toHaveBeenCalledWith(true);
    expect(props.onBusy).toHaveBeenLastCalledWith(false);
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("discards a stale envelope from an old scope and never installs old values", async () => {
    const resolvers: Array<(r: Response) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolvers.push(resolve);
          }),
      ),
    );
    const { view, props } = renderInputs();
    await act(async () => {
      await Promise.resolve();
    });
    view.rerender(
      <MorphometryInputs
        {...baseProps}
        caseState={{ ...caseState, artifact_version: "v2" }}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(resolvers.length).toBeGreaterThanOrEqual(2);
    // Resolve the FIRST (old-scope) response late; it must be discarded.
    await act(async () => {
      resolvers[0](okResponse(fixture));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByTestId("value-neck origin")).not.toBeInTheDocument();
    // The new-scope response still validates against the new artifact_version;
    // the old fixture payload is rejected and routed to the parent.
    await act(async () => {
      resolvers[1](okResponse(fixture));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(props.onError).toHaveBeenCalled();
    expect(screen.queryByTestId("value-neck origin")).not.toBeInTheDocument();
  });

  it("never fetches or enables anything for an unsupported source", async () => {
    const fetchMock = routeFetch(() => okResponse(fixture));
    renderInputs({ caseState: { ...caseState, spatial_units: "unknown" } });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("parent-path-count")).not.toBeInTheDocument();
    expect(screen.getByText("Geometry landmarks")).toBeInTheDocument();
  });

  it("rejects a zero dome direction and an incomplete draft before save", async () => {
    const origin: Point3 = [1, 2, 3];
    const { view } = renderInputs({ location: origin });
    await waitReady();
    fireEvent.click(screen.getByRole("button", { name: "Clear parent path" }));
    fireEvent.click(screen.getByRole("button", { name: "Set sac seed" }));
    fireEvent.click(screen.getByRole("button", { name: "Set neck origin" }));
    // Dome direction captured at the neck origin itself: zero vector.
    fireEvent.click(screen.getByRole("button", { name: "Set dome direction" }));
    expect(screen.getByRole("alert").textContent).toMatch(/zero/i);
    expect(screen.getByTestId("value-dome direction").textContent).toBe(
      "not captured",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Save geometry inputs" }),
    );
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([u]) => String(u).endsWith("/morphometry-inputs")),
    ).toBe(false);
    expect(screen.getByRole("alert").textContent).toBe(
      "Capture the sac seed, neck origin and dome direction first.",
    );
    view.rerender(<MorphometryInputs {...baseProps} />);
  });
});
