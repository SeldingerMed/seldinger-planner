import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  binding,
  bundleAnswer,
  caseState,
  gray,
  hex,
  REVISION,
  volume,
} from "./__fixtures__/overlayCase";
import AbdominalOverlayPanel, { lineupWords } from "./AbdominalOverlayPanel";
import * as lineups from "./abdominalLineup";
import * as bone from "./boneLineup";
import * as corrections from "./vesselCorrection";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

const BRANCHES = [
  {
    name: "aorta",
    path_ras: [
      [0, 0, 0],
      [0, 0, 20],
    ],
    radius_mm: [8, 8],
    length_mm: 20,
  },
];
const modelCurrent = {
  status: "current",
  record_id: "m1",
  body_sha256: "9".repeat(64),
  body: {
    source_sha256: caseState.image_sha256,
    proposal: { branches: BRANCHES },
  },
};
const MOVED = [
  [1, 0, 0, 2],
  [0, 1, 0, -3],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

/** A stand-in server holding the model and the line-up. */
function server(start: { model?: boolean } = {}) {
  const calls: { key: string; body: any }[] = [];
  let model = start.model
    ? { model_revision: 1, current: modelCurrent }
    : { model_revision: 0, current: { status: "not_confirmed" } };
  let lineup: any = {
    registration_revision: 0,
    current: { status: "not_confirmed" },
  };
  const base = `/api/cases/${caseState.case_id}`;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET",
        body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ key: `${method} ${url}`, body });
      if (url === `${base}/aortoiliac-model`) {
        if (method === "PUT") {
          if (body.export.source_sha256 !== caseState.image_sha256)
            return json(
              { detail: "The model was made from another scan" },
              422,
            );
          model = {
            model_revision: model.model_revision + 1,
            current: modelCurrent,
          };
        }
        return json(model);
      }
      if (url === `${base}/bone-lineup-registration`) {
        if (method === "PUT")
          lineup = {
            registration_revision: lineup.registration_revision + 1,
            current: {
              status: "current",
              evidence: "verified",
              inputs: body.inputs,
              result: { rotation_deg: 0, isocenter_shift_mm: 3.6 },
            },
          };
        return json(lineup);
      }
      if (url === "/api/projection-frames/phantom-run")
        return json(bundleAnswer());
      if (url.startsWith("/api/projection-frames/phantom-run/planes/"))
        return new Response(gray.slice().buffer, {
          headers: { "X-Frame-Manifest-Revision": REVISION },
        });
      return json({}, 404);
    }),
  );
  return calls;
}

const proposal = (
  change: Partial<lineups.AbdominalLineupProposal> = {},
): lineups.AbdominalLineupProposal =>
  ({
    method: lineups.ABDOMINAL_LINEUP_METHOD,
    engine_method: "bone_edge_compass_v1",
    matrix: MOVED,
    used: [0],
    frame_scores: [0.42],
    start_score: 0.11,
    depth: "not_determined_single_view",
    second_view: { status: "not_given" },
    single: {} as never,
    both: null,
    ...change,
  }) as lineups.AbdominalLineupProposal;

function stubLineup(value: lineups.AbdominalLineupProposal) {
  // The scan here is a vessel phantom; the samples are the engine's concern.
  vi.spyOn(bone, "boneSamples").mockReturnValue({} as never);
  return vi.spyOn(lineups, "createAbdominalLineupJob").mockImplementation(
    () =>
      ({
        advance: () => true,
        result: () => value,
      }) as never,
  );
}

const panel = () =>
  render(
    <AbdominalOverlayPanel
      caseState={caseState}
      binding={binding}
      volume={volume as never}
      cursor={[1, 2, 3]}
    />,
  );

test("admits only the model made from this scan", async () => {
  const calls = server();
  panel();
  await screen.findByText("No aorta and iliac model is loaded for this scan.");
  const input = screen.getByLabelText("Model export (JSON)");
  const other = new File(
    [JSON.stringify({ source_sha256: "e".repeat(64) })],
    "model.json",
  );
  fireEvent.change(input, { target: { files: [other] } });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The model was made from another scan",
  );
  const mine = new File(
    [JSON.stringify({ source_sha256: caseState.image_sha256 })],
    "model.json",
  );
  fireEvent.change(input, { target: { files: [mine] } });
  expect(
    await screen.findByText(
      /Model from this scan .* aorta\. A proposal to review\./,
    ),
  ).toBeInTheDocument();
  const put = calls.filter((c) => c.key.startsWith("PUT"));
  expect(put.at(-1)?.body).toMatchObject({
    artifact_version: caseState.artifact_version,
    reference_revision: binding.reference_revision,
    model_revision: 0,
  });
});

test("proposes, needs review, saves and reopens a one-frame line-up", async () => {
  const calls = server({ model: true });
  const job = stubLineup(proposal());
  panel();
  await screen.findByText(/Model from this scan/);
  fireEvent.change(screen.getByLabelText("Frame source"), {
    target: { value: "phantom-run" },
  });
  fireEvent.click(screen.getByText("Open frames"));
  await screen.findByLabelText("First frame");
  // The plane has no stated geometry, so the operator enters the view.
  expect(screen.getByLabelText("First frame view")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Line up on bone"));
  expect(await screen.findByLabelText("Line-up proposal")).toHaveTextContent(
    "depth along its beam is not determined. Bone agreement 0.42, from 0.11",
  );
  const frames = job.mock.calls[0][0].frames;
  expect(frames).toHaveLength(1);
  expect(frames[0].isocenter).toEqual([1, 2, 3]);
  const save = screen.getByText("Confirm and save line-up");
  expect(save).toBeDisabled();
  fireEvent.click(
    screen.getByLabelText("I reviewed the bone and the model on the frame"),
  );
  fireEvent.click(save);
  await screen.findByText(/Saved operator-confirmed line-up, revision 1/);
  const body = calls.find(
    (c) =>
      c.key === `PUT /api/cases/${caseState.case_id}/bone-lineup-registration`,
  )?.body;
  expect(body.inputs).toMatchObject({
    confirmed: true,
    method: lineups.ABDOMINAL_LINEUP_METHOD,
    engine_method: "bone_edge_compass_v1",
    frame_source_id: "phantom-run",
    frame_manifest_revision: REVISION,
    depth: "not_determined_single_view",
    second_view: { status: "not_given" },
    model_revision: 1,
    model_sha256: modelCurrent.body_sha256,
    reported_start_score: 0.11,
    isocenter: [1, 2, 3],
    volume_to_carm_ras: MOVED,
    same_position: false,
  });
  expect(body.inputs.planes).toEqual([
    {
      plane: "single",
      frame_index: 12,
      frame_sha256: hex(gray),
      geometry_source: "operator_entered",
      view: expect.objectContaining({ primary_deg: 0 }),
      reported_score: 0.42,
    },
  ]);
  // Reopened: a fresh panel draws the saved overlay from the server alone.
  cleanup();
  panel();
  fireEvent.click(await screen.findByText("Show saved overlay"));
  expect(
    await screen.findByLabelText("Saved overlay on plane single, frame 12"),
  ).toBeInTheDocument();
  expect(screen.queryByText("Confirm and save line-up")).toBeNull();
});

test("says a second frame was set aside and why", () => {
  expect(
    lineupWords("not_determined_single_view", {
      status: "set_aside",
      reason: "moved_first_frame",
    }),
  ).toBe(
    "Placed across the frame from one frame; depth along its beam is not determined. The second frame was set aside: taking it would have moved the first frame off its bone.",
  );
  expect(lineupWords("two_views", { status: "not_given" })).toBe(
    "Placed in 3D from two frames.",
  );
});

test("proposes one wire and breathing correction over the saved line-up, drawn once confirmed", async () => {
  server({ model: true });
  stubLineup(proposal());
  panel();
  await screen.findByText(/Model from this scan/);
  fireEvent.change(screen.getByLabelText("Frame source"), {
    target: { value: "phantom-run" },
  });
  fireEvent.click(screen.getByText("Open frames"));
  await screen.findByLabelText("First frame");
  fireEvent.click(screen.getByText("Line up on bone"));
  await screen.findByLabelText("Line-up proposal");
  // Not over an unsaved proposal.
  expect(screen.queryByLabelText("Wire and breathing correction")).toBeNull();
  fireEvent.click(
    screen.getByLabelText("I reviewed the bone and the model on the frame"),
  );
  fireEvent.click(screen.getByText("Confirm and save line-up"));
  await screen.findByText(/Saved operator-confirmed line-up, revision 1/);
  // Reopened from the server alone.
  cleanup();
  panel();
  fireEvent.click(await screen.findByText("Show saved overlay"));
  await waitFor(() =>
    expect(screen.getByText("Show saved overlay")).toBeEnabled(),
  );
  const frame = await screen.findByLabelText(
    "Saved overlay on plane single, frame 12",
  );

  // One scan point is too few to fit breathing: the line-up stands.
  fireEvent.click(screen.getByLabelText("The scan point at the cursor"));
  fireEvent.click(frame, { clientX: 30, clientY: 20 });
  expect(screen.getByLabelText("Correction marks")).toHaveTextContent(
    "0 right iliac wire, 0 left iliac wire, 1 scan point marks.",
  );
  fireEvent.click(screen.getByText("Propose correction"));
  expect(screen.getByLabelText("Correction proposal")).toHaveTextContent(
    /^The line-up stands\. Too few marks/,
  );
  expect(screen.queryByText("Confirm correction")).toBeNull();

  // A second mark, and the engine's proposal is shown before it is drawn.
  const fitted = vi.spyOn(corrections, "proposeCorrection").mockReturnValue({
    method: corrections.CORRECTION_METHOD,
    status: "proposed",
    reason: null,
    params: { straighten: { right_iliac: 0, left_iliac: 0 }, shift_mm: 6 },
    rigid_rms_px: 9.2,
    corrected_rms_px: 1.4,
    marks: { wire: 0, landmarks: 2 },
  });
  fireEvent.click(frame, { clientX: 31, clientY: 40 });
  fireEvent.click(screen.getByText("Propose correction"));
  const input = fitted.mock.calls[0][0];
  expect(input.landmarks).toEqual([
    { ras: [1, 2, 3], pixel: [30, 20] },
    { ras: [1, 2, 3], pixel: [31, 40] },
  ]);
  // Breathing runs from the aorta's lowest point to its highest.
  expect(input.breathing).toEqual({ anchor_s: 0, full_s: 20 });
  expect(input.matrix).toEqual(MOVED);
  expect(screen.getByLabelText("Correction proposal")).toHaveTextContent(
    "Marks 9.2 px from the line-up alone, 1.4 px corrected: right iliac straightened 0%, left 0%, breathing 6.0 mm along the body.",
  );
  expect(
    screen.queryByLabelText(/corrected for wire and breathing/),
  ).toBeNull();
  fireEvent.click(screen.getByText("Confirm correction"));
  expect(
    screen.getByLabelText(
      "Saved overlay on plane single, frame 12, corrected for wire and breathing",
    ),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Correction proposal")).toHaveTextContent(
    /Confirmed for this view; not saved with the case\.$/,
  );
  fireEvent.click(screen.getByText("Undo correction"));
  expect(
    screen.getByLabelText("Saved overlay on plane single, frame 12"),
  ).toBeInTheDocument();
});
