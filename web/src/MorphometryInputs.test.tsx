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
import nativeProposal from "./fixtures/phase2-native-proposal.json";
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
  it.each([null, { ...binding, image_sha256: "c".repeat(64) }])("hides the ready proposal panel immediately when binding becomes %j", async (nextBinding) => {
    const { view } = renderInputs();
    await waitReady();
    expect(screen.getByRole("button", { name: "Propose geometry from accepted anatomy" })).toBeInTheDocument();
    const fetch = vi.mocked(globalThis.fetch);
    view.rerender(<MorphometryInputs {...baseProps} binding={nextBinding} />);
    expect(screen.queryByRole("button", { name: "Propose geometry from accepted anatomy" })).not.toBeInTheDocument();
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole("button", { name: "Propose geometry from accepted anatomy" })).not.toBeInTheDocument();
    expect(fetch.mock.calls.some(([url]) => String(url).includes("/undefined/"))).toBe(false);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });
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
    // onRevision fires before React commits the saved draft and runs its
    // dirty-state effect. Wait for those actual completion signals too.
    await waitFor(() => {
      expect(props.onBusy).toHaveBeenLastCalledWith(false);
      expect(props.onDirtyChange).toHaveBeenLastCalledWith(false);
    });
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

const FIRST_ANCHOR: Point3 = [-15.3, 13.0, -16.3];
const LAST_ANCHOR: Point3 = [-15.3, 16.4, -15.7];
// Anchors of the real producer's saved parent path: a fresh mount reloads them.
const SAVED_FIRST: Point3 = [
  ...fixture.operator_inputs.parent_path[0],
] as Point3;
const SAVED_LAST: Point3 = [
  ...fixture.operator_inputs.parent_path[
    fixture.operator_inputs.parent_path.length - 1
  ],
] as Point3;
const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);

function proposalFixture(
  start: Point3 = FIRST_ANCHOR,
  end: Point3 = LAST_ANCHOR,
) {
  return {
    case_id: fixture.case_id,
    image_sha256: fixture.image_sha256,
    reference_revision: fixture.reference_revision,
    artifact_version: fixture.artifact_version,
    kind: "centerline",
    current: {
      status: "current",
      result_id: "res-proposal-1",
      parameters: {
        start_ras: start,
        end_ras: end,
        max_points: 32,
      },
      dependencies: {
        case_id: fixture.case_id,
        image_sha256: fixture.image_sha256,
        artifact_version: fixture.artifact_version,
        source_revision: fixture.reference_revision,
        masks: {
          vessel: {
            candidate_id: "cand-1",
            mask_sha256: HEX_A,
            segmentation_revision: 1,
          },
        },
      },
      result: {
        job_sha256: HEX_B,
        method: "native_skeleton_path_proposal",
        clinical_validation: false,
        device_calibrated: false,
        operator_confirmation_required: true,
        spatial_units: "mm",
        path_ras: [
          start,
          [-15.3, 13.2, -16.0],
          [-15.3, 14.5, -15.9],
          [-15.3, 15.8, -15.8],
          end,
        ],
        proximal_index: 1,
        distal_index: 3,
        length_mm: 3.4,
        point_count: 5,
        skeleton_voxel_count: 912,
        grid_shape: [64, 64, 48],
      },
    },
  };
}

/** Clear the saved path and build a fresh 4-point draft with known anchors. */
async function buildAnchoredDraft() {
  const { view } = renderInputs();
  await waitReady();
  fireEvent.click(screen.getByRole("button", { name: "Clear parent path" }));
  const spots: Point3[] = [
    FIRST_ANCHOR,
    [-15.3, 13.5, -16.1],
    [-15.3, 15.0, -15.9],
    LAST_ANCHOR,
  ];
  for (const spot of spots) {
    view.rerender(<MorphometryInputs {...baseProps} location={spot} />);
    fireEvent.click(screen.getByRole("button", { name: "Add parent point" }));
  }
  return view;
}

function proposeButton() {
  return screen.getByRole("button", { name: "Propose centerline" });
}

describe("MorphometryInputs centerline proposal", () => {
  it("blocks repeated proposal clicks using internal busy without parent feedback", async () => {
    let finish!: (r: Response) => void;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? new Promise<Response>((resolve) => { finish = resolve; })
        : Promise.resolve(okResponse(fixture)),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderInputs(); // onBusy is a spy only; disabled remains false.
    await waitReady();
    const button = proposeButton();
    fireEvent.click(button);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(baseProps.onBusy.mock.calls).toEqual([[true]]);
    await act(async () => {
      finish(okResponse(proposalFixture(SAVED_FIRST, SAVED_LAST)));
      await Promise.resolve();
    });
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(baseProps.onBusy.mock.calls).toEqual([[true], [false]]);
    expect(baseProps.onError).not.toHaveBeenCalled();
  });

  it("rejects a proposal whose nested source revision contradicts the envelope", async () => {
    const real = structuredClone(nativeProposal.proposal);
    real.current.dependencies.source_revision = "0".repeat(64);
    routeFetch((_url, init) =>
      okResponse(init?.method === "POST" ? real : nativeProposal.geometry),
    );
    renderInputs({
      caseState: nativeProposal.case_state as CaseState,
      binding: {
        case_id: real.case_id,
        image_sha256: real.image_sha256,
        reference_revision: real.reference_revision,
      },
    });
    await waitReady();
    fireEvent.click(proposeButton());
    await waitFor(() => expect(baseProps.onError).toHaveBeenCalled());
    expect(screen.queryByTestId("proposal-length")).not.toBeInTheDocument();
  });

  it("accepts an actual default-worker proposal with numeric segmentation revision", async () => {
    const real = nativeProposal.proposal;
    routeFetch((_url, init) =>
      okResponse(init?.method === "POST" ? real : nativeProposal.geometry),
    );
    renderInputs({
      caseState: nativeProposal.case_state as CaseState,
      binding: {
        case_id: real.case_id,
        image_sha256: real.image_sha256,
        reference_revision: real.reference_revision,
      },
    });
    await waitReady();
    fireEvent.click(proposeButton());
    await waitFor(() =>
      expect(screen.getByTestId("proposal-length")).toBeInTheDocument(),
    );
    expect(baseProps.onError).not.toHaveBeenCalled();
    expect(baseProps.onRevision).not.toHaveBeenCalled();
  });

  it("enables the proposal button only for an eligible ready draft", async () => {
    const { view } = renderInputs();
    await waitReady();
    // Saved producer path has >= 2 distinct finite anchors: enabled on ready.
    expect(proposeButton()).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Clear parent path" }));
    expect(proposeButton()).toBeDisabled();
    view.rerender(<MorphometryInputs {...baseProps} location={FIRST_ANCHOR} />);
    fireEvent.click(screen.getByRole("button", { name: "Add parent point" }));
    // A single point cannot supply two distinct anchors.
    expect(proposeButton()).toBeDisabled();
    view.rerender(<MorphometryInputs {...baseProps} location={LAST_ANCHOR} />);
    fireEvent.click(screen.getByRole("button", { name: "Add parent point" }));
    expect(proposeButton()).not.toBeDisabled();
  });

  it("POSTs only identity and anchor parameters to the proposal endpoint", async () => {
    await buildAnchoredDraft();
    let postBody: unknown = null;
    routeFetch((_url, init) => {
      if (init?.method === "POST") {
        postBody = JSON.parse(String(init?.body));
        return okResponse(proposalFixture());
      }
      return undefined;
    });
    fireEvent.click(proposeButton());
    await waitFor(() => expect(postBody).not.toBeNull());
    expect(postBody).toEqual({
      artifact_version: fixture.artifact_version,
      reference_revision: fixture.reference_revision,
      parameters: {
        start_ras: FIRST_ANCHOR,
        end_ras: LAST_ANCHOR,
        max_points: 32,
      },
    });
    const text = JSON.stringify(postBody);
    for (const forbidden of [
      "path",
      "source_url",
      "result_id",
      "job_sha256",
      "dependencies",
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("proposes with real busy feedback, requires explicit use, and saves only via the existing PUT", async () => {
    const view = await (async () => {
      const out = renderInputs();
      await waitReady();
      return out.view;
    })();
    fireEvent.click(screen.getByRole("button", { name: "Clear parent path" }));
    for (const spot of [FIRST_ANCHOR, LAST_ANCHOR]) {
      view.rerender(<MorphometryInputs {...baseProps} location={spot} />);
      fireEvent.click(screen.getByRole("button", { name: "Add parent point" }));
    }
    let finishProposal!: (r: Response) => void;
    // The remounted Parent reloads the saved draft, whose anchors are the
    // saved producer path's first and last points.
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? new Promise<Response>((resolve) => {
              finishProposal = resolve;
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
    view.unmount();
    render(<Parent />);
    await waitReady();
    fireEvent.click(proposeButton());
    // The parent's busy feedback disables the component while the request runs.
    await waitFor(() => expect(proposeButton()).toBeDisabled());
    expect(baseProps.onDirtyChange).toHaveBeenLastCalledWith(false);
    await act(async () => {
      finishProposal(okResponse(proposalFixture(SAVED_FIRST, SAVED_LAST)));
      await Promise.resolve();
    });
    await waitFor(() => expect(proposeButton()).not.toBeDisabled());
    // Proposal is offered for inspection, not auto-applied.
    expect(baseProps.onRevision).not.toHaveBeenCalled();
    expect(screen.getByTestId("proposal-length").textContent).toBe("3.40 mm");
    expect(screen.getByTestId("proposed-proximal-index").textContent).toBe("1");
    expect(screen.getByTestId("proposed-distal-index").textContent).toBe("3");
    expect(screen.getAllByTestId("proposed-path-point")).toHaveLength(5);
    expect(screen.getByTestId("parent-path-count").textContent).toBe(
      `${fixture.operator_inputs.parent_path.length} points`,
    );
    const putCallsBefore = vi
      .mocked(fetch)
      .mock.calls.filter(([, init]) => init?.method === "PUT");
    expect(putCallsBefore).toHaveLength(0);
    // Explicit confirmation copies only the path and station indices.
    fireEvent.click(
      screen.getByRole("button", { name: "Use proposed parent path" }),
    );
    expect(screen.getByTestId("parent-path-count").textContent).toBe(
      "5 points",
    );
    expect(
      screen.getByRole("combobox", { name: "Proximal station index" }),
    ).toHaveValue("1");
    expect(
      screen.getByRole("combobox", { name: "Distal station index" }),
    ).toHaveValue("3");
    expect(baseProps.onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(baseProps.onRevision).not.toHaveBeenCalled();
    // Saving goes through the pre-existing PUT path.
    const prop = proposalFixture(SAVED_FIRST, SAVED_LAST);
    let putBody: unknown = null;
    routeFetch((_url, init) => {
      if (init?.method === "PUT") {
        putBody = JSON.parse(String(init?.body));
        return okResponse({
          ...fixture,
          artifact_version: "v9",
          operator_inputs: (putBody as { inputs: unknown }).inputs,
        });
      }
      return undefined;
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save geometry inputs" }),
    );
    await waitFor(() =>
      expect(baseProps.onRevision).toHaveBeenCalledWith("v9"),
    );
    const inputs = (
      putBody as {
        inputs: {
          parent_path: number[][];
          neck_origin: number[];
          aneurysm_seed: number[];
        };
      }
    ).inputs;
    expect(inputs.parent_path).toEqual(prop.current.result.path_ras);
    expect(inputs.neck_origin).toEqual(fixture.operator_inputs.neck_origin);
    expect(inputs.aneurysm_seed).toEqual(fixture.operator_inputs.aneurysm_seed);
  });

  it.each([
    [
      "artifact_version",
      (p: ReturnType<typeof proposalFixture>) => {
        p.artifact_version = "other";
      },
    ],
    [
      "image dependency",
      (p: ReturnType<typeof proposalFixture>) => {
        p.current.dependencies.image_sha256 = "c".repeat(64);
      },
    ],
    [
      "bad job hash",
      (p: ReturnType<typeof proposalFixture>) => {
        p.current.result.job_sha256 = "short";
      },
    ],
    [
      "wrong method",
      (p: ReturnType<typeof proposalFixture>) => {
        p.current.result.method = "approximate";
      },
    ],
    [
      "confirmation required",
      (p: ReturnType<typeof proposalFixture>) => {
        p.current.result.operator_confirmation_required = false;
      },
    ],
    [
      "point count",
      (p: ReturnType<typeof proposalFixture>) => {
        p.current.result.point_count = 4;
      },
    ],
    [
      "nonfinite path point",
      (p: ReturnType<typeof proposalFixture>) => {
        p.current.result.path_ras[2] = [NaN, 0, 0];
      },
    ],
    [
      "duplicate path point",
      (p: ReturnType<typeof proposalFixture>) => {
        p.current.result.path_ras[2] = [...p.current.result.path_ras[1]];
      },
    ],
    [
      "interior station",
      (p: ReturnType<typeof proposalFixture>) => {
        p.current.result.distal_index = 4;
      },
    ],
    [
      "nonpositive length",
      (p: ReturnType<typeof proposalFixture>) => {
        p.current.result.length_mm = 0;
      },
    ],
    [
      "echoed anchors",
      (p: ReturnType<typeof proposalFixture>) => {
        p.current.parameters.start_ras = [0, 0, 0];
      },
    ],
    [
      "empty mask dependency",
      (p: ReturnType<typeof proposalFixture>) => {
        p.current.dependencies.masks.vessel.mask_sha256 = "";
      },
    ],
  ])(
    "rejects an invalid proposal (%s) without touching the draft",
    async (_label, mutate) => {
      await buildAnchoredDraft();
      const before = screen.getByTestId("parent-path-count").textContent;
      const candidate = proposalFixture();
      mutate(candidate);
      routeFetch((_url, init) =>
        init?.method === "POST" ? okResponse(candidate) : undefined,
      );
      fireEvent.click(proposeButton());
      await waitFor(() => expect(baseProps.onError).toHaveBeenCalled());
      expect(baseProps.onRevision).not.toHaveBeenCalled();
      expect(screen.queryByTestId("proposal-length")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Use proposed parent path" }),
      ).not.toBeInTheDocument();
      expect(screen.getByTestId("parent-path-count").textContent).toBe(before);
      expect(baseProps.onBusy).toHaveBeenLastCalledWith(false);
    },
  );

  it("suppresses a stale proposal response and releases the captured busy owner", async () => {
    let finish!: (r: Response) => void;
    const ownerBusy = vi.fn(),
      nextBusy = vi.fn();
    let currentVersion = fixture.artifact_version;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? new Promise<Response>((resolve) => {
              finish = resolve;
            })
          : Promise.resolve(
              okResponse({ ...fixture, artifact_version: currentVersion }),
            ),
      ),
    );
    const { view } = renderInputs({ onBusy: ownerBusy });
    await waitReady();
    fireEvent.click(screen.getByRole("button", { name: "Clear parent path" }));
    for (const spot of [FIRST_ANCHOR, LAST_ANCHOR]) {
      view.rerender(
        <MorphometryInputs {...baseProps} onBusy={ownerBusy} location={spot} />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Add parent point" }));
    }
    fireEvent.click(proposeButton());
    expect(ownerBusy).toHaveBeenCalledWith(true);
    // A new case version re-scopes the component before the response lands.
    currentVersion = "v2";
    view.rerender(
      <MorphometryInputs
        {...baseProps}
        caseState={{ ...caseState, artifact_version: "v2" }}
        onBusy={nextBusy}
      />,
    );
    await act(async () => {
      finish(okResponse(proposalFixture()));
      await Promise.resolve();
    });
    expect(baseProps.onError).not.toHaveBeenCalled();
    expect(ownerBusy).toHaveBeenLastCalledWith(false);
    expect(nextBusy).not.toHaveBeenCalled();
  });

  it("does not retain an instruction to review a proposal after anchors invalidate it", async () => {
    const view = await buildAnchoredDraft();
    routeFetch((_url, init) =>
      init?.method === "POST" ? okResponse(proposalFixture()) : undefined,
    );
    fireEvent.click(proposeButton());
    await waitFor(() =>
      expect(screen.getByTestId("proposal-length")).toBeInTheDocument(),
    );
    view.rerender(
      <MorphometryInputs {...baseProps} location={[-15.3, 20, -16]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add parent point" }));
    expect(screen.queryByTestId("proposal-length")).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "Review the proposed parent path and stations before using it.",
      ),
    ).not.toBeInTheDocument();
  });

  it("drops a retained proposal when the draft anchors change", async () => {
    const view = await buildAnchoredDraft();
    routeFetch((_url, init) =>
      init?.method === "POST" ? okResponse(proposalFixture()) : undefined,
    );
    fireEvent.click(proposeButton());
    await waitFor(() =>
      expect(screen.getByTestId("proposal-length")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear parent path" }));
    expect(
      screen.queryByRole("button", { name: "Use proposed parent path" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("proposal-length")).not.toBeInTheDocument();
  });
});
