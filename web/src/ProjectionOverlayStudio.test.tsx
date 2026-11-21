import { gzipSync } from "node:zlib";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  binding,
  bundleAnswer,
  caseState,
  currentAnswer,
  currentPairAnswer,
  gray,
  hex,
  identity,
  maskBlob,
  maskEntry,
  medial,
  nifti,
  pairBundleAnswer,
  pairGray,
  pairTruth,
  phantom,
  pivot,
  presenceAnswer,
  presenceCurrent,
  registrationAnswer,
  REVISION,
  savedEvidenceInputs,
  savedEvidencePairInputs,
  savedInputs,
  savedPairInputs,
  SIDE,
  truth,
  VIEW,
  VIEW_B,
  volume,
} from "./__fixtures__/overlayCase";
import { applyRigid } from "./__fixtures__/angioPhantom";
import type { Vec3 } from "./obliqueSlice";
import ProjectionOverlayStudio, {
  OVERLAY_REQUEST_TIMEOUT_MS,
} from "./ProjectionOverlayStudio";
import { projectRegistered } from "./projectionRegistration";
import * as overlayJobs from "./projectionOverlayJob";
import * as segmentation from "./segmentation";
import * as viewProposals from "./viewProposals";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const bytes = (value: Uint8Array, headers: Record<string, string> = {}) =>
  new Response(
    value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    ) as ArrayBuffer,
    { headers },
  );
type Routes = {
  registration?: () => Response;
  vessel?: unknown;
  bundle?: () => Response;
  frame?: (url: string) => Response;
  mask?: () => Response;
  put?: (body: any) => Response;
  presence?: (method: string, body: any, revision: number) => Response;
};
/** A stand-in server. Every request is recorded as "METHOD path". */
function server(routes: Routes = {}) {
  const calls: {
    key: string;
    body: unknown;
    signal: AbortSignal | null | undefined;
  }[] = [];
  let revision = 0;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET",
      body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ key: `${method} ${url}`, body, signal: init?.signal });
    const base = `/api/cases/${identity.case_id}`;
    if (url === `${base}/projection-registration`) {
      const answer =
        method === "PUT"
          ? (routes.put ?? (() => json({}, 500)))(body)
          : (routes.registration ?? (() => json(registrationAnswer())))();
      // The report route answers for the registration revision last served.
      try {
        const sent = await answer.clone().json();
        if (Number.isInteger(sent?.registration_revision))
          revision = sent.registration_revision;
      } catch {
        // A malformed answer leaves the revision as it was.
      }
      return answer;
    }
    if (url === `${base}/vessel-presence`)
      return (
        routes.presence ?? ((_method, _body, at) => json(presenceAnswer(at)))
      )(method, body, revision);
    if (url === `${base}/segmentations`)
      return json({
        current: {
          vessel: "vessel" in routes ? routes.vessel : maskEntry,
          aneurysm: null,
        },
      });
    const accepted = (routes.vessel ?? maskEntry) as typeof maskEntry;
    if (url === accepted.mask_url)
      return (routes.mask ?? (() => bytes(maskBlob)))();
    if (url === "/api/projection-frames/phantom-run")
      return (routes.bundle ?? (() => json(bundleAnswer())))();
    if (url.startsWith("/api/projection-frames/phantom-run/planes/"))
      return (
        routes.frame ??
        (() => bytes(gray, { "X-Frame-Manifest-Revision": REVISION }))
      )(url);
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, keys: () => calls.map((call) => call.key) };
}
function Harness({
  cursor = null,
  onDirty,
  locked = false,
  withVolume = true,
}: {
  cursor?: Vec3 | null;
  onDirty?: (dirty: boolean) => void;
  locked?: boolean;
  withVolume?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  return (
    <>
      <button disabled={busy || dirty}>Other workspace action</button>
      <ProjectionOverlayStudio
        caseState={caseState}
        binding={binding}
        volume={withVolume ? volume : null}
        cursor={cursor}
        disabled={busy || locked}
        onBusy={setBusy}
        onDirtyChange={(value) => {
          setDirty(value);
          onDirty?.(value);
        }}
      />
    </>
  );
}
const click = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));
const status = (name: string) => screen.getByRole("status", { name });
const type = (name: string | RegExp, value: string) =>
  fireEvent.change(screen.getByRole("textbox", { name }), {
    target: { value },
  });
async function openFrames() {
  await screen.findByText(/No confirmed 2D-to-3D proposal is saved/);
  type("Frame bundle identifier", "phantom-run");
  click("Open admitted frames");
  await screen.findByRole("img", { name: "Admitted frame 12, plane single" });
}
/** The entered geometry the phantom frame was rendered with. */
function enterGeometry() {
  type("Source to isocenter (mm)", "800");
  type("Field width at the detector (mm)", "180");
  fireEvent.click(screen.getByRole("checkbox", { name: /Fit the field size/ }));
}
const proposed = () =>
  waitFor(
    () => {
      expect(status("Overlay status").textContent).toMatch(/^Unsaved proposal/);
      expect(
        screen
          .getByRole("checkbox", { name: /I reviewed the overlay/ })
          .closest("fieldset"),
      ).not.toBeDisabled();
    },
    { timeout: 30000 },
  );

test("proposes, confirms and saves exactly what the operator reviewed", async () => {
  let saved: unknown = null;
  const api = server({
    put: (body) => {
      saved = body;
      return json(currentAnswer(body.inputs));
    },
  });
  const dirty = vi.fn();
  render(<Harness onDirty={dirty} />);
  await openFrames();
  expect(status("Frame provenance").textContent).toMatch(
    /synthetic scope · PNG frames · 300 × 300 pixels · identifiers removed by an operator-attested crop or redaction/,
  );
  // An uncalibrated plane has no admitted geometry to choose.
  expect(
    screen.queryByRole("checkbox", { name: /Enter geometry by hand/ }),
  ).toBeNull();
  expect(screen.getByText(/These values are assumed/).textContent).toMatch(
    /the frame was cropped/,
  );
  enterGeometry();
  click("Propose overlay");
  await proposed();
  const text = status("Overlay status").textContent!;
  expect(text).toMatch(/They are not a registration accuracy/);
  expect(text).toMatch(
    /coarse 3.by.3.cell neighborhood \(not a 2 mm distance test\)/,
  );
  expect(text).not.toMatch(/field size fitted/);
  expect(dirty).toHaveBeenLastCalledWith(true);
  expect(screen.getByRole("img").getAttribute("aria-label")).toBe(
    "Admitted frame 12, plane single, with projected 3D vessels",
  );
  // The operator can hide the projected vessels to see the frame beneath,
  // and enlarge the figure. Neither changes the proposal.
  expect(screen.getByRole("figure").textContent).toMatch(
    /Cyan: accepted 3D vessel mask projected under the unsaved proposal/,
  );
  click("Hide projected 3D vessels");
  expect(screen.getByRole("figure").textContent).not.toMatch(/Cyan/);
  expect(screen.getByRole("img").getAttribute("aria-label")).toBe(
    "Admitted frame 12, plane single",
  );
  click("Show projected 3D vessels");
  click("Larger view");
  expect(screen.getByRole("figure").className).toMatch(/enlarged/);
  click("Close larger view");
  expect(screen.getByRole("figure").className).not.toMatch(/enlarged/);
  expect(status("Overlay status").textContent).toBe(text);
  expect(screen.getByRole("figure").textContent).toMatch(
    /Not a validated registration\./,
  );
  // Saving needs the explicit review tick.
  const save = screen.getByRole("button", { name: "Save confirmed proposal" });
  expect(save).toHaveProperty("disabled", true);
  expect(api.keys().filter((key) => key.startsWith("PUT"))).toEqual([]);
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I reviewed the overlay/ }),
  );
  click("Save confirmed proposal");
  await screen.findByText(
    /Saved operator-confirmed proposal, revision 1, not a validated registration/,
  );
  expect(api.calls.length).toBeGreaterThan(5);
  expect(api.calls.every((call) => call.signal instanceof AbortSignal)).toBe(
    true,
  );
  const body = saved as any;
  expect(body).toMatchObject({
    artifact_version: identity.artifact_version,
    reference_revision: identity.reference_revision,
    registration_revision: 0,
    inputs: {
      confirmed: true,
      frame_source_id: "phantom-run",
      frame_manifest_revision: REVISION,
      plane: "single",
      frame_index: 12,
      frame_sha256: hex(gray),
      mask_candidate_id: maskEntry.candidate_id,
      mask_sha256: maskEntry.mask_sha256,
      geometry_source: "operator_entered",
      view: VIEW,
      fit_detector_scale: false,
      detector_scale: 1,
      method: "centerline_distance_compass_v1",
      polarity: "dark",
      sensitivity: 0.5,
    },
  });
  // No pixels, mask voxels or points leave the browser.
  expect(Object.keys(body).sort()).toEqual([
    "artifact_version",
    "inputs",
    "reference_revision",
    "registration_revision",
  ]);
  expect(JSON.stringify(body).length).toBeLessThan(2500);
  // The saved pose lays the mask on the frame within a millimeter.
  const size = { width: SIDE, height: SIDE },
    got = projectRegistered(
      body.inputs.view,
      body.inputs.isocenter,
      body.inputs.volume_to_carm_ras,
      medial.points,
      size,
    ),
    want = projectRegistered(VIEW, pivot, truth, medial.points, size);
  let sum = 0;
  for (let k = 0; k < got.length; k += 2)
    sum += Math.hypot(got[k] - want[k], got[k + 1] - want[k + 1]);
  expect(((sum / (got.length / 2)) * ((180 / SIDE) * 800)) / 1200).toBeLessThan(
    1,
  );
  await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(false));
  expect(status("Overlay status").textContent).toMatch(
    /Showing the saved operator-confirmed proposal. It is not a validated registration/,
  );
  expect(
    screen.queryByRole("button", { name: "Save confirmed proposal" }),
  ).toBeNull();
}, 60000);

test("a review tick does not carry over to a new proposal", async () => {
  const api = server();
  render(<Harness />);
  await openFrames();
  enterGeometry();
  click("Propose overlay");
  await proposed();
  const tick = () =>
    screen.getByRole("checkbox", { name: /I reviewed the overlay/ });
  fireEvent.click(tick());
  expect(tick()).toHaveProperty("checked", true);
  click("Propose overlay");
  await waitFor(() =>
    expect(status("Overlay status").textContent).toMatch(/^Computing/),
  );
  await proposed();
  expect(tick()).toHaveProperty("checked", false);
  expect(
    screen.getByRole("button", { name: "Save confirmed proposal" }),
  ).toHaveProperty("disabled", true);
  expect(api.keys().filter((key) => key.startsWith("PUT"))).toEqual([]);
}, 60000);

test("its own pending request locks the controls without help from the owner", async () => {
  let answer: (response: Response) => void = () => {};
  server({
    bundle: () =>
      new Promise<Response>((resolve) => (answer = resolve)) as never,
  });
  // An owner that ignores the busy report and never disables the studio.
  render(
    <ProjectionOverlayStudio
      caseState={caseState}
      binding={binding}
      volume={volume}
      cursor={null}
      disabled={false}
      onBusy={() => {}}
    />,
  );
  await screen.findByText(/No confirmed 2D-to-3D proposal is saved/);
  type("Frame bundle identifier", "phantom-run");
  // The controls sit in fieldsets, which is where the lock is applied.
  const controls = () =>
    screen
      .getByRole("button", { name: "Open admitted frames" })
      .closest("fieldset")!;
  expect(controls()).toHaveProperty("disabled", false);
  click("Open admitted frames");
  await waitFor(() => expect(controls()).toHaveProperty("disabled", true));
  answer(json(bundleAnswer()));
  await screen.findByRole("img", { name: "Admitted frame 12, plane single" });
  expect(controls()).toHaveProperty("disabled", false);
});

test("computation locks sibling actions and its inputs until complete or canceled", async () => {
  const api = server();
  const original = overlayJobs.createOverlayJob;
  let finish = false;
  const create = vi
    .spyOn(overlayJobs, "createOverlayJob")
    .mockImplementation((input) => {
      const job = original(input);
      return { ...job, advance: (expired) => finish && job.advance(expired) };
    });
  const rendered = render(<Harness />);
  try {
    await openFrames();
    enterGeometry();
    click("Propose overlay");
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Other workspace action" }),
      ).toBeDisabled(),
    );
    expect(
      screen
        .getByRole("button", { name: "Open admitted frames" })
        .closest("fieldset"),
    ).toBeDisabled();
    const count = api.calls.length;
    click("Open admitted frames");
    expect(api.calls).toHaveLength(count);
    finish = true;
    await proposed();
    expect(
      screen.getByRole("button", { name: "Other workspace action" }),
    ).toBeDisabled();
    click("Discard proposal");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Other workspace action" }),
      ).not.toBeDisabled(),
    );
    finish = false;
    click("Propose overlay");
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    rendered.rerender(<Harness locked />);
    rendered.rerender(<Harness />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Other workspace action" }),
      ).not.toBeDisabled(),
    );
    expect(status("Overlay status").textContent).toBe("");
  } finally {
    create.mockRestore();
  }
}, 60000);

test.each(["completes", "times out"])(
  "the frame request %s independently after the bundle request has finished",
  async (outcome) => {
    server();
    const originalFetch = globalThis.fetch;
    let signal: AbortSignal | null | undefined;
    let finish!: () => void;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (!url.includes("/planes/")) return originalFetch(url, init);
        signal = init?.signal;
        return new Promise<Response>((resolve) => {
          finish = () => resolve(originalFetch(url, init));
        });
      }),
    );
    render(<Harness />);
    await screen.findByText(/No confirmed 2D-to-3D proposal is saved/);
    const timers = vi.spyOn(globalThis, "setTimeout");
    try {
      type("Frame bundle identifier", "phantom-run");
      click("Open admitted frames");
      await waitFor(() => expect(signal).toBeTruthy());
      const deadlines = timers.mock.calls
        .filter(([, ms]) => ms === OVERLAY_REQUEST_TIMEOUT_MS)
        .map(([callback]) => callback as () => void);
      expect(deadlines).toHaveLength(2);
      await act(async () => deadlines[0]());
      // The manifest is already parsed. Its old deadline cannot time out a
      // still-valid frame fetch or force authoritative-state recovery.
      expect(screen.queryByRole("alert")).toBeNull();
      expect(signal?.aborted).toBe(false);
      expect(
        screen.getByRole("button", { name: "Other workspace action" }),
      ).toBeDisabled();
      if (outcome === "times out") {
        await act(async () => deadlines[1]());
        expect(screen.getByRole("alert").textContent).toMatch(
          /request timed out/,
        );
        expect(signal?.aborted).toBe(true);
      }
      await act(async () => finish());
      if (outcome === "completes") {
        await screen.findByRole("img", {
          name: "Admitted frame 12, plane single",
        });
        expect(screen.queryByRole("alert")).toBeNull();
        expect(
          screen
            .getByRole("button", { name: "Open admitted frames" })
            .closest("fieldset"),
        ).not.toBeDisabled();
      } else {
        expect(screen.queryByRole("img")).toBeNull();
        expect(
          screen
            .getByRole("button", { name: "Open admitted frames" })
            .closest("fieldset"),
        ).toBeDisabled();
      }
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Other workspace action" }),
        ).not.toBeDisabled(),
      );
    } finally {
      timers.mockRestore();
    }
  },
);

test("a stalled read aborts at its deadline, releases the workspace and can be explicitly reloaded", async () => {
  server();
  const originalFetch = globalThis.fetch;
  let stalled = true;
  let signal: AbortSignal | null | undefined;
  let lateAnswer!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (!stalled || !url.endsWith("/projection-registration"))
        return originalFetch(url, init);
      signal = init?.signal;
      // Deliberately ignore abort: even a noncooperative transport cannot
      // retain the lock or publish a late snapshot after explicit recovery.
      return new Promise<Response>((resolve) => {
        lateAnswer = resolve;
      });
    }),
  );
  const timers = vi.spyOn(globalThis, "setTimeout");
  render(<Harness />);
  try {
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Other workspace action" }),
      ).toBeDisabled(),
    );
    const deadline = timers.mock.calls.find(
      ([, ms]) => ms === OVERLAY_REQUEST_TIMEOUT_MS,
    )?.[0];
    expect(deadline).toBeTypeOf("function");
    await act(async () => {
      (deadline as () => void)();
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Other workspace action" }),
      ).not.toBeDisabled(),
    );
    expect(signal?.aborted).toBe(true);
    expect(screen.getByRole("alert").textContent).toMatch(/request timed out/);
    stalled = false;
    click("Reload saved proposal");
    await screen.findByText(/No confirmed 2D-to-3D proposal is saved/);
    await act(async () => {
      lateAnswer(json(currentAnswer()));
    });
    expect(
      screen.getByText(/No confirmed 2D-to-3D proposal is saved/),
    ).toBeTruthy();
  } finally {
    timers.mockRestore();
  }
});

test("a timed-out save requires a saved-state read before retrying and never duplicates the write", async () => {
  let committed: any = null,
    writes = 0;
  server({
    registration: () =>
      json(committed ? currentAnswer(committed) : registrationAnswer()),
  });
  const originalFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method !== "PUT") return originalFetch(url, init);
      writes++;
      committed = JSON.parse(String(init.body)).inputs;
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    }),
  );
  const timers = vi.spyOn(globalThis, "setTimeout");
  render(<Harness />);
  try {
    await openFrames();
    enterGeometry();
    click("Propose overlay");
    await proposed();
    fireEvent.click(
      screen.getByRole("checkbox", { name: /I reviewed the overlay/ }),
    );
    click("Save confirmed proposal");
    await waitFor(() => expect(writes).toBe(1));
    const deadline = timers.mock.calls
      .filter(([, ms]) => ms === OVERLAY_REQUEST_TIMEOUT_MS)
      .at(-1)![0];
    await act(async () => {
      (deadline as () => void)();
    });
    expect(screen.getByRole("alert").textContent).toMatch(
      /may have been stored/,
    );
    expect(
      screen
        .getByRole("button", { name: "Save confirmed proposal" })
        .closest("fieldset"),
    ).toBeDisabled();
    click("Save confirmed proposal");
    expect(writes).toBe(1);
    click("Reload saved proposal");
    await screen.findByText(/Saved operator-confirmed proposal, revision 1/);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Other workspace action" }),
      ).not.toBeDisabled(),
    );
    expect(writes).toBe(1);
  } finally {
    timers.mockRestore();
  }
}, 60000);

test("identity changes and unmount release the captured request owner exactly once", async () => {
  let oldAnswer!: (value: Response) => void;
  const api = server();
  const original = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) =>
      url.endsWith("/projection-registration") &&
      (!init?.method || init.method === "GET")
        ? new Promise<Response>((resolve) => {
            oldAnswer = resolve;
          })
        : original(url, init),
    ),
  );
  const oldOwner = vi.fn(),
    nextOwner = vi.fn();
  const props = { caseState, binding, volume, cursor: null };
  const rendered = render(
    <ProjectionOverlayStudio {...props} onBusy={oldOwner} />,
  );
  await waitFor(() => expect(oldOwner).toHaveBeenLastCalledWith(true));
  const finishOld = oldAnswer;
  rendered.rerender(
    <ProjectionOverlayStudio
      {...props}
      caseState={{ ...caseState, artifact_version: "8" }}
      onBusy={nextOwner}
    />,
  );
  expect(oldOwner).toHaveBeenLastCalledWith(false);
  const finishNew = oldAnswer;
  finishNew(json({ ...registrationAnswer(), artifact_version: "8" }));
  await screen.findByText(/No confirmed 2D-to-3D proposal is saved/);
  expect(nextOwner).toHaveBeenLastCalledWith(false);
  await act(async () => {
    finishOld(json(registrationAnswer()));
  });
  rendered.rerender(
    <ProjectionOverlayStudio
      {...props}
      caseState={{ ...caseState, artifact_version: "9" }}
      onBusy={nextOwner}
    />,
  );
  expect(nextOwner).toHaveBeenLastCalledWith(true);
  const finishUnmounted = oldAnswer;
  rendered.unmount();
  await act(async () => {
    finishUnmounted(json({ ...registrationAnswer(), artifact_version: "9" }));
  });
  expect(oldOwner.mock.calls.filter(([busy]) => busy === false)).toHaveLength(
    1,
  );
  expect(nextOwner.mock.calls.filter(([busy]) => busy === false)).toHaveLength(
    2,
  );
  expect(api.keys().filter((key) => key.startsWith("PUT"))).toHaveLength(0);
});

test("a changed input drops the proposal before it can be saved", async () => {
  const api = server();
  const dirty = vi.fn();
  render(<Harness onDirty={dirty} />);
  await openFrames();
  enterGeometry();
  click("Propose overlay");
  await proposed();
  type("Source to isocenter (mm)", "790");
  expect(status("Overlay status").textContent).toBe("");
  expect(
    screen.queryByRole("button", { name: "Save confirmed proposal" }),
  ).toBeNull();
  await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(false));
  // Restoring the input does not bring the old proposal back.
  type("Source to isocenter (mm)", "800");
  expect(status("Overlay status").textContent).toBe("");
  click("Propose overlay");
  await proposed();
  click("Discard proposal");
  expect(status("Overlay status").textContent).toBe("");
  expect(api.keys().filter((key) => key.startsWith("PUT"))).toEqual([]);
}, 60000);

test("a refused save keeps the proposal unsaved and says so", async () => {
  let answer = () => json({}, 409);
  server({ put: () => answer() });
  render(<Harness />);
  await openFrames();
  enterGeometry();
  click("Propose overlay");
  await proposed();
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I reviewed the overlay/ }),
  );
  click("Save confirmed proposal");
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /The case or the saved proposal changed. Reload before saving/,
  );
  answer = () => json({}, 422);
  click("Save confirmed proposal");
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toMatch(
      /The proposal was not saved/,
    ),
  );
  // An acknowledgement that does not describe a confirmed proposal is refused.
  answer = () => json(currentAnswer(savedInputs(), { evidence: "assumed" }));
  click("Save confirmed proposal");
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toMatch(
      /The proposal was not saved/,
    ),
  );
  expect(
    screen.getByText(/No confirmed 2D-to-3D proposal is saved/),
  ).toBeTruthy();
  expect(status("Overlay status").textContent).toMatch(/^Unsaved proposal/);
}, 60000);

test("a frame that cannot be fetched is not called an integrity failure", async () => {
  for (const frame of [
    () => new Response("", { status: 503 }),
    // Served under another manifest revision.
    () => bytes(gray, { "X-Frame-Manifest-Revision": "0".repeat(64) }),
    (): Response => {
      throw new TypeError("Failed to fetch");
    },
  ]) {
    server({ frame });
    const view = render(<Harness />);
    await screen.findByText(/No confirmed 2D-to-3D proposal is saved/);
    type("Frame bundle identifier", "phantom-run");
    click("Open admitted frames");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "This frame could not be loaded and is not displayed.",
    );
    expect(screen.queryByRole("img")).toBeNull();
    view.unmount();
  }
});

test("a frame that fails its digest is never drawn", async () => {
  const flipped = gray.slice();
  flipped[5] ^= 1;
  server({
    frame: () => bytes(flipped, { "X-Frame-Manifest-Revision": REVISION }),
  });
  render(<Harness />);
  await screen.findByText(/No confirmed 2D-to-3D proposal is saved/);
  type("Frame bundle identifier", "phantom-run");
  click("Open admitted frames");
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /^This frame failed its integrity check and is not displayed\.$/,
  );
  expect(screen.queryByRole("img")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Propose overlay" }),
  ).toHaveProperty("disabled", true);
});

test("bad identifiers and missing bundles are reported without a frame", async () => {
  const api = server({ bundle: () => json({}, 404) });
  render(<Harness />);
  await screen.findByText(/No confirmed 2D-to-3D proposal is saved/);
  type("Frame bundle identifier", "../secret");
  click("Open admitted frames");
  expect(screen.getByRole("alert").textContent).toMatch(/Enter the identifier/);
  expect(api.keys().some((key) => key.includes("projection-frames"))).toBe(
    false,
  );
  type("Frame bundle identifier", "phantom-run");
  click("Open admitted frames");
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toMatch(
      /not installed or failed their integrity checks/,
    ),
  );
  expect(screen.queryByRole("img")).toBeNull();
});

test("needs an accepted vessel mask and the loaded source", async () => {
  server({ vessel: null });
  const view = render(<Harness />);
  await openFrames();
  expect(
    screen.getByText(/Accept a vessel segmentation for this source first/),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Propose overlay" }),
  ).toHaveProperty("disabled", true);
  view.unmount();
  server({ vessel: { ...maskEntry, status: "preview" } });
  const preview = render(<Harness />);
  await openFrames();
  expect(screen.getByText(/Accept a vessel segmentation/)).toBeTruthy();
  preview.unmount();
  server();
  render(<Harness withVolume={false} />);
  await openFrames();
  expect(screen.getByText(/Load the verified source volume/)).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Propose overlay" }),
  ).toHaveProperty("disabled", true);
});

test("a mask that fails its digest stops the proposal", async () => {
  const flipped = maskBlob.slice();
  flipped[flipped.length - 9] ^= 1;
  server({ mask: () => bytes(flipped) });
  render(<Harness />);
  await openFrames();
  enterGeometry();
  click("Propose overlay");
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /Overlay computation failed: Segmentation integrity check failed/,
  );
  expect(
    screen.queryByRole("button", { name: "Save confirmed proposal" }),
  ).toBeNull();
});

test("admitted DICOM geometry is used unless the operator overrides it", async () => {
  const answer = bundleAnswer({ method: "admitted_dicom_xa_frames" });
  const plane = (answer.manifest.planes as any[])[0];
  plane.geometry = VIEW;
  plane.container_sha256 = "e".repeat(64);
  plane.container_bytes = 1024;
  plane.frames.forEach((frame: any) => {
    frame.input_sha256 = plane.container_sha256;
  });
  plane.deidentification = {
    ...plane.deidentification,
    basis: "dicom_declared_no_burned_in_annotation",
    burned_in_annotation: "no",
    crop: null,
    source_rows: SIDE,
    source_columns: SIDE,
  };
  let saved: any = null;
  server({
    bundle: () => json(answer),
    put: (body) => {
      saved = body;
      return json(currentAnswer(body.inputs));
    },
  });
  render(<Harness cursor={[...pivot] as Vec3} />);
  await openFrames();
  expect(status("Admitted geometry").textContent).toMatch(
    /source to detector 1200 mm · source to patient 800 mm · field 180 × 180 mm, from the admitted DICOM object/,
  );
  expect(status("Frame provenance").textContent).toMatch(
    /DICOM XA frames .* the DICOM object declares no burned-in annotation/,
  );
  expect(
    screen.queryByRole("textbox", { name: /Source to isocenter/ }),
  ).toBeNull();
  click("Set isocenter to crosshair");
  expect(status("Overlay isocenter").textContent).toMatch(/mm \(RAS\)/);
  click("Propose overlay");
  await proposed();
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I reviewed the overlay/ }),
  );
  click("Save confirmed proposal");
  await screen.findByText(/Saved operator-confirmed proposal/);
  expect(saved.inputs).toMatchObject({
    geometry_source: "frame_manifest",
    view: VIEW,
    fit_detector_scale: false,
    detector_scale: 1,
    isocenter: [...pivot],
  });
  // Overriding switches to entered numbers, labelled as assumed.
  fireEvent.click(
    screen.getByRole("checkbox", { name: /Enter geometry by hand/ }),
  );
  expect(screen.getByText(/These values are assumed/).textContent).not.toMatch(
    /cropped/,
  );
  expect(
    screen.getByRole("checkbox", { name: /Fit the field size/ }),
  ).toHaveProperty("checked", true);
}, 60000);

test("out-of-range entered geometry blocks the proposal", async () => {
  server();
  render(<Harness />);
  await openFrames();
  type("Source to isocenter (mm)", "1300");
  expect(screen.getByRole("alert").textContent).toMatch(
    /outside the supported C-arm bounds/,
  );
  expect(
    screen.getByRole("button", { name: "Propose overlay" }),
  ).toHaveProperty("disabled", true);
  type("Source to isocenter (mm)", "");
  expect(
    screen.getByRole("button", { name: "Propose overlay" }),
  ).toHaveProperty("disabled", true);
});

test("shows a saved proposal only while its evidence is unchanged", async () => {
  const api = server({ registration: () => json(currentAnswer()) });
  const view = render(<Harness />);
  const saved = await screen.findByRole("status", {
    name: "Saved overlay proposal",
  });
  expect(saved.textContent).toMatch(
    /revision 1, not a validated registration: frame 12 of plane single in phantom-run, operator-entered geometry \(assumed\), turned 4.0° and moved the isocenter 6.4 mm .* installed and unchanged/,
  );
  click("Show saved overlay");
  await waitFor(
    () =>
      expect(status("Overlay status").textContent).toMatch(
        /Showing the saved operator-confirmed proposal/,
      ),
    { timeout: 30000 },
  );
  expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(
    /with projected 3D vessels/,
  );
  // The controls show the geometry the record was computed with.
  expect(
    ["Source to isocenter (mm)", "Field width at the detector (mm)"].map(
      (name) =>
        (screen.getByRole("textbox", { name }) as HTMLInputElement).value,
    ),
  ).toEqual(["800", "180"]);
  expect(
    screen.getByRole("checkbox", { name: /Fit the field size/ }),
  ).toHaveProperty("checked", false);
  expect(api.keys().filter((key) => key.startsWith("PUT"))).toEqual([]);
  view.unmount();

  // The bundle was reinstalled under another manifest revision. It is
  // consistent in itself, with the same pixels, and is still not the bundle
  // the proposal was confirmed against.
  server({
    registration: () => json(currentAnswer()),
    bundle: () =>
      json({ ...bundleAnswer(), manifest_revision: "b".repeat(64) }),
    frame: () => bytes(gray, { "X-Frame-Manifest-Revision": "b".repeat(64) }),
  });
  const changed = render(<Harness />);
  await screen.findByRole("status", { name: "Saved overlay proposal" });
  click("Show saved overlay");
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /no longer available unchanged, so its overlay is not shown/,
  );
  expect(screen.queryByRole("img")).toBeNull();
  changed.unmount();

  // Another vessel mask has been accepted since: a new candidate with the
  // same voxels, then the same candidate name with other bytes. Both are
  // served consistently, and neither is the mask that was confirmed.
  const regzipped = new Uint8Array(
    gzipSync(nifti(phantom.mask, phantom.shape, phantom.affine), { level: 1 }),
  );
  expect(hex(regzipped)).not.toBe(maskEntry.mask_sha256);
  for (const routes of [
    {
      vessel: {
        ...maskEntry,
        candidate_id: "vessel-candidate-2",
        mask_url: maskEntry.mask_url.replace("candidate-1", "candidate-2"),
      },
    },
    {
      vessel: { ...maskEntry, mask_sha256: hex(regzipped) },
      mask: () => bytes(regzipped),
    },
  ]) {
    const api = server({
      registration: () => json(currentAnswer()),
      ...routes,
    });
    const remasked = render(<Harness />);
    await screen.findByRole("status", { name: "Saved overlay proposal" });
    click("Show saved overlay");
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /no longer available unchanged/,
    );
    expect(screen.queryByRole("img")).toBeNull();
    // Refused before any frame or mask byte was requested.
    expect(api.keys().filter((key) => /frames|mask$/.test(key))).toEqual([]);
    remasked.unmount();
  }

  // The same manifest revision now names other pixels for the frame.
  const other = gray.map((value) => 255 - value);
  const swapped = bundleAnswer();
  swapped.manifest.planes[0].frames[0].sha256 = hex(other);
  server({
    registration: () => json(currentAnswer()),
    bundle: () => json(swapped),
    frame: () => bytes(other, { "X-Frame-Manifest-Revision": REVISION }),
  });
  const reframed = render(<Harness />);
  await screen.findByRole("status", { name: "Saved overlay proposal" });
  click("Show saved overlay");
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /no longer available unchanged/,
  );
  expect(screen.queryByRole("img")).toBeNull();
  reframed.unmount();

  server({
    registration: () =>
      json(currentAnswer(savedInputs(), { evidence: "unavailable" })),
  });
  render(<Harness />);
  expect(
    (await screen.findByRole("status", { name: "Saved overlay proposal" }))
      .textContent,
  ).toMatch(/no longer available unchanged/);
  expect(
    screen.queryByRole("button", { name: "Show saved overlay" }),
  ).toBeNull();
}, 60000);

test("stale and unreadable saved state is not shown", async () => {
  server({
    registration: () =>
      json(
        registrationAnswer(
          { status: "stale", registration_id: "r", inputs: null, result: null },
          3,
        ),
      ),
  });
  const view = render(<Harness />);
  await screen.findByText(
    /confirmed for an earlier revision of this case. It is not shown or reused/,
  );
  view.unmount();
  server({
    registration: () =>
      json(
        currentAnswer(savedInputs(), {
          result: {
            ...(currentAnswer().current.result as object),
            validated: true,
          },
        }),
      ),
  });
  const claimed = render(<Harness />);
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /could not be loaded/,
  );
  expect(
    screen.queryByRole("button", { name: "Open admitted frames" }),
  ).toBeNull();
  claimed.unmount();
  server({ registration: () => json({}, 503) });
  render(<Harness />);
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /could not be loaded/,
  );
});

test("is locked while the owner is busy and absent without a millimeter source", async () => {
  server();
  const view = render(<Harness locked />);
  await screen.findByText(/No confirmed 2D-to-3D proposal is saved/);
  expect(screen.getByRole("group", { name: "Admitted frames" })).toHaveProperty(
    "disabled",
    true,
  );
  view.unmount();
  const { container } = render(
    <ProjectionOverlayStudio
      caseState={{ ...caseState, spatial_units: "unknown" as never }}
      binding={binding}
      volume={volume}
      cursor={null}
    />,
  );
  expect(container.innerHTML).toBe("");
});

// Two planes of a declared pair, fitted with one pose.

const pairFrame = (url: string) =>
  bytes(pairGray[url.includes("/planes/b/") ? 1 : 0], {
    "X-Frame-Manifest-Revision": REVISION,
  });
const pairRoutes = {
  bundle: () => json(pairBundleAnswer()),
  frame: pairFrame,
};
/** Asks for views once the studio takes input: a frame that has just been
 * drawn may still be loading, and a click then would do nothing. */
const proposeViews = async () => {
  const button = () =>
    screen.getByRole("button", { name: "Propose views for this frame" });
  await waitFor(() => expect(button()).toBeEnabled());
  fireEvent.click(button());
};
const choosePlane = (label: string) =>
  fireEvent.change(screen.getByRole("combobox", { name: "Plane" }), {
    target: { value: label },
  });
/** Opens the pair and enters each plane's geometry as it was rendered. */
async function openPair() {
  await screen.findByText(/No confirmed 2D-to-3D proposal is saved/);
  type("Frame bundle identifier", "phantom-run");
  click("Open admitted frames");
  await screen.findByRole("img", { name: "Admitted frame 12, plane a" });
  enterGeometry();
  choosePlane("b");
  await screen.findByRole("img", { name: "Admitted frame 12, plane b" });
  // Plane B starts as a lateral view and keeps its own values.
  expect(screen.getByRole("textbox", { name: /Primary angle/ })).toHaveProperty(
    "value",
    "90",
  );
  expect(
    screen.getByRole("textbox", { name: "Source to isocenter (mm)" }),
  ).toHaveProperty("value", "750");
  enterGeometry();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Fit one pose to both planes" }),
  );
}
/** Waits until the studio accepts input. A click while a frame request is
 * still pending is ignored, as it is for an operator. */
const acceptsInput = () =>
  waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Propose two-plane overlay" })
        .closest("fieldset"),
    ).not.toBeDisabled(),
  );
async function proposePair() {
  await acceptsInput();
  click("Propose two-plane overlay");
  await waitFor(
    () =>
      expect(status("Overlay status").textContent).toMatch(
        /^Unsaved two-plane proposal/,
      ),
    { timeout: 30000 },
  );
}

test("fits one pose to both planes and saves a record that binds both frames", async () => {
  let saved: any = null;
  const api = server({
    ...pairRoutes,
    put: (body) => {
      saved = body;
      const answer = currentPairAnswer(body.inputs);
      return json(answer);
    },
  });
  const dirty = vi.fn();
  render(<Harness onDirty={dirty} />);
  await openPair();
  expect(status("Frame provenance").textContent).toMatch(
    /the two planes are linked by operator declaration only/,
  );
  expect(status("Two-plane selection").textContent).toMatch(
    /Plane A frame 12 and plane B frame 12\..*The central rays are 90° apart\./,
  );
  // Returning to plane A shows the values entered for it, not plane B's.
  choosePlane("a");
  await screen.findByRole("img", { name: "Admitted frame 12, plane a" });
  expect(screen.getByRole("textbox", { name: /Primary angle/ })).toHaveProperty(
    "value",
    "0",
  );
  expect(
    screen.getByRole("textbox", { name: "Source to isocenter (mm)" }),
  ).toHaveProperty("value", "800");
  expect(screen.getByText(/Both frames must show the patient/)).toBeTruthy();
  await proposePair();
  const text = status("Overlay status").textContent!;
  expect(text).toMatch(/central rays 90° apart\. Plane A: .* Plane B: /);
  expect(text).toMatch(
    /They are not a registration accuracy, and a wrong pose can score as well as a right one/,
  );
  expect(text).not.toMatch(/field size fitted/);
  expect(dirty).toHaveBeenLastCalledWith(true);
  // Both frames are drawn, each with the one pose over it.
  expect(
    screen.getAllByRole("img").map((img) => img.getAttribute("aria-label")),
  ).toEqual([
    "Admitted frame 12, plane a, with projected 3D vessels",
    "Admitted frame 12, plane b, with projected 3D vessels",
  ]);
  expect(screen.getByRole("figure").textContent).toMatch(
    /unsaved two-plane proposal, one pose for both frames\..*Not a validated registration\./,
  );
  // Saving needs the review tick and the same-position attestation, both.
  const save = screen.getByRole("button", { name: "Save confirmed proposal" });
  const review = screen.getByRole("checkbox", {
      name: /I reviewed both overlays/,
    }),
    attest = screen.getByRole("checkbox", {
      name: /Both frames show the patient in the same position/,
    });
  expect(save).toHaveProperty("disabled", true);
  fireEvent.click(review);
  expect(save).toHaveProperty("disabled", true);
  fireEvent.click(review);
  fireEvent.click(attest);
  expect(save).toHaveProperty("disabled", true);
  fireEvent.click(save);
  expect(api.keys().filter((key) => key.startsWith("PUT"))).toEqual([]);
  fireEvent.click(review);
  click("Save confirmed proposal");
  await screen.findByText(
    /Saved operator-confirmed two-plane proposal, revision 1, not a validated registration: frame 12 of plane a with operator-entered geometry \(assumed\) and frame 12 of plane b with operator-entered geometry \(assumed\) in phantom-run, central rays 90° apart, one pose for both/,
  );
  expect(status("Saved overlay proposal").textContent).toMatch(
    /The operator attested that both frames show the patient in the same position; that was not checked\./,
  );
  expect(Object.keys(saved).sort()).toEqual([
    "artifact_version",
    "inputs",
    "reference_revision",
    "registration_revision",
  ]);
  expect(Object.keys(saved.inputs).sort()).toEqual(
    Object.keys(savedPairInputs()).sort(),
  );
  expect(saved).toMatchObject({
    artifact_version: identity.artifact_version,
    reference_revision: identity.reference_revision,
    registration_revision: 0,
    inputs: {
      confirmed: true,
      same_position_attested: true,
      frame_source_id: "phantom-run",
      frame_manifest_revision: REVISION,
      mask_candidate_id: maskEntry.candidate_id,
      mask_sha256: maskEntry.mask_sha256,
      method: "centerline_distance_compass_biplane_v1",
      planes: [0, 1].map((k) => ({
        plane: "ab"[k],
        frame_index: 12,
        frame_sha256: hex(pairGray[k]),
        geometry_source: "operator_entered",
        view: k ? VIEW_B : VIEW,
        fit_detector_scale: false,
        detector_scale: 1,
        polarity: "dark",
        sensitivity: 0.5,
      })),
    },
  });
  for (const plane of saved.inputs.planes)
    expect(Object.keys(plane).sort()).toEqual(
      Object.keys(savedPairInputs().planes[0]).sort(),
    );
  // No pixels, mask voxels or points leave the browser.
  expect(JSON.stringify(saved).length).toBeLessThan(4000);
  // The saved pose puts the vessel points within a millimeter of where the
  // frames were rendered, in three dimensions.
  let sum = 0;
  for (let k = 0; k < medial.points.length; k += 3) {
    const x: Vec3 = [
        medial.points[k],
        medial.points[k + 1],
        medial.points[k + 2],
      ],
      got = applyRigid(saved.inputs.volume_to_carm_ras, x),
      want = applyRigid(pairTruth, x);
    sum += Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2]);
  }
  expect(sum / (medial.points.length / 3)).toBeLessThan(1);
  await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(false));
  expect(status("Overlay status").textContent).toMatch(
    /Showing the saved operator-confirmed two-plane proposal. It is not a validated registration/,
  );
  expect(
    screen.queryByRole("button", { name: "Save confirmed proposal" }),
  ).toBeNull();
  expect(screen.getAllByRole("img")).toHaveLength(2);
}, 120000);

test("a change to either plane drops a two-plane proposal and its ticks", async () => {
  // The search is replaced by a fixed answer: this test is about what the
  // studio does with a proposal, not about finding one.
  const real = overlayJobs.createBiplaneOverlayJob;
  const spy = vi
    .spyOn(overlayJobs, "createBiplaneOverlayJob")
    .mockImplementation((input) => {
      const points = real({ ...input, search: false });
      const score = {
        mean_distance_mm: 0.4,
        matched_fraction: 0.9,
        in_field_fraction: 1,
        uncovered_fraction: 0.1,
      };
      return {
        advance: (expired) => points.advance(expired),
        result: () => ({
          ...points.result(),
          targets: null,
          proposal: {
            method: "centerline_distance_compass_biplane_v1",
            matrix: pairTruth,
            planes: [input.planes[0], input.planes[1]].map((plane) => ({
              view: plane.view,
              detector_scale: 1,
              score,
              start_score: { ...score, mean_distance_mm: 6 },
            })) as any,
            plane_angle_deg: 90,
            translation_mm: 8.8,
            rotation_deg: 6.4,
            point_count: 100,
            evaluations: 1,
          },
        }),
      };
    });
  try {
    const api = server(pairRoutes);
    const dirty = vi.fn();
    render(<Harness onDirty={dirty} />);
    await openPair();
    const tick = async () => {
      await proposePair();
      fireEvent.click(
        screen.getByRole("checkbox", { name: /I reviewed both overlays/ }),
      );
      fireEvent.click(
        screen.getByRole("checkbox", { name: /Both frames show the patient/ }),
      );
      expect(
        screen.getByRole("button", { name: "Save confirmed proposal" }),
      ).toHaveProperty("disabled", false);
    };
    await tick();
    // Plane B is the plane open in the controls. Changing its sensitivity
    // changes what the proposal was computed from.
    fireEvent.change(screen.getByRole("slider"), { target: { value: "0.6" } });
    expect(status("Overlay status").textContent).toBe("");
    expect(
      screen.queryByRole("button", { name: "Save confirmed proposal" }),
    ).toBeNull();
    await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(false));
    // A new proposal starts with neither tick.
    await proposePair();
    for (const name of [/I reviewed both overlays/, /Both frames show/])
      expect(screen.getByRole("checkbox", { name })).toHaveProperty(
        "checked",
        false,
      );
    // So does a change on plane A, and choosing another frame of a plane.
    choosePlane("a");
    await screen.findByText(/Unsaved two-plane proposal/);
    type("Source to isocenter (mm)", "790");
    expect(status("Overlay status").textContent).toBe("");
    type("Source to isocenter (mm)", "800");
    expect(status("Overlay status").textContent).toBe("");
    await tick();
    // Leaving two-plane mode drops it as well.
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Fit one pose to both planes" }),
    );
    expect(status("Overlay status").textContent).toBe("");
    expect(
      screen.getByRole("button", { name: "Propose overlay" }),
    ).toBeTruthy();
    expect(api.keys().filter((key) => key.startsWith("PUT"))).toEqual([]);
    // Each search was given plane A, then plane B, with their own views.
    for (const [input] of spy.mock.calls) {
      expect(input.planes.map((plane) => plane.view.primary_deg)).toEqual([
        0, 90,
      ]);
      expect(input.search).toBe(true);
    }
  } finally {
    spy.mockRestore();
  }
}, 60000);

test("a two-plane record names the frame chosen on each plane", async () => {
  // Plane B has a second admitted frame with other pixels.
  const later = pairGray[1].map((value) => 255 - value);
  const bundle = pairBundleAnswer();
  (bundle.manifest.planes as any)[1].frames[1].sha256 = hex(later);
  const real = overlayJobs.createBiplaneOverlayJob;
  const score = {
    mean_distance_mm: 0.4,
    matched_fraction: 0.9,
    in_field_fraction: 1,
    uncovered_fraction: 0.1,
  };
  const spy = vi
    .spyOn(overlayJobs, "createBiplaneOverlayJob")
    .mockImplementation((input) => {
      const points = real({ ...input, search: false });
      return {
        advance: (expired) => points.advance(expired),
        result: () => ({
          ...points.result(),
          targets: null,
          proposal: {
            method: "centerline_distance_compass_biplane_v1",
            matrix: pairTruth,
            planes: [input.planes[0], input.planes[1]].map((plane) => ({
              view: plane.view,
              detector_scale: 1,
              score,
              start_score: { ...score, mean_distance_mm: 6 },
            })) as any,
            plane_angle_deg: 90,
            translation_mm: 8.8,
            rotation_deg: 6.4,
            point_count: 100,
            evaluations: 1,
          },
        }),
      };
    });
  try {
    let saved: any = null;
    server({
      bundle: () => json(bundle),
      frame: (url) =>
        url.endsWith("/planes/b/frames/30")
          ? bytes(later, { "X-Frame-Manifest-Revision": REVISION })
          : pairFrame(url),
      put: (body) => {
        saved = body;
        return json(currentPairAnswer(body.inputs));
      },
    });
    render(<Harness />);
    await openPair();
    fireEvent.change(screen.getByRole("combobox", { name: "Frame" }), {
      target: { value: "30" },
    });
    await screen.findByRole("img", { name: "Admitted frame 30, plane b" });
    expect(status("Two-plane selection").textContent).toMatch(
      /Plane A frame 12 and plane B frame 30\./,
    );
    // Looking at plane A and coming back keeps plane B's chosen frame.
    choosePlane("a");
    await screen.findByRole("img", { name: "Admitted frame 12, plane a" });
    choosePlane("b");
    await screen.findByRole("img", { name: "Admitted frame 30, plane b" });
    await proposePair();
    const [input] = spy.mock.calls[0];
    expect(input.planes.map((plane) => plane.frame.gray)).toEqual([
      pairGray[0],
      later,
    ]);
    expect(
      screen.getAllByRole("img").map((img) => img.getAttribute("aria-label")),
    ).toEqual([
      "Admitted frame 12, plane a, with projected 3D vessels",
      "Admitted frame 30, plane b, with projected 3D vessels",
    ]);
    fireEvent.click(
      screen.getByRole("checkbox", { name: /I reviewed both overlays/ }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Both frames show the patient/ }),
    );
    click("Save confirmed proposal");
    await screen.findByText(/frame 30 of plane b/);
    expect(
      saved.inputs.planes.map((plane: any) => [
        plane.plane,
        plane.frame_index,
        plane.frame_sha256,
      ]),
    ).toEqual([
      ["a", 12, hex(pairGray[0])],
      ["b", 30, hex(later)],
    ]);
  } finally {
    spy.mockRestore();
  }
}, 60000);

test("planes too close together cannot be fitted with one pose", async () => {
  server(pairRoutes);
  render(<Harness />);
  await openPair();
  // Plane B is open. 29 degrees from plane A is one degree short.
  type(/Primary angle/, "29");
  expect(screen.getByRole("alert").textContent).toMatch(
    /needs central rays at least 30° apart/,
  );
  expect(
    screen.getByRole("button", { name: "Propose two-plane overlay" }),
  ).toHaveProperty("disabled", true);
  type(/Primary angle/, "30");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Propose two-plane overlay" }),
  ).toHaveProperty("disabled", false);
  // A value outside the C-arm bounds on one plane blocks it too.
  type(/Primary angle/, "400");
  expect(
    screen.getAllByRole("alert").map((alert) => alert.textContent),
  ).toContain(
    "Geometry values of one plane are outside the supported C-arm bounds.",
  );
  expect(
    screen.getByRole("button", { name: "Propose two-plane overlay" }),
  ).toHaveProperty("disabled", true);
});

test("a second frame that fails its digest stops the two-plane proposal", async () => {
  const spy = vi.spyOn(overlayJobs, "createBiplaneOverlayJob");
  try {
    let tamper = false;
    const api = server({
      ...pairRoutes,
      frame: (url) =>
        tamper && url.includes("/planes/a/")
          ? bytes(
              pairGray[0].map((value) => 255 - value),
              { "X-Frame-Manifest-Revision": REVISION },
            )
          : pairFrame(url),
    });
    render(<Harness />);
    await openPair();
    // Plane B is open and verified. Plane A is read again for the proposal
    // and no longer matches its recorded digest.
    tamper = true;
    await acceptsInput();
    click("Propose two-plane overlay");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Overlay computation failed: A frame failed its integrity check and is not used.",
    );
    expect(spy).not.toHaveBeenCalled();
    expect(status("Overlay status").textContent).toBe("");
    expect(
      screen.queryByRole("button", { name: "Save confirmed proposal" }),
    ).toBeNull();
    expect(api.keys().filter((key) => key.startsWith("PUT"))).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});

test("shows a saved two-plane proposal only while both frames are unchanged", async () => {
  const api = server({
    ...pairRoutes,
    registration: () => json(currentPairAnswer()),
  });
  const view = render(<Harness />);
  const saved = await screen.findByRole("status", {
    name: "Saved overlay proposal",
  });
  expect(saved.textContent).toMatch(
    /two-plane proposal, revision 1, not a validated registration: frame 12 of plane a .* and frame 12 of plane b .* central rays 90° apart, one pose for both, turned 6.4° and moved the isocenter 8.8 mm .* that was not checked\. Its frames and vessel mask are installed and unchanged\./,
  );
  click("Show saved overlay");
  await waitFor(
    () =>
      expect(status("Overlay status").textContent).toMatch(
        /Showing the saved operator-confirmed two-plane proposal/,
      ),
    { timeout: 30000 },
  );
  expect(
    screen.getAllByRole("img").map((img) => img.getAttribute("aria-label")),
  ).toEqual([
    "Admitted frame 12, plane a, with projected 3D vessels",
    "Admitted frame 12, plane b, with projected 3D vessels",
  ]);
  expect(screen.getByRole("figure").textContent).toMatch(
    /saved operator-confirmed two-plane proposal/,
  );
  // The controls now show what the record was computed with: plane A is
  // open, with the record's geometry, no fit and the record's isocenter.
  const shownValue = (name: string | RegExp) =>
    (screen.getByRole("textbox", { name }) as HTMLInputElement).value;
  expect(screen.getByRole("combobox", { name: "Plane" })).toHaveProperty(
    "value",
    "a",
  );
  expect([
    shownValue(/Primary angle/),
    shownValue("Source to isocenter (mm)"),
    shownValue("Field width at the detector (mm)"),
  ]).toEqual(["0", "800", "180"]);
  expect(
    screen.getByRole("checkbox", { name: /Fit the field size/ }),
  ).toHaveProperty("checked", false);
  expect(
    screen.getByRole("checkbox", { name: "Fit one pose to both planes" }),
  ).toHaveProperty("checked", true);
  expect(status("Overlay isocenter").textContent).toBe(
    `Isocenter: ${pivot.map((x) => x.toFixed(1)).join(", ")} mm (RAS)`,
  );
  expect(status("Two-plane selection").textContent).toMatch(
    /The central rays are 90° apart\./,
  );
  expect(screen.queryByRole("alert")).toBeNull();
  // A redraw extracts no lines and offers nothing to save.
  expect(screen.getByRole("figure").textContent).not.toMatch(/Amber/);
  expect(
    screen.queryByRole("button", { name: "Save confirmed proposal" }),
  ).toBeNull();
  expect(api.keys().filter((key) => key.startsWith("PUT"))).toEqual([]);
  // Opening a frame drops the redraw, as any frame change does: the redraw
  // shows the record's frames, not the one opened.
  fireEvent.change(screen.getByRole("combobox", { name: "Frame" }), {
    target: { value: "12" },
  });
  await waitFor(() => expect(status("Overlay status").textContent).toBe(""));
  view.unmount();

  // Plane B's frame has other pixels under the same manifest revision.
  const other = pairGray[1].map((value) => 255 - value);
  const swapped = pairBundleAnswer();
  (swapped.manifest.planes as any)[1].frames[0].sha256 = hex(other);
  server({
    registration: () => json(currentPairAnswer()),
    bundle: () => json(swapped),
    frame: (url) =>
      url.includes("/planes/b/")
        ? bytes(other, { "X-Frame-Manifest-Revision": REVISION })
        : pairFrame(url),
  });
  render(<Harness />);
  await screen.findByRole("status", { name: "Saved overlay proposal" });
  click("Show saved overlay");
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /no longer available unchanged, so its overlay is not shown/,
  );
  expect(screen.queryByRole("img")).toBeNull();
}, 60000);

test("an isocenter and entered geometry are not carried to another source", async () => {
  server(pairRoutes);
  const props = { binding, volume, cursor: [1, 2, 3] as Vec3 };
  const view = render(
    <ProjectionOverlayStudio {...props} caseState={caseState} />,
  );
  await openPair();
  click("Set isocenter to crosshair");
  expect(status("Overlay isocenter").textContent).toMatch(
    /1\.0, 2\.0, 3\.0 mm/,
  );
  // A later revision of the same case and source keeps them. The bundle has
  // to be opened again, as before.
  const revised = { ...caseState, artifact_version: "8" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/projection-registration")
        ? json({ ...registrationAnswer(), artifact_version: "8" })
        : url.endsWith("/segmentations")
          ? json({ current: { vessel: maskEntry, aneurysm: null } })
          : url.includes("/planes/")
            ? pairFrame(url)
            : json(pairBundleAnswer()),
    ),
  );
  view.rerender(<ProjectionOverlayStudio {...props} caseState={revised} />);
  await screen.findByText(/No confirmed 2D-to-3D proposal is saved/);
  type("Frame bundle identifier", "phantom-run");
  click("Open admitted frames");
  await screen.findByRole("img", { name: "Admitted frame 12, plane a" });
  expect(status("Overlay isocenter").textContent).toMatch(
    /1\.0, 2\.0, 3\.0 mm/,
  );
  expect(
    screen.getByRole("textbox", { name: "Source to isocenter (mm)" }),
  ).toHaveProperty("value", "800");
  // Another source: the isocenter was a point in the first source's space,
  // and the geometry was entered for its frames.
  const other = {
    ...binding,
    image_sha256: "9".repeat(64),
  };
  const otherCase = { ...revised, image_sha256: other.image_sha256 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/projection-registration")
        ? json({
            ...registrationAnswer(),
            artifact_version: "8",
            image_sha256: other.image_sha256,
          })
        : url.endsWith("/segmentations")
          ? json({ current: { vessel: maskEntry, aneurysm: null } })
          : url.includes("/planes/")
            ? pairFrame(url)
            : json(pairBundleAnswer()),
    ),
  );
  view.rerender(
    <ProjectionOverlayStudio
      {...props}
      binding={other}
      caseState={otherCase}
    />,
  );
  await screen.findByText(/No confirmed 2D-to-3D proposal is saved/);
  type("Frame bundle identifier", "phantom-run");
  click("Open admitted frames");
  await screen.findByRole("img", { name: "Admitted frame 12, plane a" });
  expect(status("Overlay isocenter").textContent).toMatch(
    /centroid of the vessel mask/,
  );
  expect(
    screen.getByRole("textbox", { name: "Source to isocenter (mm)" }),
  ).toHaveProperty("value", "750");
  expect(
    screen.getByRole("checkbox", { name: "Fit one pose to both planes" }),
  ).toHaveProperty("checked", false);
});

test("one image admitted under both planes cannot be fitted as a pair", async () => {
  const same = pairBundleAnswer();
  (same.manifest.planes as any)[1].frames[0].sha256 = hex(pairGray[0]);
  server({
    bundle: () => json(same),
    frame: () => bytes(pairGray[0], { "X-Frame-Manifest-Revision": REVISION }),
  });
  render(<Harness />);
  await openPair();
  expect(
    screen.getAllByRole("alert").map((alert) => alert.textContent),
  ).toEqual([
    "Both planes name identical pixels. One image was admitted under both planes, so they cannot be fitted together.",
  ]);
  expect(
    screen.getByRole("button", { name: "Propose two-plane overlay" }),
  ).toHaveProperty("disabled", true);
});

test("with two planes the controls name the plane they edit", async () => {
  server(pairRoutes);
  render(<Harness />);
  await openPair();
  // Plane B is open.
  expect(
    screen.getByRole("group", { name: "Acquisition geometry, plane B" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("combobox", { name: "Vessels in plane B's frame are" }),
  ).toBeTruthy();
  const slider = screen.getByRole("slider", {
    name: "2D vessel sensitivity, plane B",
  });
  expect(slider.getAttribute("aria-valuetext")).toBe("0.50");
  choosePlane("a");
  await screen.findByRole("group", { name: "Acquisition geometry, plane A" });
  expect(
    screen.getByRole("combobox", { name: "Vessels in plane A's frame are" }),
  ).toBeTruthy();
});

test("redrawing a saved record replaces values typed for another proposal", async () => {
  // A fitted record: the field was entered 150 mm wide and fitted 1.2 times
  // wider. Plane B's record uses the admitted geometry.
  const inputs = savedPairInputs();
  inputs.planes[0] = {
    ...inputs.planes[0],
    fit_detector_scale: true,
    detector_scale: 1.2,
    polarity: "bright",
    sensitivity: 0.65,
    view: { ...VIEW, detector_width_mm: 180, detector_height_mm: 180 },
  };
  server({
    ...pairRoutes,
    registration: () => json(currentPairAnswer(inputs)),
  });
  render(<Harness />);
  await screen.findByRole("status", { name: "Saved overlay proposal" });
  type("Frame bundle identifier", "phantom-run");
  click("Open admitted frames");
  await screen.findByRole("img", { name: "Admitted frame 12, plane a" });
  // Values outside the C-arm bounds are typed for plane A, and pair mode
  // is on, so the studio reports them.
  type(/Primary angle/, "400");
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Fit one pose to both planes" }),
  );
  expect(
    screen.getAllByRole("alert").map((alert) => alert.textContent),
  ).toEqual([
    "Geometry values of one plane are outside the supported C-arm bounds.",
    "Geometry values are outside the supported C-arm bounds.",
  ]);
  click("Show saved overlay");
  await waitFor(
    () =>
      expect(status("Overlay status").textContent).toMatch(
        /Showing the saved operator-confirmed two-plane proposal/,
      ),
    { timeout: 30000 },
  );
  // No alert about typed values sits beside the saved overlay.
  expect(screen.queryByRole("alert")).toBeNull();
  const shownValue = (name: string | RegExp) =>
    (screen.getByRole("textbox", { name }) as HTMLInputElement).value;
  expect(shownValue(/Primary angle/)).toBe("0");
  // The entered width, not the fitted one.
  expect(shownValue("Field width at the detector (mm)")).toBe("150");
  expect(
    screen.getByRole("checkbox", { name: /Fit the field size/ }),
  ).toHaveProperty("checked", true);
  expect(
    screen.getByRole("combobox", { name: "Vessels in plane A's frame are" }),
  ).toHaveProperty("value", "bright");
  expect(screen.getByRole("slider")).toHaveProperty("value", "0.65");
});

test("a mask failure in the two-plane proposal is reported as the mask's", async () => {
  const jobs = vi.spyOn(overlayJobs, "createBiplaneOverlayJob");
  try {
    // Both frames verify. The mask no longer matches its digest.
    const flipped = maskBlob.slice();
    flipped[flipped.length - 9] ^= 1;
    server({ ...pairRoutes, mask: () => bytes(flipped) });
    const view = render(<Harness />);
    await openPair();
    await acceptsInput();
    click("Propose two-plane overlay");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Overlay computation failed: Segmentation integrity check failed.",
    );
    view.unmount();
    // A failure that carries no message is still the mask's, not a frame's.
    const read = vi
      .spyOn(segmentation, "loadSegmentationMask")
      .mockRejectedValue("offline");
    try {
      server(pairRoutes);
      render(<Harness />);
      await openPair();
      await acceptsInput();
      click("Propose two-plane overlay");
      expect((await screen.findByRole("alert")).textContent).toBe(
        "Overlay computation failed: The vessel mask could not be read.",
      );
      expect(read).toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
    expect(jobs).not.toHaveBeenCalled();
  } finally {
    jobs.mockRestore();
  }
});

test("a frame the two-plane proposal cannot fetch is reported as not loaded", async () => {
  const jobs = vi.spyOn(overlayJobs, "createBiplaneOverlayJob");
  try {
    let down = false;
    server({
      ...pairRoutes,
      frame: (url: string) =>
        down ? new Response("", { status: 503 }) : pairFrame(url),
    });
    render(<Harness />);
    await openPair();
    // Plane B is open and verified. Plane A is read again for the proposal
    // and the server no longer answers.
    down = true;
    await acceptsInput();
    click("Propose two-plane overlay");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Overlay computation failed: A frame could not be loaded and is not used.",
    );
    expect(jobs).not.toHaveBeenCalled();
  } finally {
    jobs.mockRestore();
  }
});

// The vessel-presence report of a saved proposal.

const presenceRoute = `/api/cases/${identity.case_id}/vessel-presence`;
const group = () =>
  screen.getByRole("group", { name: "Vessel presence report" });

test("offers a vessel presence report only on a saved current proposal", async () => {
  const api = server();
  const view = render(<Harness />);
  await screen.findByText(/No confirmed 2D-to-3D proposal is saved/);
  expect(
    screen.queryByRole("group", { name: "Vessel presence report" }),
  ).toBeNull();
  expect(api.keys()).not.toContain(`GET ${presenceRoute}`);
  view.unmount();

  const stale = server({
    registration: () =>
      json(registrationAnswer({ status: "stale", registration_id: "r-0" }, 2)),
  });
  render(<Harness />);
  await screen.findByText(/confirmed for an earlier revision of this case/);
  expect(
    screen.queryByRole("group", { name: "Vessel presence report" }),
  ).toBeNull();
  expect(stale.keys()).not.toContain(`GET ${presenceRoute}`);
});

test("computes and saves a vessel presence report on the saved proposal", async () => {
  let stored: any = null;
  const api = server({
    registration: () => json(currentAnswer()),
    presence: (method, body, at) => {
      if (method === "PUT") stored = presenceCurrent(body.inputs);
      return json(stored ?? presenceAnswer(at));
    },
  });
  const dirty = vi.fn();
  render(<Harness onDirty={dirty} />);
  await waitFor(() =>
    expect(status("Saved vessel presence report").textContent).toBe(
      "No vessel presence report is saved for this proposal.",
    ),
  );
  const other = screen.getByRole("button", { name: "Other workspace action" });
  await waitFor(() => expect(other).toHaveProperty("disabled", false));
  fireEvent.click(
    within(group()).getByRole("button", { name: "Compute vessel presence" }),
  );
  // While the report is computed the studio's own actions wait.
  await screen.findByRole("status", { name: "Vessel presence status" });
  expect(
    screen.getByRole("button", { name: "Show saved overlay" }),
  ).toHaveProperty("disabled", true);
  expect(
    screen
      .getByRole("button", { name: "Open admitted frames" })
      .closest("fieldset"),
  ).toBeDisabled();
  await waitFor(
    () =>
      expect(status("Vessel presence summary").textContent).toMatch(
        /^Unsaved report: \d+ unnamed segments/,
      ),
    { timeout: 30000 },
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Show saved overlay" }),
    ).toHaveProperty("disabled", false),
  );
  // The report is computed from the saved proposal's own frame and mask.
  expect(api.keys()).toEqual(
    expect.arrayContaining([
      "GET /api/projection-frames/phantom-run",
      "GET /api/projection-frames/phantom-run/planes/single/frames/12",
      `GET ${maskEntry.mask_url}`,
    ]),
  );
  // The whole tree is in the frame at the saved pose: nothing is missing.
  const table = within(
    screen.getByRole("table", { name: "Vessel presence in plane single" }),
  );
  expect(
    within(table.getByRole("row", { name: /^No 2D support/ }))
      .getAllByRole("cell")
      .map((cell) => cell.textContent),
  ).toEqual(["0", "0.0"]);
  // An unsaved report is not an unsaved draft of the case.
  expect(dirty).not.toHaveBeenCalledWith(true);
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I reviewed the classes/ }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Save confirmed report" }),
  );
  await waitFor(() =>
    expect(status("Saved vessel presence report").textContent).toMatch(
      /^Saved operator-confirmed report, revision 1, on proposal revision 1\./,
    ),
  );
  const put = api.calls.find((call) => call.key === `PUT ${presenceRoute}`)!;
  expect((put.body as any).inputs.registration_id).toBe("registration-1");
  expect((put.body as any).inputs.registration_revision).toBe(1);
  expect((put.body as any).inputs.registration_input_sha256).toBe(
    "f".repeat(64),
  );
  expect((put.body as any).inputs.planes[0].frame_sha256).toBe(hex(gray));
  await waitFor(() => expect(other).toHaveProperty("disabled", false));
}, 60000);

test("the workspace is locked while a report request is open", async () => {
  let release: (value: Response) => void = () => {};
  const held = new Promise<Response>((resolve) => (release = resolve));
  server({
    registration: () => json(currentAnswer()),
    presence: () => held as unknown as Response,
  });
  render(<Harness />);
  await screen.findByRole("status", { name: "Saved overlay proposal" });
  const other = screen.getByRole("button", { name: "Other workspace action" });
  await waitFor(() => expect(other).toHaveProperty("disabled", true));
  expect(
    screen.getByRole("button", { name: "Show saved overlay" }),
  ).toHaveProperty("disabled", true);
  await act(async () => {
    release(json(presenceAnswer(1)));
    await held;
  });
  await waitFor(() => expect(other).toHaveProperty("disabled", false));
  expect(
    screen.getByRole("button", { name: "Show saved overlay" }),
  ).toHaveProperty("disabled", false);
});

test("no report is computed while a proposal is unsaved, and a new proposal starts a new report", async () => {
  let registration = currentAnswer();
  let stored: any = null;
  const api = server({
    registration: () => json(registration),
    put: (body) => {
      registration = currentAnswer(
        body.inputs,
        { registration_id: "registration-7" },
        2,
      );
      return json(registration);
    },
    presence: (method, body, at) => {
      if (method === "PUT") stored = presenceCurrent(body.inputs);
      // The report saved for revision 1 is stale against revision 2.
      return json(
        stored && stored.registration_revision === at
          ? stored
          : stored
            ? presenceAnswer(at, { status: "stale", report_id: "report-1" }, 1)
            : presenceAnswer(at),
      );
    },
  });
  render(<Harness />);
  await waitFor(() =>
    expect(status("Saved vessel presence report").textContent).toMatch(
      /^No vessel presence report/,
    ),
  );
  const compute = () =>
    within(group()).getByRole("button", {
      name: /^(Compute|Recompute) vessel presence$/,
    }) as HTMLButtonElement;
  fireEvent.click(compute());
  await waitFor(
    () =>
      expect(status("Vessel presence summary").textContent).toMatch(
        /^Unsaved report/,
      ),
    { timeout: 30000 },
  );
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I reviewed the classes/ }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Save confirmed report" }),
  );
  await waitFor(() =>
    expect(status("Saved vessel presence report").textContent).toMatch(
      /revision 1, on proposal revision 1/,
    ),
  );
  // A new proposal on the same frame.
  type("Frame bundle identifier", "phantom-run");
  click("Open admitted frames");
  await screen.findByRole("img", { name: "Admitted frame 12, plane single" });
  enterGeometry();
  click("Propose overlay");
  await proposed();
  expect(compute().disabled).toBe(true);
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I reviewed the overlay/ }),
  );
  click("Save confirmed proposal");
  await screen.findByText(
    /Saved operator-confirmed proposal, revision 2, not a validated registration/,
  );
  // The report belonged to revision 1. It is read again and is stale.
  await waitFor(() =>
    expect(status("Saved vessel presence report").textContent).toBe(
      "A report was confirmed for an earlier proposal or an earlier revision of this case. It is not shown or reused.",
    ),
  );
  expect(
    screen.queryByRole("table", { name: "Vessel presence in plane single" }),
  ).toBeNull();
  expect(
    api.keys().filter((key) => key === `GET ${presenceRoute}`).length,
  ).toBeGreaterThanOrEqual(2);
  expect(compute().disabled).toBe(false);
}, 90000);

const chooseMethod = (value: string) =>
  fireEvent.change(screen.getByRole("combobox", { name: "Method" }), {
    target: { value },
  });

test("proposes by vessel evidence and saves a record with its own score and no sensitivity", async () => {
  let saved: any = null;
  const api = server({
    put: (body) => {
      saved = body;
      return json(currentAnswer(body.inputs));
    },
  });
  render(<Harness />);
  await openFrames();
  enterGeometry();
  // The line-set controls belong to the centerline distance method.
  expect(screen.getByRole("slider")).toBeTruthy();
  chooseMethod("vessel_evidence");
  expect(screen.queryByRole("slider")).toBeNull();
  expect(
    screen.queryByRole("checkbox", { name: /Show extracted 2D centerlines/ }),
  ).toBeNull();
  expect(screen.getByText(/with no threshold/).textContent).toMatch(
    /One plane fixes depth only weakly/,
  );
  click("Propose overlay");
  await proposed();
  const text = status("Overlay status").textContent!;
  expect(text).toMatch(/^Unsaved proposal by vessel evidence: /);
  expect(text).toMatch(
    /from the starting pose\. Its mean vessel evidence under the projected 3D vessel points is 0\.\d\d on a scale from 0 to 1/,
  );
  expect(text).toMatch(
    /a catheter or a bone edge included\. It is not a registration accuracy, and a wrong pose can score as well as a right one/,
  );
  // No distance is reported, and no fit was asked for.
  expect(text).not.toMatch(/ mm from the extracted|field size/);
  expect(screen.getByRole("img").getAttribute("aria-label")).toBe(
    "Admitted frame 12, plane single, with projected 3D vessels",
  );
  const save = screen.getByRole("button", { name: "Save confirmed proposal" });
  expect(save).toHaveProperty("disabled", true);
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I reviewed the overlay/ }),
  );
  click("Save confirmed proposal");
  await screen.findByText(
    /Saved operator-confirmed proposal by vessel evidence, revision 1, not a validated registration/,
  );
  expect(Object.keys(saved.inputs).sort()).toEqual(
    Object.keys(savedEvidenceInputs()).sort(),
  );
  expect(saved.inputs).toMatchObject({
    confirmed: true,
    plane: "single",
    frame_index: 12,
    frame_sha256: hex(gray),
    mask_sha256: maskEntry.mask_sha256,
    geometry_source: "operator_entered",
    view: VIEW,
    fit_detector_scale: false,
    detector_scale: 1,
    detector_fit: "not_requested",
    method: "vessel_evidence_compass_v1",
    polarity: "dark",
  });
  expect(Object.keys(saved.inputs.reported_score).sort()).toEqual([
    "in_field_fraction",
    "mean_evidence",
    "uncovered_fraction",
  ]);
  expect(saved.inputs.reported_score.mean_evidence).toBeGreaterThan(
    saved.inputs.reported_start_score.mean_evidence,
  );
  // The saved pose lays the mask on the frame within a millimeter.
  const size = { width: SIDE, height: SIDE },
    got = projectRegistered(
      saved.inputs.view,
      saved.inputs.isocenter,
      saved.inputs.volume_to_carm_ras,
      medial.points,
      size,
    ),
    want = projectRegistered(VIEW, pivot, truth, medial.points, size);
  let sum = 0;
  for (let k = 0; k < got.length; k += 2)
    sum += Math.hypot(got[k] - want[k], got[k + 1] - want[k + 1]);
  expect((sum / (got.length / 2)) * (((180 / SIDE) * 800) / 1200)).toBeLessThan(
    1,
  );
  expect(api.keys().filter((key) => key.startsWith("PUT"))).toHaveLength(1);
  // A record by vessel evidence has no line set for a presence report.
  expect(group().textContent).toMatch(
    /made by vessel evidence\. A vessel presence report reads the 2D centerlines of a centerline distance proposal, and is not available for this one/,
  );
  expect(
    within(group()).queryByRole("button", { name: /vessel presence/i }),
  ).toBeNull();
}, 90000);

test("a two-plane proposal by vessel evidence needs the same attestation", async () => {
  let saved: any = null;
  server({
    ...pairRoutes,
    put: (body) => {
      saved = body;
      return json(currentPairAnswer(body.inputs));
    },
  });
  render(<Harness />);
  await openPair();
  chooseMethod("vessel_evidence");
  expect(screen.getByText(/with no threshold/).textContent).toMatch(
    /Both frames must show the patient in the same position/,
  );
  await proposePair();
  const text = status("Overlay status").textContent!;
  expect(text).toMatch(
    /^Unsaved two-plane proposal by vessel evidence: .* central rays 90° apart\. Plane A: .* Plane B: /,
  );
  expect(text).toMatch(/It is not a registration accuracy/);
  expect(
    screen.getAllByRole("img").map((img) => img.getAttribute("aria-label")),
  ).toEqual([
    "Admitted frame 12, plane a, with projected 3D vessels",
    "Admitted frame 12, plane b, with projected 3D vessels",
  ]);
  const save = screen.getByRole("button", { name: "Save confirmed proposal" }),
    review = screen.getByRole("checkbox", { name: /I reviewed both overlays/ }),
    attest = screen.getByRole("checkbox", {
      name: /Both frames show the patient in the same position/,
    });
  fireEvent.click(review);
  expect(save).toHaveProperty("disabled", true);
  fireEvent.click(attest);
  click("Save confirmed proposal");
  await screen.findByText(
    /Saved operator-confirmed two-plane proposal by vessel evidence, revision 1, not a validated registration/,
  );
  expect(Object.keys(saved.inputs).sort()).toEqual(
    Object.keys(savedEvidencePairInputs()).sort(),
  );
  expect(saved.inputs).toMatchObject({
    same_position_attested: true,
    method: "vessel_evidence_compass_biplane_v1",
    detector_fit: "not_requested",
  });
  saved.inputs.planes.forEach((plane: any, k: number) => {
    expect(Object.keys(plane).sort()).toEqual(
      Object.keys(savedEvidencePairInputs().planes[k]).sort(),
    );
    expect(plane).toMatchObject({
      plane: "ab"[k],
      frame_sha256: hex(pairGray[k]),
      view: k ? VIEW_B : VIEW,
      detector_scale: 1,
    });
  });
  // The saved pose is right in three dimensions, not only in each image.
  const at = (matrix: number[][]) => applyRigid(matrix, pivot),
    found = at(saved.inputs.volume_to_carm_ras),
    want = at(pairTruth);
  expect(
    Math.hypot(found[0] - want[0], found[1] - want[1], found[2] - want[2]),
  ).toBeLessThan(1);
}, 90000);

test("redraws a saved vessel evidence record without searching, and says what became of a fit", async () => {
  const run = vi.spyOn(overlayJobs, "createOverlayJob");
  const api = server({
    registration: () =>
      json(
        currentAnswer(
          savedEvidenceInputs({
            fit_detector_scale: true,
            detector_fit: "dropped",
          }),
        ),
      ),
  });
  render(<Harness />);
  const saved = await screen.findByRole("status", {
    name: "Saved overlay proposal",
  });
  expect(saved.textContent).toMatch(
    /Saved operator-confirmed proposal by vessel evidence, revision 1, not a validated registration: .* installed and unchanged\. A fit of the field size was tried and not kept: it did not improve on the entered size\./,
  );
  click("Show saved overlay");
  await waitFor(
    () =>
      expect(status("Overlay status").textContent).toMatch(
        /Showing the saved operator-confirmed proposal/,
      ),
    { timeout: 30000 },
  );
  // The stored pose is drawn as stored: nothing is searched or rescored.
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0][0].search).toBeNull();
  // The controls show the method the record was made with.
  expect(screen.getByRole("combobox", { name: "Method" })).toHaveProperty(
    "value",
    "vessel_evidence",
  );
  expect(screen.queryByRole("slider")).toBeNull();
  expect(api.keys().filter((key) => key.startsWith("PUT"))).toEqual([]);
  run.mockRestore();
}, 60000);

test("a saved record says which plane's size a kept fit moved, or that none did", async () => {
  // A fit can be kept for the pose it found with every size where it was.
  const words = async (
    inputs: any,
    answer: (inputs: any) => unknown = currentAnswer,
  ) => {
    server({ ...pairRoutes, registration: () => json(answer(inputs)) });
    const view = render(<Harness />);
    const text = (
      await screen.findByRole("status", { name: "Saved overlay proposal" })
    ).textContent;
    view.unmount();
    return text;
  };
  expect(
    await words(
      savedEvidenceInputs({ fit_detector_scale: true, detector_fit: "kept" }),
    ),
  ).toMatch(
    /installed and unchanged\. A fit of the field size was kept, with the field at its entered size\.$/,
  );
  const pair = savedEvidencePairInputs({ detector_fit: "kept" });
  pair.planes = pair.planes.map((plane: any) => ({
    ...plane,
    geometry_source: "operator_entered",
    fit_detector_scale: true,
  }));
  expect(await words(pair, currentPairAnswer)).toMatch(
    /installed and unchanged\. A fit of the field size was kept, with both fields at their entered sizes\.$/,
  );
  pair.planes[0] = { ...pair.planes[0], detector_scale: 1.04 };
  pair.planes[1] = { ...pair.planes[1], detector_scale: 0.9 };
  expect(await words(pair, currentPairAnswer)).toMatch(
    /A fit of the field size was kept: plane a's field at 1\.04 times the entered width and plane b's field at 0\.90 times the entered width\.$/,
  );
  // A size that moved a little is not written as 1.00, and is not called
  // unmoved either: it gets the digits that show the move.
  expect(
    await words(
      savedEvidenceInputs({
        fit_detector_scale: true,
        detector_fit: "kept",
        detector_scale: 1.004,
      }),
    ),
  ).toMatch(
    /A fit of the field size was kept: the field at 1\.004 times the entered width\.$/,
  );
  pair.planes[0] = { ...pair.planes[0], detector_scale: 1 };
  pair.planes[1] = { ...pair.planes[1], detector_scale: 0.99996 };
  expect(await words(pair, currentPairAnswer)).toMatch(
    /A fit of the field size was kept: plane b's field at 0\.99996 times the entered width\.$/,
  );
});

test("a saved two-plane vessel evidence record is redrawn on both frames", async () => {
  server({
    ...pairRoutes,
    registration: () => json(currentPairAnswer(savedEvidencePairInputs())),
  });
  render(<Harness />);
  const saved = await screen.findByRole("status", {
    name: "Saved overlay proposal",
  });
  expect(saved.textContent).toMatch(
    /Saved operator-confirmed two-plane proposal by vessel evidence, revision 1/,
  );
  click("Show saved overlay");
  await waitFor(
    () =>
      expect(
        screen.getAllByRole("img").map((img) => img.getAttribute("aria-label")),
      ).toEqual([
        "Admitted frame 12, plane a, with projected 3D vessels",
        "Admitted frame 12, plane b, with projected 3D vessels",
      ]),
    { timeout: 30000 },
  );
  expect(screen.getByRole("combobox", { name: "Method" })).toHaveProperty(
    "value",
    "vessel_evidence",
  );
}, 60000);

test("a saved centerline distance record sets the method back", async () => {
  server({ registration: () => json(currentAnswer()) });
  render(<Harness />);
  await screen.findByRole("status", { name: "Saved overlay proposal" });
  // The studio takes input once the saved report has been read.
  await waitFor(() =>
    expect(status("Saved vessel presence report").textContent).toMatch(
      /^No vessel presence report/,
    ),
  );
  type("Frame bundle identifier", "phantom-run");
  click("Open admitted frames");
  await screen.findByRole(
    "img",
    { name: "Admitted frame 12, plane single" },
    { timeout: 10000 },
  );
  chooseMethod("vessel_evidence");
  expect(screen.queryByRole("slider")).toBeNull();
  click("Show saved overlay");
  await waitFor(
    () =>
      expect(status("Overlay status").textContent).toMatch(
        /Showing the saved operator-confirmed proposal/,
      ),
    { timeout: 30000 },
  );
  expect(screen.getByRole("combobox", { name: "Method" })).toHaveProperty(
    "value",
    "centerline_distance",
  );
  expect(screen.getByRole("slider")).toBeTruthy();
  expect(status("Saved overlay proposal").textContent).not.toMatch(
    /vessel evidence|field size/,
  );
}, 60000);

test("changing the method drops a one-plane proposal made by the other one", async () => {
  const api = server();
  render(<Harness />);
  await openFrames();
  enterGeometry();
  click("Propose overlay");
  await proposed();
  expect(status("Overlay status").textContent).not.toMatch(/vessel evidence/);
  chooseMethod("vessel_evidence");
  expect(status("Overlay status").textContent).toBe("");
  expect(
    screen.queryByRole("button", { name: "Save confirmed proposal" }),
  ).toBeNull();
  // Going back does not bring it back, and the same holds the other way.
  chooseMethod("centerline_distance");
  expect(status("Overlay status").textContent).toBe("");
  chooseMethod("vessel_evidence");
  click("Propose overlay");
  await proposed();
  expect(status("Overlay status").textContent).toMatch(/by vessel evidence/);
  chooseMethod("centerline_distance");
  expect(status("Overlay status").textContent).toBe("");
  expect(
    screen.queryByRole("button", { name: "Save confirmed proposal" }),
  ).toBeNull();
  expect(api.keys().filter((key) => key.startsWith("PUT"))).toEqual([]);
}, 90000);

test("changing the method drops a proposal made by the other one", async () => {
  const api = server({ ...pairRoutes });
  render(<Harness />);
  await openPair();
  await proposePair();
  expect(status("Overlay status").textContent).not.toMatch(/vessel evidence/);
  chooseMethod("vessel_evidence");
  expect(status("Overlay status").textContent).toBe("");
  expect(
    screen.queryByRole("button", { name: "Save confirmed proposal" }),
  ).toBeNull();
  // Going back does not bring the old proposal back, in either direction.
  chooseMethod("centerline_distance");
  expect(status("Overlay status").textContent).toBe("");
  chooseMethod("vessel_evidence");
  await proposePair();
  expect(status("Overlay status").textContent).toMatch(/by vessel evidence/);
  chooseMethod("centerline_distance");
  expect(status("Overlay status").textContent).toBe("");
  expect(api.keys().filter((key) => key.startsWith("PUT"))).toEqual([]);
}, 90000);

test("saves a kept fit of the field size as the size the search found", async () => {
  let saved: any = null;
  server({
    put: (body) => {
      saved = body;
      return json(currentAnswer(body.inputs));
    },
  });
  render(<Harness />);
  await openFrames();
  // The frame was rendered at 180 mm. The fit stays on.
  type("Source to isocenter (mm)", "800");
  type("Field width at the detector (mm)", "205");
  chooseMethod("vessel_evidence");
  click("Propose overlay");
  await proposed();
  expect(status("Overlay status").textContent).toMatch(
    /0 to 1 \(starting pose 0\.\d\d\), \d+% of points inside the frame, \d+% of the strong line-like structure in the frame with no projected point near it, field size fitted at 0\.(8[5-9]|9[0-3]) times the entered width\. A fit of the field size was kept\. Vessel evidence is high/,
  );
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I reviewed the overlay/ }),
  );
  click("Save confirmed proposal");
  await screen.findByText(
    /Saved operator-confirmed proposal by vessel evidence, revision 1, .* installed and unchanged\. A fit of the field size was kept: the field at 0\.(8[5-9]|9[0-3]) times the entered width\.$/,
  );
  const { inputs } = saved;
  expect(inputs).toMatchObject({
    fit_detector_scale: true,
    detector_fit: "kept",
    geometry_source: "operator_entered",
  });
  // The record holds the fitted size, and the scale that leads back to the
  // entered one.
  expect(inputs.detector_scale).toBeGreaterThan(0.85);
  expect(inputs.detector_scale).toBeLessThan(0.93);
  expect(inputs.view.detector_width_mm).toBeCloseTo(
    205 * inputs.detector_scale,
    6,
  );
  expect(Math.abs(inputs.view.detector_width_mm - 180)).toBeLessThan(5);
  expect(inputs.view.detector_height_mm).toBeCloseTo(
    inputs.view.detector_width_mm,
    6,
  );
}, 90000);

test("a two-plane fit is recorded plane by plane", async () => {
  let saved: any = null;
  server({
    ...pairRoutes,
    put: (body) => {
      saved = body;
      return json(currentPairAnswer(body.inputs));
    },
  });
  render(<Harness />);
  await screen.findByText(/No confirmed 2D-to-3D proposal is saved/);
  type("Frame bundle identifier", "phantom-run");
  click("Open admitted frames");
  await screen.findByRole("img", { name: "Admitted frame 12, plane a" });
  // Plane A at its true size with no fit. Plane B entered too wide, fitted.
  enterGeometry();
  choosePlane("b");
  await screen.findByRole("img", { name: "Admitted frame 12, plane b" });
  type("Source to isocenter (mm)", "800");
  type("Field width at the detector (mm)", "205");
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Fit one pose to both planes" }),
  );
  chooseMethod("vessel_evidence");
  await proposePair();
  // Only the fitted plane names a fitted size.
  expect(status("Overlay status").textContent).toMatch(
    /Plane A: [^:]* no projected point near it\. Plane B: [^:]* no projected point near it, field size fitted at 0\.(8[5-9]|9[0-3]) times the entered width\. A fit of the field size was kept\. Vessel evidence is high/,
  );
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I reviewed both overlays/ }),
  );
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: /Both frames show the patient in the same position/,
    }),
  );
  click("Save confirmed proposal");
  await screen.findByText(
    /Saved operator-confirmed two-plane proposal by vessel evidence, revision 1, .* A fit of the field size was kept: plane b's field at 0\.(8[5-9]|9[0-3]) times the entered width\.$/,
  );
  const [a, b] = saved.inputs.planes;
  expect(saved.inputs.detector_fit).toBe("kept");
  // Each plane's result and starting scores, in that order.
  for (const plane of [a, b])
    expect(plane.reported_score.mean_evidence).toBeGreaterThan(
      plane.reported_start_score.mean_evidence + 0.2,
    );
  expect(a).toMatchObject({
    fit_detector_scale: false,
    detector_scale: 1,
    view: VIEW,
  });
  expect(b.fit_detector_scale).toBe(true);
  expect(b.detector_scale).toBeGreaterThan(0.85);
  expect(b.detector_scale).toBeLessThan(0.93);
  expect(b.view.detector_width_mm).toBeCloseTo(205 * b.detector_scale, 6);
  expect(b.view).toMatchObject({
    primary_deg: VIEW_B.primary_deg,
    secondary_deg: VIEW_B.secondary_deg,
    source_isocenter_mm: 800,
  });
}, 90000);

const PROPOSED = [
  { primary_deg: -35.2, secondary_deg: 12.4, turn_deg: 8.1, share: 0.41 },
  { primary_deg: 4.6, secondary_deg: -3.3, turn_deg: -2.2, share: 0.17 },
];
const radio = (name: string | RegExp) => screen.getByRole("radio", { name });
const startView = (k: number) => ({
  primary_deg: PROPOSED[k].primary_deg,
  secondary_deg: PROPOSED[k].secondary_deg,
  turn_deg: PROPOSED[k].turn_deg,
});
const unsavedProposal = () =>
  waitFor(
    () =>
      expect(status("Overlay status").textContent).toMatch(/^Unsaved proposal/),
    { timeout: 30000 },
  );

test("proposes views only when asked, starts the search from a picked one and does not save it", async () => {
  const api = server();
  const views = vi
      .spyOn(viewProposals, "proposeFrameViews")
      .mockResolvedValue(PROPOSED),
    create = vi.spyOn(overlayJobs, "createOverlayJob");
  try {
    render(<Harness />);
    await openFrames();
    enterGeometry();
    // Nothing is proposed, and nothing is picked, until the operator asks.
    expect(views).not.toHaveBeenCalled();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(
      screen.getByText(/research network trained on synthetic frames/)
        .textContent,
    ).toMatch(
      /not for clinical use.*its first view is often not the nearest.*can be reviewed but not saved/,
    );
    await proposeViews();
    await screen.findByRole("radio", { name: /Proposed view 1/ });
    expect(views).toHaveBeenCalledTimes(1);
    expect(views.mock.calls[0][0]).toMatchObject({
      sha256: hex(gray),
      width: SIDE,
      height: SIDE,
    });
    expect(views.mock.calls[0][1]).toBe("dark");
    expect(radio("The volume's own position")).toHaveProperty("checked", true);
    expect(radio(/Proposed view 1/).parentElement!.textContent).toMatch(
      /Proposed view 1: primary -35°, secondary 12°, turned 8° in the image \(share 41%\)/,
    );
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.queryByRole("status", { name: "Search start" })).toBeNull();

    fireEvent.click(radio(/Proposed view 2/));
    expect(
      screen.getAllByRole("radio").map((item) => (item as any).checked),
    ).toEqual([false, false, true]);
    expect(status("Search start").textContent).toBe(
      "The search will start from proposed view 2: primary 5°, secondary -3°, turned -2° in the image.",
    );
    click("Propose overlay");
    await unsavedProposal();
    expect(create.mock.calls.at(-1)![0].start_view).toEqual(startView(1));
    expect(status("Start of this proposal").textContent).toMatch(
      /^This proposal started from proposed view 2: primary 5°, secondary -3°, turned -2° in the image\. The 3D model was turned under the entered geometry before the search\. A proposal started this way cannot be saved/,
    );
    // It can be reviewed and discarded, and that is all.
    expect(
      screen.queryByRole("button", { name: "Save confirmed proposal" }),
    ).toBeNull();
    expect(
      screen.queryByRole("checkbox", { name: /I reviewed the overlay/ }),
    ).toBeNull();
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe(
      "Admitted frame 12, plane single, with projected 3D vessels",
    );
    expect(api.keys().filter((key) => key.startsWith("PUT"))).toEqual([]);

    // Going back to the volume's own position drops that proposal, and the
    // next one is an ordinary proposal that can be saved.
    fireEvent.click(radio("The volume's own position"));
    expect(status("Overlay status").textContent).toBe("");
    expect(screen.queryByRole("status", { name: "Search start" })).toBeNull();
    click("Propose overlay");
    await proposed();
    expect(create.mock.calls.at(-1)![0].start_view).toBeNull();
    expect(
      screen.queryByRole("status", { name: "Start of this proposal" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Save confirmed proposal" }),
    ).toBeTruthy();
  } finally {
    views.mockRestore();
    create.mockRestore();
  }
}, 60000);

test("a picked view is for the frame and polarity it was proposed for", async () => {
  server();
  const views = vi
      .spyOn(viewProposals, "proposeFrameViews")
      .mockResolvedValue(PROPOSED),
    create = vi.spyOn(overlayJobs, "createOverlayJob");
  try {
    render(<Harness />);
    await openFrames();
    enterGeometry();
    await proposeViews();
    fireEvent.click(
      await screen.findByRole("radio", { name: /Proposed view 1/ }),
    );
    expect(status("Search start").textContent).toMatch(/proposed view 1/);
    // Read as bright vessels, the frame is another input to the network:
    // the views are gone and so is the pick.
    fireEvent.change(
      screen.getByRole("combobox", { name: /Vessels in this frame are/ }),
      { target: { value: "bright" } },
    );
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("status", { name: "Search start" })).toBeNull();
    // Views proposed at that polarity can be picked in their turn, and that
    // pick is no start for the frame read as dark vessels.
    await proposeViews();
    fireEvent.click(
      await screen.findByRole("radio", { name: /Proposed view 2/ }),
    );
    expect(views.mock.calls.at(-1)![1]).toBe("bright");
    expect(status("Search start").textContent).toMatch(/proposed view 2/);
    fireEvent.change(
      screen.getByRole("combobox", { name: /Vessels in this frame are/ }),
      { target: { value: "dark" } },
    );
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("status", { name: "Search start" })).toBeNull();
    click("Propose overlay");
    await waitFor(() => expect(create).toHaveBeenCalled(), { timeout: 30000 });
    expect(create.mock.calls.at(-1)![0].start_view).toBeNull();
  } finally {
    views.mockRestore();
    create.mockRestore();
  }
}, 60000);

test("says so when no views can be proposed, and the search is as it was", async () => {
  server();
  const views = vi
    .spyOn(viewProposals, "proposeFrameViews")
    .mockRejectedValue(new Error("The view network is not installed"));
  try {
    render(<Harness />);
    await openFrames();
    enterGeometry();
    await proposeViews();
    expect((await screen.findByRole("alert")).textContent).toBe(
      "No views were proposed: The view network is not installed.",
    );
    expect(screen.queryByRole("radio")).toBeNull();
    click("Propose overlay");
    await proposed();
    expect(
      screen.getByRole("button", { name: "Save confirmed proposal" }),
    ).toBeTruthy();
    // The message is about the frame as it was read then.
    fireEvent.change(
      screen.getByRole("combobox", { name: /Vessels in this frame are/ }),
      { target: { value: "bright" } },
    );
    expect(screen.queryByRole("alert")).toBeNull();
  } finally {
    views.mockRestore();
  }
}, 60000);

/** The pair, with a second frame of other pixels admitted on plane B. */
function pairWithALaterFrame() {
  const later = pairGray[1].map((value) => 255 - value);
  const bundle = pairBundleAnswer();
  (bundle.manifest.planes as any)[1].frames[1].sha256 = hex(later);
  return {
    bundle: () => json(bundle),
    frame: (url: string) =>
      url.endsWith("/planes/b/frames/30")
        ? bytes(later, { "X-Frame-Manifest-Revision": REVISION })
        : pairFrame(url),
  };
}
const chooseFrame = async (index: number, plane: string) => {
  fireEvent.change(screen.getByRole("combobox", { name: "Frame" }), {
    target: { value: String(index) },
  });
  await screen.findByRole("img", {
    name: `Admitted frame ${index}, plane ${plane}`,
  });
};

test("a picked view is no start for another frame of its plane", async () => {
  server(pairWithALaterFrame());
  const views = vi
    .spyOn(viewProposals, "proposeFrameViews")
    .mockResolvedValue(PROPOSED);
  try {
    render(<Harness />);
    await screen.findByText(/No confirmed 2D-to-3D proposal is saved/);
    type("Frame bundle identifier", "phantom-run");
    click("Open admitted frames");
    await screen.findByRole("img", { name: "Admitted frame 12, plane a" });
    choosePlane("b");
    await screen.findByRole("img", { name: "Admitted frame 12, plane b" });
    await proposeViews();
    fireEvent.click(
      await screen.findByRole("radio", { name: /Proposed view 1/ }),
    );
    expect(status("Search start").textContent).toMatch(
      /^The search will start from proposed view 1: /,
    );
    await chooseFrame(30, "b");
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("status", { name: "Search start" })).toBeNull();
  } finally {
    views.mockRestore();
  }
}, 60000);

test("a view picked for one plane's frame stands when both planes are then fitted", async () => {
  server(pairRoutes);
  const views = vi
    .spyOn(viewProposals, "proposeFrameViews")
    .mockResolvedValue(PROPOSED);
  try {
    render(<Harness />);
    await screen.findByText(/No confirmed 2D-to-3D proposal is saved/);
    type("Frame bundle identifier", "phantom-run");
    click("Open admitted frames");
    await screen.findByRole("img", { name: "Admitted frame 12, plane a" });
    // One plane at a time: the frames of a two-plane bundle are still
    // plane A's and plane B's, and the pick is made for plane A's.
    await proposeViews();
    fireEvent.click(
      await screen.findByRole("radio", { name: /^Proposed view 1: / }),
    );
    expect(views.mock.calls[0][0]).toMatchObject({ plane: "a" });
    expect(status("Search start").textContent).toBe(
      "The search will start from proposed view 1: primary -35°, secondary 12°, turned 8° in the image.",
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Fit one pose to both planes" }),
    );
    expect(status("Search start").textContent).toBe(
      "The search will start from proposed view 1 for plane A's frame: primary -35°, secondary 12°, turned 8° in the image.",
    );
    expect((radio(/^Proposed view 1: /) as HTMLInputElement).checked).toBe(
      true,
    );
  } finally {
    views.mockRestore();
  }
}, 60000);

test("a picked view stands when its frame is opened again", async () => {
  server(pairRoutes);
  const views = vi
    .spyOn(viewProposals, "proposeFrameViews")
    .mockResolvedValue(PROPOSED);
  try {
    render(<Harness />);
    await openPair();
    choosePlane("a");
    await screen.findByRole("img", { name: "Admitted frame 12, plane a" });
    await proposeViews();
    fireEvent.click(
      await screen.findByRole("radio", { name: /^Proposed view 1: / }),
    );
    expect(status("Search start").textContent).toBe(
      "The search will start from proposed view 1 for plane A's frame: primary -35°, secondary 12°, turned 8° in the image.",
    );
    // A frame is known by its bytes. Opened again, it is the frame the view
    // was picked for, and the status line says the pick is in force. Opening
    // puts the studio back to one plane, which is all the wording loses.
    type("Frame bundle identifier", "phantom-run");
    click("Open admitted frames");
    await screen.findByRole("img", { name: "Admitted frame 12, plane a" });
    expect(status("Search start").textContent).toBe(
      "The search will start from proposed view 1: primary -35°, secondary 12°, turned 8° in the image.",
    );
  } finally {
    views.mockRestore();
  }
}, 60000);

test("the weights are fetched under the deadline of the studio's other requests", () => {
  expect(viewProposals.VIEW_NETWORK_TIMEOUT_MS).toBe(
    OVERLAY_REQUEST_TIMEOUT_MS,
  );
  expect(OVERLAY_REQUEST_TIMEOUT_MS).toBe(30_000);
});

test("a picked view is not carried to another source", async () => {
  server(pairRoutes);
  const views = vi
    .spyOn(viewProposals, "proposeFrameViews")
    .mockResolvedValue(PROPOSED);
  const props = { binding, volume, cursor: null };
  const reopen = async () => {
    type("Frame bundle identifier", "phantom-run");
    click("Open admitted frames");
    await screen.findByRole("img", { name: "Admitted frame 12, plane a" });
  };
  const routes = (image_sha256: string) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/projection-registration")
          ? json({ ...registrationAnswer(), image_sha256 })
          : url.endsWith("/segmentations")
            ? json({ current: { vessel: maskEntry, aneurysm: null } })
            : url.includes("/planes/")
              ? pairFrame(url)
              : json(pairBundleAnswer()),
      ),
    );
  try {
    const view = render(
      <ProjectionOverlayStudio {...props} caseState={caseState} />,
    );
    await openPair();
    choosePlane("a");
    await screen.findByRole("img", { name: "Admitted frame 12, plane a" });
    await proposeViews();
    fireEvent.click(
      await screen.findByRole("radio", { name: /^Proposed view 1: / }),
    );
    expect(status("Search start").textContent).toMatch(/proposed view 1/);
    // The same frames admitted under another source: the pick was made for
    // the first one and is no start here.
    const other = { ...binding, image_sha256: "9".repeat(64) };
    routes(other.image_sha256);
    view.rerender(
      <ProjectionOverlayStudio
        {...props}
        binding={other}
        caseState={{ ...caseState, image_sha256: other.image_sha256 }}
      />,
    );
    await screen.findByText(/No confirmed 2D-to-3D proposal is saved/);
    await reopen();
    expect(screen.queryByRole("status", { name: "Search start" })).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
  } finally {
    views.mockRestore();
  }
}, 60000);

test("for two planes a picked view is for its frame and polarity, and a proposal belongs to its start", async () => {
  server(pairWithALaterFrame());
  const views = vi
      .spyOn(viewProposals, "proposeFrameViews")
      .mockResolvedValue(PROPOSED),
    create = vi.spyOn(overlayJobs, "createBiplaneOverlayJob");
  const polarityOfB = (value: string) =>
    fireEvent.change(
      screen.getByRole("combobox", { name: /Vessels in plane B's frame are/ }),
      { target: { value } },
    );
  try {
    render(<Harness />);
    await openPair();
    chooseMethod("vessel_evidence");
    await proposeViews();
    fireEvent.click(
      await screen.findByRole("radio", { name: /Proposed view 1/ }),
    );
    expect(status("Search start").textContent).toMatch(/for plane B's frame/);
    // Plane B read as bright vessels is not the frame the view was for.
    polarityOfB("bright");
    expect(screen.queryByRole("status", { name: "Search start" })).toBeNull();
    polarityOfB("dark");
    expect(status("Search start").textContent).toMatch(/for plane B's frame/);
    // Nor is another frame of plane B.
    await chooseFrame(30, "b");
    expect(screen.queryByRole("status", { name: "Search start" })).toBeNull();
    await chooseFrame(12, "b");
    expect(status("Search start").textContent).toMatch(/for plane B's frame/);

    await proposePair();
    expect(create.mock.calls.at(-1)![0].start_view).toEqual({
      plane: 1,
      view: startView(0),
    });
    expect(status("Start of this proposal").textContent).toMatch(
      /proposed view 1 for plane B's frame/,
    );
    // Another start is another proposal: this one is dropped.
    fireEvent.click(radio("The volume's own position"));
    expect(status("Overlay status").textContent).toBe("");
    expect(
      screen.queryByRole("status", { name: "Start of this proposal" }),
    ).toBeNull();
  } finally {
    views.mockRestore();
    create.mockRestore();
  }
}, 90000);

test("for two planes one picked view turns the model for both, and the proposal is not saved", async () => {
  const api = server(pairRoutes);
  const views = vi
      .spyOn(viewProposals, "proposeFrameViews")
      .mockResolvedValue(PROPOSED),
    create = vi.spyOn(overlayJobs, "createBiplaneOverlayJob");
  try {
    render(<Harness />);
    await openPair();
    chooseMethod("vessel_evidence");
    await acceptsInput();
    // Plane B's frame is on screen: the views are proposed for it.
    await proposeViews();
    fireEvent.click(
      await screen.findByRole("radio", { name: /Proposed view 1/ }),
    );
    expect(views.mock.calls[0][0]).toMatchObject({ plane: "b" });
    expect(status("Search start").textContent).toBe(
      "The search will start from proposed view 1 for plane B's frame: primary -35°, secondary 12°, turned 8° in the image.",
    );
    // The pick stays the start while plane A's frame is on screen.
    choosePlane("a");
    await screen.findByRole("img", { name: "Admitted frame 12, plane a" });
    expect(status("Search start").textContent).toMatch(/for plane B's frame/);
    expect(screen.queryByRole("radio")).toBeNull();
    // With views proposed for plane A's frame too, the list shows the start
    // in force, which is still plane B's, and not the volume's own position.
    await acceptsInput();
    await proposeViews();
    await screen.findByRole("radio", { name: /^Proposed view 1: / });
    expect(
      screen
        .getAllByRole("radio")
        .map((item) => (item as HTMLInputElement).checked),
    ).toEqual([false, true, false, false]);
    expect(
      (
        radio(
          "Proposed view 1 for plane B's frame: primary -35°, secondary 12°, turned 8° in the image",
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(status("Search start").textContent).toMatch(/for plane B's frame/);
    await proposePair();
    expect(create.mock.calls.at(-1)![0].start_view).toEqual({
      plane: 1,
      view: startView(0),
    });
    expect(status("Start of this proposal").textContent).toMatch(
      /^This proposal started from proposed view 1 for plane B's frame: /,
    );
    expect(
      screen.queryByRole("button", { name: "Save confirmed proposal" }),
    ).toBeNull();
    expect(api.keys().filter((key) => key.startsWith("PUT"))).toEqual([]);
  } finally {
    views.mockRestore();
    create.mockRestore();
  }
}, 60000);
