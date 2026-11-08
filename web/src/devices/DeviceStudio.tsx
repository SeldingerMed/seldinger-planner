import { useEffect, useMemo, useState } from "react";
import type { CaseState } from "../api";
import DeviceScene, { type SceneMesh } from "./DeviceScene";
import PhysicsBench from "./PhysicsBench";
import NumericalPhysics from "./NumericalPhysics";
import CoordinateInput from "./CoordinateInput";
import { flowDiverter, intrasaccular, coilPack } from "./geometry";
import { binarySTL, lineTubes } from "./mesh";
import {
  DEVICE_CATALOG,
  comparePlacement,
  planeClearance,
  referenceOnly,
  resolveCoilPrimaryDiameterMm,
  type DeviceSpec,
  type PlanningAnatomy,
} from "./analysis";
import {
  bindingKey,
  restoreScenarios,
  saveScenario,
  type Placement,
  type Scenario,
  type SceneBinding,
  type Triple,
} from "./scenarios";
import "./devices.css";
import { sha256Hex } from "../browserCrypto";

type Props = {
  file: File | null;
  caseState: CaseState | null;
  sourceRevision: string | null;
  onClose: () => void;
};
const benchPath: Triple[] = Array.from({ length: 33 }, (_, i) => [
  5 * Math.sin((i * Math.PI) / 32),
  0,
  -30 + (i * 60) / 32,
]);
const initial: Placement = {
  deviceId: "surpass-elite",
  diameter: 4.5,
  length: 20,
  height: 4,
  center: [0, 0, 0],
  axis: [0, 0, 1],
  path: benchPath,
  offset: 0,
  roll: 0,
  coilLength: 100,
  braidAngle: 55,
};
const finite3 = (p: unknown): p is Triple =>
  Array.isArray(p) &&
  p.length === 3 &&
  p.every((v) => typeof v === "number" && Number.isFinite(v));
function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="ds-slider">
      <span>
        {label}
        <output>{Number(value.toFixed(2))}</output>
      </span>
      <input
        aria-label={label}
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(+e.target.value)}
      />
    </label>
  );
}
/**
 * Visualization-only coil wire radius for the procedural skeleton. The
 * catalog captures no verified per-SKU primary diameter for the coil
 * families, so this default is never a measured or sourced value; metrics
 * that need the real primary diameter are suppressed instead (see
 * resolveCoilPrimaryDiameterMm / comparePlacement).
 */
const ILLUSTRATIVE_COIL_WIRE_DIAMETER_MM = 0.25;
function model(device: DeviceSpec, p: Placement, angle: number) {
  if (device.category === "flow-diverter")
    return flowDiverter({
      path: p.path,
      startMm: p.offset,
      diameterMm: p.diameter,
      lengthMm: p.length,
      wireCount: device.displayWireCount,
      turns:
        (p.length * Math.tan((angle * Math.PI) / 180)) / (Math.PI * p.diameter),
    });
  if (device.category === "coil")
    return coilPack({
      center: p.center,
      axis: p.axis,
      sacDiameterMm: p.diameter,
      primaryDiameterMm:
        resolveCoilPrimaryDiameterMm(device, p) ??
        ILLUSTRATIVE_COIL_WIRE_DIAMETER_MM,
      lengthMm: p.coilLength,
    });
  return intrasaccular({
    center: p.center,
    axis: p.axis,
    diameterMm: p.diameter,
    heightMm: p.height,
    shape: device.shape as "web-sl" | "web-sls" | "contour",
    wireCount: device.displayWireCount,
  });
}
async function readJson(url: string) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok)
    throw new Error(
      "Saved anatomy is unavailable; use device bench or reload the case.",
    );
  return r.json();
}

export default function DeviceStudio({
  file,
  caseState,
  sourceRevision,
  onClose,
}: Props) {
  const [placement, setPlacement] = useState<Placement>(initial),
    [showReferences, setReferences] = useState(false),
    [view, setView] = useState<"bench" | "anatomy">("bench");
  const [layout, setLayout] = useState<"linked" | "volume">("volume"),
    [clip, setClip] = useState(2),
    [ctaOpacity, setCtaOpacity] = useState(0.12),
    [windowRange, setWindow] = useState<[number, number]>([0, 600]);
  const [loadedIdentity, setLoadedIdentity] = useState<string | null>(null);
  // Initial anatomy-load failures must be tracked separately from
  // operational errors (failed saves, scene errors) so a later failure
  // never disables already-loaded anatomy controls.
  const [loadError, setLoadError] = useState("");
  const [anatomy, setAnatomy] = useState<PlanningAnatomy | null>(null),
    [anatomyMeshes, setAnatomyMeshes] = useState<SceneMesh[]>([]),
    [showVessel, setShowVessel] = useState(true),
    [showSac, setShowSac] = useState(true);
  const [location, setLocation] = useState<Triple | null>(null),
    [focus, setFocus] = useState<Triple | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [scenarios, setScenarios] = useState<Scenario[]>([]),
    [compareId, setCompareId] = useState("");
  const [picked, setPicked] = useState<Triple[]>([]),
    [name, setName] = useState("Alternative 1"),
    [showCTA, setShowCTA] = useState(true),
    [zoom, setZoom] = useState(0.65);
  const device =
    DEVICE_CATALOG.devices.find((d) => d.id === placement.deviceId) ??
    DEVICE_CATALOG.devices[0];
  const angle = placement.braidAngle ?? 55;
  const identity = caseState
    ? `${caseState.case_id}:${caseState.image_sha256}:${caseState.artifact_version}:${sourceRevision}`
    : "bench";
  useEffect(() => {
    setLoadedIdentity(null);
    setAnatomy(null);
    setAnatomyMeshes([]);
    setScenarios([]);
    setView("bench");
    setPlacement(structuredClone(initial));
    setPicked([]);
    setLocation(null);
    setCompareId("");
    setError("");
    setLoadError("");
    if (!caseState || caseState.spatial_units !== "mm" || !sourceRevision)
      return;
    let active = true;
    setLoading(true);
    (async () => {
      try {
        const env = await readJson(
          `/api/cases/${caseState.case_id}/morphometry`,
        );
        if (
          env.case_id !== caseState.case_id ||
          env.image_sha256 !== caseState.image_sha256 ||
          env.artifact_version !== caseState.artifact_version ||
          env.reference_revision !== sourceRevision
        )
          throw new Error(
            "Anatomy snapshot changed. Reopen the case before planning.",
          );
        const cur = env.current,
          inputs = env.operator_inputs;
        if (
          cur?.status !== "current" ||
          cur.dependencies?.artifact_version !== caseState.artifact_version ||
          cur.dependencies?.image_sha256 !== caseState.image_sha256 ||
          cur.dependencies?.source_revision !== sourceRevision ||
          !cur.result_id ||
          cur.result?.spatial_units !== "mm" ||
          !inputs ||
          !Array.isArray(inputs.parent_path) ||
          inputs.parent_path.length < 2 ||
          !inputs.parent_path.every(finite3) ||
          !finite3(inputs.aneurysm_seed) ||
          !finite3(inputs.neck_normal)
        )
          throw new Error(
            "Compute current accepted-mask geometry first. Device bench remains available.",
          );
        const result = cur.result;
        const scalar = (x: unknown) =>
          typeof x === "number" && Number.isFinite(x) && x > 0 ? x : null;
        const a: PlanningAnatomy = {
          path: inputs.parent_path,
          sacWidth: scalar(result.sac?.width),
          sacHeight: scalar(result.sac?.height),
          neckWidth: scalar(result.neck?.max_diameter),
          proximalDiameter: scalar(result.proximal_parent?.equivalent_diameter),
          distalDiameter: scalar(result.distal_parent?.equivalent_diameter),
          sacVolume: scalar(result.sac?.volume),
          geometryResultId: cur.result_id,
          center: inputs.aneurysm_seed,
          neckOrigin: finite3(inputs.neck_origin)
            ? inputs.neck_origin
            : undefined,
          axis: inputs.neck_normal,
        };
        const entries = await readJson(
          `/api/cases/${caseState.case_id}/segmentations`,
        );
        const meshes: SceneMesh[] = [];
        for (const role of ["vessel", "aneurysm"]) {
          const e = entries.current?.[role];
          if (
            !e ||
            e.status !== "accepted" ||
            e.case_id !== caseState.case_id ||
            e.image_sha256 !== caseState.image_sha256 ||
            e.reference_revision !== sourceRevision ||
            cur.dependencies?.masks?.[role]?.mask_sha256 !== e.mask_sha256
          )
            throw new Error(
              "Accepted anatomy masks no longer match the geometry snapshot.",
            );
          const r = await fetch(
            `/api/cases/${caseState.case_id}/segmentations/${encodeURIComponent(e.candidate_id)}/surface`,
            { cache: "no-store" },
          );
          if (
            !r.ok ||
            r.headers.get("X-Mask-Sha256") !== e.mask_sha256 ||
            Number(r.headers.get("content-length")) > 2500084
          )
            throw new Error(
              "Accepted-mask surface unavailable. Reopen after the local API is updated.",
            );
          const bytes = await r.arrayBuffer();
          if (bytes.byteLength > 2500084 || bytes.byteLength < 134)
            throw new Error("Surface size rejected");
          const hash = await sha256Hex(bytes);
          if (hash !== r.headers.get("X-Surface-Sha256"))
            throw new Error("Anatomy surface integrity check failed");
          meshes.push({
            id: role,
            buffer: bytes,
            color:
              role === "vessel" ? [89, 199, 181, 255] : [247, 135, 110, 255],
            opacity: role === "vessel" ? 0.55 : 0.3,
          });
        }
        const after = await readJson(
          `/api/cases/${caseState.case_id}/morphometry`,
        );
        if (
          after.artifact_version !== env.artifact_version ||
          after.current?.result_id !== cur.result_id
        )
          throw new Error("Anatomy changed while loading planning scene.");
        if (active) {
          setLoadedIdentity(identity);
          setAnatomy(a);
          setAnatomyMeshes(meshes);
        }
      } catch (e) {
        if (active) {
          setLoadError((e as Error).message);
          setError((e as Error).message);
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [identity]);
  const binding: SceneBinding = useMemo(
    () => ({
      caseId: caseState?.case_id ?? "device-bench",
      imageSha: caseState?.image_sha256 ?? "none",
      artifactVersion: caseState?.artifact_version ?? "0",
      referenceRevision: sourceRevision ?? "none",
      catalogVersion: DEVICE_CATALOG.catalogVersion,
      geometryResultId:
        view === "anatomy"
          ? (anatomy?.geometryResultId ?? "none")
          : "device-bench",
    }),
    [identity, anatomy?.geometryResultId, view],
  );
  const storageKey = `seldinger-device-scenarios-v1:${bindingKey(binding)}`;
  useEffect(() => {
    try {
      setScenarios(restoreScenarios(localStorage.getItem(storageKey), binding));
    } catch {
      setScenarios([]);
    }
  }, [storageKey]);
  const report = useMemo(
    () =>
      comparePlacement(device, placement, view === "anatomy" ? anatomy : null),
    [device, placement, anatomy, view],
  );
  const selectedModel = useMemo(() => {
    try {
      return { value: model(device, placement, angle), error: "" };
    } catch (e) {
      return { value: null, error: (e as Error).message };
    }
  }, [device, placement, angle]);
  const compare = scenarios.find((s) => s.id === compareId);
  const clearance = useMemo(() => {
    if (
      view !== "anatomy" ||
      device.category === "flow-diverter" ||
      !selectedModel.value ||
      !anatomy?.neckOrigin ||
      !anatomy?.axis ||
      !anatomy?.center
    )
      return null;
    return planeClearance(
      selectedModel.value.surface?.points ?? selectedModel.value.lines.flat(),
      anatomy.neckOrigin,
      anatomy.axis,
      anatomy.center,
    );
  }, [view, device, selectedModel, anatomy]);
  const meshes = useMemo(() => {
    const rows: SceneMesh[] =
      view === "anatomy"
        ? anatomyMeshes.filter((m) =>
            m.id === "vessel" ? showVessel : showSac,
          )
        : [];
    if (selectedModel.value) {
      const g = selectedModel.value;
      rows.push({
        id: "selected-device",
        buffer: binarySTL(
          lineTubes(g.lines, device.category === "coil" ? 0.09 : 0.018, 5),
        ),
        color: [227, 233, 240, 255],
        opacity: 1,
      });
      if (g.surface)
        rows.push({
          id: "device-envelope",
          buffer: binarySTL(g.surface),
          color: [198, 212, 238, 255],
          opacity: 0.1,
        });
    }
    if (compare) {
      const d = DEVICE_CATALOG.devices.find(
        (d) => d.id === compare.placement.deviceId,
      );
      if (d)
        try {
          const g = model(
            d,
            compare.placement,
            compare.placement.braidAngle ?? 55,
          );
          rows.push({
            id: "comparison-device",
            buffer: binarySTL(lineTubes(g.lines, 0.025, 5)),
            color: [255, 192, 69, 255],
            opacity: 0.65,
          });
        } catch {
          /* Incompatible scenarios are never forced to render. */
        }
    }
    return rows;
  }, [
    view,
    anatomyMeshes,
    showVessel,
    showSac,
    selectedModel,
    device,
    compare,
    angle,
  ]);
  function update(p: Partial<Placement>) {
    setPlacement((v) => ({ ...v, ...p }));
  }
  function choose(d: DeviceSpec) {
    const s =
      d.sizes.find((s) => s.diameterMm === 4.5) ??
      d.sizes[Math.floor(d.sizes.length / 2)];
    update({
      deviceId: d.id,
      diameter: s?.diameterMm ?? 6,
      length: s?.lengthMm ?? 20,
      height: s?.heightMm ?? 4,
    });
  }
  function save() {
    try {
      const rows = saveScenario(scenarios, binding, placement, name);
      localStorage.setItem(storageKey, JSON.stringify(rows));
      setScenarios(rows);
      setName(`Alternative ${rows.length + 1}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const canAnatomy = !!(
    file &&
    loadedIdentity === identity &&
    !loadError &&
    !loading &&
    anatomy &&
    anatomyMeshes.length === 2 &&
    caseState?.spatial_units === "mm"
  );
  return (
    <section
      className="device-studio"
      role="dialog"
      aria-modal="true"
      aria-label="Device planning studio"
    >
      <header className="ds-header">
        <div>
          <span className="eyebrow">ANATOMY × DEVICE × APPROACH</span>
          <h1>Device planning studio</h1>
        </div>
        <div>
          <span className="ds-chip">
            {view === "bench"
              ? "DEVICE BENCH · not patient anatomy"
              : `CTA · revision ${caseState?.artifact_version}`}
          </span>
          <button onClick={onClose}>Close studio</button>
        </div>
      </header>
      <div className="ds-body">
        <aside className="ds-catalog">
          <h2>Device library</h2>
          <p>
            Authored procedural models, linked to manufacturer and FDA sources.
          </p>
          {["flow-diverter", "intrasaccular", "coil"].map((category) => (
            <div key={category}>
              <h3>{category.replaceAll("-", " ")}</h3>
              {DEVICE_CATALOG.devices
                .filter(
                  (d) =>
                    d.category === category &&
                    (showReferences || !referenceOnly(d)),
                )
                .map((d) => (
                  <button
                    key={d.id}
                    aria-pressed={d.id === device.id}
                    className={
                      d.id === device.id ? "ds-device selected" : "ds-device"
                    }
                    onClick={() => choose(d)}
                  >
                    <strong>{d.name}</strong>
                    <small>{d.manufacturer}</small>
                    <span>{d.usStatus}</span>
                  </button>
                ))}
            </div>
          ))}
          <label className="ds-check">
            <input
              type="checkbox"
              checked={showReferences}
              onChange={(e) => setReferences(e.target.checked)}
            />
            Show research and recalled references
          </label>
        </aside>
        <main className="ds-main">
          <div className="ds-toolbar">
            <button
              className={view === "bench" ? "selected" : ""}
              onClick={() => {
                setView("bench");
                setLayout("volume");
                update({
                  center: [0, 0, 0],
                  axis: [0, 0, 1],
                  path: benchPath,
                  offset: 0,
                });
              }}
            >
              Device bench
            </button>
            <button
              disabled={!canAnatomy}
              className={view === "anatomy" ? "selected" : ""}
              onClick={() => {
                setView("anatomy");
                setLayout("linked");
                if (anatomy)
                  update({
                    path: anatomy.path,
                    center: anatomy.center!,
                    axis: anatomy.axis!,
                    offset: 0,
                  });
              }}
            >
              Place in CTA
            </button>
            <button
              onClick={() =>
                setLayout((v) => (v === "linked" ? "volume" : "linked"))
              }
            >
              Toggle 3D / linked slices
            </button>
            {loading && <span role="status">Preparing accepted anatomy…</span>}
          </div>
          <div className="ds-canvas-wrap">
            <DeviceScene
              key={`${view}:${identity}:${showCTA}`}
              file={view === "anatomy" && showCTA ? file : null}
              meshes={meshes}
              clip={view === "anatomy" ? clip : 2}
              ctaOpacity={ctaOpacity}
              zoom={zoom}
              windowRange={windowRange}
              layout={layout}
              focus={focus}
              onLocation={setLocation}
              onError={setError}
            />
            <div className="ds-scene-caption">
              <strong>{device.name}</strong>
              <span>
                {device.wireCount
                  ? `${device.wireCount} wires per cited US source`
                  : "Display weave is illustrative"}{" "}
                · RAS mm · enhanced wire visibility
              </span>
            </div>
          </div>
          {(loadError || error || selectedModel.error) && (
            <p className="ds-warning" role="alert">
              {selectedModel.error || loadError || error}
            </p>
          )}
          <div className="ds-display">
            <Slider
              label="Scene zoom"
              value={zoom}
              min={0.3}
              max={6}
              step={0.05}
              onChange={setZoom}
            />
            <Slider
              label="CTA opacity (3D view)"
              value={ctaOpacity}
              min={0}
              max={1}
              step={0.02}
              onChange={setCtaOpacity}
            />
            <Slider
              label="CTA cutaway"
              value={clip}
              min={-1}
              max={2}
              step={0.05}
              onChange={setClip}
            />
            <button
              onClick={() =>
                setWindow((v) => (v[1] === 600 ? [0, 150] : [0, 600]))
              }
            >
              CTA / soft tissue
            </button>
            <label>
              <input
                type="checkbox"
                aria-label="CTA volume"
                disabled={view !== "anatomy"}
                checked={showCTA}
                onChange={(e) => {
                  setShowCTA(e.target.checked);
                  setLayout(e.target.checked ? "linked" : "volume");
                  setLocation(null);
                }}
              />
              CTA volume
            </label>
            <label>
              <input
                type="checkbox"
                checked={showVessel}
                onChange={(e) => setShowVessel(e.target.checked)}
              />
              Vessel surface
            </label>
            <label>
              <input
                type="checkbox"
                checked={showSac}
                onChange={(e) => setShowSac(e.target.checked)}
              />
              Sac surface
            </label>
          </div>
          <section className="ds-comparison">
            <h2>
              {view === "bench"
                ? "Saved bench examples"
                : "Saved anatomy alternatives"}
            </h2>
            <div className="ds-save">
              <input
                aria-label="Scenario name"
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
              />
              <button
                disabled={!selectedModel.value || report.blocked}
                onClick={save}
              >
                Save placement
              </button>
              <button
                onClick={() => {
                  setScenarios([]);
                  setCompareId("");
                  try {
                    localStorage.removeItem(storageKey);
                  } catch {}
                }}
              >
                Clear saved alternatives
              </button>
            </div>
            <div className="ds-scenarios">
              {scenarios.map((s) => (
                <article key={s.id}>
                  <strong>{s.name}</strong>
                  <span>
                    {
                      DEVICE_CATALOG.devices.find(
                        (d) => d.id === s.placement.deviceId,
                      )?.name
                    }
                  </span>
                  <small>
                    {s.placement.diameter} mm · {s.placement.length} mm ·{" "}
                    {s.placement.height} mm
                  </small>
                  <button
                    onClick={() => setPlacement(structuredClone(s.placement))}
                  >
                    Restore
                  </button>
                  <button
                    onClick={() =>
                      setCompareId((v) => (v === s.id ? "" : s.id))
                    }
                  >
                    {compareId === s.id
                      ? "Hide comparison"
                      : "Overlay comparison"}
                  </button>
                </article>
              ))}
            </div>
            <p>
              {view === "bench"
                ? "Bench examples are separate from anatomy placements. No bench placement is silently applied to a CTA."
                : "Saved in this browser, bound to this image, case revision and geometry result. Reopen after anatomy changes; older alternatives are not reused as current."}
            </p>
          </section>
        </main>
        <aside className="ds-inspector">
          <h2>{device.name}</h2>
          <p>{device.construction}</p>
          <p>{device.sizeCoverage}</p>
          {device.warning && <p className="ds-warning">{device.warning}</p>}
          {device.sizes.length > 0 && (
            <label>
              Captured source-listed nominal size
              <select
                aria-label="Source-listed nominal size"
                value={device.sizes.findIndex(
                  (s) =>
                    s.diameterMm === placement.diameter &&
                    (s.lengthMm === null || s.lengthMm === placement.length) &&
                    (s.heightMm === null || s.heightMm === placement.height),
                )}
                onChange={(e) => {
                  const s = device.sizes[+e.target.value];
                  if (s)
                    update({
                      diameter: s.diameterMm,
                      length: s.lengthMm ?? placement.length,
                      height: s.heightMm ?? placement.height,
                    });
                }}
              >
                <option value={-1}>
                  Exploratory geometry · no matching catalog size
                </option>
                {device.sizes.map((s, i) => (
                  <option key={i} value={i}>
                    {s.diameterMm} × {s.lengthMm ?? s.heightMm} mm{" "}
                    {s.sku ?? "(chart size, SKU not resolved)"}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Slider
            label={
              device.category === "coil"
                ? "Illustrative sac diameter (not coil SKU)"
                : "Device nominal diameter (mm)"
            }
            value={placement.diameter}
            min={2}
            max={12}
            step={0.25}
            onChange={(v) => update({ diameter: v })}
          />
          {device.category === "flow-diverter" ? (
            <>
              <Slider
                label="Device length (mm)"
                value={placement.length}
                min={5}
                max={50}
                step={1}
                onChange={(v) => update({ length: v })}
              />
              <Slider
                label="Illustrative braid angle (degrees)"
                value={angle}
                min={35}
                max={75}
                onChange={(v) => update({ braidAngle: v })}
              />
              <Slider
                label="Axial placement offset (mm)"
                value={placement.offset}
                min={0}
                max={15}
                step={0.5}
                onChange={(v) => update({ offset: v })}
              />
            </>
          ) : device.category === "coil" ? (
            <Slider
              label="Secondary coil length (mm)"
              value={placement.coilLength}
              min={20}
              max={400}
              step={10}
              onChange={(v) => update({ coilLength: v })}
            />
          ) : (
            <Slider
              label="Device height (mm)"
              value={placement.height}
              min={1}
              max={12}
              step={0.25}
              onChange={(v) => update({ height: v })}
            />
          )}
          {device.category !== "flow-diverter" &&
            (["R", "A", "S"] as const).map((axis, k) => (
              <label key={axis}>
                Center {axis} (mm)
                <CoordinateInput
                  label={`Center ${axis} (mm)`}
                  value={placement.center[k]}
                  onCommit={(v) => {
                    update({
                      center: placement.center.map((x, j) =>
                        j === k ? v : x,
                      ) as Triple,
                    });
                  }}
                />
              </label>
            ))}
          {view === "anatomy" && (
            <div className="ds-picking">
              <p>
                Crosshair RAS:{" "}
                {location?.map((x) => x.toFixed(2)).join(" / ") ??
                  "Click a linked CTA slice"}
              </p>
              <button
                disabled={!location}
                onClick={() => {
                  if (location) update({ center: [...location] });
                }}
              >
                Center device at crosshair
              </button>
              <button
                disabled={!location}
                onClick={() => {
                  if (location)
                    setPicked((v) => [...v.slice(-31), [...location]]);
                }}
              >
                Add path point
              </button>
              <button
                disabled={picked.length < 2}
                onClick={() => {
                  update({ path: structuredClone(picked) });
                  setPicked([]);
                }}
              >
                Use {picked.length} picked points as device path
              </button>
              <button onClick={() => setPicked([])}>Clear picked path</button>
              <button
                onClick={() => {
                  if (anatomy?.center) setFocus([...anatomy.center]);
                }}
              >
                Focus saved sac seed
              </button>
              <button
                disabled={!location}
                onClick={() => {
                  if (location) {
                    const v = location.map(
                      (x, k) => x - placement.center[k],
                    ) as Triple;
                    if (Math.hypot(...v) > 1e-5) update({ axis: v });
                  }
                }}
              >
                Aim device axis toward crosshair
              </button>
            </div>
          )}
          <details>
            <summary>Appearance and model boundaries</summary>
            <p>{device.appearance}</p>
            <p>{device.modelLimits}</p>
            <p>
              Wire display radius and unsupported braid pitch are visualization
              controls, not measured mechanical properties. The model does not
              simulate deployment forces.
            </p>
          </details>
          <NumericalPhysics
            caseState={view === "anatomy" && canAnatomy ? caseState : null}
            sourceRevision={
              view === "anatomy" && canAnatomy ? sourceRevision : null
            }
            geometryResultId={
              view === "anatomy" && canAnatomy
                ? (anatomy?.geometryResultId ?? null)
                : null
            }
          />
          <PhysicsBench
            key={`${device.id}:${bindingKey(binding)}`}
            category={device.category}
            diameter={placement.diameter}
            length={placement.length}
            coilLength={placement.coilLength}
          />
          <section className="ds-advice">
            <h3>Proactive planning checks</h3>
            {clearance && (
              <>
                <div className="ds-metric">
                  <span>Sampled envelope / operator neck plane</span>
                  <strong>{clearance.minimumMm.toFixed(2)} mm</strong>
                </div>
                <p>
                  {clearance.minimumMm < 0
                    ? "The modeled envelope crosses the operator neck plane toward the parent-vessel side. Inspect seating and protrusion before interpreting this placement."
                    : "Sampled model vertices lie on the sac-seed side of the operator plane. This does not establish containment or a neck seal."}
                </p>
              </>
            )}
            {report.metrics.map((m) => (
              <div className="ds-metric" key={m.label}>
                <span>{m.label}</span>
                <strong>
                  {m.value.toFixed(2)} {m.unit}
                </strong>
              </div>
            ))}
            <ul>
              {report.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
            <p>
              No clinical outcome probability is calculated. Patient-specific
              flow reduction requires a solved and validated flow model, not
              this geometric overlay.
            </p>
          </section>
          <details>
            <summary>Manufacturer / FDA evidence</summary>
            {device.sources.map((s, i) => (
              <p key={i}>
                <a href={s.url} target="_blank" rel="noreferrer">
                  {s.section} ↗
                </a>
              </p>
            ))}
            <small>Catalog {DEVICE_CATALOG.catalogVersion}</small>
          </details>
        </aside>
      </div>
    </section>
  );
}
