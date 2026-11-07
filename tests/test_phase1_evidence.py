"""Regression checks for evidence boundaries in migrated Phase 1 modules."""

import math

import pytest

from planner import calculators as c
from planner.device_db import connect, query_devices, seed_default_catalog
from planner.territories import CaseContext, analyze_case_territories


@pytest.mark.parametrize("age,points", [(60, 0), (61, 1), (65, 1), (66, 2), (91, 7), (96, 8)])
def test_elapss_published_age_steps(age, points):
    result = c.compute_elapss_score(age_years=age)
    assert result["points_breakdown"]["age"] == points


def test_elapss_published_lowest_risk_band():
    result = c.compute_elapss_score(age_years=50, size_mm=2, earlier_sah=True)
    assert result["total_points"] == 0
    assert result["three_year_growth_risk_pct"] == 5.0


@pytest.mark.parametrize(
    "population,points",
    [
        ("north_american_european_other", 0),
        ("north_american_european_non_finnish", 0),
        ("other", 0),
        ("japanese", 3),
        ("finnish", 5),
    ],
)
def test_phases_population_aliases_preserve_published_points(population, points):
    result = c.compute_phases_score(population=population)
    assert result["points_breakdown"]["population"] == points
    assert result["total_points"] == points


# Fixed clinical-input examples cover both sides of every published risk band.
@pytest.mark.parametrize(
    "kwargs,points,risk",
    [
        (
            {
                "population": "other",
                "site": "ICA",
                "size_mm": 2,
                "hypertension": False,
                "earlier_sah_from_another_aneurysm": True,
                "age_years": 70,
            },
            2,
            0.4,
        ),
        (
            {
                "population": "other",
                "site": "ICA",
                "size_mm": 2,
                "hypertension": True,
                "earlier_sah_from_another_aneurysm": True,
                "age_years": 70,
            },
            3,
            0.7,
        ),
        (
            {
                "population": "other",
                "site": "ICA",
                "size_mm": 7,
                "hypertension": False,
                "earlier_sah_from_another_aneurysm": False,
                "age_years": 70,
            },
            4,
            0.9,
        ),
        (
            {
                "population": "other",
                "site": "ICA",
                "size_mm": 7,
                "hypertension": False,
                "earlier_sah_from_another_aneurysm": True,
                "age_years": 70,
            },
            5,
            1.3,
        ),
        (
            {
                "population": "other",
                "site": "ICA",
                "size_mm": 7,
                "hypertension": True,
                "earlier_sah_from_another_aneurysm": True,
                "age_years": 70,
            },
            6,
            1.7,
        ),
        (
            {
                "population": "other",
                "site": "ICA",
                "size_mm": 10,
                "hypertension": False,
                "earlier_sah_from_another_aneurysm": False,
                "age_years": 70,
            },
            7,
            2.4,
        ),
        (
            {
                "population": "other",
                "site": "ICA",
                "size_mm": 10,
                "hypertension": False,
                "earlier_sah_from_another_aneurysm": True,
                "age_years": 70,
            },
            8,
            3.2,
        ),
        (
            {
                "population": "other",
                "site": "ICA",
                "size_mm": 10,
                "hypertension": True,
                "earlier_sah_from_another_aneurysm": True,
                "age_years": 70,
            },
            9,
            4.3,
        ),
        (
            {
                "population": "other",
                "site": "ICA",
                "size_mm": 20,
                "hypertension": False,
                "earlier_sah_from_another_aneurysm": False,
                "age_years": 55,
            },
            10,
            5.3,
        ),
        (
            {
                "population": "other",
                "site": "ICA",
                "size_mm": 20,
                "hypertension": False,
                "earlier_sah_from_another_aneurysm": False,
                "age_years": 70,
            },
            11,
            7.2,
        ),
        (
            {
                "population": "other",
                "site": "ICA",
                "size_mm": 20,
                "hypertension": False,
                "earlier_sah_from_another_aneurysm": True,
                "age_years": 70,
            },
            12,
            17.8,
        ),
    ],
)
def test_phases_known_value_risk_band_boundaries(kwargs, points, risk):
    result = c.compute_phases_score(**kwargs)
    assert result["total_points"] == points
    assert result["five_year_rupture_risk_pct"] == risk


@pytest.mark.parametrize(
    "kwargs,points,risk",
    [
        (
            {
                "population": "north_american_chinese_european",
                "location": "ICA",
                "size_mm": 2,
                "age_years": 55,
                "shape_irregular": False,
                "earlier_sah": True,
            },
            0,
            5.0,
        ),
        (
            {
                "population": "north_american_chinese_european",
                "location": "ICA",
                "size_mm": 2,
                "age_years": 55,
                "shape_irregular": True,
                "earlier_sah": True,
            },
            4,
            5.0,
        ),
        (
            {
                "population": "north_american_chinese_european",
                "location": "ICA",
                "size_mm": 2,
                "age_years": 55,
                "shape_irregular": True,
                "earlier_sah": False,
            },
            5,
            7.8,
        ),
        (
            {
                "population": "north_american_chinese_european",
                "location": "ICA",
                "size_mm": 2,
                "age_years": 76,
                "shape_irregular": True,
                "earlier_sah": False,
            },
            9,
            7.8,
        ),
        (
            {
                "population": "north_american_chinese_european",
                "location": "ICA",
                "size_mm": 3,
                "age_years": 61,
                "shape_irregular": True,
                "earlier_sah": False,
            },
            10,
            11.7,
        ),
        (
            {
                "population": "north_american_chinese_european",
                "location": "ICA",
                "size_mm": 5,
                "age_years": 55,
                "shape_irregular": True,
                "earlier_sah": True,
            },
            14,
            11.7,
        ),
        (
            {
                "population": "north_american_chinese_european",
                "location": "ICA",
                "size_mm": 5,
                "age_years": 55,
                "shape_irregular": True,
                "earlier_sah": False,
            },
            15,
            17.5,
        ),
        (
            {
                "population": "north_american_chinese_european",
                "location": "ICA",
                "size_mm": 5,
                "age_years": 76,
                "shape_irregular": True,
                "earlier_sah": False,
            },
            19,
            17.5,
        ),
        (
            {
                "population": "north_american_chinese_european",
                "location": "MCA",
                "size_mm": 7,
                "age_years": 55,
                "shape_irregular": True,
                "earlier_sah": True,
            },
            20,
            25.8,
        ),
        (
            {
                "population": "north_american_chinese_european",
                "location": "ICA",
                "size_mm": 10,
                "age_years": 61,
                "shape_irregular": False,
                "earlier_sah": False,
            },
            24,
            25.8,
        ),
        (
            {
                "population": "north_american_chinese_european",
                "location": "MCA",
                "size_mm": 7,
                "age_years": 76,
                "shape_irregular": True,
                "earlier_sah": False,
            },
            25,
            42.7,
        ),
    ],
)
def test_elapss_known_value_risk_band_boundaries(kwargs, points, risk):
    result = c.compute_elapss_score(**kwargs)
    assert result["total_points"] == points
    assert result["three_year_growth_risk_pct"] == risk


@pytest.mark.parametrize(
    "kwargs",
    [
        {"size_mm": float("nan")},
        {"size_mm": -1},
        {"age_years": -1},
        {"population": "unrecognized"},
        {"hypertension": "no"},
    ],
)
def test_phases_rejects_invalid_inputs(kwargs):
    with pytest.raises(ValueError):
        c.compute_phases_score(**kwargs)


@pytest.mark.parametrize(
    "fn,kwargs",
    [
        (c.compute_tavr_annulus_sizing, {"annulus_area_mm2": math.nan, "annulus_perimeter_mm": 50}),
        (
            c.compute_evar_seal_zone,
            {
                "infrarenal_neck_diameter_mm": 20,
                "infrarenal_neck_length_mm": 15,
                "infrarenal_angle_deg": math.inf,
            },
        ),
    ],
)
def test_geometric_calculators_reject_nonfinite(fn, kwargs):
    with pytest.raises(ValueError):
        fn(**kwargs)


@pytest.mark.parametrize("field", ["minimal_lumen_diameter_mm", "distal_normal_diameter_mm"])
@pytest.mark.parametrize("value", [True, False, "1"])
def test_nascet_rejects_non_numeric_diameter_values(field, value):
    kwargs = {"minimal_lumen_diameter_mm": 1.0, "distal_normal_diameter_mm": 4.0}
    with pytest.raises(ValueError):
        c.compute_nascet_stenosis(**(kwargs | {field: value}))


def test_supplemental_device_seeds_do_not_fabricate_identifiers(tmp_path):
    with connect(tmp_path / "catalog.sqlite") as conn:
        seed_default_catalog(conn)
        rows = query_devices(conn)
        supplemental = [row for row in rows if row["territory"] != "neurovascular"]
        assert supplemental
        for row in supplemental:
            assert row["status"] == "unverified_seed"
            assert row["skus"] == []
            assert "number" not in row["regulatory"]
            assert row["regulatory"]["verification"] == "not_verified"


def test_unknown_coil_diameter_stays_unknown(tmp_path):
    with connect(tmp_path / "catalog.sqlite") as conn:
        seed_default_catalog(conn)
        for model in ("target-360", "axium-prime"):
            row = query_devices(conn, model_id=model)[0]
            assert row["spec"].get("primaryDiameterMm") is None
            assert row["skus"] == []


def test_empty_territory_context_does_not_invent_findings():
    result = analyze_case_territories(CaseContext(case_id="synthetic"))
    assert result.findings == []


def test_aneurysm_geometry_does_not_assign_severity_or_other_diagnoses():
    ctx = CaseContext(
        case_id="synthetic",
        measurements={"dome_width_mm": 6, "dome_height_mm": 7, "neck_width_mm": 3},
    )
    result = analyze_case_territories(ctx)
    assert len(result.findings) == 1
    assert result.findings[0].pathology == "intracranial_aneurysm"
    assert result.findings[0].severity == "unknown"
