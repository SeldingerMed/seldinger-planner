import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { renderFrame, TREE } from "./__fixtures__/angioPhantom";
import {
  binding,
  bundleAnswer,
  currentAnswer,
  currentPairAnswer,
  hex,
  identity,
  maskBlob,
  maskEntry,
  pairBundleAnswer,
  pairGray,
  pairTruth,
  phantom,
  pivot,
  presenceAnswer,
  presenceCurrent,
  registrationAnswer,
  REVISION,
  savedInputs,
  savedPairInputs,
  SIDE,
  truth,
  VIEW,
  VIEW_B,
} from "./__fixtures__/overlayCase";
import * as frameModule from "./projectionFrames";
import { parseSavedRegistration } from "./projectionFrames";
import { reportInputs, type PresenceReportInputs } from "./presenceReport";
import type { SegmentationEntry } from "./segmentation";
import { vesselTarget } from "./vesselness2d";
import { vesselPresence } from "./vesselPresence";
import * as jobs from "./vesselPresenceJob";
import VesselPresencePanel, {
  PRESENCE_REQUEST_TIMEOUT_MS,
} from "./VesselPresencePanel";
import { vesselSegments } from "./vesselSegments";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const FRAME = { width: SIDE, height: SIDE };
const grid = { shape: phantom.shape, affine: phantom.affine };
const segments = vesselSegments(phantom.mask, phantom.shape, phantom.affine);
/** The frontal frame with one branch of the tree left out of it. */
const missing = renderFrame(VIEW, pivot, truth, {
  ...FRAME,
  polarity: "dark",
  noise: 12,
  seed: 7,
  tree: [TREE[0], TREE[1], TREE[3]],
});
const single = parseSavedRegistration(
  currentAnswer(savedInputs({ frame_sha256: hex(missing) })),
  identity,
);
/** The lateral frame of the pair with the same branch left out, and with
 * vessels brighter than the background. */
const lateralMissing = renderFrame(VIEW_B, pivot, pairTruth, {
  ...FRAME,
  polarity: "bright",
  noise: 12,
  seed: 12,
  tree: [TREE[0], TREE[1], TREE[3]],
});
const pairInputs = savedPairInputs();
pairInputs.planes[1] = {
  ...pairInputs.planes[1],
  frame_sha256: hex(lateralMissing),
  polarity: "bright",
  sensitivity: 0.8,
};
const pair = parseSavedRegistration(currentPairAnswer(pairInputs), identity);

/** The report computed directly, not through the panel or its job. */
function direct(
  registration: typeof single,
  planes: {
    gray: Uint8Array;
    view: typeof VIEW;
    polarity?: "dark" | "bright";
    sensitivity?: number;
  }[],
  matrix: number[][],
): PresenceReportInputs {
  return reportInputs(
    registration,
    segments,
    vesselPresence({
      segments,
      isocenter: pivot,
      matrix,
      planes: planes.map((plane) => ({
        view: plane.view,
        frame: FRAME,
        target: vesselTarget(
          plane.gray,
          SIDE,
          SIDE,
          plane.polarity ?? "dark",
          plane.sensitivity ?? 0.5,
        ),
      })),
    }),
  );
}
const expectedSingle = direct(single, [{ gray: missing, view: VIEW }], truth);
const expectedPair = direct(
  pair,
  [
    { gray: pairGray[0], view: VIEW },
    {
      gray: lateralMissing,
      view: VIEW_B,
      polarity: "bright",
      sensitivity: 0.8,
    },
  ],
  pairTruth,
);

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
  get?: () => Response | Promise<Response>;
  put?: (body: any) => Response | Promise<Response>;
  bundle?: () => Response;
  frame?: (url: string) => Response;
  mask?: () => Response;
};
function server(routes: Routes = {}) {
  const calls: { key: string; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET",
        body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ key: `${method} ${url}`, body });
      if (url === `/api/cases/${identity.case_id}/vessel-presence`) {
        const answer = await (method === "PUT"
          ? (routes.put ?? (() => json({}, 500)))(body)
          : (routes.get ?? (() => json(presenceAnswer(1))))());
        if (init?.signal?.aborted)
          throw new DOMException("Aborted", "AbortError");
        return answer;
      }
      if (url === maskEntry.mask_url)
        return (routes.mask ?? (() => bytes(maskBlob)))();
      if (url === "/api/projection-frames/phantom-run")
        return (
          routes.bundle ??
          (() =>
            json(
              bundleAnswer({
                planes: [
                  {
                    ...bundleAnswer().manifest.planes[0],
                    frames: [
                      {
                        index: 12,
                        sha256: hex(missing),
                        input_sha256: "c".repeat(64),
                      },
                    ],
                  },
                ],
              }),
            ))
        )();
      if (url.startsWith("/api/projection-frames/phantom-run/planes/"))
        return (
          routes.frame ??
          (() => bytes(missing, { "X-Frame-Manifest-Revision": REVISION }))
        )(url);
      return json({}, 404);
    }),
  );
  return {
    calls,
    keys: () => calls.map((call) => call.key),
    puts: () => calls.filter((call) => call.key.startsWith("PUT")),
  };
}
const pairRoutes: Routes = {
  bundle: () =>
    json(
      pairBundleAnswer({
        planes: pairBundleAnswer().manifest.planes.map(
          (plane: any, k: number) => ({
            ...plane,
            frames: [
              {
                index: 12,
                sha256: hex(k ? lateralMissing : pairGray[0]),
                input_sha256: "c".repeat(64),
              },
            ],
          }),
        ),
      }),
    ),
  frame: (url) =>
    bytes(url.includes("/planes/b/") ? lateralMissing : pairGray[0], {
      "X-Frame-Manifest-Revision": REVISION,
    }),
};

function Panel({
  registration = single,
  mask = maskEntry as unknown as SegmentationEntry | null,
  disabled = false,
  withGrid = true,
  onRequests,
  onComputing,
}: {
  registration?: typeof single;
  mask?: SegmentationEntry | null;
  disabled?: boolean;
  withGrid?: boolean;
  onRequests?: (open: boolean) => void;
  onComputing?: (computing: boolean) => void;
}) {
  return (
    <VesselPresencePanel
      identity={identity}
      binding={binding}
      registration={registration}
      mask={mask}
      grid={withGrid ? grid : null}
      disabled={disabled}
      onRequests={onRequests}
      onComputing={onComputing}
    />
  );
}
const status = (name: string) => screen.getByRole("status", { name });
const saved = () => status("Saved vessel presence report").textContent!;
const button = (name: string | RegExp) =>
  screen.getByRole("button", { name }) as HTMLButtonElement;
const computedReport = () =>
  waitFor(
    () =>
      expect(status("Vessel presence summary").textContent).toMatch(
        /^Unsaved report/,
      ),
    { timeout: 30000 },
  );
const rows = (name: string) =>
  within(screen.getByRole("table", { name }))
    .getAllByRole("row")
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    );
function tableOf(inputs: PresenceReportInputs, plane: number) {
  const names = [
    "supported",
    "no_2d_support",
    "outside_field",
    "indeterminate",
  ];
  const mine = inputs.planes[plane];
  return [
    ...names.map((name) => {
      const lengths = inputs.segments
        .filter((_, k) => mine.segments[k].presence === name)
        .map((segment) => segment.length_mm);
      return [
        String(lengths.length),
        lengths.reduce((a, b) => a + b, 0).toFixed(1),
      ];
    }),
    [
      String(mine.unmatched_mm.length),
      mine.unmatched_mm.reduce((a, b) => a + b, 0).toFixed(1),
    ],
  ];
}

test("the constructed frames give the classes the tests rely on", () => {
  // One branch is missing from the single frame: its segments have no 2D
  // support there, and the rest of the tree is supported.
  const found = expectedSingle.planes[0].segments.map((s) => s.presence);
  expect(found.filter((name) => name === "no_2d_support").length).toBe(3);
  expect(found).toContain("supported");
  expect(found).not.toContain("outside_field");
  // The two planes of the pair differ, so a mix-up between them shows.
  expect(expectedPair.planes[0].segments).not.toEqual(
    expectedPair.planes[1].segments,
  );
});

test("computes, shows and saves exactly the report the operator reviewed", async () => {
  const requests = vi.fn(),
    computing = vi.fn();
  const api = server({
    put: (body) => json(presenceCurrent(body.inputs)),
  });
  render(<Panel onRequests={requests} onComputing={computing} />);
  await waitFor(() =>
    expect(saved()).toBe(
      "No vessel presence report is saved for this proposal.",
    ),
  );
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.queryByRole("table")).toBeNull();
  fireEvent.click(button("Compute vessel presence"));
  await computedReport();
  expect(computing).toHaveBeenCalledWith(true);
  expect(computing).toHaveBeenLastCalledWith(false);
  expect(requests).toHaveBeenLastCalledWith(false);
  const total = expectedSingle.segments
    .reduce((sum, segment) => sum + segment.length_mm, 0)
    .toFixed(1);
  expect(status("Vessel presence summary").textContent).toBe(
    `Unsaved report: ${expectedSingle.segments.length} unnamed segments, ${total} mm in all. ${(100 * expectedSingle.unassigned_fraction).toFixed(1)}% of the mask's volume is in no segment.`,
  );
  expect(rows("Vessel presence in plane single")).toEqual(
    tableOf(expectedSingle, 0),
  );
  expect(screen.getByRole("img").getAttribute("aria-label")).toBe(
    "Admitted frame 12, plane single, with vessel segments colored by presence class",
  );
  expect(screen.getByRole("figure").textContent).toMatch(
    /Red: no 2D support\..*Not a validated registration\./,
  );
  // The per-segment table carries the counts each class follows from.
  const listed = rows("Vessel segments");
  expect(listed).toHaveLength(expectedSingle.segments.length);
  expectedSingle.segments.forEach((segment, k) => {
    const entry = expectedSingle.planes[0].segments[k],
      words = {
        supported: "2D support",
        no_2d_support: "No 2D support",
        outside_field: "Outside the field",
        indeterminate: "Indeterminate",
      }[entry.presence];
    expect(listed[k]).toEqual([
      segment.length_mm.toFixed(1),
      segment.mean_radius_mm.toFixed(1),
      `${words} (${entry.supported} of ${entry.clear} judged samples)`,
    ]);
  });
  // The panel says what the report is not.
  expect(screen.getByText(/It asserts no cause/).textContent).toMatch(
    /may be occluded, unfilled, outside the injected territory or absent, or the proposal may be wrong.*not a validated registration/,
  );
  // Saving needs the review tick.
  expect(button("Save confirmed report").disabled).toBe(true);
  expect(api.puts()).toEqual([]);
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I reviewed the classes/ }),
  );
  fireEvent.click(button("Save confirmed report"));
  await waitFor(() =>
    expect(saved()).toBe(
      "Saved operator-confirmed report, revision 1, on proposal revision 1. Computed here from the frames, the mask and the saved proposal: the counts agree with the saved report.",
    ),
  );
  expect(api.puts()).toHaveLength(1);
  expect(api.puts()[0].body).toEqual({
    artifact_version: identity.artifact_version,
    reference_revision: identity.reference_revision,
    report_revision: 0,
    inputs: JSON.parse(JSON.stringify(expectedSingle)),
  });
  // No pixel, pose or coordinate is sent.
  expect(JSON.stringify(api.puts()[0].body)).not.toMatch(
    /pixels|points|volume_to_carm|isocenter|labels/,
  );
  expect(status("Vessel presence summary").textContent).toMatch(
    /^Saved report: /,
  );
  expect(screen.queryByRole("checkbox", { name: /I reviewed/ })).toBeNull();
  // The saved report is the one on screen: nothing was fetched again.
  expect(api.keys().filter((key) => key.includes("planes/"))).toHaveLength(1);
  expect(requests).toHaveBeenLastCalledWith(false);
}, 60000);

test("fits each plane's frame, view and settings to its own result", async () => {
  const api = server({
    ...pairRoutes,
    put: (body) => json(presenceCurrent(body.inputs)),
  });
  const create = vi.spyOn(jobs, "createPresenceJob");
  render(<Panel registration={pair} />);
  await waitFor(() => expect(saved()).toMatch(/^No vessel presence report/));
  fireEvent.click(button("Compute vessel presence"));
  await computedReport();
  // The job is given the saved pose, and each plane's own frame, view,
  // polarity and sensitivity as they were confirmed.
  expect(create).toHaveBeenCalledTimes(1);
  const given = create.mock.calls[0][0];
  expect(given.matrix).toEqual(pairTruth);
  expect(given.isocenter).toEqual([...pivot]);
  expect(given.shape).toEqual(phantom.shape);
  expect(given.affine).toEqual(phantom.affine);
  expect(Array.from(given.mask)).toEqual(Array.from(phantom.mask));
  expect(
    given.planes.map((plane) => ({
      view: plane.view,
      polarity: plane.polarity,
      sensitivity: plane.sensitivity,
      pixels: hex(plane.frame.gray),
      size: [plane.frame.width, plane.frame.height],
    })),
  ).toEqual([
    {
      view: VIEW,
      polarity: "dark",
      sensitivity: 0.5,
      pixels: hex(pairGray[0]),
      size: [SIDE, SIDE],
    },
    {
      view: VIEW_B,
      polarity: "bright",
      sensitivity: 0.8,
      pixels: hex(lateralMissing),
      size: [SIDE, SIDE],
    },
  ]);
  expect(rows("Vessel presence in plane a")).toEqual(tableOf(expectedPair, 0));
  expect(rows("Vessel presence in plane b")).toEqual(tableOf(expectedPair, 1));
  expect(
    screen.getAllByRole("img").map((image) => image.getAttribute("aria-label")),
  ).toEqual([
    "Admitted frame 12, plane a, with vessel segments colored by presence class",
    "Admitted frame 12, plane b, with vessel segments colored by presence class",
  ]);
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I reviewed the classes/ }),
  );
  fireEvent.click(button("Save confirmed report"));
  await waitFor(() => expect(saved()).toMatch(/^Saved operator-confirmed/));
  expect(api.puts()[0].body.inputs).toEqual(
    JSON.parse(JSON.stringify(expectedPair)),
  );
}, 60000);

test("a saved report is recomputed when read back, and shown as reproduced", async () => {
  const api = server({
    get: () => json(presenceCurrent(expectedSingle, {}, 4)),
  });
  render(<Panel />);
  await waitFor(
    () =>
      expect(saved()).toBe(
        "Saved operator-confirmed report, revision 4, on proposal revision 1. Computed here from the frames, the mask and the saved proposal: the counts agree with the saved report.",
      ),
    { timeout: 30000 },
  );
  expect(status("Vessel presence summary").textContent).toMatch(
    /^Saved report: /,
  );
  expect(rows("Vessel presence in plane single")).toEqual(
    tableOf(expectedSingle, 0),
  );
  // Nothing to confirm and nothing written.
  expect(screen.queryByRole("checkbox", { name: /I reviewed/ })).toBeNull();
  expect(api.puts()).toEqual([]);
  // Recomputed once, not on every render.
  expect(api.keys().filter((key) => key.includes("planes/"))).toHaveLength(1);
}, 60000);

test("a saved report the recomputation does not reproduce is said so, and not shown", async () => {
  // A valid report with other counts in two segments: a stored row that
  // was computed from another mask or frame, or by another method.
  const other = structuredClone(expectedSingle);
  const supportedAt = other.planes[0].segments.findIndex(
      (entry) =>
        entry.presence === "supported" && entry.supported > 0.8 * entry.clear,
    ),
    missingAt = other.planes[0].segments.findIndex(
      (entry) => entry.presence === "no_2d_support",
    );
  other.planes[0].segments[supportedAt].supported--;
  other.planes[0].segments[missingAt] = {
    ...other.planes[0].segments[missingAt],
    presence: "supported",
    supported: other.planes[0].segments[missingAt].clear,
  };
  const api = server({
    get: () => json(presenceCurrent(other, {}, 2)),
    put: (body) => json(presenceCurrent(body.inputs, {}, 3)),
  });
  render(<Panel />);
  await waitFor(
    () =>
      expect(saved()).toBe(
        `Saved operator-confirmed report, revision 2, on proposal revision 1. Computed here from the frames, the mask and the saved proposal: the saved report was not reproduced, 2 of ${other.segments.length} segments have other counts in plane single. Its counts are not shown.`,
      ),
    { timeout: 30000 },
  );
  // What is shown is the recomputation, marked unsaved.
  expect(status("Vessel presence summary").textContent).toMatch(
    /^Unsaved report: /,
  );
  expect(rows("Vessel presence in plane single")).toEqual(
    tableOf(expectedSingle, 0),
  );
  expect(rows("Vessel presence in plane single")).not.toEqual(
    tableOf(other, 0),
  );
  // It can be confirmed as a new revision on top of the saved one.
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I reviewed the classes/ }),
  );
  fireEvent.click(button("Save confirmed report"));
  await waitFor(() => expect(saved()).toMatch(/revision 3, .*counts agree/));
  expect(api.puts()[0].body.report_revision).toBe(2);
}, 60000);

test("a saved report whose evidence is gone withholds its counts", async () => {
  const lost = parseSavedRegistration(
    currentAnswer(savedInputs({ frame_sha256: hex(missing) }), {
      evidence: "unavailable",
    }),
    identity,
  );
  const api = server({ get: () => json(presenceCurrent(expectedSingle)) });
  render(<Panel registration={lost} />);
  await waitFor(() =>
    expect(saved()).toBe(
      "Saved operator-confirmed report, revision 1, on proposal revision 1. Its frames or vessel mask are no longer available unchanged, so it cannot be recomputed. Its counts are not shown.",
    ),
  );
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.queryByRole("button", { name: /vessel presence/ })).toBeNull();
  expect(screen.queryByRole("img")).toBeNull();
  expect(api.keys()).toEqual([
    `GET /api/cases/${identity.case_id}/vessel-presence`,
  ]);
});

test("changing the accepted mask hides a previously reproduced report immediately", async () => {
  server({ get: () => json(presenceCurrent(expectedSingle)) });
  const view = render(<Panel />);
  await waitFor(() => expect(saved()).toMatch(/counts agree/), {
    timeout: 30000,
  });
  expect(screen.getAllByRole("table").length).toBeGreaterThan(0);
  view.rerender(
    <Panel
      mask={{ ...maskEntry, candidate_id: "other-mask" } as SegmentationEntry}
    />,
  );
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.queryByRole("img")).toBeNull();
  await waitFor(() => expect(saved()).toMatch(/accepted vessel mask differs/));
  expect(
    screen.queryByRole("button", { name: /Compute vessel presence/ }),
  ).toBeNull();
}, 60000);

test("a stale report is not shown, and a new one can be computed", async () => {
  server({
    get: () =>
      json(presenceAnswer(1, { status: "stale", report_id: "report-0" }, 2)),
  });
  render(<Panel />);
  await waitFor(() =>
    expect(saved()).toBe(
      "A report was confirmed for an earlier proposal or an earlier revision of this case. It is not shown or reused.",
    ),
  );
  expect(screen.queryByRole("table")).toBeNull();
  expect(button("Compute vessel presence").disabled).toBe(false);
});

test("nothing is offered for a registration that is not current", async () => {
  const api = server();
  const view = render(
    <Panel
      registration={parseSavedRegistration(registrationAnswer(), identity)}
    />,
  );
  expect(view.container.textContent).toBe("");
  expect(api.keys()).toEqual([]);
});

test("needs the accepted mask and the source volume", async () => {
  server();
  const view = render(<Panel mask={null} />);
  await waitFor(() => expect(saved()).toMatch(/^No vessel presence report/));
  expect(screen.queryByRole("button", { name: /vessel presence/ })).toBeNull();
  view.unmount();
  render(<Panel withGrid={false} />);
  await waitFor(() => expect(saved()).toMatch(/^No vessel presence report/));
  expect(screen.queryByRole("button", { name: /vessel presence/ })).toBeNull();
});

test("computes nothing from a frame, bundle or mask that is not the confirmed one", async () => {
  const failure =
    "Vessel presence was not computed: The saved proposal could not be recomputed from its frames and vessel mask. Check their availability and identity, then retry.";
  const create = vi.spyOn(jobs, "createPresenceJob");
  const cases: { routes?: Routes; mask?: Record<string, unknown> }[] = [
    // Another frame's pixels under the confirmed name, served consistently.
    {
      routes: {
        bundle: () => json(bundleAnswer()),
        frame: () =>
          bytes(
            renderFrame(VIEW, pivot, truth, {
              ...FRAME,
              polarity: "dark",
              noise: 12,
              seed: 7,
            }),
            { "X-Frame-Manifest-Revision": REVISION },
          ),
      },
    },
    // The bundle was reinstalled under another manifest revision.
    {
      routes: {
        bundle: () =>
          json({ ...bundleAnswer(), manifest_revision: "b".repeat(64) }),
      },
    },
    { routes: { bundle: () => json({}, 404) } },
    { routes: { frame: () => json({}, 404) } },
    { routes: { mask: () => json({}, 404) } },
  ];
  for (const entry of cases) {
    const api = server(entry.routes);
    const view = render(
      <Panel
        mask={(entry.mask ?? maskEntry) as unknown as SegmentationEntry}
      />,
    );
    await waitFor(() => expect(saved()).toMatch(/^No vessel presence report/));
    fireEvent.click(button("Compute vessel presence"));
    expect((await screen.findByRole("alert")).textContent).toBe(failure);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(api.puts()).toEqual([]);
    view.unmount();
  }
  expect(create).not.toHaveBeenCalled();
});

test("a failed automatic recheck withholds saved counts and can be retried", async () => {
  let available = false;
  const api = server({
    get: () => json(presenceCurrent(expectedSingle)),
    bundle: () => {
      if (!available) throw new TypeError("network offline");
      return json(
        bundleAnswer({
          planes: [
            {
              ...bundleAnswer().manifest.planes[0],
              frames: [
                {
                  index: 12,
                  sha256: hex(missing),
                  input_sha256: "c".repeat(64),
                },
              ],
            },
          ],
        }),
      );
    },
  });
  render(<Panel />);
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toMatch(
    /could not be recomputed/,
  );
  expect(screen.queryAllByRole("table")).toHaveLength(0);
  expect(api.puts()).toEqual([]);
  available = true;
  fireEvent.click(button("Compute vessel presence"));
  await waitFor(() => expect(saved()).toMatch(/counts agree/), {
    timeout: 30000,
  });
  expect(screen.getAllByRole("table").length).toBeGreaterThan(0);
}, 60000);

test("a failed computation is reported and leaves nothing to confirm", async () => {
  server();
  vi.spyOn(jobs, "createPresenceJob").mockReturnValue({
    advance: () => {
      throw new Error("Vessel mask has too many segments");
    },
    result: () => {
      throw new Error("unreachable");
    },
  });
  render(<Panel />);
  await waitFor(() => expect(saved()).toMatch(/^No vessel presence report/));
  fireEvent.click(button("Compute vessel presence"));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Vessel presence was not computed: Vessel mask has too many segments.",
  );
  expect(screen.queryByRole("checkbox", { name: /I reviewed/ })).toBeNull();
});

test("a computation can be cancelled, and waits while the panel is disabled", async () => {
  server();
  let advanced = 0;
  vi.spyOn(jobs, "createPresenceJob").mockReturnValue({
    advance: () => {
      advanced++;
      return false;
    },
    result: () => {
      throw new Error("unreachable");
    },
  });
  const computing = vi.fn();
  const view = render(<Panel onComputing={computing} />);
  await waitFor(() => expect(saved()).toMatch(/^No vessel presence report/));
  fireEvent.click(button("Compute vessel presence"));
  await screen.findByRole("status", { name: "Vessel presence status" });
  await waitFor(() => expect(advanced).toBeGreaterThan(2));
  expect(computing).toHaveBeenLastCalledWith(true);
  expect(screen.queryByRole("button", { name: /Compute/ })).toBeNull();
  // Disabled: the job is kept and not advanced.
  view.rerender(<Panel onComputing={computing} disabled />);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const paused = advanced;
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(advanced).toBe(paused);
  view.rerender(<Panel onComputing={computing} />);
  await waitFor(() => expect(advanced).toBeGreaterThan(paused));
  fireEvent.click(button("Cancel vessel presence computation"));
  await waitFor(() => expect(computing).toHaveBeenLastCalledWith(false));
  const stopped = advanced;
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(advanced).toBe(stopped);
  expect(button("Compute vessel presence").disabled).toBe(false);
  expect(screen.queryByRole("table")).toBeNull();
});

test("starts nothing while disabled", async () => {
  const api = server({ get: () => json(presenceCurrent(expectedSingle)) });
  const view = render(<Panel disabled />);
  await waitFor(() =>
    expect(saved()).toMatch(/revision 1.*Not yet recomputed here\./),
  );
  expect(button("Compute vessel presence").disabled).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  // The saved report is read, and its recomputation waits.
  expect(api.keys()).toEqual([
    `GET /api/cases/${identity.case_id}/vessel-presence`,
  ]);
  // No counts are shown until the recomputation has checked them.
  expect(screen.queryByRole("table")).toBeNull();
  expect(
    screen.queryByRole("status", { name: "Vessel presence summary" }),
  ).toBeNull();
  view.rerender(<Panel />);
  await waitFor(() => expect(saved()).toMatch(/counts agree/), {
    timeout: 30000,
  });
}, 60000);

test("a report that cannot be read is not shown, and can be reloaded", async () => {
  let answer: () => Response = () => json({}, 500);
  server({ get: () => answer() });
  render(<Panel />);
  const failure =
    "The saved vessel presence report could not be loaded. Reload it before continuing.";
  expect((await screen.findByRole("alert")).textContent).toBe(failure);
  expect(screen.queryByRole("button", { name: /Compute/ })).toBeNull();
  // A current report that names another registration is refused whole.
  answer = () =>
    json(
      presenceCurrent({ ...expectedSingle, registration_id: "registration-9" }),
    );
  fireEvent.click(button("Reload saved report"));
  await waitFor(() =>
    expect(button("Reload saved report").disabled).toBe(false),
  );
  expect(screen.getByRole("alert").textContent).toBe(failure);
  expect(screen.queryByRole("table")).toBeNull();
  // A summary that claims validation is refused whole.
  answer = () => {
    const claimed = presenceCurrent(expectedSingle) as any;
    claimed.current.result.validated = true;
    return json(claimed);
  };
  fireEvent.click(button("Reload saved report"));
  await waitFor(() =>
    expect(button("Reload saved report").disabled).toBe(false),
  );
  expect(screen.getByRole("alert").textContent).toBe(failure);
  answer = () => json(presenceAnswer(1));
  fireEvent.click(button("Reload saved report"));
  await waitFor(() => expect(saved()).toMatch(/^No vessel presence report/));
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a refused save keeps the report unsaved and says why", async () => {
  let reply = 409;
  const api = server({ put: () => json({}, reply) });
  render(<Panel />);
  await waitFor(() => expect(saved()).toMatch(/^No vessel presence report/));
  fireEvent.click(button("Compute vessel presence"));
  await computedReport();
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I reviewed the classes/ }),
  );
  fireEvent.click(button("Save confirmed report"));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "The case, the saved proposal or the saved report changed. Reload before saving.",
  );
  expect(saved()).toMatch(/^No vessel presence report/);
  reply = 422;
  fireEvent.click(button("Save confirmed report"));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe(
      "The report was refused and was not saved. The frame, mask or saved proposal changed, or the report is not one the record accepts. Reload and compute it again.",
    ),
  );
  expect(api.puts()).toHaveLength(2);
  expect(status("Vessel presence summary").textContent).toMatch(
    /^Unsaved report/,
  );
}, 60000);

test.each([409, 422])(
  "a %s save refusal offers reload and uses the refreshed report revision",
  async (code) => {
    let stored: unknown = presenceAnswer(1),
      attempts = 0;
    const api = server({
      get: () => json(stored),
      put: (body) => {
        if (++attempts === 1) {
          stored = presenceAnswer(
            1,
            { status: "stale", report_id: "report-old" },
            2,
          );
          return json({}, code);
        }
        return json(presenceCurrent(body.inputs, {}, 3));
      },
    });
    render(<Panel />);
    await waitFor(() => expect(saved()).toMatch(/^No vessel presence report/));
    fireEvent.click(button("Compute vessel presence"));
    await computedReport();
    fireEvent.click(
      screen.getByRole("checkbox", { name: /I reviewed the classes/ }),
    );
    fireEvent.click(button("Save confirmed report"));
    await screen.findByRole("alert");
    fireEvent.click(button("Reload saved report"));
    await waitFor(() => expect(saved()).toMatch(/earlier proposal/));
    expect(
      api
        .keys()
        .filter(
          (k) => k === `GET /api/cases/${identity.case_id}/vessel-presence`,
        ),
    ).toHaveLength(2);
    expect(screen.queryAllByRole("table")).toHaveLength(0);
    fireEvent.click(button("Compute vessel presence"));
    await computedReport();
    expect(button("Save confirmed report").disabled).toBe(true);
    fireEvent.click(
      screen.getByRole("checkbox", { name: /I reviewed the classes/ }),
    );
    fireEvent.click(button("Save confirmed report"));
    await waitFor(() => expect(saved()).toMatch(/revision 3.*counts agree/));
    expect(api.puts().map((p) => p.body.report_revision)).toEqual([0, 2]);
  },
  60000,
);

test("a save with no readable answer may have been stored: reload first", async () => {
  const uncertain =
    "Save acknowledgement was not received. The report may have been stored. Reload the saved report before continuing.";
  for (const put of [
    () => json({}, 500),
    // Stored, but the answer names another registration revision.
    (body: any) =>
      json({ ...presenceCurrent(body.inputs), registration_revision: 2 }),
    () => new Response("not json"),
  ]) {
    let stored: unknown = null;
    const api = server({
      get: () => json(stored ?? presenceAnswer(1)),
      put: (body) => {
        stored = presenceCurrent(body.inputs);
        return put(body);
      },
    });
    const view = render(<Panel />);
    await waitFor(() => expect(saved()).toMatch(/^No vessel presence report/));
    fireEvent.click(button("Compute vessel presence"));
    await computedReport();
    fireEvent.click(
      screen.getByRole("checkbox", { name: /I reviewed the classes/ }),
    );
    fireEvent.click(button("Save confirmed report"));
    expect((await screen.findByRole("alert")).textContent).toBe(uncertain);
    // Nothing can be saved again until the report is read back.
    expect(
      screen.queryByRole("button", { name: "Save confirmed report" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Compute/ })).toBeNull();
    expect(api.puts()).toHaveLength(1);
    fireEvent.click(button("Reload saved report"));
    await waitFor(() => expect(saved()).toMatch(/revision 1.*counts agree/), {
      timeout: 30000,
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(api.puts()).toHaveLength(1);
    view.unmount();
  }
}, 120000);

test("a request that does not answer is given up after its deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const requests = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          ),
        ),
    ),
  );
  render(<Panel onRequests={requests} />);
  expect(requests).toHaveBeenLastCalledWith(true);
  await vi.advanceTimersByTimeAsync(PRESENCE_REQUEST_TIMEOUT_MS - 1);
  expect(screen.queryByRole("alert")).toBeNull();
  await vi.advanceTimersByTimeAsync(2);
  vi.useRealTimers();
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /could not be loaded/,
  );
  expect(requests).toHaveBeenLastCalledWith(false);
});

// The deadline is for requests. Reading a large mask in a background tab can
// take longer than any request may, and is not a request.
test("decoding the mask is not held to the request deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  server();
  const decode = frameModule.decodeVesselMask;
  const slow = vi
    .spyOn(frameModule, "decodeVesselMask")
    .mockImplementation(async (...given) => {
      await new Promise((resolve) =>
        setTimeout(resolve, PRESENCE_REQUEST_TIMEOUT_MS + 5000),
      );
      return decode(...given);
    });
  // Hashing and decoding answer outside the faked timers.
  const until = async (met: () => boolean) => {
    for (let k = 0; k < 5000 && !met(); k++) {
      await vi.advanceTimersByTimeAsync(1);
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(met()).toBe(true);
  };
  render(<Panel />);
  await until(() => !!screen.queryByRole("button"));
  fireEvent.click(button("Compute vessel presence"));
  await until(() => slow.mock.calls.length === 1);
  await vi.advanceTimersByTimeAsync(PRESENCE_REQUEST_TIMEOUT_MS + 5001);
  // It ends with a report, or with the button offered again and nothing said.
  await until(
    () =>
      !!screen.queryByRole("status", { name: "Vessel presence summary" }) ||
      (
        screen.queryByRole("button", {
          name: "Compute vessel presence",
        }) as HTMLButtonElement | null
      )?.disabled === false,
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(status("Vessel presence summary").textContent).toMatch(
    /^Unsaved report/,
  );
});

test("a report belongs to one registration: a new one starts over", async () => {
  const api = server({
    get: () => json(presenceAnswer(1)),
  });
  const view = render(<Panel />);
  await waitFor(() => expect(saved()).toMatch(/^No vessel presence report/));
  fireEvent.click(button("Compute vessel presence"));
  await computedReport();
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I reviewed the classes/ }),
  );
  // The proposal is confirmed again: the registration revision moves on.
  const next = parseSavedRegistration(
    currentAnswer(
      savedInputs({ frame_sha256: hex(missing) }),
      { registration_id: "registration-5" },
      2,
    ),
    identity,
  );
  server({ get: () => json(presenceAnswer(2)) });
  view.rerender(<Panel registration={next} />);
  await waitFor(() => expect(saved()).toMatch(/^No vessel presence report/));
  // The report computed for the earlier registration is gone, unsaved.
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.queryByRole("checkbox", { name: /I reviewed/ })).toBeNull();
  expect(api.puts()).toEqual([]);
}, 60000);
