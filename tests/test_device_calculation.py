"""Synthetic scalar inputs only. These are NOT measurements of the public CTA."""

import pytest

from planner.device_calculation import calculate_reported_sizing


def values():
    return {
        "proximal_parent": 3.0,
        "distal_parent": 3.5,
        "neck_coverage_length": 8.0,
        "average_sac_diameter": 5.0,
        "smallest_sac_height": 4.0,
        "dome_diameter": 6.0,
    }


@pytest.mark.parametrize(
    "field,value",
    [
        ("proximal_parent", True),
        ("average_sac_diameter", float("nan")),
        ("neck_coverage_length", "8"),
        ("dome_diameter", 101),
        ("distal_parent", 10**500),
        ("spatial_units", "mm"),
    ],
)
def test_measurements_are_bounded_explicit_scalars_not_overrides(field, value):
    raw = values()
    raw[field] = value
    with pytest.raises(ValueError):
        calculate_reported_sizing(raw, {"kind": "operator_reported", "note": "Synthetic test only"})


@pytest.mark.parametrize(
    "provenance",
    [
        None,
        {},
        {"kind": "clinically_validated", "note": "No actual evidence"},
        {"kind": "operator_reported", "note": " "},
        {"kind": "operator_reported", "note": "x" * 513},
        {"kind": "operator_reported", "note": "Test", "verified": True},
    ],
)
def test_provenance_cannot_upgrade_operator_reports(provenance):
    with pytest.raises(ValueError):
        calculate_reported_sizing(values(), provenance)


def test_calculation_does_not_alias_reported_provenance_or_shared_source_metadata():
    from planner.device_sizing import PIPELINE_SOURCE

    provenance = {"kind": "operator_reported", "note": "Synthetic scalar input"}
    original = PIPELINE_SOURCE["url"]
    report = calculate_reported_sizing(values(), provenance)
    provenance["kind"] = "unsupported_claim"
    try:
        report["pipeline"]["source"]["url"] = "changed"
        assert PIPELINE_SOURCE["url"] == original
        assert report["provenance"]["kind"] == "operator_reported"
    finally:
        PIPELINE_SOURCE["url"] = original


def test_missing_independent_dimensions_produce_gaps_not_substitute_targets():
    raw = values()
    missing = (
        "neck_coverage_length",
        "average_sac_diameter",
        "smallest_sac_height",
        "dome_diameter",
    )
    for field in missing:
        raw.pop(field)
    report = calculate_reported_sizing(
        raw, {"kind": "operator_reported", "note": "Synthetic partial input"}
    )
    assert report["status"] == "partial_inputs"
    assert set(report["missing_inputs"]) == set(missing)
    assert report["pipeline"]["rows"] == []
    assert report["pipeline"]["minimum_labeled_coverage_length_mm"] is None
    assert report["web"].get("nominal_target_diameter_mm") is None


def test_explicit_reported_measurements_exercise_historical_arithmetic_without_selection():
    report = calculate_reported_sizing(
        values(),
        {"kind": "operator_reported", "note": "Synthetic scalar test, not real-case measurements."},
    )
    assert report["status"] == "calculated"
    assert report["binding_status"] == "unbound_pure_calculation"
    assert report["clinical_suitability_established"] is False
    assert report["validated_sizing"] is False
    assert report["compatibility_status"] == "not_established"
    assert report["pipeline"]["minimum_labeled_coverage_length_mm"] == 14.0
    row = next(r for r in report["pipeline"]["rows"] if r["device_id"] == "PIPELINE-HIST-3_50")
    assert row["nominal_difference_mm"] == 0 and row["diameter_equivalent"] is True
    assert row["length_checks_mm"][10.0] is False and row["length_checks_mm"][14.0] is True
    assert report["web"]["nominal_target_diameter_mm"] == 6.0
    assert report["web"]["nominal_target_height_mm"] == 3.0
    assert report["web_catalog_status"] == "not_available"
    assert "selected_device" not in report
