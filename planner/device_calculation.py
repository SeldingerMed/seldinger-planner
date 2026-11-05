"""Historical arithmetic over explicit operator reports, not inferred sizing."""

import math
from copy import deepcopy

from planner.device_checks import device_catalog
from planner.device_sizing import evaluate_pipeline, web_sizing_targets

DEVICE_SIZING_CALCULATION_VERSION = "historical-operator-sizing-v1"
MEASUREMENT_FIELDS = (
    "proximal_parent",
    "distal_parent",
    "neck_coverage_length",
    "average_sac_diameter",
    "smallest_sac_height",
    "dome_diameter",
)


def calculate_reported_sizing(measurements, provenance) -> dict:
    if (
        not isinstance(provenance, dict)
        or set(provenance) != {"kind", "note"}
        or provenance["kind"] != "operator_reported"
        or not isinstance(provenance["note"], str)
        or not 0 < len(provenance["note"].strip()) <= 512
        or len(provenance["note"]) > 512
    ):
        raise ValueError("Explicit unvalidated operator-report provenance is required")
    if not isinstance(measurements, dict) or set(measurements) - set(MEASUREMENT_FIELDS):
        raise ValueError("Unsupported operator measurement fields")
    for value in measurements.values():
        if value is not None and (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not 0 < value <= 100
            or not math.isfinite(value)
        ):
            raise ValueError(
                "Operator measurements must be positive finite numbers within the software cap"
            )
    raw = {"spatial_units": "mm", **measurements}
    pipeline = evaluate_pipeline(raw)
    web = web_sizing_targets(raw)
    return deepcopy(
        {
            "status": "partial_inputs"
            if "missing_inputs" in (pipeline["status"], web["status"])
            else "calculated",
            "binding_status": "unbound_pure_calculation",
            "calculation_version": DEVICE_SIZING_CALCULATION_VERSION,
            "catalog_version": device_catalog()["catalog_version"],
            "clinical_suitability_established": False,
            "validated_sizing": False,
            "compatibility_status": "not_established",
            "input_basis": "operator_reported_unvalidated_measurements",
            "provenance": provenance,
            "missing_inputs": [
                field for field in MEASUREMENT_FIELDS if measurements.get(field) is None
            ],
            "pipeline": pipeline,
            "web": web,
            "web_catalog_status": "not_available",
        }
    )
