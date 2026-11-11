import type { NVImage } from "@niivue/niivue";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import fixtures from "./__fixtures__/phase4-reformat-scenes.json";
import type { Vec3 } from "./obliqueSlice";
import ReformatStudio from "./ReformatStudio";

const proposed = JSON.stringify([
  [1, 0, 0, 3],
  [0, 1, 0, -2],
  [0, 0, 1, 5],
  [0, 0, 0, 1],
]);
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
const secondary = { ...volume } as NVImage;
vi.mock("./NativeReformatView", () => ({ default: () => null }));
vi.mock("./secondarySource", () => ({
  loadSecondarySource: vi.fn(async (sourceId: string) => ({
    metadata: {
      // The server names the source it verified, which need not be the
      // text that was typed.
      source_id: sourceId === "alias-src" ? "real-src" : sourceId,
      image_sha256: "a".repeat(64),
      reference_revision: "b".repeat(64),
    },
    volume: secondary,
  })),
}));
vi.mock("./RegistrationProposal", () => ({
  default: (props: {
    primary: NVImage;
    secondary: NVImage;
    matrixText: string;
    disabled: boolean;
    secondaryWindow: [number, number];
    opacity: number;
    onPropose: (text: string) => void;
  }) => (
    <button
      type="button"
      data-testid="proposal"
      data-matrix={props.matrixText}
      data-disabled={String(props.disabled)}
      data-view={`${props.secondaryWindow.join(" ")} ${props.opacity}`}
      data-sources={String(
        props.primary === volume && props.secondary === secondary,
      )}
      onClick={() => props.onPropose(proposed)}
    >
      stub proposal
    </button>
  ),
}));
const binding = {
  case_id: fixtures.current.case_id,
  image_sha256: fixtures.current.image_sha256,
  reference_revision: fixtures.current.reference_revision,
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("a proposal is offered only for a verified secondary and lands as an unconfirmed draft edit", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify(fixtures.not_confirmed)));
  vi.stubGlobal("fetch", fetch);
  const onDirty = vi.fn();
  const studio = (disabled: boolean) => (
    <ReformatStudio
      caseState={{ ...binding, artifact_version: "1", spatial_units: "mm" }}
      binding={binding}
      volume={volume}
      cursor={[8, 8, 8] as Vec3}
      windowRange={[0, 600]}
      disabled={disabled}
      onDirtyChange={onDirty}
    />
  );
  const view = render(studio(false));
  await screen.findByText(/Scene revision 0/);
  expect(screen.queryByTestId("proposal")).toBeNull();
  fireEvent.change(screen.getByLabelText("Secondary source ID"), {
    target: { value: "second-src" },
  });
  // Typed but not loaded: nothing to register against yet.
  expect(screen.queryByTestId("proposal")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Load secondary" }));
  const stub = await screen.findByTestId("proposal");
  const matrix = screen.getByLabelText(
    "Secondary to primary rigid matrix",
  ) as HTMLTextAreaElement;
  expect(stub.dataset).toMatchObject({
    matrix: matrix.value,
    disabled: "false",
    sources: "true",
  });
  // A studio that stops taking edits also stops a running proposal.
  view.rerender(studio(true));
  expect(screen.getByTestId("proposal").dataset.disabled).toBe("true");
  view.rerender(studio(false));
  expect(screen.getByTestId("proposal").dataset.disabled).toBe("false");
  const confirm = screen.getByRole("checkbox", {
    name: /I confirm this path/,
  }) as HTMLInputElement;
  fireEvent.click(confirm);
  expect(confirm.checked).toBe(true);
  onDirty.mockClear();

  fireEvent.click(stub);
  expect(matrix.value).toBe(proposed);
  expect(screen.getByTestId("proposal").dataset.matrix).toBe(proposed);
  // A proposal is a draft edit: it withdraws the operator's confirmation
  // and saves nothing.
  expect(confirm.checked).toBe(false);
  expect(onDirty).toHaveBeenLastCalledWith(true);
  expect(fetch).toHaveBeenCalledTimes(1);

  // The draft is reviewed in the preview, so the controls it is drawn with
  // stay usable while the draft is unsaved. The saved view's stay closed.
  const slider = (name: string) =>
    screen.getByRole("slider", { name: new RegExp(`^${name}`) });
  expect(slider("Path station")).toBeDisabled();
  expect(slider("Lumen boundary threshold")).toBeDisabled();
  for (const [name, value] of [
    ["Secondary window low", "-50"],
    ["Secondary window high", "900"],
    ["Secondary opacity", "0.7"],
  ]) {
    expect(slider(name)).toBeEnabled();
    fireEvent.change(slider(name), { target: { value } });
  }
  expect(screen.getByTestId("proposal").dataset.view).toBe("-50 900 0.7");
  view.rerender(studio(true));
  expect(slider("Secondary opacity")).toBeDisabled();
  view.rerender(studio(false));
  expect(slider("Secondary opacity")).toBeEnabled();

  // A different source ID withdraws the proposal control with the secondary.
  fireEvent.change(screen.getByLabelText("Secondary source ID"), {
    target: { value: "other-src" },
  });
  expect(screen.queryByTestId("proposal")).toBeNull();
  expect(slider("Secondary opacity")).toBeDisabled();
  // Nor is it offered for a verified source that is not the one named.
  fireEvent.change(screen.getByLabelText("Secondary source ID"), {
    target: { value: "alias-src" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Load secondary" }));
  await screen.findByText("Secondary image verified · real-src");
  expect(screen.queryByTestId("proposal")).toBeNull();
  expect(slider("Secondary opacity")).toBeDisabled();
});
