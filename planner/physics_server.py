"""Local case/source-bound numerical HTTP interface. No imaging imports."""

import hashlib
import math
from typing import Annotated, Literal

from fastapi import HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictFloat, StrictInt, model_validator

from planner.geometry_server import GeometryComputeRequest
from planner.geometry_state import GeometryConflict
from planner.physics_state import PhysicsLedger, encoded
from planner.planning_context import freeze

Number = Annotated[StrictFloat, Field(allow_inf_nan=False)]
Point = tuple[Number, Number, Number]


class RodParameters(BaseModel):
    model_config = ConfigDict(extra="forbid")
    radius_mm: Number = Field(gt=0, le=5)
    ea_n: Number = Field(gt=0, le=100000)
    ei_n_mm2: Number = Field(ge=0, le=100000)
    contact_stiffness_n_per_mm: Number = Field(gt=0, le=100000)
    rest_points_ras: list[Point] | None = Field(default=None, min_length=4, max_length=32)


class RodRequest(GeometryComputeRequest):
    geometry_result_id: str = Field(min_length=1, max_length=128)
    parameters: RodParameters


class _ClosedModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class FlowParameters(_ClosedModel):
    flow_axis: StrictInt = Field(ge=0, le=2)
    inlet_velocity_mm_s: Number = Field(gt=0, le=1000)
    viscosity_pa_s: Number = Field(ge=1e-6, le=1)
    resistance_pa_s_per_mm2: Number = Field(ge=0, le=100)
    neck_thickness_mm: Number = Field(gt=0, le=20)


class FlowRequest(GeometryComputeRequest):
    geometry_result_id: str = Field(min_length=1, max_length=128)
    parameters: FlowParameters


class _Residuals(_ClosedModel):
    momentum_residual_relative: Number = Field(ge=0)
    discrete_continuity_residual: Number = Field(ge=0)
    divergence_l2: Number = Field(ge=0)


class _ResidualPhases(_ClosedModel):
    baseline: _Residuals
    treated: _Residuals


class _FlowDiagnostic(_ClosedModel):
    inlet_flux_mm3_s: Number = Field(gt=0)
    outlet_flux_mm3_s: Number = Field(gt=0)
    flux_imbalance_pct: Number = Field(ge=0)
    pressure_drop_pa: Number


class _FlowPhases(_ClosedModel):
    baseline: _FlowDiagnostic
    treated: _FlowDiagnostic


class _FlowMesh(_ClosedModel):
    fluid_voxels: StrictInt = Field(ge=4, le=1000)
    tetrahedra: StrictInt = Field(ge=24, le=6000)
    velocity_dofs: StrictInt = Field(gt=0, le=120000)
    pressure_dofs: StrictInt = Field(gt=0, le=120000)


class _FlowResult(_ClosedModel):
    method: Literal["taylor_hood_native_voxel_stokes_brinkman"]
    job_sha256: str
    clinical_validation: bool
    device_calibrated: bool
    baseline_mean_sac_speed_mm_s: Number = Field(gt=0)
    treated_mean_sac_speed_mm_s: Number = Field(ge=0)
    relative_sac_speed_change_pct: Number
    solver_diagnostics: _ResidualPhases
    flow_diagnostics: _FlowPhases
    mesh_diagnostics: _FlowMesh
    units: dict[str, str]


class CenterlineParameters(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start_ras: Point
    end_ras: Point
    max_points: StrictInt = Field(default=32, ge=4, le=32)

    @model_validator(mode="after")
    def distinct_anchors(self):
        if self.start_ras == self.end_ras:
            raise ValueError("Centerline anchors must be distinct")
        return self


class CenterlineRequest(GeometryComputeRequest):
    parameters: CenterlineParameters


PARAMETER_MODELS = {
    "rod-deployment": RodParameters,
    "centerline": CenterlineParameters,
    "stokes-flow": FlowParameters,
}


def default_runner():
    from planner.physics_worker import run_local_physics

    return run_local_physics


def validate_result(kind, value, job):
    job_sha256 = hashlib.sha256(encoded(job).encode()).hexdigest()
    if not isinstance(value, dict) or value.get("job_sha256") != job_sha256:
        raise ValueError("Numerical result does not match the submitted job")
    if value.get("clinical_validation") is not False or value.get("device_calibrated") is not False:
        raise ValueError("Unsupported numerical validation claim")
    if len(encoded(value).encode()) > 65536:
        raise ValueError("Numerical output exceeds its bound")
    if kind == "rod-deployment":
        expected = {
            "job_sha256",
            "method",
            "clinical_validation",
            "device_calibrated",
            "optimizer_success",
            "iterations",
            "energy_initial_n_mm",
            "energy_final_n_mm",
            "max_penetration_mm",
            "minimum_nodal_wall_clearance_mm",
            "points_ras",
        }
        if set(value) != expected or value["method"] != "discrete_elastic_rod_native_lumen":
            raise ValueError("Invalid rod result fields")
        if (
            type(value["optimizer_success"]) is not bool
            or type(value["iterations"]) is not int
            or not 0 <= value["iterations"] <= 150
        ):
            raise ValueError("Invalid rod convergence diagnostics")
        for key in (
            "energy_initial_n_mm",
            "energy_final_n_mm",
            "max_penetration_mm",
            "minimum_nodal_wall_clearance_mm",
        ):
            v = value[key]
            if (
                isinstance(v, bool)
                or not isinstance(v, (float, int))
                or not math.isfinite(v)
                or (key != "minimum_nodal_wall_clearance_mm" and v < 0)
            ):
                raise ValueError("Invalid physical diagnostic")
        points = value["points_ras"]
        if (
            not isinstance(points, list)
            or not 4 <= len(points) <= 32
            or len(points) != len(job["operator_inputs"]["parent_path"])
        ):
            raise ValueError("Invalid solved rod path")
        for p in points:
            if (
                not isinstance(p, list)
                or len(p) != 3
                or any(
                    isinstance(v, bool) or not isinstance(v, (float, int)) or not math.isfinite(v)
                    for v in p
                )
            ):
                raise ValueError("Invalid solved rod coordinate")
    elif kind == "stokes-flow":
        parsed = _FlowResult.model_validate(value)
        if parsed.units != {
            "velocity": "mm/s",
            "pressure": "Pa",
            "flux": "mm^3/s",
            "divergence_l2": "mm^(3/2)/s",
        }:
            raise ValueError("Invalid flow diagnostic units")
        mesh = parsed.mesh_diagnostics
        if (
            mesh.tetrahedra != 6 * mesh.fluid_voxels
            or mesh.velocity_dofs + mesh.pressure_dofs > 120000
        ):
            raise ValueError("Invalid flow mesh diagnostics")
        expected_change = (
            100
            * (parsed.treated_mean_sac_speed_mm_s - parsed.baseline_mean_sac_speed_mm_s)
            / parsed.baseline_mean_sac_speed_mm_s
        )
        if not math.isclose(
            parsed.relative_sac_speed_change_pct, expected_change, rel_tol=1e-9, abs_tol=1e-8
        ):
            raise ValueError("Contradictory signed flow change")
    elif kind == "centerline":
        expected = {
            "job_sha256",
            "method",
            "clinical_validation",
            "device_calibrated",
            "operator_confirmation_required",
            "spatial_units",
            "path_ras",
            "proximal_index",
            "distal_index",
            "length_mm",
            "point_count",
            "skeleton_voxel_count",
            "grid_shape",
        }
        if (
            set(value) != expected
            or value["method"] != "native_skeleton_path_proposal"
            or value["operator_confirmation_required"] is not True
            or value["spatial_units"] != "mm"
        ):
            raise ValueError("Invalid centerline proposal contract")
        points = value["path_ras"]
        if not isinstance(points, list) or not 4 <= len(points) <= job["parameters"]["max_points"]:
            raise ValueError("Invalid centerline proposal path")
        for point in points:
            if (
                not isinstance(point, list)
                or len(point) != 3
                or any(
                    isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v)
                    for v in point
                )
            ):
                raise ValueError("Invalid centerline proposal coordinate")
        if (
            len({tuple(point) for point in points}) != len(points)
            or value["point_count"] != len(points)
            or type(value["point_count"]) is not int
        ):
            raise ValueError("Invalid centerline point count")
        indices = value["proximal_index"], value["distal_index"]
        if (
            any(type(i) is not int or not 0 < i < len(points) - 1 for i in indices)
            or indices[0] == indices[1]
        ):
            raise ValueError("Invalid proposed station indices")
        length = value["length_mm"]
        if (
            isinstance(length, bool)
            or not isinstance(length, (int, float))
            or not math.isfinite(length)
            or length <= 0
        ):
            raise ValueError("Invalid proposed path length")
        shape = value["grid_shape"]
        if (
            not isinstance(shape, list)
            or len(shape) != 3
            or any(type(n) is not int or not 1 <= n <= 2048 for n in shape)
            or type(value["skeleton_voxel_count"]) is not int
            or not 1 <= value["skeleton_voxel_count"] <= math.prod(shape)
        ):
            raise ValueError("Invalid centerline grid diagnostics")
    else:
        raise ValueError("Unsupported numerical output kind")
    return freeze(value)


def register_physics_routes(app, db_path, sources, read_case, results_dir, runner=None):
    ledger = PhysicsLedger(db_path)

    def bound(case_id):
        case = freeze(read_case(case_id))
        bundle = sources.load_for_case(case)
        if case["spatial_units"] != "mm" or bundle[0].get("spatial_units") != "mm":
            raise HTTPException(409, "Confirmed millimeter source geometry is required")
        identity = {k: case[k] for k in ("case_id", "image_sha256", "artifact_version")}
        return identity | {"reference_revision": bundle[1]}, bundle

    def read(case_id, kind):
        before, bundle = bound(case_id)
        try:
            current = freeze(ledger.current(case_id, before["reference_revision"], kind))
            inputs = (
                ledger.geometry.inputs(case_id, before["reference_revision"])
                if current["status"] == "current" and kind != "centerline"
                else None
            )
            latest = freeze(ledger.current(case_id, before["reference_revision"], kind))
            after, _bundle = bound(case_id)
            if after != before or latest != current:
                raise HTTPException(409, "Numerical evidence changed while reading; reload")
            if current["status"] == "current":
                parameters = (
                    PARAMETER_MODELS[kind]
                    .model_validate(current["parameters"])
                    .model_dump(mode="json")
                )
                job = {
                    "kind": kind,
                    **before,
                    "source_id": bundle[0]["source_id"],
                    "dependencies": current["dependencies"],
                    "parameters": parameters,
                    "operator_inputs": inputs,
                }
                validate_result(kind, current["result"], job)
        except (ValueError, TypeError, KeyError, OSError, OverflowError):
            raise HTTPException(503, "Stored numerical evidence is unavailable") from None
        return JSONResponse(
            before | {"kind": kind, "current": current}, headers={"Cache-Control": "no-store"}
        )

    def compute(case_id, kind, payload):
        before, bundle = bound(case_id)
        if (
            before["artifact_version"] != payload.artifact_version
            or before["reference_revision"] != payload.reference_revision
        ):
            raise HTTPException(409, "Case or source revision changed")
        try:
            snapshot = freeze(ledger.snapshot(case_id, before["reference_revision"], kind))
        except GeometryConflict as exc:
            raise HTTPException(409, str(exc)) from None
        if snapshot["artifact_version"] != payload.artifact_version or snapshot.get(
            "geometry_result_id"
        ) != getattr(payload, "geometry_result_id", None):
            raise HTTPException(409, "Numerical dependencies changed")
        inputs = None
        if kind != "centerline":
            inputs = ledger.geometry.inputs(case_id, before["reference_revision"])
            if (
                inputs is None
                or hashlib.sha256(encoded(inputs).encode()).hexdigest()
                != snapshot["geometry_dependencies"]["operator_sha256"]
            ):
                raise HTTPException(409, "Operator geometry changed")
        parameters = payload.parameters.model_dump(mode="json")
        job = {
            "kind": kind,
            **before,
            "source_id": bundle[0]["source_id"],
            "dependencies": snapshot,
            "parameters": parameters,
            "operator_inputs": inputs,
        }
        from planner.segmentation_server import _INFERENCE_GATE

        if not _INFERENCE_GATE.acquire(blocking=False):
            raise HTTPException(429, "Another native computation is already running")
        try:
            try:
                result = validate_result(
                    kind, (runner or default_runner())(job, blob_dir=results_dir), job
                )
            except (ValueError, TypeError, KeyError, RuntimeError, OSError, OverflowError):
                raise HTTPException(
                    503, "Numerical computation failed; no result was stored"
                ) from None
            after, _bundle = bound(case_id)
            if after != before:
                raise HTTPException(409, "Case or source changed during numerical computation")
            try:
                current = ledger.store(
                    case_id, before["reference_revision"], kind, snapshot, parameters, result
                )
            except GeometryConflict:
                raise HTTPException(
                    409, "Numerical dependencies changed before persistence"
                ) from None
            latest, _bundle = bound(case_id)
            if (
                latest != before
                or ledger.snapshot(case_id, before["reference_revision"], kind) != snapshot
            ):
                raise HTTPException(409, "Numerical evidence changed; reload saved results")
            return before | {"kind": kind, "current": current}
        finally:
            _INFERENCE_GATE.release()

    @app.post("/api/cases/{case_id}/physics/rod-deployment")
    def compute_rod(case_id: str, payload: RodRequest):
        return compute(case_id, "rod-deployment", payload)

    @app.get("/api/cases/{case_id}/physics/rod-deployment")
    def read_rod(case_id: str):
        return read(case_id, "rod-deployment")

    @app.post("/api/cases/{case_id}/physics/stokes-flow")
    def compute_flow(case_id: str, payload: FlowRequest):
        return compute(case_id, "stokes-flow", payload)

    @app.get("/api/cases/{case_id}/physics/stokes-flow")
    def read_flow(case_id: str):
        return read(case_id, "stokes-flow")

    @app.post("/api/cases/{case_id}/centerline-proposals")
    def compute_centerline(case_id: str, payload: CenterlineRequest):
        return compute(case_id, "centerline", payload)

    @app.get("/api/cases/{case_id}/centerline-proposals")
    def read_centerline(case_id: str):
        return read(case_id, "centerline")
