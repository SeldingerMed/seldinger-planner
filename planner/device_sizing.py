"""Historical Pipeline catalog and approximate WEB sizing targets.

Prototype rule engine over parent-verified historical FDA source values.

- Pipeline: P100018S015C.pdf, revision 71012-001 Rev. 5 (12/2018), Table 1,
  Directions for Use 2-3. Historical-source scope only; this is NOT a current
  complete commercial catalog and device_id values are internal generated
  identifiers, not manufacturer SKUs.
- WEB: P170032C.pdf, revision LBA0040, Rev Q 12/2018, sizing instructions.
  Approximate nominal targets only; the full WEB table/model IDs are verified
  separately and no WEB catalog rows are represented here.

A geometric pass never establishes clinical compatibility, treatment
suitability, or device recommendation. Numeric inputs must be finite positive
non-bool numbers in millimeters; strings and booleans are rejected, never
coerced. Missing/unknown/non-mm units produce no numeric sizing outputs.
"""

import math
from dataclasses import dataclass

PIPELINE_SOURCE = {
    "url": "https://www.accessdata.fda.gov/cdrh_docs/pdf10/P100018S015C.pdf",
    "revision": "71012-001 Rev. 5 (12/2018)",
    "table": "Table 1",
    "scope": "historical_directions_for_use",
}
WEB_SOURCE = {
    "url": "https://www.accessdata.fda.gov/cdrh_docs/pdf17/P170032C.pdf",
    "revision": "LBA0040, Rev Q 12/2018",
    "section": "sizing_instructions",
}
FAMILY_PARENT_RANGE_MM = (2.0, 5.0)
WEB_DOME_FAMILY_RANGE_MM = (3.0, 10.0)
COVERAGE_MARGIN_MM = 6.0
WEB_DIAMETER_MARGIN_MM = 1.0
WEB_HEIGHT_MARGIN_MM = 1.0

_PIPELINE_LENGTH_GROUPS = {
    "2.50": (10, 12, 14, 16, 18, 20),
    "2.75": (10, 12, 14, 16, 18, 20),
}
_PIPELINE_LONG_LENGTHS = (25, 30, 35)


@dataclass(frozen=True)
class PipelineRow:
    """One historical catalog row. device_id is an internal identifier."""

    device_id: str
    labeled_diameter_mm: float
    self_expanded_diameter_mm: float
    labeled_lengths_mm: tuple


class DeviceSizingError(ValueError):
    """Raised for malformed measurement payloads (not clinical rejection)."""


def _finite_positive(value, field):
    """Return value as float or raise DeviceSizingError. No coercion of strings/bools."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise DeviceSizingError(f"{field} must be a finite positive number")
    value = float(value)
    if not math.isfinite(value) or value <= 0.0:
        raise DeviceSizingError(f"{field} must be finite and positive")
    return value


def _clean_measurements(measurements, required_numeric, allow_missing=()):
    """Validate units and numeric fields; return (units, values dict, missing list).

    Values in ``allow_missing`` may be absent without failing the payload; the
    caller decides what status an explicit absence maps to.
    """
    if not isinstance(measurements, dict):
        raise DeviceSizingError("measurements must be a dict")
    units = measurements.get("spatial_units")
    if units != "mm":
        return units, {}, []
    missing = []
    values = {}
    for field in required_numeric:
        raw = measurements.get(field)
        if raw is None:
            if field in allow_missing:
                missing.append(field)
                continue
            return units, {}, missing
        values[field] = _finite_positive(raw, field)
    return units, values, missing


def pipeline_catalog() -> dict:
    """Return the verified historical Pipeline catalog (parent-retrieved source).

    Rows are constructed with exact integer/decimal steps. Labeled diameter
    approximates the target vessel; self-expanded diameter (labeled + 0.25 mm)
    is the fully expanded value equivalent to the largest target vessel; the
    two are never conflated. If proximal/distal diameters differ, match the
    larger vessel. Labeled length must be at least neck length + 6 mm.
    """
    rows = []
    for i in range(11):
        labeled_steps = 10 + i  # 2.50..5.00 mm in 0.25 mm integer steps
        labeled = round(labeled_steps / 4.0, 2)
        key = f"{labeled:.2f}"
        lengths = list(_PIPELINE_LENGTH_GROUPS.get(key, (10, 12, 14, 16, 18, 20)))
        if key not in _PIPELINE_LENGTH_GROUPS:
            lengths.extend(_PIPELINE_LONG_LENGTHS)
        rows.append(
            PipelineRow(
                device_id=f"PIPELINE-HIST-{key.replace('.', '_')}",
                labeled_diameter_mm=labeled,
                self_expanded_diameter_mm=round(labeled_steps / 4.0 + 0.25, 2),
                labeled_lengths_mm=tuple(lengths),
            ).__dict__
            | {"labeled_lengths_mm": list(lengths)}
        )
    return {
        "clinical_suitability_established": False,
        "catalog_scope": "historical_source_only",
        "note": (
            "Historical FDA source rows only; not a current complete commercial "
            "catalog. device_id values are internal identifiers, not manufacturer SKUs."
        ),
        "source": PIPELINE_SOURCE,
        "source_instructions": {
            "labeled_diameter": "approximates_target_vessel",
            "fully_expanded_diameter": "largest_target_vessel",
            "proximal_distal_differ": "match_larger_vessel",
            "labeled_length_rule": "at_least_neck_length_plus_6mm",
            "family_parent_vessel_range_mm": list(FAMILY_PARENT_RANGE_MM),
        },
        "rows": rows,
    }


def evaluate_pipeline(measurements: dict) -> dict:
    """Explicit geometric checks against the historical Pipeline table.

    ``measurements`` keys: ``spatial_units`` (must be ``"mm"``),
    ``proximal_parent``, ``distal_parent``, ``neck_coverage_length``
    (longitudinal coverage length, not automatically a neck-plane Feret width).

    Returns the largest measured parent, the minimum labeled coverage length
    (neck coverage + 6 mm), and per-row nominal diameter differences with
    explicit length-check outcomes. Diameter equivalence is marked only when
    exactly equal; no numeric tolerance is applied. No treatment
    recommendation, ranking, or device selection is produced.
    """
    base = {
        "clinical_suitability_established": False,
        "validated_sizing": False,
        "source": PIPELINE_SOURCE,
        "spatial_units": measurements.get("spatial_units")
        if isinstance(measurements, dict)
        else None,
        "largest_parent_mm": None,
        "minimum_labeled_coverage_length_mm": None,
        "rows": [],
    }
    units, values, _missing = _clean_measurements(
        measurements,
        ("proximal_parent", "distal_parent", "neck_coverage_length"),
    )
    if units != "mm" or not values:
        return base | {"status": "missing_inputs"}
    base["spatial_units"] = "mm"
    largest = max(values["proximal_parent"], values["distal_parent"])
    if not FAMILY_PARENT_RANGE_MM[0] <= largest <= FAMILY_PARENT_RANGE_MM[1]:
        return base | {"status": "out_of_family_range", "largest_parent_mm": largest}
    min_coverage = values["neck_coverage_length"] + COVERAGE_MARGIN_MM
    rows = []
    for row in pipeline_catalog()["rows"]:
        labeled = row["labeled_diameter_mm"]
        rows.append(
            {
                "device_id": row["device_id"],
                "labeled_diameter_mm": labeled,
                "self_expanded_diameter_mm": row["self_expanded_diameter_mm"],
                "nominal_difference_mm": round(labeled - largest, 10),
                "diameter_equivalent": labeled == largest,
                "length_checks_mm": {
                    float(length): length >= min_coverage for length in row["labeled_lengths_mm"]
                },
            }
        )
    return base | {
        "status": "geometric_checks_only",
        "largest_parent_mm": largest,
        "minimum_labeled_coverage_length_mm": min_coverage,
        "rows": rows,
    }


def web_sizing_targets(measurements: dict) -> dict:
    """Approximate WEB nominal targets from verified sizing instructions only.

    ``measurements`` keys: ``spatial_units`` (must be ``"mm"``),
    ``average_sac_diameter``, ``smallest_sac_height``, and the separately
    recorded ``dome_diameter`` (never equated with the average sac diameter).

    Approximate nominal target diameter = average sac diameter + 1 mm;
    approximate nominal target height = smallest sac height - 1 mm. These are
    approximate values, not a recommendation and not a device. If the height
    target is <= 0 the result is ``unsupported``; if the recorded dome diameter
    falls outside the historical 3-10 mm family range the result is
    ``out_of_family_range``. No tolerance is applied to the approximates.
    Clinical location, neck criteria, rupture/previous treatment and catheter
    compatibility are not inferred.
    """
    base = {
        "clinical_suitability_established": False,
        "validated_sizing": False,
        "approximate": True,
        "source": WEB_SOURCE,
        "spatial_units": measurements.get("spatial_units")
        if isinstance(measurements, dict)
        else None,
        "average_sac_diameter_mm": None,
        "smallest_sac_height_mm": None,
        "dome_diameter_mm": None,
    }
    units, values, _missing = _clean_measurements(
        measurements,
        ("average_sac_diameter", "smallest_sac_height", "dome_diameter"),
    )
    if units != "mm" or len(values) != 3:
        return base | {"status": "missing_inputs"}
    base["spatial_units"] = "mm"
    avg = values["average_sac_diameter"]
    height = values["smallest_sac_height"]
    dome = values["dome_diameter"]
    base["average_sac_diameter_mm"] = avg
    base["smallest_sac_height_mm"] = height
    base["dome_diameter_mm"] = dome
    height_target = height - WEB_HEIGHT_MARGIN_MM
    if not WEB_DOME_FAMILY_RANGE_MM[0] <= dome <= WEB_DOME_FAMILY_RANGE_MM[1]:
        return base | {"status": "out_of_family_range"}
    if height_target <= 0.0:
        return base | {"status": "unsupported"}
    return base | {
        "status": "geometric_checks_only",
        "nominal_target_diameter_mm": avg + WEB_DIAMETER_MARGIN_MM,
        "nominal_target_height_mm": height_target,
    }
