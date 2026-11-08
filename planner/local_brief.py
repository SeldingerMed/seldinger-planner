"""Coherent local scalar brief, separate from model-tool and pixel interfaces."""

import json
import re

from fastapi import HTTPException
from fastapi.responses import JSONResponse

from planner.advanced_context import project_territory_context, render_territory_context
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


def register_local_brief(app, read_case, read_plan, read_territory, read_scene):
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
        if any(
            any(envelope[k] != identity[k] for k in IDENTITY_KEYS)
            for envelope in [*territories.values(), scene]
        ):
            raise HTTPException(409, "Source changed while preparing brief")
        return freeze(
            {"identity": identity, "planning": planning, "territories": territories, "scene": scene}
        )

    @app.get("/api/cases/{case_id}/local-brief")
    def local_brief(case_id: str):
        try:
            before = snapshot(case_id)
            territory = project_territory_context(before["identity"], before["territories"])
            scene = project_scene(before["identity"], before["scene"])
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
            return JSONResponse(
                {
                    **before["identity"],
                    "territories": territory["modes"],
                    "scene": scene,
                    "markdown": "\n".join(lines),
                },
                headers={"Cache-Control": "no-store"},
            )
        except HTTPException:
            raise
        except (ValueError, TypeError, KeyError, OSError, OverflowError) as exc:
            raise HTTPException(503, "Local brief evidence is unavailable") from exc
