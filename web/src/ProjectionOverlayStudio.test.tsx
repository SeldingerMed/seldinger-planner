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
} from "@testing-library/react";
import {
  binding,
  bundleAnswer,
  caseState,
  currentAnswer,
  gray,
  hex,
  identity,
  maskBlob,
  maskEntry,
  medial,
  nifti,
  phantom,
  pivot,
  registrationAnswer,
  REVISION,
  savedInputs,
  SIDE,
  truth,
  VIEW,
  volume,
} from "./__fixtures__/overlayCase";
import type { Vec3 } from "./obliqueSlice";
import ProjectionOverlayStudio from "./ProjectionOverlayStudio";
import { projectRegistered } from "./projectionRegistration";
import * as overlayJobs from "./projectionOverlayJob";

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
  frame?: () => Response;
  mask?: () => Response;
  put?: (body: any) => Response;
};
/** A stand-in server. Every request is recorded as "METHOD path". */
function server(routes: Routes = {}) {
  const calls: { key: string; body: unknown }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET",
      body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ key: `${method} ${url}`, body });
    const base = `/api/cases/${identity.case_id}`;
    if (url === `${base}/projection-registration`)
      return method === "PUT"
        ? (routes.put ?? (() => json({}, 500)))(body)
        : (routes.registration ?? (() => json(registrationAnswer())))();
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
      )();
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
    /failed its integrity check and is not displayed/,
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
