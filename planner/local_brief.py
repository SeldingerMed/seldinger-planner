"""Coherent local scalar brief, separate from model-tool and pixel interfaces."""

import hashlib
import json
import re

from fastapi import HTTPException
from fastapi.responses import JSONResponse

from planner.advanced_context import project_territory_context, render_territory_context
from planner.numerical_projection import NUMERICAL_KINDS, project_numerical
from planner.planning_context import IDENTITY_KEYS, freeze
from planner.reformat_scene import VERSION, digest, summarize, validate_scene

MODES = ("tavr", "coronary_pci", "aortic_peripheral")


def project_scene(identity, envelope):
    if any(envelope[k] != identity[k] for k in IDENTITY_KEYS):
        raise ValueError("Scene identity contradicts brief")
    revision = envelope["scene_revision"]
    if type(revision) is not int or not 0 <= revision <= 1_000_000_000:
        raise ValueError("Invalid scene revision")
    current = envelope["current"]
    status = current["status"]
    if status == "not_confirmed":
        if revision != 0 or envelope["secondary_metadata"] is not None:
            raise ValueError("Contradictory absent scene")
        return {"status": status, "scene_revision": revision}
    scene_id = current["scene_id"]
    if (
        not isinstance(scene_id, str)
        or re.fullmatch(r"[A-Za-z0-9_-]{16,128}", scene_id) is None
        or revision < 1
    ):
        raise ValueError("Invalid scene identifier")
    if status == "stale":
        if (
            current["inputs"] is not None
            or current["result"] is not None
            or envelope["secondary_metadata"] is not None
        ):
            raise ValueError("Stale scene carries values")
        return {"status": status, "scene_revision": revision, "scene_id": scene_id}
    if status != "current" or current["dependencies"] != {**identity, "version": VERSION}:
        raise ValueError("Contradictory current scene")
    inputs = validate_scene(current["inputs"])
    result = summarize(inputs)
    if result != current["result"] or digest(inputs) != current["input_sha256"]:
        raise ValueError("Scene integrity failed")
    secondary = inputs["secondary"]
    metadata = envelope["secondary_metadata"]
    if secondary is None:
        if metadata is not None:
            raise ValueError("Unexpected secondary source")
        secondary_projection = None
    else:
        if not isinstance(metadata, dict) or any(
            metadata[k] != secondary[k] for k in ("source_id", "image_sha256", "reference_revision")
        ):
            raise ValueError("Secondary identity differs")
        secondary_projection = {
            k: secondary[k] for k in ("source_id", "image_sha256", "reference_revision")
        }
    return {
        "status": status,
        "scene_revision": revision,
        "scene_id": scene_id,
        "input_sha256": current["input_sha256"],
        **result,
        "secondary": secondary_projection,
    }


def project_scenarios(identity, envelope, geometry) -> dict:
    """Scalar-only projection of an immutable, current-source alternative set."""
    from planner.device_scenarios import _encoded, validate_identity, validate_scenarios

    if envelope is None:
        return {"status": "unavailable"}
    keys = {
        "case_id",
        "image_sha256",
        "artifact_version",
        "reference_revision",
        "geometry_result_id",
        "catalog_version",
    }
    if not isinstance(envelope, dict) or set(envelope) != keys | {"scenario_revision", "current"}:
        raise ValueError("Invalid saved-alternative envelope")
    binding = validate_identity({key: envelope[key] for key in keys})
    if any(binding[key] != identity[key] for key in IDENTITY_KEYS):
        raise ValueError("Saved alternatives contradict brief identity")
    if geometry is None or binding["geometry_result_id"] != geometry["result_id"]:
        raise ValueError("Saved alternatives contradict current geometry")
    revision = envelope["scenario_revision"]
    if type(revision) is not int or not 0 <= revision <= 9223372036854775806:
        raise ValueError("Invalid saved-alternative revision")
    current = envelope["current"]
    status = current["status"]
    base = {**binding, "scenario_revision": revision, "status": status}
    if status == "not_computed":
        if revision != 0 or current != {"status": "not_computed"}:
            raise ValueError("Contradictory absent alternatives")
        return base
    set_id = current["set_id"]
    if (
        not isinstance(set_id, str)
        or re.fullmatch(r"[A-Za-z0-9_-]{16,128}", set_id) is None
        or revision < 1
    ):
        raise ValueError("Invalid saved-alternative identifier")
    base["set_id"] = set_id
    if status == "stale":
        reasons = current["stale_reasons"]
        if (
            set(current) != {"status", "set_id", "scenarios", "stale_reasons"}
            or current["scenarios"] is not None
            or reasons
            not in (
                ["device_scenario_identity_changed"],
                ["device_scenario_dependencies_changed"],
            )
        ):
            raise ValueError("Contradictory stale alternatives")
        return {**base, "stale_reasons": reasons}
    if status != "current" or set(current) != {
        "status",
        "set_id",
        "dependencies",
        "scenarios_sha256",
        "scenarios",
    }:
        raise ValueError("Unknown saved-alternative state")
    dependencies = current["dependencies"]
    dependency_keys = {
        "case_id",
        "image_sha256",
        "artifact_version",
        "source_revision",
        "operator_sha256",
        "masks",
        "calculation_version",
    }
    if not isinstance(dependencies, dict) or set(dependencies) != dependency_keys:
        raise ValueError("Invalid saved-alternative dependency fields")
    from planner.geometry_contract import CALCULATION_VERSION

    if (
        dependencies["calculation_version"] != CALCULATION_VERSION
        or not isinstance(dependencies["operator_sha256"], str)
        or re.fullmatch(r"[a-f0-9]{64}", dependencies["operator_sha256"]) is None
    ):
        raise ValueError("Invalid saved-alternative calculation identity")
    masks = dependencies["masks"]
    if not isinstance(masks, dict) or set(masks) != {"vessel", "aneurysm"}:
        raise ValueError("Invalid saved-alternative mask roles")
    for mask in masks.values():
        if not isinstance(mask, dict) or set(mask) != {
            "candidate_id",
            "mask_sha256",
            "segmentation_revision",
        }:
            raise ValueError("Invalid saved-alternative mask fields")
        if (
            not isinstance(mask["candidate_id"], str)
            or re.fullmatch(r"[A-Za-z0-9_-]{1,80}", mask["candidate_id"]) is None
            or not isinstance(mask["mask_sha256"], str)
            or re.fullmatch(r"[a-f0-9]{64}", mask["mask_sha256"]) is None
            or type(mask["segmentation_revision"]) is not int
            or not 1 <= mask["segmentation_revision"] <= 9223372036854775807
        ):
            raise ValueError("Invalid saved-alternative mask identity")
    expected = {key: identity[key] for key in ("case_id", "image_sha256", "artifact_version")}
    expected["source_revision"] = identity["reference_revision"]
    if any(dependencies[key] != value for key, value in expected.items()):
        raise ValueError("Saved-alternative dependencies contradict source")
    rows = validate_scenarios(current["scenarios"])
    if hashlib.sha256(_encoded(rows).encode()).hexdigest() != current["scenarios_sha256"]:
        raise ValueError("Saved-alternative content hash differs")
    parameters = (
        "deviceId",
        "diameter",
        "length",
        "height",
        "offset",
        "roll",
        "coilLength",
        "braidAngle",
    )
    return {
        **base,
        "dependencies": dependencies,
        "scenarios_sha256": current["scenarios_sha256"],
        "scenarios": [
            {
                "id": row["id"],
                "name": row["name"],
                "placement": {
                    key: row["placement"][key] for key in parameters if key in row["placement"]
                },
                "path_point_count": len(row["placement"]["path"]),
            }
            for row in rows
        ],
    }


def register_local_brief(
    app, read_case, read_plan, read_territory, read_scene, read_scenarios=None, read_numerical=None
):
    def snapshot(case_id):
        case = freeze(read_case(case_id))
        planning = freeze(read_plan(case_id))
        if case["spatial_units"] != "mm" or not planning["reference_revision"]:
            raise HTTPException(409, "Bound millimeter source required")
        identity = {k: planning[k] for k in IDENTITY_KEYS}
        if any(case[k] != identity[k] for k in ("case_id", "image_sha256", "artifact_version")):
            raise HTTPException(409, "Case changed while preparing brief")
        territories = {mode: freeze(read_territory(case_id, mode)) for mode in MODES}
        scene = freeze(read_scene(case_id))
        geometry = planning.get("morphometry_summary")
        # This reader requires current geometry. Without that prerequisite,
        # unavailable means not assessed, not that no saved set exists. Do not
        # call it and turn otherwise valid source-only/territory exports into 409.
        scenarios = (
            freeze(read_scenarios(case_id))
            if read_scenarios is not None and geometry is not None
            else None
        )
        if (
            scenarios is not None
            and geometry is not None
            and scenarios["geometry_result_id"] != geometry["result_id"]
        ):
            raise HTTPException(409, "Geometry changed while preparing alternatives")
        if any(
            any(envelope[k] != identity[k] for k in IDENTITY_KEYS)
            for envelope in [*territories.values(), scene]
        ):
            raise HTTPException(409, "Source changed while preparing brief")
        return freeze(
            {
                "identity": identity,
                "planning": planning,
                "territories": territories,
                "scene": scene,
                "scenarios": scenarios,
                "numerical": {
                    kind: freeze(read_numerical(case_id, kind)) for kind in NUMERICAL_KINDS
                }
                if read_numerical is not None
                else None,
            }
        )

    @app.get("/api/cases/{case_id}/local-brief")
    def local_brief(case_id: str):
        try:
            before = snapshot(case_id)
            territory = project_territory_context(before["identity"], before["territories"])
            scene = project_scene(before["identity"], before["scene"])
            alternatives = project_scenarios(
                before["identity"],
                before["scenarios"],
                before["planning"].get("morphometry_summary"),
            )
            numerical = (
                [
                    project_numerical(
                        before["identity"],
                        kind,
                        before["numerical"][kind],
                        before["planning"].get("morphometry_summary"),
                    )
                    for kind in NUMERICAL_KINDS
                ]
                if before["numerical"] is not None
                else None
            )
            if snapshot(case_id) != before:
                raise HTTPException(409, "Brief evidence changed; reload")
            lines = ["# Local planning brief", "", "## Source binding", ""]
            lines += [f"- {key}: `{value}`" for key, value in before["identity"].items()]
            lines += ["", "## Current planning evidence", ""]
            for field, label in (
                ("segmentation_summary", "Accepted segmentations"),
                ("morphometry_summary", "Computed morphometry"),
                ("device_sizing_summary", "Saved device sizing"),
            ):
                evidence = before["planning"][field]
                lines += (
                    [
                        f"### {label}",
                        "",
                        "```json",
                        json.dumps(evidence, indent=2, allow_nan=False),
                        "```",
                        "",
                    ]
                    if evidence
                    else [f"- {label}: unavailable"]
                )
            lines += [render_territory_context(territory), "", "## Reformat scene", ""]
            lines += [
                f"- {key}: {value}"
                for key, value in scene.items()
                if value is not None and key != "secondary"
            ]
            if scene.get("secondary"):
                lines += ["", "### Registered secondary source", ""]
                lines += [f"- {key}: `{value}`" for key, value in scene["secondary"].items()]
            lines += [
                "",
                "Scene geometry is operator-confirmed. Display settings are recorded separately by the local viewer."
                if scene["status"] == "current"
                else "No current confirmed scene is included.",
                "",
            ]
            lines += ["## Saved device alternatives", "", f"- Status: {alternatives['status']}"]
            for field in (
                "scenario_revision",
                "set_id",
                "geometry_result_id",
                "catalog_version",
                "scenarios_sha256",
            ):
                if field in alternatives:
                    lines.append(f"- {field}: `{alternatives[field]}`")
            if alternatives["status"] == "current":
                lines += [
                    "",
                    "Operator-selected procedural parameters, not verified commercial specifications or fit results.",
                    "",
                ]
                for row in alternatives["scenarios"]:
                    lines += [
                        f"### `{row['id']}`",
                        "",
                        "```json",
                        json.dumps(row, indent=2, allow_nan=False),
                        "```",
                        "",
                    ]
            lines += [
                "",
                "## Numerical runs on this anatomy",
                "",
                "Operator-parameter runs, independent of the saved device alternatives.",
                "Parameter hashes bind all validated operator parameters. Custom rest shapes are represented by point count and hash, not coordinates.",
                "",
            ]
            if numerical is None:
                lines.append("Numerical reader unavailable.")
            else:
                for run in numerical:
                    lines += [
                        f"### {run['kind']}",
                        "",
                        "```json",
                        json.dumps(run, indent=2, allow_nan=False),
                        "```",
                        "",
                    ]
            return JSONResponse(
                {
                    **before["identity"],
                    "planning": before["planning"],
                    "territories": territory["modes"],
                    "scene": scene,
                    "device_scenarios": alternatives,
                    "numerical_runs": numerical,
                    "markdown": "\n".join(lines),
                },
                headers={"Cache-Control": "no-store"},
            )
        except HTTPException:
            raise
        except (ValueError, TypeError, KeyError, OSError, OverflowError) as exc:
            raise HTTPException(503, "Local brief evidence is unavailable") from exc
