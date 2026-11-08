import { useEffect, useRef, useState } from "react";
import { api } from "../api";

/**
 * Hypothetical-parameter solved-numerics panel. Every parameter is an
 * operator-typed draft string; nothing is defaulted from device or
 * manufacturer data and nothing here has clinical validation.
 */

type CaseLike = {
  case_id: string;
  image_sha256: string;
  artifact_version: string;
  spatial_units: string;
};

type Scope = {
  caseId: string;
  imageHash: string;
  artifactVersion: string;
  sourceRevision: string;
  geometryResultId: string;
};

type Vec3 = [number, number, number];

type RodResult = {
  method: string;
  clinical_validation: boolean;
  device_calibrated: boolean;
  optimizer_success: boolean;
  iterations: number;
  energy_initial_n_mm: number;
  energy_final_n_mm: number;
  max_penetration_mm: number;
  minimum_nodal_wall_clearance_mm: number;
  points_ras: number[][];
  job_sha256: string;
};

type StokesResult = {
  method: string;
  clinical_validation: boolean;
  device_calibrated: boolean;
  baseline_mean_sac_speed_mm_s: number;
  treated_mean_sac_speed_mm_s: number;
  relative_sac_speed_change_pct: number;
  solver_diagnostics: {
    baseline: Residuals;
    treated: Residuals;
  };
  job_sha256: string;
};

type Residuals = {
  momentum_residual_relative: number;
  discrete_continuity_residual: number;
  divergence_l2: number;
};

const hex64 = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

const nonNegative = (v: unknown): v is number => finite(v) && v >= 0;

function parseDraft(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function sameParameters(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => sameParameters(v, b[i]));
  if (a === null || b === null) return a === b;
  if (typeof a === "object" && typeof b === "object" && a && b) {
    const ka = Object.keys(a as object).sort(),
      kb = Object.keys(b as object).sort();
    if (ka.join(",") !== kb.join(",")) return false;
    return ka.every((k) =>
      sameParameters(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      ),
    );
  }
  return a === b;
}

function validateResiduals(r: unknown): boolean {
  return (
    typeof r === "object" &&
    r !== null &&
    [
      "momentum_residual_relative",
      "discrete_continuity_residual",
      "divergence_l2",
    ].every((key) => nonNegative((r as Record<string, unknown>)[key]))
  );
}

function validateRod(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const r = result as Record<string, unknown>;
  return (
    r.method === "discrete_elastic_rod_native_lumen" &&
    r.clinical_validation === false &&
    r.device_calibrated === false &&
    typeof r.optimizer_success === "boolean" &&
    Number.isInteger(r.iterations) &&
    (r.iterations as number) >= 0 &&
    (r.iterations as number) <= 150 &&
    nonNegative(r.energy_initial_n_mm) &&
    nonNegative(r.energy_final_n_mm) &&
    nonNegative(r.max_penetration_mm) &&
    finite(r.minimum_nodal_wall_clearance_mm) &&
    Array.isArray(r.points_ras) &&
    r.points_ras.length >= 4 &&
    r.points_ras.length <= 32 &&
    r.points_ras.every(
      (p) => Array.isArray(p) && p.length === 3 && p.every((x) => finite(x)),
    ) &&
    hex64(r.job_sha256)
  );
}

function validateStokes(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const r = result as Record<string, unknown>;
  const d = r.solver_diagnostics as Record<string, unknown> | undefined;
  return (
    r.method === "taylor_hood_native_voxel_stokes_brinkman" &&
    r.clinical_validation === false &&
    r.device_calibrated === false &&
    finite(r.baseline_mean_sac_speed_mm_s) &&
    (r.baseline_mean_sac_speed_mm_s as number) > 0 &&
    nonNegative(r.treated_mean_sac_speed_mm_s) &&
    finite(r.relative_sac_speed_change_pct) &&
    Math.abs(
      (r.relative_sac_speed_change_pct as number) -
        (100 *
          ((r.treated_mean_sac_speed_mm_s as number) -
            (r.baseline_mean_sac_speed_mm_s as number))) /
          (r.baseline_mean_sac_speed_mm_s as number),
    ) <=
      1e-8 * Math.max(1, Math.abs(r.relative_sac_speed_change_pct as number)) &&
    typeof d === "object" &&
    d !== null &&
    validateResiduals(d.baseline) &&
    validateResiduals(d.treated) &&
    hex64(r.job_sha256)
  );
}

function metric(value: unknown): string {
  return Number((value as number).toPrecision(4)).toString();
}

function inputProps(value: string, onChange: (v: string) => void) {
  return {
    type: "text",
    inputMode: "decimal" as const,
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      onChange(e.target.value),
  };
}

export default function NumericalPhysics({
  caseState,
  sourceRevision,
  geometryResultId,
}: {
  caseState: CaseLike | null;
  sourceRevision: string | null;
  geometryResultId: string | null;
}) {
  const [mode, setMode] = useState<"rod" | "stokes">("rod");
  const [rodDraft, setRodDraft] = useState({
    radius_mm: "",
    ea_n: "",
    ei_n_mm2: "",
    contact_stiffness_n_per_mm: "",
  });
  const [flowDraft, setFlowDraft] = useState({
    flow_axis: "",
    inlet_velocity_mm_s: "",
    viscosity_pa_s: "",
    resistance_pa_s_per_mm2: "",
    neck_thickness_mm: "",
  });
  const [error, setError] = useState("");
  const [result, setResult] = useState<{
    scopeKey: string;
    parameterKey: string;
    current: Record<string, unknown>;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);

  const scope: Scope | null =
    caseState &&
    caseState.spatial_units === "mm" &&
    sourceRevision &&
    geometryResultId
      ? {
          caseId: caseState.case_id,
          imageHash: caseState.image_sha256,
          artifactVersion: caseState.artifact_version,
          sourceRevision,
          geometryResultId,
        }
      : null;

  // Any scope change immediately suppresses a rendered result.
  useEffect(() => {
    epoch.current += 1;
    setResult(null);
    setError("");
  }, [
    caseState?.case_id,
    caseState?.image_sha256,
    caseState?.artifact_version,
    caseState?.spatial_units,
    sourceRevision,
    geometryResultId,
  ]);

  function clearResult(invalidate = true) {
    if (invalidate) epoch.current += 1;
    setResult(null);
    setError("");
  }

  const rodParams = (() => {
    const p = {
      radius_mm: parseDraft(rodDraft.radius_mm),
      ea_n: parseDraft(rodDraft.ea_n),
      ei_n_mm2: parseDraft(rodDraft.ei_n_mm2),
      contact_stiffness_n_per_mm: parseDraft(
        rodDraft.contact_stiffness_n_per_mm,
      ),
    };
    if (Object.values(p).some((v) => v === null)) return null;
    return p.radius_mm! > 0 &&
      p.radius_mm! <= 5 &&
      p.ea_n! > 0 &&
      p.ea_n! <= 100000 &&
      p.ei_n_mm2! >= 0 &&
      p.ei_n_mm2! <= 100000 &&
      p.contact_stiffness_n_per_mm! > 0 &&
      p.contact_stiffness_n_per_mm! <= 100000
      ? { ...p, rest_points_ras: null }
      : null;
  })();

  const flowParams = (() => {
    const p = {
      flow_axis: parseDraft(flowDraft.flow_axis),
      inlet_velocity_mm_s: parseDraft(flowDraft.inlet_velocity_mm_s),
      viscosity_pa_s: parseDraft(flowDraft.viscosity_pa_s),
      resistance_pa_s_per_mm2: parseDraft(flowDraft.resistance_pa_s_per_mm2),
      neck_thickness_mm: parseDraft(flowDraft.neck_thickness_mm),
    };
    if (Object.values(p).some((v) => v === null)) return null;
    const axis = p.flow_axis as number;
    return Number.isInteger(axis) &&
      axis >= 0 &&
      axis <= 2 &&
      p.inlet_velocity_mm_s! > 0 &&
      p.inlet_velocity_mm_s! <= 1000 &&
      p.viscosity_pa_s! >= 1e-6 &&
      p.viscosity_pa_s! <= 1 &&
      p.resistance_pa_s_per_mm2! >= 0 &&
      p.resistance_pa_s_per_mm2! <= 100 &&
      p.neck_thickness_mm! > 0 &&
      p.neck_thickness_mm! <= 20
      ? p
      : null;
  })();

  const params = mode === "rod" ? rodParams : flowParams;
  const ready = !!scope && !!params && !busy;
  const visibleResult =
    scope &&
    result?.scopeKey === JSON.stringify(scope) &&
    result?.parameterKey === JSON.stringify(params)
      ? result.current
      : null;

  async function compute() {
    if (!ready || !scope || !params) return;
    const requestEpoch = ++epoch.current;
    const kind = mode === "rod" ? "rod-deployment" : "stokes-flow";
    const sent = { ...params };
    setBusy(true);
    clearResult(false);
    try {
      const env = (await api<Record<string, unknown>>(
        `/cases/${scope.caseId}/physics/${kind}`,
        {
          artifact_version: scope.artifactVersion,
          reference_revision: scope.sourceRevision,
          geometry_result_id: scope.geometryResultId,
          parameters: sent,
        },
        "POST",
      )) as Record<string, unknown>;
      const cur = env.current as Record<string, unknown> | undefined;
      const deps = cur?.dependencies as Record<string, unknown> | undefined;
      const valid =
        env.case_id === scope.caseId &&
        env.image_sha256 === scope.imageHash &&
        env.artifact_version === scope.artifactVersion &&
        env.reference_revision === scope.sourceRevision &&
        env.kind === kind &&
        cur?.status === "current" &&
        typeof cur.result_id === "string" &&
        hex64(cur.parameters_sha256) &&
        deps?.case_id === scope.caseId &&
        deps?.geometry_result_id === scope.geometryResultId &&
        deps?.source_revision === scope.sourceRevision &&
        deps?.image_sha256 === scope.imageHash &&
        deps?.artifact_version === scope.artifactVersion &&
        sameParameters(cur.parameters, sent) &&
        (kind === "rod-deployment"
          ? validateRod(cur.result)
          : validateStokes(cur.result));
      if (epoch.current !== requestEpoch) return; // a newer request superseded this one
      if (!valid) {
        setResult(null);
        setError(
          "Response did not match the solved-numerics contract; not rendered.",
        );
        return;
      }
      setResult(
        cur
          ? {
              scopeKey: JSON.stringify(scope),
              parameterKey: JSON.stringify(sent),
              current: structuredClone(cur),
            }
          : null,
      );
      setError("");
    } catch (e) {
      if (epoch.current !== requestEpoch) return;
      setResult(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="ds-numerical-physics">
      <summary>Solved numerics (hypothetical, nonclinical)</summary>
      <p>
        Operator-typed hypothetical parameters only. No device default,
        manufacturer value or calibrated property is used. Results are research
        solves, not clinical evidence.
      </p>
      <div role="group" aria-label="Solver mode">
        <button
          aria-pressed={mode === "rod"}
          onClick={() => {
            setMode("rod");
            clearResult();
          }}
        >
          rod-deployment
        </button>
        <button
          aria-pressed={mode === "stokes"}
          onClick={() => {
            setMode("stokes");
            clearResult();
          }}
        >
          stokes-flow
        </button>
      </div>
      {mode === "rod" ? (
        <>
          <label>
            Rod radius (mm)
            <input
              {...inputProps(rodDraft.radius_mm, (v) => {
                clearResult();
                setRodDraft((d) => ({ ...d, radius_mm: v }));
              })}
              disabled={!scope}
            />
          </label>
          <label>
            Rod elastic axial stiffness EA (N)
            <input
              {...inputProps(rodDraft.ea_n, (v) => {
                clearResult();
                setRodDraft((d) => ({ ...d, ea_n: v }));
              })}
              disabled={!scope}
            />
          </label>
          <label>
            Rod bending stiffness EI (N·mm2)
            <input
              {...inputProps(rodDraft.ei_n_mm2, (v) => {
                clearResult();
                setRodDraft((d) => ({ ...d, ei_n_mm2: v }));
              })}
              disabled={!scope}
            />
          </label>
          <label>
            Lumen contact stiffness (N per mm)
            <input
              {...inputProps(rodDraft.contact_stiffness_n_per_mm, (v) => {
                clearResult();
                setRodDraft((d) => ({ ...d, contact_stiffness_n_per_mm: v }));
              })}
              disabled={!scope}
            />
          </label>
          <p>Rest shape: the saved operator parent path.</p>
        </>
      ) : (
        <>
          <label>
            Flow axis (native 0/1/2)
            <input
              {...inputProps(flowDraft.flow_axis, (v) => {
                clearResult();
                setFlowDraft((d) => ({ ...d, flow_axis: v }));
              })}
              disabled={!scope}
            />
          </label>
          <label>
            Inlet velocity (mm/s)
            <input
              {...inputProps(flowDraft.inlet_velocity_mm_s, (v) => {
                clearResult();
                setFlowDraft((d) => ({ ...d, inlet_velocity_mm_s: v }));
              })}
              disabled={!scope}
            />
          </label>
          <label>
            Fluid viscosity (Pa·s)
            <input
              {...inputProps(flowDraft.viscosity_pa_s, (v) => {
                clearResult();
                setFlowDraft((d) => ({ ...d, viscosity_pa_s: v }));
              })}
              disabled={!scope}
            />
          </label>
          <label>
            Brinkman resistance (Pa·s per mm2)
            <input
              {...inputProps(flowDraft.resistance_pa_s_per_mm2, (v) => {
                clearResult();
                setFlowDraft((d) => ({ ...d, resistance_pa_s_per_mm2: v }));
              })}
              disabled={!scope}
            />
          </label>
          <label>
            Neck thickness (mm)
            <input
              {...inputProps(flowDraft.neck_thickness_mm, (v) => {
                clearResult();
                setFlowDraft((d) => ({ ...d, neck_thickness_mm: v }));
              })}
              disabled={!scope}
            />
          </label>
        </>
      )}
      <button
        aria-label="Compute solved numerics"
        disabled={!ready}
        onClick={compute}
      >
        {busy ? "Computing…" : "Compute"}
      </button>
      {error && <p role="alert">{error} The response was not rendered.</p>}
      {visibleResult && (
        <div data-testid="np-result">
          {(() => {
            const cur = visibleResult;
            const r = cur.result as Record<string, unknown>;
            const rod =
              mode === "rod" &&
              r.method === "discrete_elastic_rod_native_lumen";
            return (
              <>
                <p>
                  result_id {String(cur.result_id)} · method {String(r.method)}{" "}
                  · job {String(r.job_sha256).slice(0, 12)}… ·{" "}
                  {rod
                    ? `iterations: ${String(r.iterations)}`
                    : "taylor-hood stokes solve"}
                </p>
                <p>
                  {rod
                    ? `optimizer_success: ${String(r.optimizer_success)} · `
                    : null}
                  clinical_validation: {String(r.clinical_validation)} ·
                  device_calibrated: {String(r.device_calibrated)}
                </p>
                {rod ? (
                  <>
                    <div className="ds-metric">
                      <span>Energy initial</span>
                      <strong>{metric(r.energy_initial_n_mm)} N·mm</strong>
                    </div>
                    <div className="ds-metric">
                      <span>Energy final</span>
                      <strong>{metric(r.energy_final_n_mm)} N·mm</strong>
                    </div>
                    <div className="ds-metric">
                      <span>Max penetration</span>
                      <strong>{metric(r.max_penetration_mm)} mm</strong>
                    </div>
                    <div className="ds-metric">
                      <span>Minimum nodal wall clearance (signed)</span>
                      <strong>
                        {metric(r.minimum_nodal_wall_clearance_mm)} mm
                      </strong>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="ds-metric">
                      <span>Baseline mean sac speed</span>
                      <strong>
                        {metric(r.baseline_mean_sac_speed_mm_s)} mm/s
                      </strong>
                    </div>
                    <div className="ds-metric">
                      <span>Treated mean sac speed</span>
                      <strong>
                        {metric(r.treated_mean_sac_speed_mm_s)} mm/s
                      </strong>
                    </div>
                    <div className="ds-metric">
                      <span>Relative sac speed change (signed)</span>
                      <strong>
                        {metric(r.relative_sac_speed_change_pct)} %
                      </strong>
                    </div>
                    {(["baseline", "treated"] as const).map((side) => {
                      const d = (
                        r.solver_diagnostics as Record<
                          string,
                          Record<string, number>
                        >
                      )[side];
                      return (
                        <p key={side}>
                          {side} residuals: momentum (relative){" "}
                          {d.momentum_residual_relative.toExponential(2)} ·
                          continuity (mm³/s){" "}
                          {d.discrete_continuity_residual.toExponential(2)} ·
                          divergence L2 (mm^(3/2)/s){" "}
                          {d.divergence_l2.toExponential(2)}
                        </p>
                      );
                    })}
                  </>
                )}
                <p>
                  Nonclinical, hypothetical-parameter research solve bound to
                  this case image, revision and geometry result. Not validated
                  or calibrated; no clinical interpretation follows.
                </p>
              </>
            );
          })()}
        </div>
      )}
    </details>
  );
}
