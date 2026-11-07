"""Tests for deterministic calculators and multi-territory plugin framework."""

import math

import pytest

from planner.calculators import (
    compute_aneurysm_morphometrics,
    compute_elapss_score,
    compute_evar_seal_zone,
    compute_nascet_stenosis,
    compute_phases_score,
    compute_tavr_annulus_sizing,
)
from planner.territories import (
    CaseContext,
    analyze_case_territories,
    enabled_plugins_for_modality,
    list_territory_plugins,
)


def test_compute_aneurysm_morphometrics_indices_and_volume():
    res = compute_aneurysm_morphometrics(
        dome_width_mm=6.0,
        dome_height_mm=7.5,
        neck_width_mm=4.0,
        parent_artery_diameter_mm=3.0,
        sac_volume_mm3=135.0,
        sac_surface_area_mm2=135.0,
    )
    assert res["clinical_suitability_established"] is False
    assert res["aspect_ratio"] == pytest.approx(7.5 / 4.0)
    assert res["size_ratio"] == pytest.approx(7.5 / 3.0)
    assert res["dome_to_neck_ratio"] == pytest.approx(6.0 / 4.0)
    assert res["bottleneck_factor"] == pytest.approx(6.0 / 4.0)
    assert res["volume_mm3"] == pytest.approx(135.0)
    assert res["volume_source"] == "clipped_mesh_exact"
    assert res["wide_neck"] is True
    assert res["nonsphericity_index"] is not None
    assert res["nonsphericity_index"] >= 0.0


def test_compute_phases_and_elapss_scores():
    phases = compute_phases_score(
        population="north_american_european_other",
        hypertension=True,
        age_years=72,
        size_mm=7.5,
        earlier_sah_from_another_aneurysm=False,
        site="PCom",
    )
    assert phases["total_points"] == 0 + 1 + 1 + 3 + 0 + 4
    assert phases["five_year_rupture_risk_pct"] == pytest.approx(4.3)

    elapss = compute_elapss_score(
        earlier_sah=False,
        location="ICA",
        age_years=65,
        population="north_american_chinese_european",
        size_mm=6.2,
        shape_irregular=True,
    )
    assert elapss["total_points"] > 0
    assert elapss["three_year_growth_risk_pct"] > 0


def test_multi_territory_calculators_nascet_tavr_evar():
    nascet = compute_nascet_stenosis(minimal_lumen_diameter_mm=1.5, distal_normal_diameter_mm=5.0)
    assert nascet["stenosis_pct"] == pytest.approx(70.0)
    assert nascet["severity_band"] == "severe_70_99"

    annulus_area = math.pi * (12.0**2)
    tavr = compute_tavr_annulus_sizing(
        annulus_area_mm2=annulus_area,
        annulus_perimeter_mm=2.0 * math.pi * 12.0,
        left_coronary_height_mm=13.5,
        right_coronary_height_mm=15.0,
    )
    assert tavr["area_derived_diameter_mm"] == pytest.approx(24.0)
    assert tavr["coronary_obstruction_flag"] is False

    evar = compute_evar_seal_zone(
        infrarenal_neck_diameter_mm=24.0,
        infrarenal_neck_length_mm=18.0,
        infrarenal_angle_deg=35.0,
        min_iliac_access_diameter_mm=7.5,
    )
    assert evar["neck_length_10mm_heuristic_met"] is True
    assert evar["illustrative_10_20pct_diameter_range_mm"][0] == pytest.approx(26.4)


def test_territory_plugin_registry_covers_neuro_heart_and_peripheral():
    plugins = list_territory_plugins()
    keys = {p["key"] for p in plugins}
    assert {
        "intracranial_aneurysm",
        "acute_ischemic_stroke_lvo",
        "carotid_stenosis",
        "coronary_lesion_pci",
        "aortic_valve_tavr",
        "aortic_aneurysm_evar",
    }.issubset(keys)

    cta_plugins = enabled_plugins_for_modality("CTA")
    assert len(cta_plugins) >= 5

    ctx = CaseContext(
        case_id="case-001",
        modality="CTA",
        territory="neurovascular",
        measurements={
            "dome_width_mm": 6.2,
            "dome_height_mm": 7.8,
            "neck_width_mm": 4.1,
            "parent_artery_diameter_mm": 3.4,
            "sac_volume_mm3": 145.0,
        },
    )
    collection = analyze_case_territories(ctx, keys=["intracranial_aneurysm"])
    payload = collection.to_dict()
    assert payload["case_id"] == "case-001"
    assert len(payload["findings"]) >= 1
    assert payload["findings"][0]["pathology"] == "intracranial_aneurysm"
