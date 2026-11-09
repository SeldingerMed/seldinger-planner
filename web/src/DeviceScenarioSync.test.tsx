// Focused tests for DeviceScenarioSync, using the literal confirmed
// producer fixture (synthetic scope) for the authoritative wire shapes.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, RevisionConflictError, WorkspaceRequestError } from "./api";
import DeviceScenarioSync, {
  type DeviceScenarioSyncProps,
} from "./DeviceScenarioSync";
import type {
  DeviceScenarioBinding,
  DeviceScenarioEntry,
} from "./deviceScenarios";

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, api: vi.fn() };
});

const apiMock = vi.mocked(api);

const BINDING: DeviceScenarioBinding = {
  case_id: "Zkscp5RtgTTwX9nbAbIxOA",
  image_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  artifact_version: "4",
  reference_revision:
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  geometry_result_id: "884HLtGETdmppB7wPMEqSg",
  catalog_version:
    "c697cac424e72db7f60edc90e7c2a5c3547802fa89022cc1890527b48a8d21bf",
};

const PLACEMENT: DeviceScenarioEntry["placement"] = {
  axis: [0.0, 0.0, 1.0],
  center: [1.0, 2.0, 3.0],
  coilLength: 30.0,
  deviceId: "synthetic-device-01",
  diameter: 7.5,
  height: 18.0,
  length: 20.0,
  offset: 1.0,
  path: [
    [0.0, 0.0, 0.0],
    [0.0, 0.0, 10.0],
  ],
  roll: 45.0,
};

// Literal producer fixture: GET / PUT ack envelope, status current, revision 1.
const CURRENT_ENVELOPE = {
  case_id: BINDING.case_id,
  image_sha256: BINDING.image_sha256,
  artifact_version: "4",
  reference_revision: BINDING.reference_revision,
  geometry_result_id: BINDING.geometry_result_id,
  catalog_version: BINDING.catalog_version,
  scenario_revision: 1,
  current: {
    status: "current",
    set_id: "d25Yl-vBDci5Q3HzKZ0vTw",
    dependencies: {
      artifact_version: "4",
      calculation_version: "native-mask-operator-plane-v1",
      case_id: BINDING.case_id,
      image_sha256: BINDING.image_sha256,
      masks: {
        aneurysm: {
          candidate_id: "aR9gj2VyCgkVgAQXETJsmA",
          mask_sha256:
            "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          segmentation_revision: 2,
        },
        vessel: {
          candidate_id: "wdFxcxZzfP3sASHxsnDmqw",
          mask_sha256:
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          segmentation_revision: 1,
        },
      },
      operator_sha256:
        "dd6fd2a0d8e82d83108f236f2acd2a34b8f963e2b630b5cafb64e3075ebf18a5",
      source_revision: BINDING.reference_revision,
    },
    scenarios: [
      { id: "abcd1234ef", name: "Synthetic scenario", placement: PLACEMENT },
    ],
    scenarios_sha256:
      "a282539ba6af48cb40d5507b98858938e96a090bc796d32759f776f6b97c5e7f",
  },
} as const;

const NOT_COMPUTED_ENVELOPE = {
  ...CURRENT_ENVELOPE,
  scenario_revision: 0,
  current: { status: "not_computed" },
} as const;

const STALE_ENVELOPE = {
  ...CURRENT_ENVELOPE,
  current: {
    status: "stale",
    set_id: "d25Yl-vBDci5Q3HzKZ0vTw",
    scenarios: null,
    stale_reasons: ["device_scenario_dependencies_changed"],
  },
} as const;

function ackEnvelope(scenarios: readonly DeviceScenarioEntry[], revision = 2): Record<string, unknown> {
  return {
    ...CURRENT_ENVELOPE,
    scenario_revision: revision,
    current: { ...CURRENT_ENVELOPE.current, scenarios },
  };
}

function setup(overrides: Partial<DeviceScenarioSyncProps> = {}) {
  const props: DeviceScenarioSyncProps = {
    binding: BINDING,
    eligible: true,
    rows: [],
    onRowsChange: vi.fn(),
    onDirtyChange: vi.fn(),
    onBusy: vi.fn(),
    onConflict: vi.fn(),
    ...overrides,
  };
  const view = render(<DeviceScenarioSync {...props} />);
  return { props, view };
}

afterEach(cleanup);

beforeEach(() => {
  apiMock.mockReset();
});

describe("DeviceScenarioSync", () => {
  it("loads the saved set on mount, echoes an independent clone, and round-trips an explicit save", async () => {
    apiMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(CURRENT_ENVELOPE)));
    apiMock.mockResolvedValueOnce(
      ackEnvelope(JSON.parse(JSON.stringify(CURRENT_ENVELOPE.current.scenarios))),
    );
    const { props, view } = setup();
    await waitFor(() =>
      expect(props.onRowsChange).toHaveBeenCalledWith([
        expect.objectContaining({ id: "abcd1234ef" }),
      ]),
    );
    const echoed = vi.mocked(props.onRowsChange).mock.calls[0][0] as DeviceScenarioEntry[];
    expect(echoed).not.toBe(CURRENT_ENVELOPE.current.scenarios);
    act(() => view.rerender(<DeviceScenarioSync {...props} rows={echoed} />));
    expect(await screen.findByText(/1 scenario\(s\) in this draft/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save scenario set" }));
    });
    expect(apiMock).toHaveBeenLastCalledWith(
      "/cases/Zkscp5RtgTTwX9nbAbIxOA/device-scenarios",
      {
        image_sha256: BINDING.image_sha256,
        artifact_version: "4",
        reference_revision: BINDING.reference_revision,
        geometry_result_id: BINDING.geometry_result_id,
        catalog_version: BINDING.catalog_version,
        confirmed: true,
        scenario_revision: 1,
        scenarios: echoed,
      },
      "PUT",
    );
    await waitFor(() =>
      expect(props.onBusy).toHaveBeenLastCalledWith(false),
    );
    expect(await screen.findByText(/Saved revision 2/)).toBeTruthy();
    expect(props.onConflict).not.toHaveBeenCalled();
  });

  it("notifies dirty on controlled row changes against the loaded baseline", async () => {
    apiMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(CURRENT_ENVELOPE)));
    const { props, view } = setup();
    await waitFor(() => expect(props.onRowsChange).toHaveBeenCalled());
    const echoed = vi.mocked(props.onRowsChange).mock.calls[0][0] as DeviceScenarioEntry[];
    await waitFor(() => expect(props.onDirtyChange).toHaveBeenCalledWith(false));
    act(() => {
      view.rerender(
        <DeviceScenarioSync
          {...props}
          rows={[...echoed, { ...echoed[0], id: "abcd1234fg" }]}
        />,
      );
    });
    await waitFor(() => expect(props.onDirtyChange).toHaveBeenCalledWith(true));
  });

  it("keeps the editable fresh draft on not_computed and saves with revision 0", async () => {
    const draft: DeviceScenarioEntry[] = [
      { id: "abcd1234ef", name: "Draft", placement: PLACEMENT },
    ];
    apiMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(NOT_COMPUTED_ENVELOPE)));
    apiMock.mockResolvedValueOnce(ackEnvelope(draft, 1));
    const { props } = setup({ rows: draft });
    await screen.findByText(/No saved scenario set yet/);
    expect(props.onRowsChange).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save scenario set" }));
    });
    expect(apiMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ scenario_revision: 0, scenarios: draft }),
      "PUT",
    );
    await screen.findByText(/Saved revision 1/);
    expect(props.onConflict).not.toHaveBeenCalled();
  });

  it("keeps the opaque revision on stale and can explicitly replace it", async () => {
    const draft: DeviceScenarioEntry[] = [
      { id: "abcd1234ef", name: "Draft", placement: PLACEMENT },
    ];
    apiMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(STALE_ENVELOPE)));
    apiMock.mockResolvedValueOnce(ackEnvelope(draft));
    const { props } = setup({ rows: draft });
    await screen.findByText(/stale/);
    expect(props.onRowsChange).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save scenario set" }));
    });
    expect(apiMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ scenario_revision: 1, scenarios: draft }),
      "PUT",
    );
  });

  it("issues no request and renders nothing when ineligible", () => {
    setup({ eligible: false });
    expect(apiMock).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Saved scenario set")).toBeNull();
  });

  it("locks on a malformed envelope and recovers only via explicit reload", async () => {
    apiMock.mockRejectedValueOnce(new Error("deviceScenarios: bad"));
    const { props } = setup();
    await screen.findByRole("alert");
    expect(screen.queryByText(/scenario\(s\) in this draft/)).toBeTruthy();
    expect(apiMock).toHaveBeenCalledTimes(1);
    apiMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(CURRENT_ENVELOPE)));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reload saved scenarios" }));
    });
    expect(props.onRowsChange).toHaveBeenCalled();
    expect(screen.queryByRole("alert")?.textContent).toBe("");
    expect(props.onConflict).toHaveBeenCalled();
  });

  it("locks repeat writes after a 409 and calls onConflict", async () => {
    apiMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(CURRENT_ENVELOPE)));
    const { props } = setup();
    await waitFor(() => expect(props.onRowsChange).toHaveBeenCalled());
    const echoed = vi.mocked(props.onRowsChange).mock.calls[0][0] as DeviceScenarioEntry[];
    apiMock.mockRejectedValueOnce(new RevisionConflictError());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save scenario set" }));
    });
    expect(props.onConflict).toHaveBeenCalled();
    await screen.findByText(/not confirmed/);
    expect(screen.getByRole("button", { name: "Save scenario set" })).toBeDisabled();
    expect(echoed).toBeTruthy();
    expect(apiMock).toHaveBeenCalledTimes(2);
    // Reload clears the lock and re-reads.
    apiMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(CURRENT_ENVELOPE)));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reload saved scenarios" }));
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save scenario set" })).toBeEnabled(),
    );
  });
  it("preserves the draft after a definitive 422 and allows a retry", async () => {
    apiMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(NOT_COMPUTED_ENVELOPE)));
    const draft: DeviceScenarioEntry[] = [
      { id: "abcd1234ef", name: "Draft", placement: PLACEMENT },
    ];
    apiMock.mockRejectedValueOnce(new WorkspaceRequestError(422));
    apiMock.mockResolvedValueOnce(ackEnvelope(draft, 1));
    const { props } = setup({ rows: draft });
    await screen.findByText(/No saved scenario set yet/);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save scenario set" }));
    });
    await screen.findByText(/Workspace request failed \(422\)/);
    expect(screen.getByRole("button", { name: "Save scenario set" })).toBeEnabled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save scenario set" }));
    });
    expect(apiMock).toHaveBeenCalledTimes(3);
    await screen.findByText(/Saved revision 1/);
    expect(props.onConflict).not.toHaveBeenCalled();
  });

  it("locks until reload after an other failed PUT", async () => {
    apiMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(NOT_COMPUTED_ENVELOPE)));
    apiMock.mockRejectedValueOnce(new WorkspaceRequestError(503));
    const { props } = setup();
    await screen.findByText(/No saved scenario set yet/);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save scenario set" }));
    });
    await screen.findByText(/save request failed/i);
    expect(screen.getByRole("button", { name: "Save scenario set" })).toBeDisabled();
    expect(props.onConflict).not.toHaveBeenCalled();
  });

  it("locks on an ambiguous acknowledgement (wrong revision) without rollback claims", async () => {
    apiMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(NOT_COMPUTED_ENVELOPE)));
    const draft: DeviceScenarioEntry[] = [
      { id: "abcd1234ef", name: "Draft", placement: PLACEMENT },
    ];
    apiMock.mockResolvedValueOnce(ackEnvelope(draft));
    const { props } = setup();
    await screen.findByText(/No saved scenario set yet/);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save scenario set" }));
    });
    await screen.findByText(/not confirmed/);
    expect(props.onConflict).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save scenario set" })).toBeDisabled();
  });

  it("does not overwrite newer rows changed while the PUT was in flight", async () => {
    apiMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(NOT_COMPUTED_ENVELOPE)));
    const draft: DeviceScenarioEntry[] = [
      { id: "abcd1234ef", name: "Draft", placement: PLACEMENT },
    ];
    const { props, view } = setup({ rows: draft });
    let resolveSave: (value: Record<string, unknown>) => void = () => {};
    apiMock.mockImplementationOnce(
      () => new Promise<Record<string, unknown>>((resolve) => (resolveSave = resolve)),
    );
    await screen.findByText(/No saved scenario set yet/);
    let savePromise: Promise<void> = Promise.resolve();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Save scenario set" }));
      savePromise = Promise.resolve();
    });
    // Parent edits rows while the PUT is in flight.
    const newer = [{ ...draft[0], name: "Newer draft" }];
    act(() => {
      view.rerender(<DeviceScenarioSync {...props} rows={newer} />);
    });
    await act(async () => {
      resolveSave(ackEnvelope(draft, 1));
      await savePromise;
    });
    expect(props.onRowsChange).not.toHaveBeenCalled();
    await waitFor(() => expect(props.onBusy).toHaveBeenLastCalledWith(false));
    expect(await screen.findByText(/Newer unsaved edits are kept/)).toBeTruthy();
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it("drops a late response after a binding change and releases busy exactly once", async () => {
    let resolveGet: (value: Record<string, unknown>) => void = () => {};
    apiMock.mockImplementationOnce(
      () => new Promise<Record<string, unknown>>((resolve) => (resolveGet = resolve)),
    );
    apiMock.mockReturnValueOnce(new Promise(() => {}));
    const { props, view } = setup();
    const otherBinding: DeviceScenarioBinding = { ...BINDING, case_id: "OtherCaseId0" };
    act(() => {
      view.rerender(<DeviceScenarioSync {...props} binding={otherBinding} />);
    });
    expect(apiMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolveGet(JSON.parse(JSON.stringify(CURRENT_ENVELOPE)));
    });
    await waitFor(() => expect(props.onBusy).toHaveBeenLastCalledWith(true));
    const releases = vi.mocked(props.onBusy!).mock.calls.filter((c) => c[0] === false);
    expect(releases).toHaveLength(1);
    expect(props.onRowsChange).not.toHaveBeenCalled();
    // The superseded source's rows/status/error never appear.
    expect(screen.queryByText(/Saved revision 1/)).toBeNull();
  });

  it("honours the parent disabled feedback without cancelling its own success", async () => {
    const draft: DeviceScenarioEntry[] = [
      { id: "abcd1234ef", name: "Draft", placement: PLACEMENT },
    ];
    apiMock.mockResolvedValueOnce(JSON.parse(JSON.stringify(NOT_COMPUTED_ENVELOPE)));
    let resolveSave: (value: Record<string, unknown>) => void = () => {};
    apiMock.mockImplementationOnce(
      () => new Promise<Record<string, unknown>>((resolve) => (resolveSave = resolve)),
    );
    const { props, view } = setup({ rows: draft });
    await screen.findByText(/No saved scenario set yet/);
    let savePromise: Promise<void> = Promise.resolve();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Save scenario set" }));
      savePromise = Promise.resolve();
    });
    // Parent busy feedback arrives mid-flight.
    act(() => {
      view.rerender(<DeviceScenarioSync {...props} disabled />);
    });
    await act(async () => {
      resolveSave(ackEnvelope(draft, 1));
      await savePromise;
    });
    await screen.findByText(/Saved revision 1/);
    expect(props.onConflict).not.toHaveBeenCalled();
    expect(props.onBusy).toHaveBeenLastCalledWith(false);
  });
});
