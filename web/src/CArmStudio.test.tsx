import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { NVImage } from "@niivue/niivue";
import plans from "./__fixtures__/step-a-projection-plans.json";
import seriesFixtures from "./__fixtures__/step-a-projection-series.json";
import scenes from "./__fixtures__/phase4-reformat-scenes.json";
import CArmStudio from "./CArmStudio";
import { proposeLowForeshorteningAngles } from "./carmGeometry";
import type { Vec3 } from "./obliqueSlice";

vi.mock("./CArmProjectionView", () => ({
  default: (props: {
    view: unknown;
    isocenter: unknown;
    threshold: unknown;
    disabled: boolean;
  }) => (
    <div
      data-testid="projection"
      data-view={JSON.stringify(props.view)}
      data-isocenter={JSON.stringify(props.isocenter)}
      data-threshold={String(props.threshold)}
      data-disabled={String(props.disabled)}
    />
  ),
}));
const volume = {
  hdr: {
    dims: [3, 32, 32, 32, 1, 1, 1, 1],
    datatypeCode: 16,
    xyzt_units: 2,
    scl_slope: 1,
    scl_inter: 0,
  },
  getAffine: () => [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ],
  img: new Float32Array(32 ** 3).fill(100),
} as unknown as NVImage;
const binding = {
  case_id: plans.current.case_id,
  image_sha256: plans.current.image_sha256,
  reference_revision: plans.current.reference_revision,
};
const state = {
  ...binding,
  artifact_version: plans.current.artifact_version,
  spatial_units: "mm" as const,
};
const base = {
  caseState: state,
  binding,
  volume,
  windowRange: [0, 600] as [number, number],
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const inputs = plans.current.current.inputs;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness({
  cursor,
  onDirty,
}: {
  cursor: Vec3 | null;
  onDirty?: (dirty: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <CArmStudio
      {...base}
      cursor={cursor}
      disabled={busy}
      onBusy={setBusy}
      onDirtyChange={onDirty}
    />
  );
}
const click = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));
const field = (name: string | RegExp) =>
  screen.getByRole("textbox", { name }) as HTMLInputElement;
const type = (name: string | RegExp, value: string) =>
  fireEvent.change(field(name), { target: { value } });
function setView(view: (typeof inputs.views)[number]) {
  type("View name", view.name);
  type(/^Primary angle/, String(view.primary_deg));
  type(/^Secondary angle/, String(view.secondary_deg));
  type("Source to detector (mm)", String(view.source_detector_mm));
  type("Source to isocenter (mm)", String(view.source_isocenter_mm));
  type("Detector width (mm)", String(view.detector_width_mm));
  type("Detector height (mm)", String(view.detector_height_mm));
}
async function buildTarget(
  view: ReturnType<typeof render>,
  onDirty?: (dirty: boolean) => void,
) {
  await screen.findByText(/Plan revision 0 · not confirmed/);
  for (const point of inputs.target_path) {
    view.rerender(<Harness cursor={point as Vec3} onDirty={onDirty} />);
    click("Add crosshair to target path");
  }
  view.rerender(
    <Harness cursor={inputs.isocenter as Vec3} onDirty={onDirty} />,
  );
  click("Set isocenter to crosshair");
}

test("builds, confirms and saves the exact plan the server acknowledged", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json(plans.not_confirmed))
    .mockResolvedValueOnce(json(plans.current));
  vi.stubGlobal("fetch", fetch);
  const dirty = vi.fn();
  const view = render(<Harness cursor={null} onDirty={dirty} />);
  await screen.findByText(/Plan revision 0 · not confirmed/);
  view.rerender(<Harness cursor={null} onDirty={dirty} />);
  expect(
    screen.getByRole("button", { name: "Add crosshair to target path" }),
  ).toBeDisabled();
  await buildTarget(view, dirty);
  expect(screen.getByText(/Target path: 3 points · 10.0 mm/)).toHaveTextContent(
    "Isocenter: 10.0, 16.0, 16.0 mm (RAS)",
  );
  // AP sees only the 5 mm left-right leg of the 10 mm L-shaped target.
  expect(screen.getByLabelText("Live view readout")).toHaveTextContent(
    "LAO/RAO 0.0 / CRA/CAU 0.0 · foreshortening 50.0% · magnification 1.60 · target inside the detector field",
  );
  for (const planned of inputs.views) {
    setView(planned);
    click("Add view to plan");
  }
  const table = screen.getByRole("table");
  expect(within(table).getAllByText("draft")).toHaveLength(3);
  expect(
    within(table).getByRole("row", { name: /Working LAO/ }),
  ).toHaveTextContent("LAO 30.0 / CRA 20.0");
  const save = screen.getByRole("button", {
    name: "Confirm and save C-arm views",
  });
  expect(save).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: /I confirm/ }));
  fireEvent.click(save);
  await screen.findByText(/Plan revision 1 · current/);
  const [url, init] = fetch.mock.calls[1];
  expect(url).toBe(`/api/cases/${state.case_id}/projection-plan`);
  expect(init.method).toBe("PUT");
  expect(JSON.parse(init.body)).toEqual({
    artifact_version: state.artifact_version,
    reference_revision: binding.reference_revision,
    plan_revision: 0,
    inputs,
  });
  expect(within(screen.getByRole("table")).getAllByText("saved")).toHaveLength(
    3,
  );
  expect(
    within(screen.getByRole("table")).getByRole("row", { name: /^AP/ }),
  ).toHaveTextContent("50.0%");
  expect(dirty).toHaveBeenLastCalledWith(false);
  expect(dirty).toHaveBeenCalledWith(true);
});

test.each([
  [409, true],
  [503, true],
  [422, false],
])(
  "save failure %s locks the draft only when ambiguous",
  async (status, locked) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(plans.not_confirmed))
      .mockResolvedValueOnce(json({ detail: "no" }, status));
    vi.stubGlobal("fetch", fetch);
    const view = render(<Harness cursor={null} />);
    await buildTarget(view);
    click("Add view to plan");
    fireEvent.click(screen.getByRole("checkbox", { name: /I confirm/ }));
    click("Confirm and save C-arm views");
    await screen.findByText(
      locked
        ? /could not be confirmed. Reload saved views before retrying/
        : /rejected before saving. Correct the editable draft/,
    );
    expect(screen.getByText(/Plan revision 0/)).toBeInTheDocument();
    const add = screen.getByRole("button", {
      name: "Add crosshair to target path",
    });
    if (locked) expect(add).toBeDisabled();
    else expect(add).toBeEnabled();
    expect(fetch).toHaveBeenCalledTimes(2);
  },
);

test("an acknowledgement that differs from the draft is not accepted", async () => {
  const other = structuredClone(plans.current);
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json(plans.not_confirmed))
    .mockResolvedValueOnce(json(other));
  vi.stubGlobal("fetch", fetch);
  const view = render(<Harness cursor={null} />);
  await buildTarget(view);
  click("Add view to plan"); // one default view; the server echoes three
  fireEvent.click(screen.getByRole("checkbox", { name: /I confirm/ }));
  click("Confirm and save C-arm views");
  await screen.findByText(/could not be confirmed/);
  expect(screen.queryByText("saved")).toBeNull();
});

function Versioned({
  version,
  cursor,
}: {
  version: string;
  cursor: Vec3 | null;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <CArmStudio
      {...base}
      caseState={{ ...state, artifact_version: version }}
      cursor={cursor}
      disabled={busy}
      onBusy={setBusy}
    />
  );
}
const nextVersion = { ...plans.not_confirmed, artifact_version: "2" };
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("a late load for the previous case version cannot replace the newer draft", async () => {
  let answerOld!: (response: Response) => void;
  const fetch = vi
    .fn()
    .mockReturnValueOnce(new Promise<Response>((r) => (answerOld = r)))
    .mockResolvedValueOnce(json(nextVersion));
  vi.stubGlobal("fetch", fetch);
  const view = render(<Versioned version="1" cursor={null} />);
  view.rerender(<Versioned version="2" cursor={[10, 16, 16]} />);
  await screen.findByText(/Plan revision 0 · not confirmed/);
  // The saved plan of version 1 arrives after version 2 is on screen.
  answerOld(json(plans.current));
  await settle();
  expect(screen.getByText(/Plan revision 0 · not confirmed/)).toBeVisible();
  expect(screen.queryByText(/Plan revision 1/)).toBeNull();
  expect(screen.queryByRole("table")).toBeNull();
  expect(field("View name").value).not.toBe("AP");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Add crosshair to target path" }),
    ).toBeEnabled(),
  );
  click("Add crosshair to target path");
  expect(screen.getByText(/Plan revision 0 · unsaved draft/)).toBeVisible();
});

test.each([
  ["acknowledgement", () => json(plans.current)],
  ["failure", () => json({ detail: "unavailable" }, 503)],
])(
  "a late save %s for the previous case version is ignored",
  async (_name, answer) => {
    let acknowledge!: (response: Response) => void;
    const fetch = vi.fn((_url: string, init?: RequestInit) =>
      init?.method === "PUT"
        ? new Promise<Response>((r) => (acknowledge = r))
        : Promise.resolve(
            json(
              fetch.mock.calls.length === 1 ? plans.not_confirmed : nextVersion,
            ),
          ),
    );
    vi.stubGlobal("fetch", fetch);
    const view = render(<Versioned version="1" cursor={null} />);
    await screen.findByText(/Plan revision 0 · not confirmed/);
    for (const point of inputs.target_path) {
      view.rerender(<Versioned version="1" cursor={point as Vec3} />);
      click("Add crosshair to target path");
    }
    view.rerender(<Versioned version="1" cursor={inputs.isocenter as Vec3} />);
    click("Set isocenter to crosshair");
    for (const planned of inputs.views) {
      setView(planned);
      click("Add view to plan");
    }
    fireEvent.click(screen.getByRole("checkbox", { name: /I confirm/ }));
    click("Confirm and save C-arm views");
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    // The case version moves on while the write is still in flight.
    view.rerender(<Versioned version="2" cursor={null} />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    await screen.findByText(/Plan revision 0 · not confirmed/);
    acknowledge(answer());
    await settle();
    expect(screen.getByText(/Plan revision 0 · not confirmed/)).toBeVisible();
    expect(screen.queryByText(/Plan revision 1/)).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/could not be confirmed/)).toBeNull();
    await waitFor(() => expect(field("View name")).toBeEnabled());
  },
);

test("a saved plan loads as authoritative, and any edit returns it to draft", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(plans.current)));
  const dirty = vi.fn();
  render(<Harness cursor={[10, 16, 16]} onDirty={dirty} />);
  await screen.findByText(/Plan revision 1 · current/);
  const table = screen.getByRole("table");
  expect(within(table).getAllByText("saved")).toHaveLength(3);
  expect(field("View name").value).toBe("AP");
  click("Edit view Lateral");
  expect(field(/^Primary angle/).value).toBe("90");
  expect(field("Detector width (mm)").value).toBe("300");
  expect(
    JSON.parse(screen.getByTestId("projection").dataset.view!),
  ).toMatchObject({ primary_deg: 90, detector_width_mm: 300 });
  expect(dirty).toHaveBeenLastCalledWith(false);
  click("Remove view Working LAO");
  expect(screen.getByText(/Plan revision 1 · unsaved draft/)).toBeVisible();
  expect(within(screen.getByRole("table")).getAllByText("draft")).toHaveLength(
    2,
  );
  expect(dirty).toHaveBeenLastCalledWith(true);
  // Re-adding under an existing name updates in place instead of duplicating.
  type(/^Primary angle/, "80");
  click("Update view in plan");
  expect(
    within(screen.getByRole("table")).getByRole("row", { name: /Lateral/ }),
  ).toHaveTextContent("LAO 80.0");
  expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(3);
});

test("stale saved views are withheld and a failed load blocks editing", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(plans.stale)));
  const stale = render(
    <CArmStudio
      {...base}
      cursor={null}
      caseState={{ ...state, artifact_version: plans.stale.artifact_version }}
    />,
  );
  await screen.findByText(/belong to an earlier case revision/);
  expect(screen.queryByRole("table")).toBeNull();
  stale.unmount();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(json({ ...plans.current, plan_revision: 7.5 })),
  );
  render(<Harness cursor={null} />);
  await screen.findByText(/could not be loaded. Reload before editing/);
  expect(screen.queryByRole("button", { name: /Add crosshair/ })).toBeNull();
});

test("target and view admission errors are explained and change nothing", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(plans.not_confirmed)));
  const view = render(<Harness cursor={[40, 16, 16]} />);
  await screen.findByText(/Plan revision 0 · not confirmed/);
  click("Add crosshair to target path");
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Crosshair must be inside the verified RAS/mm image",
  );
  click("Set isocenter to crosshair");
  expect(screen.getByText(/Isocenter: not set/)).toBeInTheDocument();
  view.rerender(<Harness cursor={[5, 16, 16]} />);
  click("Add crosshair to target path");
  click("Add crosshair to target path"); // repeated point
  expect(screen.getByRole("alert")).toHaveTextContent("repeated point");
  expect(screen.getByText(/Target path: 1 point ·/)).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Add view to plan" }),
  ).toBeDisabled();
  view.rerender(<Harness cursor={[10, 16, 16]} />);
  click("Add crosshair to target path");
  click("Set isocenter to path centroid");
  expect(screen.getByText(/Isocenter: 7.5, 16.0, 16.0 mm/)).toBeInTheDocument();
  type("View name", "# heading");
  click("Add view to plan");
  expect(screen.getByRole("alert")).toHaveTextContent("View names use");
  type("View name", "Too close");
  type("Source to isocenter (mm)", "1200");
  expect(
    screen.getByText(/outside the supported C-arm geometry bounds/),
  ).toBeInTheDocument();
  expect(screen.getByTestId("projection").dataset.view).toBe("null");
  click("Add view to plan");
  expect(screen.getAllByRole("alert").at(-1)).toHaveTextContent(
    "isocenter must lie between",
  );
  expect(screen.getByText("No views in this plan yet.")).toBeInTheDocument();
  type("Source to isocenter (mm)", "750");
  for (let i = 1; i <= 8; i++) {
    type("View name", `V${i}`);
    click("Add view to plan");
  }
  type("View name", "V9");
  click("Add view to plan");
  expect(screen.getByRole("alert")).toHaveTextContent("at most 8 views");
  expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(9);
  type("Projection threshold (source intensity units)", "abc");
  expect(screen.getByTestId("projection").dataset.threshold).toBe("null");
});

test("the projection threshold is seeded from the window and then independent of it", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(plans.not_confirmed)));
  const view = render(<CArmStudio {...base} cursor={null} />);
  await screen.findByText(/Plan revision 0 · not confirmed/);
  const input = field("Projection threshold (source intensity units)");
  expect(input.value).toBe("300");
  expect(input).toHaveAccessibleDescription(
    /independent of it afterwards: changing the window or level does not change/,
  );
  view.rerender(<CArmStudio {...base} windowRange={[0, 100]} cursor={null} />);
  expect(input.value).toBe("300");
  expect(screen.getByTestId("projection").dataset.threshold).toBe("300");
});

test("the angle proposal fills the editor without touching the plan", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(plans.not_confirmed)));
  const view = render(<Harness cursor={null} />);
  await buildTarget(view);
  const expected = proposeLowForeshorteningAngles(inputs.target_path);
  click("Propose low-foreshortening angles");
  expect(field(/^Primary angle/).value).toBe(String(expected.primary_deg));
  expect(field(/^Secondary angle/).value).toBe(String(expected.secondary_deg));
  expect(screen.getByLabelText("Live view readout")).toHaveTextContent(
    `foreshortening ${expected.foreshortening_percent.toFixed(1)}%`,
  );
  expect(screen.getByText("No views in this plan yet.")).toBeInTheDocument();
  expect(screen.getByText(/does not consider vessel overlap/)).toBeVisible();
});

test("acquired run geometry is shown with its calibration gate and can seed the editor", async () => {
  const fetch = vi.fn(async (url: string) =>
    url.endsWith("/projection-plan")
      ? json(plans.not_confirmed)
      : url.endsWith("/synthetic-biplane")
        ? json(seriesFixtures.biplane)
        : url.endsWith("/synthetic-rotation")
          ? json(seriesFixtures.uncalibrated)
          : json({}, 404),
  );
  vi.stubGlobal("fetch", fetch);
  render(<Harness cursor={null} />);
  await screen.findByText(/Plan revision 0 · not confirmed/);
  expect(screen.getByText(/No angiographic frames are stored/)).toBeVisible();
  expect(screen.queryByText(/isocentric acquisition/)).toBeNull();
  type("Installed projection source ID", "synthetic-biplane");
  click("Load run geometry");
  await screen.findByText(/synthetic-biplane · synthetic · biplane/);
  // Classic XA has no isocenter attribute; the distance's origin is stated.
  expect(
    screen.getByText(/source-to-object distance \(0018,1111\)/),
  ).toHaveTextContent("holds only for an isocentric acquisition");
  expect(screen.getByRole("row", { name: /^A / })).toHaveTextContent(
    "RAO 30.5 / CRA 20.3",
  );
  click("Copy plane B geometry to the view editor");
  expect(field("View name").value).toBe("Run B");
  expect(field(/^Primary angle/).value).toBe("90");
  expect(field("Source to detector (mm)").value).toBe("1195");
  expect(field("Detector width (mm)").value).toBe("204.8");
  expect(screen.getByText("No views in this plan yet.")).toBeInTheDocument();
  type("Installed projection source ID", "synthetic-rotation");
  click("Load run geometry");
  await screen.findByText(
    /uncalibrated: imager pixel spacing, static positioner/,
  );
  expect(
    screen.getByRole("button", {
      name: "Copy plane SINGLE geometry to the view editor",
    }),
  ).toBeDisabled();
  type("Installed projection source ID", "missing-run");
  click("Load run geometry");
  await screen.findByText(/could not be verified/);
  expect(screen.queryByText(/synthetic-rotation ·/)).toBeNull();
  type("Installed projection source ID", "Bad Id");
  const before = fetch.mock.calls.length;
  click("Load run geometry");
  await screen.findByText(/could not be verified/);
  expect(fetch.mock.calls.length).toBe(before);
});

test("copies the current saved reformat path as the target", async () => {
  const identity = {
    case_id: scenes.current.case_id,
    image_sha256: scenes.current.image_sha256,
    artifact_version: scenes.current.artifact_version,
    reference_revision: scenes.current.reference_revision,
  };
  const empty = {
    ...identity,
    plan_revision: 0,
    current: { status: "not_confirmed" },
  };
  const fetch = vi.fn(async (url: string) =>
    url.endsWith("/projection-plan")
      ? json(empty)
      : json(
          url.endsWith("/reformat-scene") ? scenes.current : {},
          url.endsWith("/reformat-scene") ? 200 : 404,
        ),
  );
  vi.stubGlobal("fetch", fetch);
  render(
    <CArmStudio
      {...base}
      cursor={null}
      caseState={{ ...identity, spatial_units: "mm" }}
      binding={identity}
    />,
  );
  await screen.findByText(/Plan revision 0 · not confirmed/);
  click("Copy saved reformat path");
  const count = scenes.current.current.inputs.path.length;
  await screen.findByText(new RegExp(`Target path: ${count} points`));
  expect(screen.getByText(/unsaved draft/)).toBeInTheDocument();
});

test("a source without verified millimeter units gets no C-arm planning", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  render(
    <CArmStudio
      {...base}
      cursor={null}
      caseState={{ ...state, spatial_units: "unknown" as "mm" }}
    />,
  );
  expect(
    screen.getByText(/needs a verified millimeter source/),
  ).toBeInTheDocument();
  await waitFor(() => expect(fetch).not.toHaveBeenCalled());
});
