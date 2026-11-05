"""Historical label comparisons. No clinical suitability or automatic sizing."""

import hashlib
import json
import math

from planner.device_sizing import (
    COVERAGE_MARGIN_MM,
    FAMILY_PARENT_RANGE_MM,
    WEB_DIAMETER_MARGIN_MM,
    WEB_DOME_FAMILY_RANGE_MM,
    WEB_HEIGHT_MARGIN_MM,
    WEB_SOURCE,
    pipeline_catalog,
)
from planner.geometry_contract import CALCULATION_VERSION

DEVICE_CHECKS_VERSION = "historical-label-range-checks-v1"


class DeviceCheckError(ValueError):
    """Malformed software evidence, not a clinical rejection."""


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def device_catalog():
    """Version canonical catalog/rule data, not unverified source PDF bytes."""
    data = {
        "version_basis": "canonical_catalog_and_rule_data_sha256",
        "device_checks_version": DEVICE_CHECKS_VERSION,
        "clinical_suitability_established": False,
        "validated_sizing": False,
        "pipeline": pipeline_catalog(),
        "web": {
            "source": WEB_SOURCE,
            "rows": [],
            "catalog_status": "not_available",
            "required_inputs": ["average_sac_diameter", "smallest_sac_height", "dome_diameter"],
        },
        "rules": {
            "pipeline_parent_range_mm": list(FAMILY_PARENT_RANGE_MM),
            "pipeline_coverage_margin_mm": COVERAGE_MARGIN_MM,
            "web_dome_family_range_mm": list(WEB_DOME_FAMILY_RANGE_MM),
            "web_diameter_margin_mm": WEB_DIAMETER_MARGIN_MM,
            "web_height_margin_mm": WEB_HEIGHT_MARGIN_MM,
        },
    }
    raw = encoded(data)
    # Return independent objects: callers cannot mutate imported source dictionaries.
    return {**json.loads(raw), "catalog_version": hashlib.sha256(raw.encode()).hexdigest()}


def _positive_number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise DeviceCheckError("Expected finite positive number")
    try:
        converted = float(value)
    except OverflowError:
        raise DeviceCheckError("Expected finite positive number") from None
    if not math.isfinite(converted) or converted <= 0:
        raise DeviceCheckError("Expected finite positive number")
    return converted


def validate_catalog(catalog):
    raw = {k: v for k, v in catalog.items() if k != "catalog_version"}
    if catalog.get("catalog_version") != hashlib.sha256(encoded(raw).encode()).hexdigest():
        raise DeviceCheckError("Catalog data does not match its version")
    if (
        catalog.get("device_checks_version") != DEVICE_CHECKS_VERSION
        or catalog.get("clinical_suitability_established") is not False
        or catalog.get("validated_sizing") is not False
    ):
        raise DeviceCheckError("Unsupported catalog policy")
    rules = catalog["rules"]
    for field in ("pipeline_parent_range_mm", "web_dome_family_range_mm"):
        low, high = rules[field]
        if _positive_number(low) >= _positive_number(high):
            raise DeviceCheckError("Invalid historical interval")
    for field in ("pipeline_coverage_margin_mm", "web_diameter_margin_mm", "web_height_margin_mm"):
        _positive_number(rules[field])


MISSING_DIMENSIONS = {
    "neck_coverage_length": {
        "status": "missing",
        "reason": "Longitudinal neck extent before the historical coverage margin is not measured; neck-plane width is not a substitute.",
    },
    "average_sac_diameter": {
        "status": "missing",
        "reason": "Independent sac diameters are not supplied; one projected width is not their average.",
    },
    "smallest_sac_height": {
        "status": "missing",
        "reason": "Current sac height is one plane's maximum, not an established independent minimum.",
    },
    "dome_diameter": {
        "status": "missing",
        "reason": "A separately recorded dome diameter is not supplied.",
    },
}


def case_device_checks(envelope, catalog):
    """Project explicit geometric comparisons, never a selected sizing diameter."""
    validate_catalog(catalog)
    current = envelope["current"]
    identity = {
        k: envelope[k]
        for k in ("case_id", "image_sha256", "reference_revision", "artifact_version")
    }
    if any(not isinstance(v, str) or not v or len(v) > 200 for v in identity.values()):
        raise DeviceCheckError("Invalid geometry identity")
    if current["status"] in ("stale", "not_computed"):
        if current["result"] is not None:
            raise DeviceCheckError("Noncurrent geometry must suppress results")
        return {
            **identity,
            "catalog_version": catalog["catalog_version"],
            "device_checks_version": DEVICE_CHECKS_VERSION,
            "geometry_status": current["status"],
            "status": current["status"],
            "checks": None,
            "dependencies": None,
            "clinical_suitability_established": False,
            "validated_sizing": False,
            "missing_dimensions": json.loads(encoded(MISSING_DIMENSIONS)),
            "stale_reasons": json.loads(encoded(current.get("stale_reasons", []))),
        }
    if current["status"] != "current":
        raise DeviceCheckError("Unknown geometry status")
    result = current["result"]
    dependencies = current["dependencies"]
    expected = {
        "case_id": identity["case_id"],
        "image_sha256": identity["image_sha256"],
        "source_revision": identity["reference_revision"],
        "artifact_version": identity["artifact_version"],
        "calculation_version": CALCULATION_VERSION,
    }
    if any(dependencies.get(k) != v for k, v in expected.items()):
        raise DeviceCheckError("Geometry dependencies do not match envelope")
    if (
        result.get("image_sha256") != identity["image_sha256"]
        or result.get("reference_revision") != identity["reference_revision"]
    ):
        raise DeviceCheckError("Geometry result belongs to another source")
    if (
        result.get("spatial_units") != "mm"
        or result.get("clinical_validation") is not False
        or result.get("validated_morphometry") is not False
    ):
        raise DeviceCheckError("Unsupported geometry units or validation claim")
    low, high = catalog["rules"]["pipeline_parent_range_mm"]
    sections = {}
    for name in ("proximal_parent", "distal_parent"):
        section = result[name]
        if (
            section.get("method") != "operator_path_normal_native_mask_section"
            or section.get("spatial_units") != "mm"
            or section.get("validated_morphometry") is not False
        ):
            raise DeviceCheckError("Unsupported parent section evidence")
        for field in ("min_diameter", "max_diameter", "equivalent_diameter", "area"):
            _positive_number(section[field])
        minimum, maximum = section["min_diameter"], section["max_diameter"]
        if minimum > maximum:
            raise DeviceCheckError("Reversed parent diameter extrema")
        sections[name] = {
            "min_diameter_mm": minimum,
            "max_diameter_mm": maximum,
            "equivalent_diameter_mm": section["equivalent_diameter"],
            "area_mm2": section["area"],
            "comparison": "within_historical_range"
            if low <= minimum <= maximum <= high
            else "outside_historical_range",
        }
    return {
        **identity,
        "catalog_version": catalog["catalog_version"],
        "device_checks_version": DEVICE_CHECKS_VERSION,
        "geometry_status": current["status"],
        "status": "partial_inputs",
        "clinical_suitability_established": False,
        "validated_sizing": False,
        "missing_dimensions": json.loads(encoded(MISSING_DIMENSIONS)),
        "dependencies": {
            "geometry_result_id": current["result_id"],
            "geometry": json.loads(encoded(current["dependencies"])),
            "catalog_version": catalog["catalog_version"],
            "device_checks_version": DEVICE_CHECKS_VERSION,
        },
        "checks": {
            "pipeline": {
                "basis": "operator_path_normal_mask_feret_extrema",
                "parent_range_mm": [low, high],
                "parent_sections": sections,
                "sizing_status": "missing_inputs",
            },
            "web": {"sizing_status": "missing_inputs", "catalog_rows_available": False},
        },
    }
