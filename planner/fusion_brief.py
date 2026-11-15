"""Scalar-only brief section for the angiogram registration and its presence report.

Nothing here carries a matrix, an isocenter, a view, a frame or a pixel. The
registration's own fit scores are left out: they describe how well two sets
of automatically extracted lines agree, and they do not measure accuracy.
"""

import re

from planner.planning_context import IDENTITY_KEYS
from planner.projection_registration import (
    BIPLANE_VERSION,
    bound_planes,
    record_version,
    validate_registration,
)
from planner.projection_registration import VERSION as REGISTRATION_VERSION
from planner.projection_registration import summarize as summarize_registration
from planner.reformat_scene import digest
from planner.vessel_presence import CLASSES, binding, bound_to, validate_presence
from planner.vessel_presence import VERSION as PRESENCE_VERSION
from planner.vessel_presence import summarize as summarize_presence

_ID = re.compile(r"[A-Za-z0-9_-]{16,128}")
_CLASS_WORDS = {
    "supported": "2D support",
    "no_2d_support": "No 2D support",
    "outside_field": "Outside the field",
    "indeterminate": "Indeterminate",
}


def _revision(value):
    if type(value) is not int or not 0 <= value <= 1_000_000_000:
        raise ValueError("Invalid revision")
    return value


def _identifier(value):
    if not isinstance(value, str) or _ID.fullmatch(value) is None:
        raise ValueError("Invalid identifier")
    return value


def _registration(identity, envelope):
    if not isinstance(envelope, dict) or set(envelope) != {
        *IDENTITY_KEYS,
        "registration_revision",
        "current",
    }:
        raise ValueError("Invalid registration envelope")
    if any(envelope[key] != identity[key] for key in IDENTITY_KEYS):
        raise ValueError("Registration identity contradicts brief")
    revision = _revision(envelope["registration_revision"])
    current = envelope["current"]
    status = current["status"]
    if status == "not_confirmed":
        if revision != 0 or current != {"status": "not_confirmed"}:
            raise ValueError("Contradictory absent registration")
        return {"status": status, "registration_revision": revision}
    registration_id = _identifier(current["registration_id"])
    if revision < 1:
        raise ValueError("Invalid registration revision")
    if status == "stale":
        if current != {
            "status": "stale",
            "registration_id": registration_id,
            "inputs": None,
            "result": None,
        }:
            raise ValueError("Stale registration carries values")
        return {
            "status": status,
            "registration_revision": revision,
            "registration_id": registration_id,
        }
    if (
        status != "current"
        or set(current)
        != {
            "status",
            "registration_id",
            "dependencies",
            "input_sha256",
            "inputs",
            "result",
            "evidence",
        }
        or current["evidence"] not in ("verified", "unavailable")
    ):
        raise ValueError("Contradictory current registration")
    inputs = validate_registration(current["inputs"])
    version = record_version(inputs)
    result = summarize_registration(inputs)
    if (
        current["dependencies"] != {**identity, "version": version}
        or result != current["result"]
        or digest(inputs) != current["input_sha256"]
    ):
        raise ValueError("Registration integrity failed")
    return {
        "status": status,
        "registration_revision": revision,
        "registration_id": registration_id,
        "input_sha256": current["input_sha256"],
        "version": version,
        "method": result["method"],
        "validated": False,
        "evidence": current["evidence"],
        **(
            {
                "same_position": result["same_position"],
                "plane_angle_deg": result["plane_angle_deg"],
            }
            if version == BIPLANE_VERSION
            else {}
        ),
        "planes": [
            {"plane": entry["plane"], "geometry_source": entry["geometry_source"]}
            for entry in bound_planes(inputs)
        ],
    }


def _presence(identity, envelope, registration):
    if not isinstance(envelope, dict) or set(envelope) != {
        *IDENTITY_KEYS,
        "registration_revision",
        "report_revision",
        "current",
    }:
        raise ValueError("Invalid vessel presence envelope")
    if (
        any(envelope[key] != identity[key] for key in IDENTITY_KEYS)
        or envelope["registration_revision"] != registration["registration_revision"]
    ):
        raise ValueError("Vessel presence identity contradicts brief")
    revision = _revision(envelope["report_revision"])
    current = envelope["current"]
    status = current["status"]
    if status == "not_confirmed":
        if revision != 0 or current != {"status": "not_confirmed"}:
            raise ValueError("Contradictory absent vessel presence report")
        return {"status": status, "report_revision": revision}
    report_id = _identifier(current["report_id"])
    if revision < 1:
        raise ValueError("Invalid report revision")
    if status == "stale":
        if current != {"status": "stale", "report_id": report_id, "inputs": None, "result": None}:
            raise ValueError("Stale vessel presence report carries values")
        return {"status": status, "report_revision": revision, "report_id": report_id}
    if status != "current" or set(current) != {
        "status",
        "report_id",
        "dependencies",
        "input_sha256",
        "inputs",
        "result",
    }:
        raise ValueError("Contradictory current vessel presence report")
    inputs = validate_presence(current["inputs"])
    result = summarize_presence(inputs)
    if (
        current["dependencies"]
        != {
            **identity,
            "version": PRESENCE_VERSION,
            **{
                key: inputs[key]
                for key in (
                    "registration_id",
                    "registration_revision",
                    "registration_input_sha256",
                )
            },
        }
        or not bound_to(inputs, binding(registration))
        or result != current["result"]
        or digest(inputs) != current["input_sha256"]
    ):
        raise ValueError("Vessel presence integrity failed")
    return {
        "status": status,
        "report_revision": revision,
        "report_id": report_id,
        "input_sha256": current["input_sha256"],
        **{key: value for key, value in result.items() if key != "status"},
    }


def project_fusion(identity, registration, presence) -> dict:
    """Registration status and presence counts. Scalars and short labels only."""
    if registration is None or presence is None:
        return {"status": "unavailable"}
    return {
        "status": "read",
        "registration": _registration(identity, registration),
        "vessel_presence": _presence(identity, presence, registration),
    }


def render_fusion(fusion) -> list[str]:
    from planner.carm_geometry import fixed

    lines = ["## Angiogram registration and vessel presence", ""]
    if fusion["status"] != "read":
        return [*lines, "Registration reader unavailable.", ""]
    registration, presence = fusion["registration"], fusion["vessel_presence"]
    lines.append(f"- Registration status: {registration['status']}")
    for field in ("registration_revision", "registration_id", "input_sha256", "method"):
        if field in registration:
            lines.append(f"- {field}: `{registration[field]}`")
    if registration["status"] != "current":
        return [*lines, "", "No current confirmed registration is included.", ""]
    lines.append(f"- Frame and mask on hand: {registration['evidence']}")
    if registration["version"] == REGISTRATION_VERSION:
        lines.append("- Planes: one")
    else:
        lines += [
            f"- Planes: two, {fixed(registration['plane_angle_deg'], 1)} degrees apart",
            "- Same patient position in both planes: attested by the operator, not checked",
        ]
    lines += [
        f"- Plane `{plane['plane']}` geometry: {plane['geometry_source'].replace('_', ' ')}"
        for plane in registration["planes"]
    ]
    lines += [
        "",
        (
            "An operator-confirmed proposal, not a validated registration. Its accuracy is"
            " not measured."
        ),
        "",
        "### Vessel presence",
        "",
        f"- Status: {presence['status']}",
    ]
    for field in ("report_revision", "report_id", "input_sha256", "method", "segment_method"):
        if field in presence:
            lines.append(f"- {field}: `{presence[field]}`")
    if presence["status"] != "current":
        return [*lines, "", "No current confirmed vessel presence report is included.", ""]
    lines += [
        (
            f"- Segments: {presence['segment_count']},"
            f" {fixed(presence['segment_length_mm'], 1)} mm in all, unnamed"
        ),
        f"- Mask volume in no segment: {fixed(100 * presence['unassigned_fraction'], 1)}%",
        "",
    ]
    for plane in presence["planes"]:
        lines += [f"#### Plane `{plane['plane']}`", ""]
        lines += [
            (
                f"- {_CLASS_WORDS[name]}: {plane['classes'][name]['count']} segments,"
                f" {fixed(plane['classes'][name]['length_mm'], 1)} mm"
            )
            for name in CLASSES
        ]
        lines += [
            (
                f"- 2D vessel pieces with no segment near: {plane['unmatched_count']},"
                f" {fixed(plane['unmatched_length_mm'], 1)} mm"
            ),
            "",
        ]
    lines += [
        (
            "Each class describes one frame under the registration above and is only as"
            " good as that registration. No cause is asserted: a segment without 2D"
            " support may be occluded, unfilled, outside the injected territory or absent,"
            " or the registration may be wrong. Counts are the browser's, confirmed by an"
            " operator and not recomputed here."
        ),
        "",
    ]
    return lines
