import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { NVImage } from "@niivue/niivue";
import geometry from "./fixtures/phase5-synthetic-confirmed-geometry.json";
import scenes from "./__fixtures__/phase4-reformat-scenes.json";
import ReformatStudio from "./ReformatStudio";

vi.mock("./NativeReformatView", () => ({ default: () => <div /> }));
const identity = Object.fromEntries(
  ["case_id", "image_sha256", "artifact_version", "reference_revision"].map((key) => [key, geometry[key as keyof typeof geometry]]),
) as Pick<typeof geometry, "case_id" | "image_sha256" | "artifact_version" | "reference_revision">;
const volume = {
  hdr: { dims: [3, 32, 32, 32, 1, 1, 1, 1], datatypeCode: 16, xyzt_units: 2, scl_slope: 1, scl_inter: 0 },
  getAffine: () => [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]],
  img: new Float32Array(32 ** 3),
} as unknown as NVImage;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function Owner({ dirty }: { dirty: (value: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  return <ReformatStudio caseState={{...identity, spatial_units:"mm"}} binding={identity}
    volume={volume} cursor={null} windowRange={[0,600]} disabled={busy} onBusy={setBusy} onDirtyChange={dirty} />;
}
function setup(raw: unknown = geometry) {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({...scenes.not_confirmed, ...identity})))
    .mockResolvedValueOnce(new Response(JSON.stringify(raw)));
  vi.stubGlobal("fetch", fetch);
  const dirty = vi.fn();
  render(<Owner dirty={dirty} />);
  return {fetch, dirty};
}
test("copies a real-producer confirmed neuro path as an unconfirmed editable scene draft", async () => {
  const {fetch, dirty} = setup();
  await screen.findByText(/Scene revision 0/);
  fireEvent.click(screen.getByRole("button", {name:"Copy saved neurovascular path"}));
  await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(geometry.operator_inputs.parent_path.length));
  expect(fetch.mock.calls[1][0]).toBe(`/api/cases/${identity.case_id}/morphometry`);
  expect(fetch.mock.calls.every((call) => call[1]?.method === "GET")).toBe(true);
  expect(dirty).toHaveBeenLastCalledWith(true);
  expect(screen.getByRole("checkbox", {name:/I confirm this path/})).not.toBeChecked();
  expect(screen.getByRole("button", {name:"Confirm and save scene"})).toBeDisabled();
});

test.each([
  ["stale geometry", (g: typeof geometry) => { g.current.status = "stale"; }],
  ["foreign source", (g: typeof geometry) => { g.image_sha256 = "a".repeat(64); }],
  ["contradictory nested result", (g: typeof geometry) => { g.current.result.image_sha256 = "a".repeat(64); }],
  ["contradictory dependency", (g: typeof geometry) => { g.current.dependencies.artifact_version = "99"; }],
  ["unknown units", (g: typeof geometry) => { g.current.result.spatial_units = "unknown"; }],
  ["unsupported producer", (g: typeof geometry) => { g.current.dependencies.calculation_version = "other"; }],
  ["outside source path", (g: typeof geometry) => { g.operator_inputs.parent_path[0] = [200, 200, 200]; }],
] as const)("rejects %s without adopting or confirming its path", async (_name, mutate) => {
  const changed = structuredClone(geometry);
  mutate(changed);
  const {fetch, dirty} = setup(changed);
  await screen.findByText(/Scene revision 0/);
  fireEvent.click(screen.getByRole("button", {name:"Copy saved neurovascular path"}));
  await screen.findByRole("alert");
  expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  expect(dirty).not.toHaveBeenCalledWith(true);
  expect(screen.getByRole("button", {name:"Confirm and save scene"})).toBeDisabled();
  expect(fetch).toHaveBeenCalledTimes(2);
});
