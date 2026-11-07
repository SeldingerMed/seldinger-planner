"""Tests for planner/device_sizing.py — synthetic, no clinical claims."""

import math

import pytest

from planner.device_sizing import (
    DeviceSizingError,
    closest_labeled_match,
    diameter_within_half_step,
    evaluate_pipeline,
    pipeline_catalog,
    web_sizing_targets,
)

# ---------------------------------------------------------------------------
# Catalog
# ---------------------------------------------------------------------------


def test_catalog_shape_and_labels():
    cat = pipeline_catalog()
    assert cat["clinical_suitability_established"] is False
    assert cat["catalog_scope"] == "historical_source_only"
    assert "P100018S015C.pdf" in cat["source"]["url"]
    assert cat["source"]["revision"] == "71012-001 Rev. 5 (12/2018)"
    assert cat["source"]["table"] == "Table 1"
    rows = cat["rows"]
    assert len(rows) == 11
    labeled = [r["labeled_diameter_mm"] for r in rows]
    assert labeled == [2.50, 2.75, 3.00, 3.25, 3.50, 3.75, 4.00, 4.25, 4.50, 4.75, 5.00]


def test_catalog_length_groups_and_expanded():
    rows = pipeline_catalog()["rows"]
    for r in rows:
        assert r["self_expanded_diameter_mm"] == pytest.approx(r["labeled_diameter_mm"] + 0.25)
        if r["labeled_diameter_mm"] in (2.50, 2.75):
            assert r["labeled_lengths_mm"] == [10, 12, 14, 16, 18, 20]
        else:
            assert r["labeled_lengths_mm"] == [10, 12, 14, 16, 18, 20, 25, 30, 35]


def test_catalog_internal_ids_not_skus_and_distinct():
    rows = pipeline_catalog()["rows"]
    ids = [r["device_id"] for r in rows]
    assert len(set(ids)) == len(ids)
    for did in ids:
        assert did.startswith("PIPELINE-HIST-")


def test_catalog_source_instructions_present():
    cat = pipeline_catalog()
    instr = cat["source_instructions"]
    assert instr["labeled_diameter"] == "approximates_target_vessel"
    assert instr["fully_expanded_diameter"] == "largest_target_vessel"
    assert instr["proximal_distal_differ"] == "match_larger_vessel"
    assert instr["labeled_length_rule"] == "at_least_neck_length_plus_6mm"
    assert "tolerance_mm" not in instr


# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------


def _good_measurements(**over):
    m = {
        "spatial_units": "mm",
        "proximal_parent": 3.4,
        "distal_parent": 3.8,
        "neck_coverage_length": 4.0,
    }
    m.update(over)
    return m


@pytest.mark.parametrize(
    "over",
    [
        {"proximal_parent": float("nan")},
        {"distal_parent": float("inf")},
        {"proximal_parent": -1.0},
        {"distal_parent": 0.0},
        {"neck_coverage_length": 0},
        {"proximal_parent": True},
        {"distal_parent": False},
        {"proximal_parent": "3.4"},
        {"proximal_parent": ""},
    ],
)
def test_invalid_numeric_inputs_rejected(over):
    m = _good_measurements(**over)
    with pytest.raises(DeviceSizingError):
        evaluate_pipeline(m)


def test_missing_or_unknown_units_no_numeric_outputs():
    for units in (None, "unknown", "voxels", ""):
        out = evaluate_pipeline(_good_measurements(spatial_units=units))
        assert out["status"] == "missing_inputs"
        assert out.get("largest_parent_mm") is None
        assert out["rows"] == []
        assert out["minimum_labeled_coverage_length_mm"] is None


def test_missing_field_is_missing_inputs():
    m = _good_measurements()
    del m["neck_coverage_length"]
    out = evaluate_pipeline(m)
    assert out["status"] == "missing_inputs"


# ---------------------------------------------------------------------------
# evaluate_pipeline geometry checks
# ---------------------------------------------------------------------------


def test_largest_parent_is_maximum():
    out = evaluate_pipeline(_good_measurements(proximal_parent=3.9, distal_parent=3.6))
    assert out["status"] == "geometric_checks_only"
    assert out["largest_parent_mm"] == pytest.approx(3.9)


def test_out_of_family_range_above():
    out = evaluate_pipeline(_good_measurements(distal_parent=5.1))
    assert out["status"] == "out_of_family_range"
    assert out["rows"] == []


def test_out_of_family_range_below():
    out = evaluate_pipeline(_good_measurements(proximal_parent=1.9, distal_parent=1.9))
    assert out["status"] == "out_of_family_range"
    assert out["rows"] == []


def test_family_range_boundaries_pass():
    for edge in (2.0, 5.0):
        out = evaluate_pipeline(_good_measurements(proximal_parent=edge, distal_parent=edge))
        assert out["status"] == "geometric_checks_only"


def test_per_row_differences_and_length_checks():
    out = evaluate_pipeline(
        _good_measurements(proximal_parent=3.25, distal_parent=3.25, neck_coverage_length=9.0)
    )
    assert out["status"] == "geometric_checks_only"
    assert out["minimum_labeled_coverage_length_mm"] == pytest.approx(15.0)
    row = next(r for r in out["rows"] if r["labeled_diameter_mm"] == 3.25)
    assert row["nominal_difference_mm"] == pytest.approx(0.0)
    assert row["diameter_equivalent"] is True
    assert row["length_checks_mm"][20.0] is True
    assert row["length_checks_mm"][14.0] is False
    big = next(r for r in out["rows"] if r["labeled_diameter_mm"] == 4.00)
    assert big["nominal_difference_mm"] == pytest.approx(0.75)
    assert big["diameter_equivalent"] is False
    assert big["length_checks_mm"][10] is False
    assert big["length_checks_mm"][16] is True


def test_neck_coverage_plus_6_boundary():
    out = evaluate_pipeline(_good_measurements(neck_coverage_length=10.0))
    assert out["minimum_labeled_coverage_length_mm"] == pytest.approx(16.0)
    row = next(r for r in out["rows"] if r["labeled_diameter_mm"] == 2.50)
    checks = row["length_checks_mm"]
    assert checks[10] is False
    assert checks[12] is False
    assert checks[16] is True


def test_no_length_16_in_short_group_boundary():
    # For 2.50/2.75 the 16 mm row must be the first meeting coverage=10mm+6
    out = evaluate_pipeline(_good_measurements(neck_coverage_length=10.0))
    row = next(r for r in out["rows"] if r["labeled_diameter_mm"] == 2.75)
    assert row["length_checks_mm"][16] is True


def test_no_recommendation_or_ranking():
    out = evaluate_pipeline(_good_measurements())
    assert "recommended_device" not in out
    assert "ranking" not in out
    assert out["clinical_suitability_established"] is False
    assert out["validated_sizing"] is False


# --------------------------------------------------- half-step indicator
def test_half_step_indicator_between_labeled_steps():
    out = evaluate_pipeline(
        _good_measurements(proximal_parent=3.48, distal_parent=3.48, neck_coverage_length=9.0)
    )
    assert out["status"] == "geometric_checks_only"
    nearest = next(r for r in out["rows"] if r["device_id"] == "PIPELINE-HIST-3_50")
    assert nearest["diameter_within_half_step"] is True
    assert nearest["diameter_equivalent"] is False
    assert nearest["nominal_difference_mm"] == pytest.approx(0.02)
    off = next(r for r in out["rows"] if r["device_id"] == "PIPELINE-HIST-3_25")
    assert off["diameter_within_half_step"] is False
    assert out["closest_labeled_match"] == {
        "device_id": "PIPELINE-HIST-3_50",
        "labeled_diameter_mm": 3.50,
    }


def test_half_step_indicator_true_for_exact_step():
    out = evaluate_pipeline(_good_measurements(proximal_parent=3.5, distal_parent=3.5))
    row = next(r for r in out["rows"] if r["device_id"] == "PIPELINE-HIST-3_50")
    assert row["diameter_equivalent"] is True
    assert row["diameter_within_half_step"] is True


def test_diameter_within_half_step_boundaries():
    # Half of the 0.25 mm catalog step, inclusive within float tolerance.
    assert diameter_within_half_step(3.50, 3.375) is True
    assert diameter_within_half_step(3.50, 3.374) is False
    assert diameter_within_half_step(3.50, 3.626) is False


def test_closest_labeled_match_picks_minimum_distance_and_ties_down():
    assert closest_labeled_match(3.48)["device_id"] == "PIPELINE-HIST-3_50"
    # Exact midpoint between 3.25 and 3.50 resolves to the smaller label.
    assert closest_labeled_match(3.375)["device_id"] == "PIPELINE-HIST-3_25"
    assert closest_labeled_match(10.0) is None  # far outside every row


# ---------------------------------------------------------------------------
# WEB targets
# ---------------------------------------------------------------------------


def _web_inputs(**over):
    m = {
        "spatial_units": "mm",
        "average_sac_diameter": 5.0,
        "smallest_sac_height": 4.5,
        "dome_diameter": 6.0,
    }
    m.update(over)
    return m


def test_web_arithmetic():
    out = web_sizing_targets(_web_inputs())
    assert out["approximate"] is True
    assert out["nominal_target_diameter_mm"] == pytest.approx(6.0)
    assert out["nominal_target_height_mm"] == pytest.approx(3.5)
    assert out["clinical_suitability_established"] is False
    assert "P170032C.pdf" in out["source"]["url"]
    assert out["source"]["revision"] == "LBA0040, Rev Q 12/2018"
    assert "tolerance" not in out
    assert out["status"] == "geometric_checks_only"


def test_web_dome_diameter_separate_from_average():
    out = web_sizing_targets(_web_inputs())
    assert out["dome_diameter_mm"] == pytest.approx(6.0)
    assert out["average_sac_diameter_mm"] == pytest.approx(5.0)
    assert out["dome_diameter_mm"] != out["average_sac_diameter_mm"]


def test_web_dome_out_of_family():
    for dome in (2.9, 10.1):
        out = web_sizing_targets(_web_inputs(dome_diameter=dome))
        assert out["status"] == "out_of_family_range"
        assert "nominal_target_diameter_mm" not in out


def test_web_dome_family_boundaries():
    for dome in (3.0, 10.0):
        out = web_sizing_targets(_web_inputs(dome_diameter=dome))
        assert out["status"] == "geometric_checks_only"


def test_web_height_target_unsupported():
    out = web_sizing_targets(_web_inputs(smallest_sac_height=1.0))
    assert out["status"] == "unsupported"
    assert "nominal_target_diameter_mm" not in out
    assert "nominal_target_height_mm" not in out


def test_web_missing_inputs():
    out = web_sizing_targets(_web_inputs(spatial_units=None))
    assert out["status"] == "missing_inputs"
    out = web_sizing_targets({k: v for k, v in _web_inputs().items() if k != "dome_diameter"})
    assert out["status"] == "missing_inputs"


@pytest.mark.parametrize(
    "over",
    [
        {"average_sac_diameter": float("nan")},
        {"smallest_sac_height": -2.0},
        {"dome_diameter": True},
        {"average_sac_diameter": "5.0"},
        {"dome_diameter": 0.0},
        {"smallest_sac_height": math.inf},
    ],
)
def test_web_invalid_inputs(over):
    with pytest.raises(DeviceSizingError):
        web_sizing_targets(_web_inputs(**over))


def test_web_no_recommendation():
    out = web_sizing_targets(_web_inputs())
    assert "device" not in out
    assert out["clinical_suitability_established"] is False
    assert out["validated_sizing"] is False
