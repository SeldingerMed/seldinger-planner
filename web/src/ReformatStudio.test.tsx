import workflows from "./__fixtures__/territory-path-workflows.json";
import { useState } from "react";
import { test, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
  cleanup,
} from "@testing-library/react";
import type { NVImage } from "@niivue/niivue";
import type { Vec3 } from "./obliqueSlice";
import fixtures from "./__fixtures__/phase4-reformat-scenes.json";
import ReformatStudio from "./ReformatStudio";
vi.mock("./NativeReformatView", () => ({
  default: ({ disabled }: { disabled: boolean }) => (
    <div data-testid="native-display" data-disabled={String(disabled)} />
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
  case_id: fixtures.current.case_id,
  image_sha256: fixtures.current.image_sha256,
  reference_revision: fixtures.current.reference_revision,
};
const state = {
  ...binding,
  artifact_version: "1",
  spatial_units: "mm" as const,
};
const props = {
  caseState: state,
  binding,
  volume,
  cursor: [8, 8, 8] as Vec3,
  windowRange: [0, 600] as [number, number],
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function Feedback({ cursor }: { cursor: Vec3 }) {
  const [busy, setBusy] = useState(false);
  return (
    <ReformatStudio
      {...props}
      cursor={cursor}
      disabled={busy}
      onBusy={setBusy}
    />
  );
}
function appendCursor() {
  fireEvent.click(screen.getByRole("button", { name: "Use viewer cursor" }));
  fireEvent.click(screen.getByRole("button", { name: "Append path point" }));
}
async function draft(rendered: ReturnType<typeof render>) {
  await screen.findByText(/Scene revision 0/);
  appendCursor();
  rendered.rerender(<Feedback cursor={[8, 8, 10]} />);
  appendCursor();
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I confirm this path/ }),
  );
}
test("real-parent busy feedback does not cancel a confirmed scene save", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(fixtures.not_confirmed)))
    .mockResolvedValueOnce(new Response(JSON.stringify(fixtures.current)));
  vi.stubGlobal("fetch", fetch);
  const view = render(<Feedback cursor={[8, 8, 8]} />);
  await draft(view);
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm and save scene" }),
  );
  await screen.findByText(/Scene revision 1/);
  const request = JSON.parse(fetch.mock.calls[1][1].body);
  expect(request.inputs.path).toEqual([
    [8, 8, 8],
    [8, 8, 10],
  ]);
  expect(request.inputs.confirmed).toBe(true);
  expect(request.scene_revision).toBe(0);
  expect(fetch.mock.calls[1][1].method).toBe("PUT");
});
test.each([409, 503])(
  "ambiguous save %s locks retries until authoritative reload",
  async (status) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(fixtures.not_confirmed)),
      )
      .mockResolvedValueOnce(new Response("{}", { status }))
      .mockResolvedValueOnce(new Response(JSON.stringify(fixtures.current)));
    vi.stubGlobal("fetch", fetch);
    const view = render(<Feedback cursor={[8, 8, 8]} />);
    await draft(view);
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm and save scene" }),
    );
    await screen.findByRole("alert");
    expect(
      screen.getByRole("button", { name: "Confirm and save scene" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Reload saved scene" }));
    await screen.findByText(/Scene revision 1/);
    expect(fetch).toHaveBeenCalledTimes(3);
  },
);
test("a proved pre-write422 preserves editable draft", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(fixtures.not_confirmed)),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 422 })),
  );
  const view = render(<Feedback cursor={[8, 8, 8]} />);
  await draft(view);
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm and save scene" }),
  );
  await screen.findByRole("alert");
  expect(
    screen.getByRole("button", { name: "Confirm and save scene" }),
  ).not.toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Append path point" }),
  ).not.toBeDisabled();
});
test("a real deferred old scene read cannot reactivate a changed case revision", async () => {
  let resolveOld!: (x: Response) => void;
  const old = new Promise<Response>((r) => {
    resolveOld = r;
  });
  const fetch = vi
    .fn()
    .mockReturnValueOnce(old)
    .mockResolvedValueOnce(new Response(JSON.stringify(fixtures.stale)));
  vi.stubGlobal("fetch", fetch);
  const view = render(<ReformatStudio {...props} />);
  view.rerender(
    <ReformatStudio
      {...props}
      caseState={{
        ...state,
        artifact_version: fixtures.stale.artifact_version,
      }}
    />,
  );
  await screen.findByText(/Scene revision 2/);
  await act(async () =>
    resolveOld(new Response(JSON.stringify(fixtures.current))),
  );
  expect(screen.queryByText(/Scene revision 1/)).not.toBeInTheDocument();
  expect(screen.getByText(/Scene revision 2/)).toBeInTheDocument();
});

test("an unmounted scene reader cannot clear a newer editor's dirty owner", async () => {
  let resolve!: (x: Response) => void;
  const pending = new Promise<Response>((r) => {
    resolve = r;
  });
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(pending));
  const dirty = vi.fn();
  const view = render(<ReformatStudio {...props} onDirtyChange={dirty} />);
  view.unmount();
  await act(async () =>
    resolve(new Response(JSON.stringify(fixtures.current))),
  );
  expect(dirty).not.toHaveBeenCalled();
});
test("editing a confirmed path stops playback instead of silently resuming it", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify(fixtures.current))),
  );
  render(<ReformatStudio {...props} />);
  await screen.findByText(/Scene revision 1/);
  fireEvent.click(screen.getByRole("button", { name: "Play flythrough" }));
  expect(
    screen.getByRole("button", { name: "Pause flythrough" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Clear path" }));
  expect(
    screen.getByRole("button", { name: "Play flythrough" }),
  ).toBeDisabled();
});

test.each(["coronary_pci", "aortic_peripheral"] as const)(
  "copies actual current saved %s path without automatically confirming it",
  async (mode) => {
    const workflow = workflows[mode];
    const sourceBinding = {
      case_id: workflow.case_id,
      image_sha256: workflow.image_sha256,
      reference_revision: workflow.reference_revision,
    };
    const initial = {
      ...fixtures.not_confirmed,
      ...sourceBinding,
      artifact_version: workflow.artifact_version,
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(initial)))
        .mockResolvedValueOnce(new Response(JSON.stringify(workflow))),
    );
    render(
      <ReformatStudio
        {...props}
        caseState={{
          ...sourceBinding,
          artifact_version: workflow.artifact_version,
          spatial_units: "mm",
        }}
        binding={sourceBinding}
      />,
    );
    await screen.findByText(/Scene revision 0/);
    fireEvent.click(
      screen.getByRole("button", {
        name:
          mode === "coronary_pci"
            ? "Copy saved coronary path"
            : "Copy saved aortic path",
      }),
    );
    await waitFor(() =>
      expect(screen.getAllByRole("listitem")).toHaveLength(
        workflow.current.inputs.path.length,
      ),
    );
    expect(
      screen.getByRole("checkbox", { name: /I confirm this path/ }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "Confirm and save scene" }),
    ).toBeDisabled();
  },
);

test("confirmation clears a previous pre-write error without losing the dirty draft", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(fixtures.not_confirmed)))
    .mockResolvedValueOnce(new Response("{}", { status: 422 }));
  vi.stubGlobal("fetch", fetch);
  const view = render(<Feedback cursor={[8, 8, 8]} />);
  await draft(view);
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm and save scene" }),
  );
  await screen.findByRole("alert");
  const confirmation = screen.getByRole("checkbox", {
    name: /I confirm this path/,
  });
  fireEvent.click(confirmation);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  fireEvent.click(confirmation);
  expect(
    screen.getByRole("button", { name: "Confirm and save scene" }),
  ).not.toBeDisabled();
  expect(fetch).toHaveBeenCalledTimes(2);
});

test("failed explicit reload releases a discarded draft's parent dirty lock", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(fixtures.not_confirmed)))
    .mockRejectedValueOnce(new Error("offline"));
  vi.stubGlobal("fetch", fetch);
  function Owner() {
    const [dirty, setDirty] = useState(false);
    const [busy, setBusy] = useState(false);
    return (
      <>
        <button disabled={dirty || busy}>Other workspace action</button>
        <ReformatStudio
          {...props}
          onDirtyChange={setDirty}
          onBusy={setBusy}
          disabled={busy}
        />
      </>
    );
  }
  render(<Owner />);
  await screen.findByText(/Scene revision 0/);
  appendCursor();
  expect(
    screen.getByRole("button", { name: "Other workspace action" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Reload saved scene" }));
  await screen.findByRole("alert");
  expect(
    screen.getByRole("button", { name: "Other workspace action" }),
  ).not.toBeDisabled();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId("native-display")).toHaveAttribute(
    "data-disabled",
    "true",
  );
});
