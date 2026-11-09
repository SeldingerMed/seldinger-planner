import { useEffect, useState } from "react";
import { api } from "../api";
import "./saved-numerical.css";

export type NumericalBinding = {
  case_id: string;
  image_sha256: string;
  artifact_version: string;
  reference_revision: string;
  geometry_result_id: string;
};
type Run = Record<string, unknown> & { kind: string; status: string };
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const hex = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const token = (v: unknown) =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const exact = (v: Record<string, unknown>, names: string[]) =>
  Object.keys(v).length === names.length &&
  names.every((k) => Object.hasOwn(v, k));
const base = ["scope", "kind", "status"];
const current = [
  ...base,
  "result_id",
  "geometry_result_id",
  "parameters_sha256",
  "parameters",
  "method",
  "device_calibrated",
  "clinical_validation",
];
const rodScalars = [
  "optimizer_success",
  "iterations",
  "energy_initial_n_mm",
  "energy_final_n_mm",
  "max_penetration_mm",
  "minimum_nodal_wall_clearance_mm",
];
const flowScalars = [
  "baseline_mean_sac_speed_mm_s",
  "treated_mean_sac_speed_mm_s",
  "relative_sac_speed_change_pct",
];
const residuals = [
  "momentum_residual_relative",
  "discrete_continuity_residual",
  "divergence_l2",
];
const flowDiagnostics = [
  "inlet_flux_mm3_s",
  "outlet_flux_mm3_s",
  "flux_imbalance_pct",
  "pressure_drop_pa",
];
function numericSection(value: unknown, names: string[]) {
  return (
    record(value) && exact(value, names) && names.every((k) => finite(value[k]))
  );
}
function positive(v: unknown, maximum: number) {
  return finite(v) && v > 0 && v <= maximum;
}

export function parseSavedNumericalRuns(
  raw: unknown,
  binding: NumericalBinding,
): Run[] {
  const fail = () => {
    throw new Error("Saved numerical run integrity failed");
  };
  if (
    !record(raw) ||
    ![
      "case_id",
      "image_sha256",
      "artifact_version",
      "reference_revision",
    ].every((k) => raw[k] === binding[k as keyof NumericalBinding]) ||
    !record(raw.planning) ||
    ![
      "case_id",
      "image_sha256",
      "artifact_version",
      "reference_revision",
    ].every(
      (k) =>
        (raw.planning as Record<string, unknown>)[k] ===
        binding[k as keyof NumericalBinding],
    ) ||
    !record(raw.planning.morphometry_summary) ||
    raw.planning.morphometry_summary.result_id !== binding.geometry_result_id ||
    !Array.isArray(raw.numerical_runs) ||
    raw.numerical_runs.length !== 2
  )
    return fail();
  const seen = new Set<string>();
  for (const row of raw.numerical_runs) {
    if (
      !record(row) ||
      row.scope !== "anatomy_operator_parameters" ||
      !["rod-deployment", "stokes-flow"].includes(String(row.kind)) ||
      seen.has(String(row.kind))
    )
      return fail();
    seen.add(String(row.kind));
    if (row.status === "stale" || row.status === "not_computed") {
      if (!exact(row, base)) return fail();
      continue;
    }
    if (
      row.status !== "current" ||
      !token(row.result_id) ||
      row.geometry_result_id !== binding.geometry_result_id ||
      !hex(row.parameters_sha256) ||
      row.device_calibrated !== false ||
      row.clinical_validation !== false ||
      !record(row.parameters)
    )
      return fail();
    const p = row.parameters;
    if (row.kind === "rod-deployment") {
      const custom = Object.hasOwn(row, "rest_shape_summary");
      if (
        !exact(row, [
          ...current,
          ...rodScalars,
          ...(custom ? ["rest_shape_summary"] : []),
        ]) ||
        row.method !== "discrete_elastic_rod_native_lumen" ||
        typeof row.optimizer_success !== "boolean" ||
        !Number.isSafeInteger(row.iterations) ||
        (row.iterations as number) < 0 ||
        (row.iterations as number) > 150 ||
        !rodScalars.slice(2).every((k) => finite(row[k])) ||
        (row.energy_initial_n_mm as number) < 0 ||
        (row.energy_final_n_mm as number) < 0 ||
        (row.max_penetration_mm as number) < 0
      )
        return fail();
      if (
        !exact(p, [
          "radius_mm",
          "ea_n",
          "ei_n_mm2",
          "contact_stiffness_n_per_mm",
          ...(custom ? [] : ["rest_points_ras"]),
        ]) ||
        !positive(p.radius_mm, 5) ||
        !positive(p.ea_n, 100000) ||
        !finite(p.ei_n_mm2) ||
        p.ei_n_mm2 < 0 ||
        p.ei_n_mm2 > 100000 ||
        !positive(p.contact_stiffness_n_per_mm, 100000) ||
        (!custom && p.rest_points_ras !== null)
      )
        return fail();
      if (
        custom &&
        (!record(row.rest_shape_summary) ||
          !exact(row.rest_shape_summary, ["point_count", "sha256"]) ||
          !Number.isSafeInteger(row.rest_shape_summary.point_count) ||
          (row.rest_shape_summary.point_count as number) < 4 ||
          (row.rest_shape_summary.point_count as number) > 32 ||
          !hex(row.rest_shape_summary.sha256))
      )
        return fail();
    } else {
      if (
        !exact(row, [
          ...current,
          ...flowScalars,
          "solver_diagnostics",
          "flow_diagnostics",
          "mesh_diagnostics",
          "units",
        ]) ||
        row.method !== "taylor_hood_native_voxel_stokes_brinkman" ||
        !flowScalars.every((k) => finite(row[k])) ||
        (row.baseline_mean_sac_speed_mm_s as number) <= 0 ||
        (row.treated_mean_sac_speed_mm_s as number) < 0
      )
        return fail();
      if (
        !exact(p, [
          "flow_axis",
          "inlet_velocity_mm_s",
          "viscosity_pa_s",
          "resistance_pa_s_per_mm2",
          "neck_thickness_mm",
        ]) ||
        !Number.isSafeInteger(p.flow_axis) ||
        (p.flow_axis as number) < 0 ||
        (p.flow_axis as number) > 2 ||
        !positive(p.inlet_velocity_mm_s, 1000) ||
        !positive(p.viscosity_pa_s, 1) ||
        (p.viscosity_pa_s as number) < 1e-6 ||
        !finite(p.resistance_pa_s_per_mm2) ||
        p.resistance_pa_s_per_mm2 < 0 ||
        p.resistance_pa_s_per_mm2 > 100 ||
        !positive(p.neck_thickness_mm, 20)
      )
        return fail();
      if (
        !record(row.solver_diagnostics) ||
        !exact(row.solver_diagnostics, ["baseline", "treated"]) ||
        !["baseline", "treated"].every((phase) =>
          numericSection(
            (row.solver_diagnostics as Record<string, unknown>)[phase],
            residuals,
          ),
        )
      )
        return fail();
      if (
        !record(row.flow_diagnostics) ||
        !exact(row.flow_diagnostics, ["baseline", "treated"]) ||
        !["baseline", "treated"].every((phase) =>
          numericSection(
            (row.flow_diagnostics as Record<string, unknown>)[phase],
            flowDiagnostics,
          ),
        )
      )
        return fail();
      if (
        !numericSection(row.mesh_diagnostics, [
          "fluid_voxels",
          "tetrahedra",
          "velocity_dofs",
          "pressure_dofs",
        ]) ||
        !record(row.units) ||
        !exact(row.units, ["velocity", "pressure", "flux", "divergence_l2"]) ||
        row.units.velocity !== "mm/s" ||
        row.units.pressure !== "Pa" ||
        row.units.flux !== "mm^3/s" ||
        row.units.divergence_l2 !== "mm^(3/2)/s"
      )
        return fail();
    }
  }
  return structuredClone(raw.numerical_runs) as Run[];
}
const metric = (v: unknown) => Number((v as number).toPrecision(4)).toString();
export default function SavedNumericalRuns({
  binding,
  refreshKey,
}: {
  binding: NumericalBinding | null;
  refreshKey: string;
}) {
  const scope = binding
    ? JSON.stringify([
        binding.case_id,
        binding.image_sha256,
        binding.artifact_version,
        binding.reference_revision,
        binding.geometry_result_id,
      ])
    : "";
  const [epoch, setEpoch] = useState(0);
  const key = `${scope}:${refreshKey}:${epoch}`;
  const [state, setState] = useState<{
    key: string;
    rows: Run[] | null;
    error: string;
  }>({ key: "", rows: null, error: "" });
  const rows = state.key === key && binding ? state.rows : null;
  const error = state.key === key ? state.error : "";
  useEffect(() => {
    let live = true;
    setState({ key, rows: null, error: "" });
    if (binding)
      void api<unknown>(
        `/cases/${encodeURIComponent(binding.case_id)}/local-brief`,
      )
        .then((raw) => {
          const rows = parseSavedNumericalRuns(raw, binding);
          if (live) setState({ key, rows, error: "" });
        })
        .catch(() => {
          if (live)
            setState({
              key,
              rows: null,
              error:
                "Saved numerical runs could not be confirmed. Reload to retry.",
            });
        });
    return () => {
      live = false;
    };
  }, [key]);
  return (
    <section className="saved-numerical-runs" aria-label="Saved numerical runs">
      <h3>Numerical runs on this anatomy</h3>
      <p>
        Stored operator-parameter runs. No result is assigned to a device
        alternative.
      </p>
      <button
        disabled={!binding || (!rows && !error)}
        onClick={() => setEpoch((e) => e + 1)}
      >
        Reload saved numerical runs
      </button>
      {!binding ? (
        <p>Current saved anatomy is required.</p>
      ) : error ? (
        <p role="alert">{error}</p>
      ) : !rows ? (
        <p role="status">Reading saved runs…</p>
      ) : (
        rows.map((run) => (
          <article key={run.kind}>
            <h4>
              {run.kind === "rod-deployment" ? "Rod deployment" : "Stokes flow"}
            </h4>
            {run.status !== "current" ? (
              <p>
                {run.status === "stale"
                  ? "Stale run; values hidden"
                  : "Not computed"}
              </p>
            ) : (
              <>
                <p>
                  Run <code>{String(run.result_id)}</code>
                </p>
                <dl>
                  {run.kind === "rod-deployment" ? (
                    <>
                      <dt>Optimizer</dt>
                      <dd>
                        {run.optimizer_success ? "Converged" : "Not converged"}
                      </dd>
                      <dt>Iterations</dt>
                      <dd>{String(run.iterations)}</dd>
                      <dt>Initial energy</dt>
                      <dd>{metric(run.energy_initial_n_mm)} N·mm</dd>
                      <dt>Final energy</dt>
                      <dd>{metric(run.energy_final_n_mm)} N·mm</dd>
                      <dt>Maximum sampled penetration</dt>
                      <dd>{metric(run.max_penetration_mm)} mm</dd>
                      <dt>Minimum sampled nodal clearance</dt>
                      <dd>{metric(run.minimum_nodal_wall_clearance_mm)} mm</dd>
                    </>
                  ) : (
                    <>
                      <dt>Baseline sac mean speed</dt>
                      <dd>{metric(run.baseline_mean_sac_speed_mm_s)} mm/s</dd>
                      <dt>With resistance</dt>
                      <dd>{metric(run.treated_mean_sac_speed_mm_s)} mm/s</dd>
                      <dt>Relative change</dt>
                      <dd>{metric(run.relative_sac_speed_change_pct)}%</dd>
                    </>
                  )}
                </dl>
                <details>
                  <summary>Operator parameters and run identity</summary>
                  <pre>{JSON.stringify(run, null, 2)}</pre>
                </details>
              </>
            )}
          </article>
        ))
      )}
    </section>
  );
}
