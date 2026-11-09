import { afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import AnatomyProposalPanel from "./AnatomyProposalPanel";
import type { AnatomyProposalBinding } from "./anatomyProposal";

/**
 * Literal fixture extracted from the actual producer receipt
 * artifacts/phase5/anatomy-default-path-verified.json (receipt.proposal).
 * No field is invented; hash tokens are opaque identities.
 */
const FIXTURE = {
  case_id: "MJbqKO1iFLQJaUH-l0CFkQ",
  image_sha256:
    "59bb2b04f473a54990cba82020cb550f2b94ffa11f10a0839313b5c2837c2cfb",
  artifact_version: "3",
  reference_revision:
    "f6358cdca2a8f72c0c96262b054b5b26dfe80981f478e999f48358a648f0216b",
  proposal_id:
    "7d5cc40f3c8835ee4c55d871fe0edf3f09a7f2947ba8e48467759b924535d339",
  proposal: {
    dependencies: {
      artifact_version: "3",
      calculation_version: "anatomy-input-proposal-v1",
      case_id: "MJbqKO1iFLQJaUH-l0CFkQ",
      image_sha256:
        "59bb2b04f473a54990cba82020cb550f2b94ffa11f10a0839313b5c2837c2cfb",
      masks: {
        aneurysm: {
          candidate_id: "SnjTcp0Buq80EPsu7d6IwA",
          mask_sha256:
            "482997ba3185529b34bac882ec9695c05ebe27b606f6987b50205bb63a571ac6",
          segmentation_revision: 2,
        },
        vessel: {
          candidate_id: "s4vG9KeCpT1UslbvgINjDw",
          mask_sha256:
            "c3dc05be459d65e22a374d4459618efd3645cce46258f63d4c5ccec7647ad73f",
          segmentation_revision: 1,
        },
      },
      source_revision:
        "f6358cdca2a8f72c0c96262b054b5b26dfe80981f478e999f48358a648f0216b",
    },
    diagnostics: {
      aneurysm_component_voxels: 123,
      interface_voxel_count: 28,
      neck_plane_rms_residual_mm: 0.4670248868079294,
      parent_point_count: 9,
      parent_length_mm: 10.485281374238571,
      target_component_selected: false,
      grid_shape: [16, 16, 24],
    },
    inputs: {
      neck_origin: [8.0, 5.821428571428571, 12.0],
      neck_normal: [-0.0, -1.0, -0.0],
      aneurysm_seed: [8.0, 4.0, 12.0],
      parent_path: [
        [7.0, 7.0, 9.0],
        [8.0, 8.0, 9.0],
        [8.0, 8.0, 10.0],
        [8.0, 7.0, 11.0],
        [8.0, 6.0, 12.0],
        [8.0, 7.0, 13.0],
        [8.0, 8.0, 14.0],
        [8.0, 8.0, 15.0],
        [9.0, 7.0, 15.0],
      ],
      proximal_index: 3,
      distal_index: 5,
    },
    job_sha256:
      "c9e0d5159c5ffc124b20988f40521561dde6868b30cdbeaf6cb1a10017c56f54",
    method: "accepted_mask_anatomy_geometry_proposal",
    operator_confirmation_required: true,
    proposal_version: "anatomy-input-proposal-v1",
  },
} as const;

const BINDING: AnatomyProposalBinding = {
  case_id: FIXTURE.case_id,
  image_sha256: FIXTURE.image_sha256,
  artifact_version: FIXTURE.artifact_version,
  reference_revision: FIXTURE.reference_revision,
};

const TARGET: [number, number, number] = [8, 5, 12];

type Deferred = {
  promise: Promise<Response>;
  resolve: (r: Response) => void;
  reject: (e: unknown) => void;
};

function defer(): Deferred {
  let resolve!: Deferred["resolve"];
  let reject!: Deferred["reject"];
  const promise = new Promise<Response>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const okResponse = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const conflictResponse = () =>
  new Response(JSON.stringify({ detail: "case moved on" }), {
    status: 409,
    headers: { "Content-Type": "application/json" },
  });

type Props = Parameters<typeof AnatomyProposalPanel>[0];

function baseProps(overrides: Partial<Props> = {}): Props {
  return {
    binding: BINDING,
    eligible: true,
    disabled: false,
    targetRas: null,
    onApply: vi.fn(),
    onBusy: vi.fn(),
    onConflict: vi.fn(),
    ...overrides,
  };
}

async function clickPropose() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /propose geometry/i }));
  });
}

function fetchCalls(mock: ReturnType<typeof vi.fn>) {
  return mock.mock.calls as [string, RequestInit][];
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AnatomyProposalPanel", () => {
  test("a failed rerequest never restores the previously displayed proposal", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse(FIXTURE))
      .mockResolvedValueOnce(new Response("", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AnatomyProposalPanel {...baseProps()} />);
    await clickPropose();
    expect(screen.getByRole("button", { name: /apply as editable draft/i })).toBeEnabled();
    await clickPropose();
    expect(await screen.findByRole("alert")).toHaveTextContent(/503/);
    expect(screen.queryByRole("button", { name: /apply as editable draft/i })).toBeNull();
  });

  test("unmount immediately releases its captured busy owner and ignores late errors", async () => {
    const pending = defer();
    vi.stubGlobal("fetch", vi.fn(() => pending.promise));
    const onBusy = vi.fn();
    const onConflict = vi.fn();
    const { unmount } = render(<AnatomyProposalPanel {...baseProps({ onBusy, onConflict })} />);
    await clickPropose();
    unmount();
    expect(onBusy.mock.calls.map(([busy]) => busy)).toEqual([true, false]);
    await act(async () => { pending.resolve(conflictResponse()); await pending.promise; });
    expect(onBusy.mock.calls.map(([busy]) => busy)).toEqual([true, false]);
    expect(onConflict).not.toHaveBeenCalled();
  });

  test("a late old-source conflict cannot lock or notify the new source", async () => {
    const pending = defer();
    vi.stubGlobal("fetch", vi.fn(() => pending.promise));
    const onConflict = vi.fn();
    const { rerender } = render(<AnatomyProposalPanel {...baseProps({ onConflict })} />);
    await clickPropose();
    rerender(<AnatomyProposalPanel {...baseProps({ onConflict, binding: { ...BINDING, artifact_version: "4" } })} />);
    await act(async () => { pending.resolve(conflictResponse()); await pending.promise; });
    expect(onConflict).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: /propose geometry/i })).toBeEnabled();
  });

  test("rejects a component-selection flag that contradicts the requested target", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(okResponse(FIXTURE))));
    render(<AnatomyProposalPanel {...baseProps({ targetRas: TARGET })} />);
    await clickPropose();
    expect(await screen.findByRole("alert")).toHaveTextContent(/contract/);
    expect(screen.queryByRole("button", { name: /apply as editable draft/i })).toBeNull();
  });

  test("golden producer response applies exactly one POST and zero save calls", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okResponse(FIXTURE)));
    vi.stubGlobal("fetch", fetchMock);
    const onApply = vi.fn();
    render(<AnatomyProposalPanel {...baseProps({ onApply })} />);

    expect(screen.queryByRole("button", { name: /apply as editable draft/i })).toBeNull();
    await clickPropose();

    expect(await screen.findByRole("status")).toHaveTextContent(/proposal ready/i);
    const calls = fetchCalls(fetchMock);
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0];
    expect(url).toBe(`/api/cases/${encodeURIComponent(BINDING.case_id)}/anatomy-proposal`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      artifact_version: BINDING.artifact_version,
      reference_revision: BINDING.reference_revision,
      target_ras: null,
    });

    fireEvent.click(screen.getByRole("button", { name: /apply as editable draft/i }));
    expect(fetchCalls(fetchMock)).toHaveLength(1); // no save/compute endpoints
    expect(onApply).toHaveBeenCalledTimes(1);
    const handedOff = onApply.mock.calls[0][0];
    expect(handedOff.proposal_id).toBe(FIXTURE.proposal_id);
    expect(handedOff.proposal.diagnostics.grid_shape).toEqual([16, 16, 24]);
    // Handoff must not alias internal state.
    handedOff.proposal.inputs.parent_path[0][0] = 999;
    expect(FIXTURE.proposal.inputs.parent_path[0][0]).toBe(7);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("renders bounded diagnostics from the accepted envelope", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okResponse(FIXTURE)));
    vi.stubGlobal("fetch", fetchMock);
    render(<AnatomyProposalPanel {...baseProps()} />);
    await clickPropose();
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("123");
    expect(status.textContent).toContain("28");
  });

  test("no fetch when ineligible, disabled, or on mount", () => {
    const fetchMock = vi.fn(() => Promise.resolve(okResponse(FIXTURE)));
    vi.stubGlobal("fetch", fetchMock);
    render(<AnatomyProposalPanel {...baseProps({ eligible: false })} />);
    expect(screen.getByRole("button", { name: /propose geometry/i })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /propose geometry/i }));
    expect(fetchMock).not.toHaveBeenCalled();

    cleanup();
    const fetchMock2 = vi.fn(() => Promise.resolve(okResponse(FIXTURE)));
    vi.stubGlobal("fetch", fetchMock2);
    render(<AnatomyProposalPanel {...baseProps({ disabled: true })} />);
    expect(screen.getByRole("button", { name: /propose geometry/i })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /propose geometry/i }));
    expect(fetchMock2).not.toHaveBeenCalled();
  });

  test("malformed response shows a sanitized error and never offers apply", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okResponse({ surprise: true })));
    vi.stubGlobal("fetch", fetchMock);
    const onApply = vi.fn();
    render(<AnatomyProposalPanel {...baseProps({ onApply })} />);
    await clickPropose();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/did not match the anatomy proposal contract/);
    expect(alert.textContent).not.toContain("surprise");
    expect(screen.queryByRole("button", { name: /apply as editable draft/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /propose geometry/i }));
    expect(fetchCalls(fetchMock)).toHaveLength(2);
    expect(onApply).not.toHaveBeenCalled();
  });

  test("non-409 HTTP errors never leak a private error body", async () => {
    const fetchMock = vi.fn(
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ detail: "internal secret detail" }), {
            status: 500,
          }),
        ) as unknown as Promise<Response>,
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<AnatomyProposalPanel {...baseProps()} />);
    await clickPropose();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("internal secret detail");
    expect(alert.textContent).toContain("500");
  });

  test("late stale response from a superseded target is discarded", async () => {
    const deferred = defer();
    const fetchMock = vi.fn(() => deferred.promise);
    vi.stubGlobal("fetch", fetchMock);
    const onApply = vi.fn();
    const busyCalls: boolean[] = [];
    const { rerender } = render(
      <AnatomyProposalPanel
        {...baseProps({
          targetRas: [1, 2, 3],
          onApply,
          onBusy: (b: boolean) => busyCalls.push(b),
        })}
      />,
    );
    await clickPropose();
    rerender(
      <AnatomyProposalPanel
        {...baseProps({
          targetRas: [4, 5, 6],
          onApply,
          onBusy: (b: boolean) => busyCalls.push(b),
        })}
      />,
    );
    await act(async () => {
      deferred.resolve(okResponse(FIXTURE));
      await deferred.promise;
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: /apply as editable draft/i })).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
    // The request's own captured onBusy is still released exactly once.
    expect(busyCalls).toEqual([true, false]);
  });

  test("realtime parent busy feedback (disabled=true mid-flight) does not cancel the request", async () => {
    const deferred = defer();
    const fetchMock = vi.fn(() => deferred.promise);
    vi.stubGlobal("fetch", fetchMock);
    const onApply = vi.fn();
    const { rerender } = render(
      <AnatomyProposalPanel
        {...baseProps({
          onApply,
          onBusy: () => {
            rerender(
              <AnatomyProposalPanel
                {...baseProps({ disabled: true, onApply })}
              />,
            );
          },
        })}
      />,
    );
    await clickPropose();
    await act(async () => {
      deferred.resolve(okResponse(FIXTURE));
      await deferred.promise;
    });
    expect(screen.getByRole("status").textContent).toMatch(/proposal ready/i);
    expect(fetchCalls(fetchMock)).toHaveLength(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  test("temporarily disabled hides the previous apply offer synchronously", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okResponse(FIXTURE)));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<AnatomyProposalPanel {...baseProps()} />);
    await clickPropose();
    await screen.findByRole("status");
    expect(screen.getByRole("button", { name: /apply as editable draft/i })).toBeEnabled();
    rerender(<AnatomyProposalPanel {...baseProps({ disabled: true })} />);
    expect(
      screen.queryByRole("button", { name: /apply as editable draft/i }),
    ).toBeNull();
    rerender(<AnatomyProposalPanel {...baseProps()} />);
    expect(screen.getByRole("button", { name: /apply as editable draft/i })).toBeEnabled();
  });

  test("binding change hides a stale proposal synchronously", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okResponse(FIXTURE)));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<AnatomyProposalPanel {...baseProps()} />);
    await clickPropose();
    await screen.findByRole("status");
    rerender(
      <AnatomyProposalPanel
        {...baseProps({
          binding: { ...BINDING, artifact_version: "4" },
        })}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /apply as editable draft/i }),
    ).toBeNull();
  });

  test("409 invokes onConflict, locks proposal and apply until Clear proposal", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(conflictResponse()));
    vi.stubGlobal("fetch", fetchMock);
    const onConflict = vi.fn();
    render(<AnatomyProposalPanel {...baseProps({ onConflict })} />);
    await clickPropose();
    await screen.findByRole("alert");
    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /propose geometry/i })).toBeDisabled();

    const fetchMock2 = vi.fn(() => Promise.resolve(okResponse(FIXTURE)));
    vi.stubGlobal("fetch", fetchMock2);
    fireEvent.click(screen.getByRole("button", { name: /propose geometry/i }));
    expect(fetchMock2).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /clear proposal/i }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByRole("button", { name: /propose geometry/i }),
    ).toBeEnabled();
    await clickPropose();
    expect(await screen.findByRole("status")).toHaveTextContent(/proposal ready/i);
    expect(fetchCalls(fetchMock2)).toHaveLength(1);
  });

  test("apply is gated on a live bound snapshot: cloned handoff, never auto-invoked", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okResponse(FIXTURE)));
    vi.stubGlobal("fetch", fetchMock);
    const onApply = vi.fn();
    const { rerender } = render(
      <AnatomyProposalPanel {...baseProps({ eligible: true, onApply })} />,
    );
    await clickPropose();
    await screen.findByRole("status");
    // Source becomes ineligible: apply must vanish, not hand off stale data.
    rerender(<AnatomyProposalPanel {...baseProps({ eligible: false, onApply })} />);
    expect(
      screen.queryByRole("button", { name: /apply as editable draft/i }),
    ).toBeNull();
    rerender(<AnatomyProposalPanel {...baseProps({ eligible: true, onApply })} />);
    // Eligibility loss cleared the stale proposal: no apply handoff, and the
    // parent must request a fresh proposal for the restored eligibility.
    expect(fetchCalls(fetchMock)).toHaveLength(1);
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /propose geometry/i })).toBeEnabled();
  });
});
