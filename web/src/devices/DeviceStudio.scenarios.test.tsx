import { useRef } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CaseState } from "../api";
import { sha256Hex } from "../browserCrypto";
import * as browserCrypto from "../browserCrypto";
import saves from "../fixtures/phase5-public-case013-scenario-saves.json";
import unresolved from "../fixtures/phase5-public-case013-unresolved-scenarios.json";
import workflow from "../fixtures/phase5-public-case013-device-workflow.json";
import numericalBrief from "../fixtures/phase5-public-case013-numerical.json";
import catalogue from "../fixtures/phase5-device-scenario-catalog.json";
import DeviceStudio from "./DeviceStudio";

// API fixtures are actual public case013 responses. Surface construction and
// WebGL are declared test doubles here, not model/browser execution evidence.
let sceneMount = 0;
vi.mock("./DeviceScene", () => ({ default: ({file,meshes}:{file:File|null;meshes:{id:string}[]}) => {
  const mount = useRef(++sceneMount);
  return <div data-testid="device-scene" data-mount={mount.current} data-has-file={String(file !== null)} data-mesh-ids={JSON.stringify(meshes.map((mesh)=>mesh.id))} />;
} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });
async function mount({save = false, saveStatus = 200, onClose = () => {}, scenarioSet = workflow.scenarios, geometry = workflow.geometry, geometryError = false, scenarioReady = Promise.resolve(), surfaceReady = Promise.resolve(), surfaceStatus = 200}:{save?:boolean;saveStatus?:number;onClose?:()=>void;scenarioSet?:unknown;geometry?:unknown;geometryError?:boolean;scenarioReady?:Promise<void>;surfaceReady?:Promise<void>;surfaceStatus?:number} = {}) {
  const bytes = new Uint8Array(200);
  const digest = await sha256Hex(bytes.buffer);
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/local-brief")) return Response.json(numericalBrief);
    if (url.endsWith("/morphometry")) return new Response(JSON.stringify(geometry));
    if (url.endsWith("/segmentations")) return new Response(JSON.stringify(workflow.segmentations));
    if (url.includes("/surface")) {
      await surfaceReady;
      if(surfaceStatus!==200) return Response.json({detail:"Unavailable"},{status:surfaceStatus});
      const role = url.includes(workflow.segmentations.current.vessel.candidate_id) ? "vessel" : "aneurysm";
      return new Response(bytes, {headers:{"X-Mask-Sha256":workflow.segmentations.current[role].mask_sha256,"X-Surface-Sha256":digest,"content-length":"200"}});
    }
    if (url.endsWith("/device-scenario-catalog")) return new Response(JSON.stringify(catalogue));
    if (url.endsWith("/device-scenarios") && init?.method === "PUT" && save) return new Response(JSON.stringify(saves.third_ack),{status:saveStatus});
    if (url.endsWith("/device-scenarios") && (!init?.method || init.method === "GET")) { await scenarioReady; return new Response(JSON.stringify(scenarioSet)); }
    throw new Error("Unexpected test fetch " + url);
  });
  vi.stubGlobal("fetch", fetch);
  const view = render(<DeviceStudio file={new File([""],"public-case013.nii.gz")} caseState={workflow.case as CaseState}
    sourceRevision={workflow.geometry.reference_revision} onClose={onClose} />);
  if (geometryError) await screen.findByText(/Compute current accepted-mask geometry first/);
  else if(surfaceStatus === 200) await waitFor(() => expect(screen.getByRole("button",{name:"Place in CTA"})).toBeEnabled());
  else await screen.findByText(/Accepted-mask surface unavailable/);
  return Object.assign(fetch,{view});
}
test.each(["aneurysm_seed", "neck_normal"])("rejects missing %s before placement adoption or mesh loads", async (field) => {
  const geometry = structuredClone(workflow.geometry);
  delete (geometry.operator_inputs as unknown as Record<string, unknown>)[field];
  const fetch = await mount({ geometry, geometryError: true });
  expect(screen.getByTestId("device-scene")).toHaveAttribute("data-has-file", "false");
  expect(screen.getByTestId("device-scene")).toHaveAttribute("data-mesh-ids", "[]");
  expect(screen.getByRole("button", { name: "Add alternative to draft" })).toBeDisabled();
  expect(fetch.mock.calls.some(([url]) => String(url).includes("/surface"))).toBe(false);
  expect(fetch.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
});

test("a stale initial set is clean until the operator creates a draft, which remains dirty on stale reload", async () => {
  const stale = {
    ...workflow.scenarios,
    current: { status: "stale", set_id: workflow.scenarios.current.set_id, scenarios: null, stale_reasons: ["device_scenario_dependencies_changed"] },
  };
  const fetch = await mount({ scenarioSet: stale });
  await screen.findByText(/Saved set is stale/);
  expect(screen.getByText(/0 scenario\(s\) in this draft/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Close studio" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: /^WEB SLTerumo/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Add alternative to draft" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Add alternative to draft" }));
  await screen.findByText(/1 scenario\(s\) in this draft/);
  expect(screen.getByRole("button", { name: "Close studio" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Reload saved scenarios" }));
  await waitFor(() => expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/device-scenarios"))).toHaveLength(2));
  await waitFor(() => expect(screen.getByRole("button", { name: "Reload saved scenarios" })).toBeEnabled());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(screen.getByRole("button", { name: "Close studio" })).toBeDisabled();
  expect(screen.getByText(/1 scenario\(s\) in this draft/)).toBeInTheDocument();
  expect(fetch.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
});

test("a pending initial scenario read does not trap a clean studio and late read cannot write", async () => {
  let release!: () => void;
  const scenarioReady = new Promise<void>(resolve => { release = resolve; });
  let unmountStudio = () => {};
  const onClose = vi.fn(() => unmountStudio());
  const fetch = await mount({ scenarioReady, onClose });
  unmountStudio = () => fetch.view.unmount();
  await waitFor(() => expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/device-scenarios"))).toHaveLength(1));
  expect(screen.getByRole("button", { name: "Close studio" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Close studio" }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId("device-scene")).not.toBeInTheDocument();
  await act(async () => { release(); await scenarioReady; });
  expect(screen.queryByText("Exploratory WEB SL")).not.toBeInTheDocument();
  expect(fetch.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
});

test("opens directly on source-bound anatomy when a calibrated case is already loaded", async () => {
  await mount();
  const sync = await screen.findByRole("region", {name:"Saved scenario set"});
  await within(sync).findByText(/saved revision 1/);
  expect(screen.getByText("Exploratory WEB SL")).toBeInTheDocument();
  expect(screen.getByText("7.26 mm")).toBeInTheDocument();
  await screen.findByText("103");
  expect(screen.getByRole("region", {name:"Saved numerical runs"})).toBeInTheDocument();
});

test("remounts the canvas when a pending native source replaces the surface-only scene", async () => {
  let release!: () => void;
  const surfaceReady = new Promise<void>(resolve => { release = resolve; });
  const mounting = mount({surfaceReady});
  const pending = await screen.findByTestId("device-scene");
  expect(pending).toHaveAttribute("data-has-file", "false");
  const prior = pending.getAttribute("data-mount");
  release(); await mounting;
  await waitFor(() => expect(screen.getByTestId("device-scene")).toHaveAttribute("data-has-file", "true"));
  expect(screen.getByTestId("device-scene").getAttribute("data-mount")).not.toBe(prior);
});

test("preserves an explicit switch to the bench while anatomy is loading", async () => {
  const mounting = mount();
  fireEvent.click(await screen.findByRole("button", {name:"Device bench"}));
  await mounting;
  expect(screen.getByRole("button", {name:"Device bench"})).toHaveClass("selected");
  expect(screen.queryByRole("region", {name:"Saved scenario set"})).not.toBeInTheDocument();
});

test("keeps unresolved and recalled imported models from silently restoring a normal device", async () => {
  await mount({scenarioSet:unresolved});
  fireEvent.click(screen.getByRole("button",{name:"Place in CTA"}));
  const unknown = (await screen.findByText("Unknown imported model")).closest("article")!;
  const recalled = screen.getByText("Recalled imported reference").closest("article")!;
  await waitFor(() => expect(screen.getAllByRole("button",{name:"Restore"})[0]).toBeEnabled());
  expect(within(unknown).getByRole("button",{name:"Restore"})).toBeDisabled();
  expect(within(unknown).getByRole("button",{name:"Overlay comparison"})).toBeDisabled();
  expect(within(recalled).getByRole("button",{name:"Restore"})).toBeDisabled();
  expect(within(recalled).getByRole("button",{name:"Overlay comparison"})).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox",{name:"Show research and recalled references"}));
  expect(within(recalled).getByRole("button",{name:"Restore"})).toBeEnabled();
  expect(within(unknown).getByRole("button",{name:"Restore"})).toBeDisabled();
});

test("hides previously loaded source imagery, anatomy meshes and alternatives immediately when units become ineligible", async () => {
  const fetch = await mount();
  fireEvent.click(screen.getByRole("button",{name:"Place in CTA"}));
  await screen.findByText("Exploratory WEB SL");
  await waitFor(() => expect(screen.getAllByRole("button",{name:"Restore"})[0]).toBeEnabled());
  expect(screen.getByTestId("device-scene")).toHaveAttribute("data-has-file","true");
  expect(screen.getByTestId("device-scene").getAttribute("data-mesh-ids")).toContain("vessel");
  fetch.view.rerender(<DeviceStudio file={new File([""],"public-case013.nii.gz")}
    caseState={{...workflow.case,spatial_units:"unknown"} as CaseState}
    sourceRevision={workflow.geometry.reference_revision} onClose={() => {}} />);
  expect(screen.getByTestId("device-scene")).toHaveAttribute("data-has-file","false");
  expect(screen.getByTestId("device-scene")).toHaveAttribute("data-mesh-ids","[]");
  expect(screen.queryByText("Exploratory WEB SL")).not.toBeInTheDocument();
});

test("initial surface HTTP failure leaves anatomy imagery and controls unavailable", async () => {
  const fetch=await mount({surfaceStatus:500});
  await screen.findByText(/Accepted-mask surface unavailable/);
  expect(screen.getByTestId("device-scene")).toHaveAttribute("data-has-file","false");
  expect(screen.getByTestId("device-scene")).toHaveAttribute("data-mesh-ids","[]");
  expect(screen.queryByText("Exploratory WEB SL")).not.toBeInTheDocument();
  expect(screen.getByRole("button",{name:"Add alternative to draft"})).toBeDisabled();
  expect(fetch.mock.calls.filter(([,init])=>init?.method==="PUT")).toHaveLength(0);
});
test("source revision replacement hides loaded data and an authoritative same-revision return restores it", async () => {
  const fetch=await mount();
  await screen.findByText("Exploratory WEB SL");
  await screen.findByText("103");
  fetch.view.rerender(<DeviceStudio file={new File([""],"public-case013.nii.gz")} caseState={workflow.case as CaseState}
    sourceRevision={"a".repeat(64)} onClose={()=>{}}/>);
  expect(screen.getByTestId("device-scene")).toHaveAttribute("data-has-file","false");
  expect(screen.getByTestId("device-scene")).toHaveAttribute("data-mesh-ids","[]");
  expect(screen.queryByText("Exploratory WEB SL")).not.toBeInTheDocument();
  expect(screen.queryByText("103")).not.toBeInTheDocument();
  await screen.findByText(/Anatomy snapshot changed/);
  fetch.view.rerender(<DeviceStudio file={new File([""],"public-case013.nii.gz")} caseState={workflow.case as CaseState}
    sourceRevision={workflow.geometry.reference_revision} onClose={()=>{}}/>);
  await screen.findByText("Exploratory WEB SL");
  await screen.findByText("103");
  expect(screen.getByTestId("device-scene")).toHaveAttribute("data-has-file","true");
  expect(fetch.mock.calls.filter(([,init])=>init?.method==="PUT")).toHaveLength(0);
});

test("actual studio reads server alternatives and restores and overlays them without local persistence", async () => {
  const writeLocal = vi.spyOn(Storage.prototype,"setItem");
  const fetch = await mount();
  fireEvent.click(screen.getByRole("button",{name:"Place in CTA"}));
  const sync = await screen.findByRole("region",{name:"Saved scenario set"});
  await within(sync).findByText(/saved revision 1/);
  expect(screen.getByText("Exploratory WEB SL")).toBeInTheDocument();
  expect(screen.getByText("Exploratory WEB SLS")).toBeInTheDocument();
  const first = within(screen.getByText("Exploratory WEB SL").closest("article")!);
  expect(first.getByText("4 mm diameter × 2 mm height")).toBeInTheDocument();
  expect(first.queryByText(/20 mm/)).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getAllByRole("button",{name:"Restore"})[0]).toBeEnabled());
  fireEvent.click(screen.getAllByRole("button",{name:"Restore"})[0]);
  expect(screen.getByRole("heading",{name:"WEB SL"})).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole("button",{name:"Overlay comparison"})[1]);
  expect(screen.getByRole("button",{name:"Hide comparison"})).toBeInTheDocument();
  expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/device-scenarios"))).toBe(true);
  expect(writeLocal).not.toHaveBeenCalled();
});

test("keeps an added anatomy alternative dirty until explicit source-bound server acknowledgement", async () => {
  vi.spyOn(browserCrypto,"newRandomId").mockReturnValue("public-ui-test-third");
  const fetch = await mount({save:true});
  fireEvent.click(screen.getByRole("button",{name:"Place in CTA"}));
  await screen.findByText("Exploratory WEB SL");
  await waitFor(() => expect(screen.getAllByRole("button",{name:"Restore"})[0]).toBeEnabled());
  fireEvent.click(screen.getAllByRole("button",{name:"Restore"})[0]);
  fireEvent.change(screen.getByRole("textbox",{name:"Scenario name"}),{target:{value:"Third API alternative"}});
  fireEvent.click(screen.getByRole("button",{name:"Add alternative to draft"}));
  expect(screen.getByText("Third API alternative")).toBeInTheDocument();
  expect(fetch.mock.calls.filter(([,init]) => init?.method === "PUT")).toHaveLength(0);
  expect(screen.getByRole("button",{name:"Device bench"})).toBeDisabled();
  expect(screen.getByRole("button",{name:"Close studio"})).toBeDisabled();
  fireEvent.click(screen.getByRole("button",{name:"Save scenario set"}));
  await screen.findByText(/Saved revision 2: 3/);
  const put = fetch.mock.calls.find(([,init]) => init?.method === "PUT")!;
  expect(JSON.parse(String(put[1]?.body))).toEqual(saves.third_request);
  await waitFor(() => expect(screen.getByRole("button",{name:"Close studio"})).toBeEnabled());
});

test("a failed anatomy save locks repeated writes but permits explicit local-draft discard and exit", async () => {
  const onClose = vi.fn();
  const fetch = await mount({save:true,saveStatus:503,onClose});
  fireEvent.click(screen.getByRole("button",{name:"Place in CTA"}));
  await screen.findByText("Exploratory WEB SL");
  await waitFor(() => expect(screen.getAllByRole("button",{name:"Restore"})[0]).toBeEnabled());
  fireEvent.click(screen.getAllByRole("button",{name:"Restore"})[0]);
  fireEvent.click(screen.getByRole("button",{name:"Add alternative to draft"}));
  fireEvent.click(screen.getByRole("button",{name:"Save scenario set"}));
  await screen.findByText(/save request failed/i);
  expect(screen.getByRole("button",{name:"Save scenario set"})).toBeDisabled();
  expect(screen.getByRole("button",{name:"Add alternative to draft"})).toBeDisabled();
  fireEvent.click(screen.getByRole("button",{name:"Discard local draft and close"}));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls.filter(([,init]) => init?.method === "PUT")).toHaveLength(1);
});
