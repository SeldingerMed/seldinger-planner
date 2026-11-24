/** The operator's path, end to end, on the known-truth synthetic heart: a
 * CT tree admitted to the case, the same heart's cine loaded as a local
 * bundle, the pair stated, one proposal made, replayed and confirmed. The
 * truth is read only after the run, to measure where the branches were put. */
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { binding, caseState } from "./__fixtures__/overlayCase";
import { CT_CINE, ctTree, renderCtCine, type CineOptions } from "./__fixtures__/coronaryCtCine";
import { CINE_BUNDLE_FORMAT } from "./cineBundle";
import CoronaryCorrespondencePanel from "./CoronaryCorrespondencePanel";

// Reading a bundle can take longer than the default second on a loaded
// runner; no expectation changes.
configure({ asyncUtilTimeout: 10_000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const TREE_SHA = "7".repeat(64);

function treeExport(source: string, change: Record<string, unknown> = {}) {
  return {
    source_sha256: source,
    method: "coronary_centerline_tree_v1",
    provenance: "curated_annotation",
    spatial_units: "mm",
    ct_phase_percent: CT_CINE.ct_phase_percent,
    operator_confirmation_required: true,
    branches: ctTree(),
    ...change,
  };
}

/** A stand-in server holding the tree and the confirmed record. */
function server() {
  const calls: { key: string; body: any }[] = [];
  let tree: any = { tree_revision: 0, current: { status: "not_confirmed" } };
  let record: any = { correspondence_revision: 0, current: { status: "not_confirmed" } };
  const base = `/api/cases/${caseState.case_id}`;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET",
        body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ key: `${method} ${url}`, body });
      if (url === `${base}/coronary-tree`) {
        if (method === "PUT") {
          if (body.export.source_sha256 !== caseState.image_sha256)
            return json({ detail: "The tree was made from another scan" }, 422);
          tree = {
            tree_revision: tree.tree_revision + 1,
            current: {
              status: "current",
              record_id: "t1",
              body_sha256: TREE_SHA,
              body: body.export,
            },
          };
        }
        return json(tree);
      }
      if (url === `${base}/coronary-correspondence`) {
        if (method === "PUT") {
          const inputs = body.inputs;
          record = {
            correspondence_revision: record.correspondence_revision + 1,
            current: {
              status: "current",
              record_id: "c1",
              evidence: "verified",
              inputs,
              result: {
                matched: inputs.branches.filter((b: any) => b.status === "matched").map((b: any) => b.id),
                not_matched: Object.fromEntries(
                  inputs.branches.filter((b: any) => b.status !== "matched").map((b: any) => [b.id, b.status]),
                ),
              },
            },
          };
        }
        return json(record);
      }
      return json({ detail: "Not found" }, 404);
    }),
  );
  return calls;
}

function bundleFile(
  options: CineOptions = {},
  change: Record<string, unknown> = {},
  name = "cine.bundle",
) {
  const { frames } = renderCtCine(options);
  const header = {
    format: CINE_BUNDLE_FORMAT,
    source_sha256: "b".repeat(64),
    frames: frames.length,
    rows: CT_CINE.size,
    columns: CT_CINE.size,
    times_ms: frames.map((f) => f.time_ms),
    timing: "frame_time_vector",
    view: { ...CT_CINE.view },
    geometry: "fixed",
    transfer_syntax: "1.2.840.10008.1.2.4.70",
    window: "percentile_0.5_99.5_whole_cine",
    identifiers: "not_carried",
    ...change,
  };
  const text = new TextEncoder().encode(`${CINE_BUNDLE_FORMAT}\n${JSON.stringify(header)}\n`);
  const size = CT_CINE.size * CT_CINE.size;
  const out = new Uint8Array(text.length + size * frames.length);
  out.set(text);
  frames.forEach((f, k) => out.set(f.pixels, text.length + k * size));
  return { file: new File([out], name), truth: renderCtCine(options).truth };
}

async function admit(source = caseState.image_sha256, change = {}) {
  const input = screen.getByLabelText("Admit CT coronary tree");
  fireEvent.change(input, {
    target: { files: [new File([JSON.stringify(treeExport(source, change))], "tree.json")] },
  });
}

async function load(file: File, source = "b".repeat(64)) {
  fireEvent.change(screen.getByLabelText("Load cine bundle"), { target: { files: [file] } });
  await screen.findByText(new RegExp(`Cine ${source.slice(0, 8)}, held in this browser only`));
}

const statePair = () =>
  fireEvent.click(screen.getByLabelText(/I state that this cine is this patient's/));

test("tree to cine through the studio: one named proposal, replayed and confirmed", async () => {
  const calls = server();
  render(<CoronaryCorrespondencePanel caseState={caseState} binding={binding} />);
  await screen.findByText("No tree admitted for this scan.");
  await admit();
  await screen.findByText(/5 branches, curated annotation, CT phase 75 percent/);
  const { file, truth } = bundleFile();
  await load(file);
  statePair();
  fireEvent.click(screen.getByText("Propose correspondence"));
  const proposal = await screen.findByLabelText("Proposal", {}, { timeout: 60_000 });

  // Every CT branch is named where it lies, by its own id and label.
  const rows = within(proposal).getAllByRole("row").slice(1);
  expect(rows.map((r) => r.getAttribute("data-branch"))).toEqual(ctTree().map((b) => b.id));
  expect(rows.every((r) => r.getAttribute("data-status") === "matched")).toBe(true);

  // The fit is shown beside its mirror image's, which it must clearly beat.
  expect(proposal.textContent).toMatch(
    /Fit 0\.\d\d \(from 0\.\d\d; its mirror image 0\.\d\d\), vessel evidence, not an accuracy\./,
  );

  // The anchor frame is counted once: matched there, followed elsewhere.
  expect(proposal.textContent).toMatch(
    /Matched on frame \d+, then followed on \d+ of the other 63 frames;\s+not drawn on \d+\./,
  );

  // Replay: on the CT's phase frame every matched branch is drawn, near
  // where it truly is (truth read only now).
  const status = within(proposal).getByRole("status");
  expect(status.textContent).toMatch(/the CT's phase/);
  const frame = Number(status.textContent!.match(/Frame (\d+)/)![1]) - 1;
  const lines = proposal.querySelectorAll("polyline");
  expect(lines.length).toBe(ctTree().length);
  const errors: number[] = [];
  for (const line of lines) {
    const id = line.getAttribute("data-branch")!;
    const drawn = line
      .getAttribute("points")!
      .split(" ")
      .map((p) => p.split(",").map(Number));
    const truePlaces = truth[frame][id];
    // Nearest true point of the same branch: the drawn course lies on it.
    for (const [x, y] of drawn)
      errors.push(Math.min(...truePlaces.map(([u, v]) => Math.hypot(u - x, v - y))));
  }
  errors.sort((a, b) => a - b);
  expect(errors[Math.floor(errors.length / 2)]).toBeLessThan(2);

  // Scrubbing moves the replay to other frames.
  fireEvent.change(within(proposal).getByLabelText("Frame"), { target: { value: "3" } });
  expect(within(proposal).getByRole("status").textContent).toMatch(/^Frame 4 of 64/);

  fireEvent.click(within(proposal).getByText("Confirm this correspondence"));
  await screen.findByLabelText("Confirmed correspondence");
  const put = calls.find((c) => c.key.startsWith("PUT") && c.key.endsWith("coronary-correspondence"));
  expect(put!.body.inputs.pair).toEqual({
    stated_by: "operator",
    tree_revision: 1,
    tree_sha256: TREE_SHA,
    cine_source_sha256: "b".repeat(64),
    cine_bundle_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(put!.body.inputs.clinical_validation).toBe(false);
  // No pixels and no truth reach the server.
  const sent = JSON.stringify(put!.body);
  expect(sent).not.toMatch(/pixels|truth|points_px/);
  expect(sent.length).toBeLessThan(65_536);
}, 120_000);

test("a proposal under way when the case's tree changes leaves the panel usable", async () => {
  server();
  const { rerender } = render(<CoronaryCorrespondencePanel caseState={caseState} binding={binding} />);
  await screen.findByText("No tree admitted for this scan.");
  await admit();
  await screen.findByText(/5 branches/);
  await load(bundleFile().file);
  statePair();
  fireEvent.click(screen.getByText("Propose correspondence"));
  expect(screen.getByLabelText("Load cine bundle")).toBeDisabled();
  // Another case opens while the proposal runs: it has no tree.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      json(
        url.endsWith("/coronary-tree")
          ? { tree_revision: 0, current: { status: "not_confirmed" } }
          : { correspondence_revision: 0, current: { status: "not_confirmed" } },
      ),
    ),
  );
  rerender(
    <CoronaryCorrespondencePanel caseState={{ ...caseState, case_id: "case-2" }} binding={binding} />,
  );
  await screen.findByText("No tree admitted for this scan.");
  await waitFor(() => expect(screen.getByLabelText("Load cine bundle")).toBeEnabled(), { timeout: 60_000 });
  expect(screen.queryByLabelText("Proposal")).toBeNull();
}, 120_000);

test("a shorter cine loaded while a late frame is shown ends the old proposal, without failing", async () => {
  // A drawing surface, so the frame is really painted.
  const painted: number[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(4 * w * h) }),
    putImageData: () => painted.push(1),
  } as unknown as CanvasRenderingContext2D);
  const failures: unknown[] = [];
  const onError = (e: ErrorEvent) => failures.push(e.error);
  window.addEventListener("error", onError);
  try {
    server();
    render(<CoronaryCorrespondencePanel caseState={caseState} binding={binding} />);
    await screen.findByText("No tree admitted for this scan.");
    await admit();
    await screen.findByText(/5 branches/);
    await load(bundleFile().file);
    statePair();
    fireEvent.click(screen.getByText("Propose correspondence"));
    const proposal = await screen.findByLabelText("Proposal", {}, { timeout: 60_000 });
    fireEvent.change(within(proposal).getByLabelText("Frame"), { target: { value: "60" } });
    expect(within(proposal).getByRole("status").textContent).toMatch(/^Frame 61 of 64/);
    expect(painted.length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("Load cine bundle"), {
      target: { files: [bundleFile({ frames: 24 }, {}, "short.bundle").file] },
    });
    await screen.findByText(/24 frames, 256 by 256/);
    // The proposal was made from the other cine: it is gone, not drawn
    // over this one, and the panel still works.
    expect(screen.queryByLabelText("Proposal")).toBeNull();
    expect(screen.getByText("Propose correspondence")).toBeInTheDocument();
    expect(failures).toEqual([]);
  } finally {
    window.removeEventListener("error", onError);
  }
}, 120_000);

test("no proposal without the operator's pair, and none for a pair stated for another cine", async () => {
  server();
  render(<CoronaryCorrespondencePanel caseState={caseState} binding={binding} />);
  await screen.findByText("No tree admitted for this scan.");
  await admit();
  await screen.findByText(/5 branches/);
  await load(bundleFile({ frames: 24 }).file);
  fireEvent.click(screen.getByText("Propose correspondence"));
  expect((await screen.findByRole("alert")).getAttribute("data-refusal")).toBe("not_paired");

  statePair();
  // Another cine, same branch names in the tree: the pair does not carry over.
  await load(
    bundleFile({ frames: 24 }, { source_sha256: "c".repeat(64) }, "other.bundle").file,
    "c".repeat(64),
  );
  expect(screen.getByRole("note").textContent).toMatch(/another tree or cine/);
  fireEvent.click(screen.getByText("Propose correspondence"));
  expect((await screen.findByRole("alert")).getAttribute("data-refusal")).toBe("pair_mismatch");
  expect(screen.queryByLabelText("Proposal")).toBeNull();
}, 60_000);

test.each([
  ["display rate only", { timing: "cine_rate", times_ms: null }, "no_frame_times"],
  ["no view", { view: null }, "no_geometry"],
  ["a moving C-arm", { geometry: "moving" }, "moving_geometry"],
  ["undeclared motion", { geometry: "unknown" }, "geometry_not_declared"],
])("refuses a cine with %s", async (_, change, reason) => {
  server();
  render(<CoronaryCorrespondencePanel caseState={caseState} binding={binding} />);
  await screen.findByText("No tree admitted for this scan.");
  await admit();
  await screen.findByText(/5 branches/);
  await load(bundleFile({ frames: 24 }, change).file);
  statePair();
  fireEvent.click(screen.getByText("Propose correspondence"));
  expect((await screen.findByRole("alert")).getAttribute("data-refusal")).toBe(reason);
});

test("refuses a tree whose CT phase is not stated", async () => {
  server();
  render(<CoronaryCorrespondencePanel caseState={caseState} binding={binding} />);
  await screen.findByText("No tree admitted for this scan.");
  await admit(caseState.image_sha256, { ct_phase_percent: null });
  await screen.findByText(/CT phase not stated/);
  await load(bundleFile({ frames: 24 }).file);
  statePair();
  fireEvent.click(screen.getByText("Propose correspondence"));
  expect((await screen.findByRole("alert")).getAttribute("data-refusal")).toBe("ct_phase_missing");
});

test("a tree from another scan is not admitted", async () => {
  server();
  render(<CoronaryCorrespondencePanel caseState={caseState} binding={binding} />);
  await screen.findByText("No tree admitted for this scan.");
  await admit("e".repeat(64));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "The tree was made from another scan",
  );
  expect(screen.getByText("No tree admitted for this scan.")).toBeTruthy();
});

test("a file that is not a bundle is refused", async () => {
  server();
  render(<CoronaryCorrespondencePanel caseState={caseState} binding={binding} />);
  await screen.findByText("No tree admitted for this scan.");
  fireEvent.change(screen.getByLabelText("Load cine bundle"), {
    target: { files: [new File([new Uint8Array([1, 2, 3])], "x.dcm")] },
  });
  expect((await screen.findByRole("alert")).textContent).toBe("Not a cine bundle.");
});

test("swapped branch names in the CT are reported under the CT's names, placed by position", async () => {
  server();
  render(<CoronaryCorrespondencePanel caseState={caseState} binding={binding} />);
  await screen.findByText("No tree admitted for this scan.");
  // The tree file swaps two labels; the cine knows no names at all.
  const swapped = ctTree().map((b) =>
    b.id === "lad" ? { ...b, label: "circumflex" } : b.id === "lcx" ? { ...b, label: "anterior descending" } : b,
  );
  await admit(caseState.image_sha256, { branches: swapped });
  await screen.findByText(/5 branches/);
  await load(bundleFile().file);
  statePair();
  fireEvent.click(screen.getByText("Propose correspondence"));
  const proposal = await screen.findByLabelText("Proposal", {}, { timeout: 60_000 });
  const lad = within(proposal).getAllByRole("row").find((r) => r.getAttribute("data-branch") === "lad")!;
  // The label is the file's; the place is the CT point's own course.
  expect(lad.textContent).toMatch(/circumflex \(lad\)/);
  expect(lad.getAttribute("data-status")).toBe("matched");
}, 120_000);
