import { useCallback, useEffect, useRef, useState } from "react";
import { api, type CaseState } from "./api";
import type { Point3 } from "./geometry";
import type { NVImage } from "@niivue/niivue";
import ObliqueSection from "./ObliqueSection";
import "./morphometry.css";

export type MorphometryBinding = {
  case_id: string;
  image_sha256: string;
  reference_revision: string;
};

type Vec3 = [number, number, number];

export type MorphometrySection = {
  max_diameter: number;
  min_diameter: number;
  equivalent_diameter?: number;
  area?: number;
  contour_world: number[][];
  plane_origin: Vec3;
  plane_normal: Vec3;
  spatial_units: string;
  validated_morphometry: boolean;
};

type CurrentEnvelope = {
  case_id: string;
  image_sha256: string;
  reference_revision: string;
  artifact_version: string;
  current: {
    status: "current";
    result_id: string;
    dependencies: {
      case_id: string;
      image_sha256: string;
      source_revision: string;
      artifact_version: string;
    };
    result: {
      spatial_units: string;
      validated_morphometry: boolean;
      clinical_validation: boolean;
      sac: {
        height: number;
        width: number;
        spatial_units: string;
        validated_morphometry: boolean;
      };
      neck: MorphometrySection;
      proximal_parent: MorphometrySection;
      distal_parent: MorphometrySection;
    };
  };
};

export type MorphometryEnvelope = Omit<CurrentEnvelope, "current"> & {
  current:
    | CurrentEnvelope["current"]
    | { status: "stale" | "not_computed"; result: null; result_id?: string };
};

const SECTIONS = ["neck", "proximal_parent", "distal_parent"] as const;
type SectionKey = (typeof SECTIONS)[number];
const SECTION_LABELS: Record<SectionKey, string> = {
  neck: "neck",
  proximal_parent: "proximal",
  distal_parent: "distal",
};

function isFinitePositive(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function isFiniteTriple(v: unknown): v is Vec3 {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((x) => typeof x === "number" && Number.isFinite(x))
  );
}

function validateSection(s: unknown): MorphometrySection | null {
  if (typeof s !== "object" || s === null) return null;
  const sec = s as Record<string, unknown>;
  if (!isFinitePositive(sec.max_diameter)) return null;
  if (!isFinitePositive(sec.min_diameter)) return null;
  if (
    sec.equivalent_diameter !== undefined &&
    !isFinitePositive(sec.equivalent_diameter)
  )
    return null;
  if (sec.area !== undefined && !isFinitePositive(sec.area)) return null;
  if (!isFiniteTriple(sec.plane_origin)) return null;
  if (!isFiniteTriple(sec.plane_normal)) return null;
  const n = sec.plane_normal;
  const norm = Math.hypot(n[0], n[1], n[2]);
  if (!Number.isFinite(norm) || norm === 0) return null;
  const contour = sec.contour_world;
  if (
    !Array.isArray(contour) ||
    contour.length < 3 ||
    contour.length > 4096 ||
    !contour.every(isFiniteTriple)
  )
    return null;
  if (sec.spatial_units !== "mm") return null;
  if (sec.validated_morphometry !== false) return null;
  return sec as unknown as MorphometrySection;
}

function validateEnvelope(
  payload: unknown,
  caseState: CaseState,
  binding: MorphometryBinding,
): MorphometryEnvelope | null {
  if (typeof payload !== "object" || payload === null) return null;
  const env = payload as MorphometryEnvelope;
  if (env.case_id !== binding.case_id) return null;
  if (env.image_sha256 !== binding.image_sha256) return null;
  if (env.reference_revision !== binding.reference_revision) return null;
  if (env.artifact_version !== caseState.artifact_version) return null;
  const cur = env.current;
  if (typeof cur !== "object" || cur === null) return null;
  if (
    (cur.status === "stale" || cur.status === "not_computed") &&
    cur.result === null
  )
    return env;
  if (cur.status !== "current") return null;
  const dep = cur.dependencies;
  if (typeof dep !== "object" || dep === null) return null;
  if (dep.case_id !== caseState.case_id) return null;
  if (dep.image_sha256 !== caseState.image_sha256) return null;
  if (dep.source_revision !== binding.reference_revision) return null;
  if (dep.artifact_version !== caseState.artifact_version) return null;
  const res = cur.result;
  if (typeof res !== "object" || res === null) return null;
  if (res.spatial_units !== "mm") return null;
  if (res.validated_morphometry !== false) return null;
  if (res.clinical_validation !== false) return null;
  const sac = res.sac;
  if (
    typeof sac !== "object" ||
    sac === null ||
    !isFinitePositive(sac.height) ||
    !isFinitePositive(sac.width) ||
    sac.spatial_units !== "mm" ||
    sac.validated_morphometry !== false
  )
    return null;
  for (const key of SECTIONS) {
    if (!validateSection(res[key])) return null;
  }
  return env;
}

function fmt(v: number): string {
  return v.toFixed(2);
}

type FetchState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error" }
  | { phase: "loaded"; scope: string; envelope: MorphometryEnvelope };

export default function MorphometryResults({
  caseState,
  binding,
  onFocus,
  disabled = false,
  nativeVolume = null,
  windowRange = [0, 600],
}: {
  caseState: CaseState;
  binding: MorphometryBinding | null;
  onFocus: (point: Point3) => void;
  disabled?: boolean;
  nativeVolume?: NVImage | null;
  windowRange?: [number, number];
}) {
  const [state, setState] = useState<FetchState>({ phase: "idle" });
  const epochRef = useRef(0);

  // Synchronous scope: any change to case/ref/version hides old numbers at
  // render time, before any effect runs.
  const scope =
    binding && !disabled && caseState.spatial_units === "mm"
      ? [
          binding.case_id,
          binding.image_sha256,
          binding.reference_revision,
          caseState.artifact_version,
        ].join(":")
      : null;

  const bound =
    !!binding &&
    binding.case_id === caseState.case_id &&
    binding.image_sha256 === caseState.image_sha256;

  const shown =
    state.phase === "loaded" && scope !== null && state.scope === scope
      ? state.envelope
      : null;
  const result =
    shown?.current.status === "current" ? shown.current.result : null;

  useEffect(() => {
    if (!scope || !bound || disabled) {
      setState({ phase: "idle" });
      return;
    }
    const epoch = ++epochRef.current;
    setState({ phase: "loading" });
    api<MorphometryEnvelope>(
      `/cases/${encodeURIComponent(binding.case_id)}/morphometry`,
    )
      .then((payload) => {
        if (epochRef.current !== epoch) return;
        const validated = validateEnvelope(payload, caseState, binding);
        if (!validated) {
          setState({ phase: "error" });
          return;
        }
        setState({ phase: "loaded", scope, envelope: validated });
      })
      .catch(() => {
        if (epochRef.current !== epoch) return;
        setState({ phase: "error" });
      });
    return () => {
      epochRef.current++;
    };
    // caseState/binding identity is captured per scope; refetch only on scope change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, bound, disabled]);

  const handleFocus = useCallback(
    (section: MorphometrySection) => {
      onFocus([
        section.plane_origin[0],
        section.plane_origin[1],
        section.plane_origin[2],
      ]);
    },
    [onFocus],
  );

  if (!scope || !bound || disabled) {
    return (
      <section className="morphometry" aria-label="Mask geometry">
        <header className="morphometry-header">
          <h3 className="morphometry-title">Mask geometry</h3>
          <span className="morphometry-badge morphometry-badge-idle">
            Not computed
          </span>
        </header>
        <p className="morphometry-subtitle">
          {caseState.spatial_units === "mm" && bound
            ? "Operator-defined planes · source mm"
            : "Calibrated mm source required"}
        </p>
      </section>
    );
  }

  let badge = "Not computed";
  let badgeClass = "morphometry-badge-idle";
  if (state.phase === "error") {
    badge = "Not computed";
  } else if (shown === null) {
    badge = state.phase === "loading" ? "Not computed" : "Not computed";
  } else if (shown.current.status === "stale") {
    badge = "Stale";
    badgeClass = "morphometry-badge-stale";
  } else if (shown.current.status === "current") {
    badge = "Current estimate";
    badgeClass = "morphometry-badge-current";
  }

  return (
    <section className="morphometry" aria-label="Mask geometry">
      <header className="morphometry-header">
        <h3 className="morphometry-title">Mask geometry</h3>
        <span className={`morphometry-badge ${badgeClass}`}>{badge}</span>
      </header>
      <p className="morphometry-subtitle">
        Operator-defined planes · source mm
      </p>
      <p className="morphometry-draft-note">
        Draft UI · not clinically validated
      </p>
      {result ? (
        <div className="morphometry-body">
          <dl className="morphometry-sac">
            <div>
              <dt>Sac height</dt>
              <dd>{fmt(result.sac.height)} mm</dd>
            </div>
            <div>
              <dt>Sac width</dt>
              <dd>{fmt(result.sac.width)} mm</dd>
            </div>
          </dl>
          {SECTIONS.map((key) => {
            const section = result[key];
            return (
              <div className="morphometry-section" key={key}>
                <h4 className="morphometry-section-title">
                  {SECTION_LABELS[key]} section
                </h4>
                <dl className="morphometry-scalars">
                  <div>
                    <dt>Max diameter</dt>
                    <dd>{fmt(section.max_diameter)} mm</dd>
                  </div>
                  <div>
                    <dt>Min diameter</dt>
                    <dd>{fmt(section.min_diameter)} mm</dd>
                  </div>
                  {section.equivalent_diameter !== undefined ? (
                    <div>
                      <dt>Equivalent diameter</dt>
                      <dd>{fmt(section.equivalent_diameter)} mm</dd>
                    </div>
                  ) : null}
                  {section.area !== undefined ? (
                    <div>
                      <dt>Area</dt>
                      <dd>{fmt(section.area)} mm²</dd>
                    </div>
                  ) : null}
                </dl>
                <ObliqueSection
                  section={section}
                  volume={nativeVolume}
                  windowRange={windowRange}
                />
                <button
                  type="button"
                  className="morphometry-focus"
                  onClick={() => handleFocus(section)}
                >
                  Locate {SECTION_LABELS[key]} origin
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
