"""Bounded scalar planning evidence shared by the agent and Markdown brief.

No pixels, contours, paths, arbitrary provenance dictionaries, or model-generated
clinical conclusions are projected. Caller is responsible for coherent reads.
"""

import json
import math

from planner.calculators import compute_aneurysm_morphometrics
from planner.territories import CaseContext, analyze_case_territories

IDENTITY_KEYS = ("case_id", "image_sha256", "artifact_version", "reference_revision")


def freeze(value):
    return json.loads(json.dumps(value, sort_keys=True, allow_nan=False))


def source_revision(case):
    return (case.get("image_source") or case.get("reference_annotation") or {}).get(
        "reference_revision"
    )


def scalar_fields(section, fields):
    if not isinstance(section, dict):
        raise TypeError("Invalid scalar section")
    result = {}
    for field in fields:
        value = section.get(field)
        if value is None:
            continue
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
            or value <= 0
        ):
            raise ValueError("Invalid physical scalar")
        result[field] = value
    return result


def geometry_summary(case, envelope):
    if envelope is None or envelope["current"]["status"] != "current":
        return None
    expected = {
        "case_id": case["case_id"],
        "image_sha256": case["image_sha256"],
        "artifact_version": case["artifact_version"],
        "reference_revision": source_revision(case),
    }
    if any(envelope[key] != value for key, value in expected.items()):
        raise ValueError("Geometry identity differs from planning snapshot")
    result = envelope["current"]["result"]
    if (
        case["spatial_units"] != "mm"
        or result.get("spatial_units") != "mm"
        or result.get("validated_morphometry") is not False
        or result.get("clinical_validation") is not False
        or result.get("image_sha256") != case["image_sha256"]
        or result.get("reference_revision") != source_revision(case)
    ):
        raise ValueError("Unsupported geometry evidence")
    sections = {
        "sac": scalar_fields(
            result["sac"], ("height", "width", "min_width", "volume", "surface_area")
        )
    }
    for role in ("neck", "proximal_parent", "distal_parent"):
        sections[role] = scalar_fields(
            result[role], ("min_diameter", "max_diameter", "equivalent_diameter", "area")
        )
    sac, neck = sections["sac"], sections["neck"]
    parent = (
        sections["proximal_parent"]["equivalent_diameter"]
        + sections["distal_parent"]["equivalent_diameter"]
    ) / 2
    indices = compute_aneurysm_morphometrics(
        dome_width_mm=sac["width"],
        dome_height_mm=sac["height"],
        neck_width_mm=neck["max_diameter"],
        parent_artery_diameter_mm=parent,
        sac_volume_mm3=sac.get("volume"),
        sac_surface_area_mm2=sac.get("surface_area"),
    )
    return {
        **sections,
        "result_id": envelope["current"]["result_id"],
        "spatial_units": "mm",
        "validated_morphometry": False,
        "clinical_suitability_established": False,
        "morphometric_indices": indices,
    }


def sizing_summary(case, geometry, envelope):
    if envelope is None or envelope["current"]["status"] != "current":
        return None
    if geometry is None or any(
        envelope[k] != v
        for k, v in {
            "case_id": case["case_id"],
            "image_sha256": case["image_sha256"],
            "artifact_version": case["artifact_version"],
            "reference_revision": source_revision(case),
            "geometry_result_id": geometry["current"]["result_id"],
        }.items()
    ):
        raise ValueError("Sizing differs from planning geometry snapshot")
    report = envelope["current"]["result"]
    if (
        report.get("validated_sizing") is not False
        or report.get("clinical_suitability_established") is not False
    ):
        raise ValueError("Unsupported sizing validation claim")
    # The validated sizing reader owns the detailed rows. Bound the projection
    # to scalar targets and status, not arbitrary nested data or free-form notes.
    out = {
        "result_id": envelope["current"]["result_id"],
        "catalog_version": envelope["catalog_version"],
        "input_revision": envelope["inputs"].get("input_revision"),
        "validated_sizing": False,
        "clinical_suitability_established": False,
        "compatibility_status": "not_established",
        "input_basis": "operator_reported_unvalidated_measurements",
    }
    for family, fields in (
        ("pipeline", ("largest_parent_mm", "minimum_labeled_coverage_length_mm")),
        ("web", ("nominal_target_diameter_mm", "nominal_target_height_mm")),
    ):
        source = report[family]
        out[family] = {"status": source["status"], **scalar_fields(source, fields)}
    out["missing_inputs"] = [value for value in report["missing_inputs"] if isinstance(value, str)][
        :6
    ]
    return out


def project_context(case, geometry, sizing, accepted):
    """Pure projection from independently frozen, already-bound provider data."""
    morphometry = geometry_summary(case, geometry)
    sizing_data = sizing_summary(case, geometry, sizing)
    segments = []
    for item in accepted.values():
        if (
            item is None
            or item["image_sha256"] != case["image_sha256"]
            or item["reference_revision"] != source_revision(case)
        ):
            continue
        segments.append(
            {
                key: item[key]
                for key in (
                    "candidate_id",
                    "role",
                    "producer",
                    "mask_sha256",
                    "segmentation_revision",
                )
            }
        )
    findings = {
        "case_id": case["case_id"],
        "findings": [],
        "clinical_suitability_established": False,
    }
    if morphometry is not None:
        measurements = {
            "dome_width_mm": morphometry["sac"]["width"],
            "dome_height_mm": morphometry["sac"]["height"],
            "neck_width_mm": morphometry["neck"]["max_diameter"],
            "sac_volume_mm3": morphometry["sac"].get("volume"),
            "sac_surface_area_mm2": morphometry["sac"].get("surface_area"),
        }
        findings["findings"] = [
            item.to_dict()
            for item in analyze_case_territories(
                CaseContext(case_id=case["case_id"], measurements=measurements),
                keys=["intracranial_aneurysm"],
            ).findings
        ]
    return {
        "case_id": case["case_id"],
        "image_sha256": case["image_sha256"],
        "artifact_version": case["artifact_version"],
        "reference_revision": source_revision(case),
        "segmentation_summary": segments,
        "morphometry_summary": morphometry,
        "device_sizing_summary": sizing_data,
        "territory_summary": findings,
        "evidence_boundary": "Software geometry and operator-reported arithmetic, not clinically validated; no treatment suitability established.",
    }


def render_context(context):
    lines = ["", "## Computed planning evidence", "", context["evidence_boundary"], ""]
    for key, label in (
        ("segmentation_summary", "Accepted segmentations"),
        ("morphometry_summary", "Computed morphometry"),
        ("device_sizing_summary", "Saved device sizing"),
    ):
        lines += [f"### {label}", ""]
        if context[key]:
            lines += [
                "```json",
                json.dumps(context[key], indent=2, ensure_ascii=False, allow_nan=False),
                "```",
                "",
            ]
        else:
            lines += ["Unavailable in this workspace: no current bound outputs are available.", ""]
    return lines
