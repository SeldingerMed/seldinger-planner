"""Pure scalar projection of rod/stokes numerical read envelopes.

Scope: anatomy_operator_parameters. Input is an already-bound, already-frozen
GET /physics/{rod-deployment|stokes-flow} envelope plus the planning-context
morphometry summary. This projection adds no numerical evidence of its own and
never re-validates against images or independent solvers: it only admits
scalar operator-parameter diagnostics already produced and validated by the
physics HTTP boundary, and suppresses points, paths and mask arrays.
"""

import hashlib
import math

from planner.physics_contract import KINDS, encoded
from planner.physics_server import PARAMETER_MODELS, _FlowResult

IDENTITY_KEYS = ("case_id", "image_sha256", "artifact_version", "reference_revision")

NUMERICAL_KINDS = ("rod-deployment", "stokes-flow")
ENVELOPE_KEYS = frozenset(IDENTITY_KEYS) | {"kind", "current"}
SCOPE = "anatomy_operator_parameters"

_ROD_SCALARS = (
    "optimizer_success",
    "iterations",
    "energy_initial_n_mm",
    "energy_final_n_mm",
    "max_penetration_mm",
    "minimum_nodal_wall_clearance_mm",
)
_ROD_KEYS = frozenset(
    {
        "job_sha256",
        "method",
        "clinical_validation",
        "device_calibrated",
        *_ROD_SCALARS,
        "points_ras",
    }
)
_ROD_METHOD = "discrete_elastic_rod_native_lumen"
_FLOW_KEYS = frozenset(
    {
        "job_sha256",
        "method",
        "clinical_validation",
        "device_calibrated",
        "baseline_mean_sac_speed_mm_s",
        "treated_mean_sac_speed_mm_s",
        "relative_sac_speed_change_pct",
        "solver_diagnostics",
        "flow_diagnostics",
        "mesh_diagnostics",
        "units",
    }
)
_FLOW_METHOD = "taylor_hood_native_voxel_stokes_brinkman"
_FLOW_SCALARS = (
    "baseline_mean_sac_speed_mm_s",
    "treated_mean_sac_speed_mm_s",
    "relative_sac_speed_change_pct",
)


def _finite(value):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)


def _finite_scalars(section, fields):
    out = {}
    for field in fields:
        value = section[field]
        if field in ("optimizer_success", "iterations"):
            if not isinstance(value, bool) and not (
                isinstance(value, int) and not isinstance(value, bool)
            ):
                raise ValueError("Invalid numerical diagnostic")
        elif not _finite(value):
            raise ValueError("Invalid numerical diagnostic")
        out[field] = value
    return out


def _finite_nested(section):
    out = {}
    for key, value in section.items():
        if isinstance(value, dict):
            out[key] = _finite_nested(value)
        elif not _finite(value):
            raise ValueError("Invalid numerical diagnostic")
        else:
            out[key] = value
    return out


def _result_output(kind, result):
    if not isinstance(result, dict):
        raise TypeError("Invalid numerical result")
    if (
        result.get("clinical_validation") is not False
        or result.get("device_calibrated") is not False
    ):
        raise ValueError("Unsupported numerical validation claim")
    if kind == "rod-deployment":
        if set(result) != _ROD_KEYS or result["method"] != _ROD_METHOD:
            raise ValueError("Invalid rod result fields")
        if type(result["optimizer_success"]) is not bool:
            raise ValueError("Invalid rod convergence flag")
        if not isinstance(result["iterations"], int) or isinstance(result["iterations"], bool):
            raise ValueError("Invalid rod convergence diagnostics")
        return {
            "method": _ROD_METHOD,
            "device_calibrated": False,
            "clinical_validation": False,
            **_finite_scalars(result, _ROD_SCALARS),
        }
    if set(result) != _FLOW_KEYS or result["method"] != _FLOW_METHOD:
        raise ValueError("Invalid flow result fields")
    result = _FlowResult.model_validate(result).model_dump(mode="json")
    return {
        "method": _FLOW_METHOD,
        "device_calibrated": False,
        "clinical_validation": False,
        **_finite_scalars(result, _FLOW_SCALARS),
        "solver_diagnostics": _finite_nested(result["solver_diagnostics"]),
        "flow_diagnostics": _finite_nested(result["flow_diagnostics"]),
        "mesh_diagnostics": _finite_nested(result["mesh_diagnostics"]),
        "units": result["units"],
    }


def _dependencies(deps, identity, geometry):
    # The native dependency snapshot (masks, operator hash, calculation
    # version) is already validated by the physics HTTP read boundary before
    # an envelope is produced. This projection only re-binds the two keys it
    # can check against the scalar planning geometry summary.
    if not isinstance(deps, dict) or "source_revision" not in deps:
        raise ValueError("Invalid numerical dependencies")
    if any(
        deps.get(key) != identity[key] for key in ("case_id", "image_sha256", "artifact_version")
    ):
        raise ValueError("Numerical dependencies differ from source identity")
    if deps["source_revision"] != identity["reference_revision"]:
        raise ValueError("Numerical dependencies belong to another source revision")
    if (
        not isinstance(geometry, dict)
        or "result_id" not in geometry
        or deps.get("geometry_result_id") != geometry["result_id"]
    ):
        raise ValueError("Numerical dependencies differ from planning geometry snapshot")


def project_numerical(identity, kind, envelope, geometry) -> dict:
    """Project one numerical read envelope into bounded scalar planning evidence.

    current envelopes require the planning-context morphometry summary and are
    projected to scalar diagnostics only; stale and not_computed envelopes
    project to status-only output.
    """
    if (
        not isinstance(identity, dict)
        or set(identity) != set(IDENTITY_KEYS)
        or any(not isinstance(identity[key], str) for key in IDENTITY_KEYS)
        or kind not in NUMERICAL_KINDS
    ):
        raise ValueError("Invalid numerical projection identity")
    if (
        kind not in KINDS
        or not isinstance(envelope, dict)
        or set(envelope) != ENVELOPE_KEYS
        or any(envelope[key] != identity[key] for key in IDENTITY_KEYS)
        or envelope["kind"] != kind
    ):
        raise ValueError("Invalid numerical read envelope")
    current = envelope["current"]
    if not isinstance(current, dict) or "status" not in current:
        raise ValueError("Invalid numerical current section")
    status = current["status"]
    if status in ("not_computed", "stale"):
        if status == "not_computed" and (
            set(current) != {"status", "result"} or current["result"] is not None
        ):
            raise ValueError("Invalid not_computed section")
        if status == "stale" and (
            set(current) != {"status", "result_id", "result"} or current["result"] is not None
        ):
            raise ValueError("Invalid stale section")
        return {"scope": SCOPE, "kind": kind, "status": status}
    if status != "current":
        raise ValueError("Unknown numerical status")
    if set(current) != {
        "status",
        "result_id",
        "dependencies",
        "parameters",
        "parameters_sha256",
        "result",
    }:
        raise ValueError("Invalid current numerical section")
    _dependencies(current["dependencies"], identity, geometry)
    parameters = (
        PARAMETER_MODELS[kind].model_validate(current["parameters"]).model_dump(mode="json")
    )
    if hashlib.sha256(encoded(parameters).encode()).hexdigest() != current["parameters_sha256"]:
        raise ValueError("Numerical parameter hash mismatch")
    result = _result_output(kind, current["result"])
    rest_summary = {}
    if kind == "rod-deployment" and parameters.get("rest_points_ras") is not None:
        points = parameters.pop("rest_points_ras")
        rest_summary = {
            "rest_shape_summary": {
                "point_count": len(points),
                "sha256": hashlib.sha256(encoded(points).encode()).hexdigest(),
            }
        }
    return {
        "scope": SCOPE,
        "kind": kind,
        "status": "current",
        "result_id": current["result_id"],
        "geometry_result_id": current["dependencies"]["geometry_result_id"],
        "parameters_sha256": current["parameters_sha256"],
        "parameters": parameters,
        **rest_summary,
        **result,
    }
