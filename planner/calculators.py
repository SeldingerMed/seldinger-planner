"""Deterministic morphometric and clinical calculators across vascular territories.

Migrates and unifies deterministic calculators from `seldinger-app/apps/agent/calculators.py`
and `seldinger-ml/ml/seldinger_ml/pathologies/aneurysm/calculators.py`, adding coronary,
structural heart (TAVR), and peripheral/aortic (EVAR/NASCET) deterministic geometry helpers.

All outputs carry `clinical_suitability_established: False` to preserve strict research/planning
evidence boundaries.
"""

from __future__ import annotations

import math
from typing import Any

_PHASES_FIVE_YEAR_RISK_PCT: list[tuple[int, float]] = [
    (2, 0.4),
    (3, 0.7),
    (4, 0.9),
    (5, 1.3),
    (6, 1.7),
    (7, 2.4),
    (8, 3.2),
    (9, 4.3),
    (10, 5.3),
    (11, 7.2),
    (999, 17.8),
]

_ELAPSS_THREE_YEAR_RISK_PCT: list[tuple[int, float]] = [
    (4, 5.0),
    (9, 7.8),
    (14, 11.7),
    (19, 17.5),
    (24, 25.8),
    (999, 42.7),
]


def _number(value: Any, name: str, *, zero_allowed: bool = False) -> None:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or (value < 0 if zero_allowed else value <= 0)
    ):
        raise ValueError(
            f"{name} must be finite and {'non-negative' if zero_allowed else 'positive'}"
        )


def _score_inputs(
    age_years: int, size_mm: float, population: str, allowed: set[str], *flags: bool
) -> str:
    if type(age_years) is not int or not 0 <= age_years <= 130:
        raise ValueError("age_years must be an integer from 0 to 130")
    _number(size_mm, "size_mm")
    if any(type(flag) is not bool for flag in flags):
        raise ValueError("Clinical history flags must be explicit booleans")
    if not isinstance(population, str) or population.lower().strip() not in allowed:
        raise ValueError("Unknown score population")
    return population.lower().strip()


def compute_aneurysm_morphometrics(
    *,
    dome_width_mm: float,
    dome_height_mm: float,
    neck_width_mm: float,
    parent_artery_diameter_mm: float | None = None,
    sac_volume_mm3: float | None = None,
    sac_surface_area_mm2: float | None = None,
    dome_depth_mm: float | None = None,
) -> dict[str, Any]:
    """Compute Dhar 2008 / Ujiie 2001 / Raghavan 2005 aneurysm morphometric indices."""
    for name, val in (
        ("dome_width_mm", dome_width_mm),
        ("dome_height_mm", dome_height_mm),
        ("neck_width_mm", neck_width_mm),
    ):
        _number(val, name)
    for name, value in (
        ("parent_artery_diameter_mm", parent_artery_diameter_mm),
        ("sac_volume_mm3", sac_volume_mm3),
        ("sac_surface_area_mm2", sac_surface_area_mm2),
        ("dome_depth_mm", dome_depth_mm),
    ):
        if value is not None:
            _number(value, name)

    depth = dome_depth_mm if (dome_depth_mm and dome_depth_mm > 0) else dome_width_mm
    aspect_ratio = dome_height_mm / neck_width_mm
    dome_to_neck_ratio = dome_width_mm / neck_width_mm
    bottleneck_factor = max(dome_width_mm, depth) / neck_width_mm
    size_ratio = (
        dome_height_mm / parent_artery_diameter_mm
        if parent_artery_diameter_mm and parent_artery_diameter_mm > 0
        else None
    )

    if sac_volume_mm3 is not None and math.isfinite(sac_volume_mm3) and sac_volume_mm3 > 0:
        volume_mm3 = float(sac_volume_mm3)
        volume_source = "clipped_mesh_exact"
    else:
        volume_mm3 = (math.pi / 6.0) * dome_width_mm * depth * dome_height_mm
        volume_source = "ellipsoid_approximation"

    nonsphericity_index: float | None = None
    if (
        sac_surface_area_mm2 is not None
        and math.isfinite(sac_surface_area_mm2)
        and sac_surface_area_mm2 > 0
    ):
        # Raghavan et al. J Neurosurg 2005: NSI = 1 - (18*pi)^(1/3) * V^(2/3) / S
        sphere_ratio = (
            ((18.0 * math.pi) ** (1.0 / 3.0)) * (volume_mm3 ** (2.0 / 3.0)) / sac_surface_area_mm2
        )
        nonsphericity_index = round(max(0.0, 1.0 - sphere_ratio), 4)

    wide_neck = bool(neck_width_mm >= 4.0 or dome_to_neck_ratio < 2.0)

    return {
        "clinical_suitability_established": False,
        "aspect_ratio": round(aspect_ratio, 3),
        "size_ratio": round(size_ratio, 3) if size_ratio is not None else None,
        "dome_to_neck_ratio": round(dome_to_neck_ratio, 3),
        "bottleneck_factor": round(bottleneck_factor, 3),
        "nonsphericity_index": nonsphericity_index,
        "volume_mm3": round(volume_mm3, 3),
        "volume_ul": round(volume_mm3, 3),
        "volume_source": volume_source,
        "surface_area_mm2": round(sac_surface_area_mm2, 3) if sac_surface_area_mm2 else None,
        "wide_neck": wide_neck,
        "citations": [
            "Ujiie H et al. Neurosurgery 2001;48(3):495-503 (Aspect Ratio)",
            "Dhar S et al. Neurosurgery 2008;63(2):185-196 (Size Ratio)",
            "Raghavan ML et al. J Neurosurg 2005;102(2):355-362 (Nonsphericity Index)",
        ],
    }


def compute_phases_score(
    *,
    population: str = "north_american_european_other",
    hypertension: bool = False,
    age_years: int = 55,
    size_mm: float = 5.0,
    earlier_sah_from_another_aneurysm: bool = False,
    site: str = "ICA",
) -> dict[str, Any]:
    """PHASES 5-year aneurysm rupture risk score (Greving et al., Lancet Neurol 2014)."""
    breakdown: dict[str, int] = {}
    pop = _score_inputs(
        age_years,
        size_mm,
        population,
        {
            "north_american_european_other",
            "north_american_european_non_finnish",
            "other",
            "japanese",
            "finnish",
        },
        hypertension,
        earlier_sah_from_another_aneurysm,
    )
    breakdown["population"] = 5 if pop == "finnish" else (3 if pop == "japanese" else 0)
    breakdown["hypertension"] = 1 if hypertension else 0
    breakdown["age"] = 1 if age_years >= 70 else 0
    if size_mm < 7.0:
        breakdown["size"] = 0
    elif size_mm < 10.0:
        breakdown["size"] = 3
    elif size_mm < 20.0:
        breakdown["size"] = 6
    else:
        breakdown["size"] = 10
    breakdown["earlier_sah"] = 1 if earlier_sah_from_another_aneurysm else 0

    s = site.upper().strip()
    if s == "ICA":
        breakdown["site"] = 0
    elif s == "MCA":
        breakdown["site"] = 2
    elif s in {"ACA", "ACOM", "PCOM", "POSTERIOR", "BA", "VA", "SCA", "PICA", "AICA"}:
        breakdown["site"] = 4
    else:
        raise ValueError(f"Unknown PHASES site '{site}'")

    total = sum(breakdown.values())
    five_yr = next(r for cutoff, r in _PHASES_FIVE_YEAR_RISK_PCT if total <= cutoff)
    return {
        "clinical_suitability_established": False,
        "total_points": total,
        "points_breakdown": breakdown,
        "five_year_rupture_risk_pct": five_yr,
        "citation": "Greving JP et al. Lancet Neurol. 2014;13(1):59-66. PMID:24290159",
    }


def compute_elapss_score(
    *,
    earlier_sah: bool = False,
    location: str = "ICA",
    age_years: int = 55,
    population: str = "north_american_chinese_european",
    size_mm: float = 5.0,
    shape_irregular: bool = False,
) -> dict[str, Any]:
    """ELAPSS 3-year aneurysm growth risk score (Backes et al., Neurology 2017)."""
    _score_inputs(
        age_years,
        size_mm,
        population,
        {"north_american_chinese_european", "japanese", "finnish"},
        earlier_sah,
        shape_irregular,
    )
    breakdown: dict[str, int] = {}
    breakdown["earlier_sah"] = 0 if earlier_sah else 1
    loc = location.upper().strip()
    if loc in {"ICA", "ACA", "ACOM"}:
        breakdown["location"] = 0
    elif loc == "MCA":
        breakdown["location"] = 3
    elif loc in {"PCOM", "POSTERIOR", "BA", "VA", "PICA", "SCA"}:
        breakdown["location"] = 5
    else:
        raise ValueError(f"Unknown ELAPSS location '{location}'")

    breakdown["age"] = 0 if age_years <= 60 else min(8, ((age_years - 60 - 1) // 5 + 1))
    pop = population.lower().strip()
    breakdown["population"] = 7 if "finnish" in pop else (1 if "japanese" in pop else 0)
    if size_mm < 3.0:
        breakdown["size"] = 0
    elif size_mm < 5.0:
        breakdown["size"] = 4
    elif size_mm < 7.0:
        breakdown["size"] = 10
    elif size_mm < 10.0:
        breakdown["size"] = 13
    else:
        breakdown["size"] = 22
    breakdown["shape"] = 4 if shape_irregular else 0

    total = sum(breakdown.values())
    three_yr = next(r for cutoff, r in _ELAPSS_THREE_YEAR_RISK_PCT if total <= cutoff)
    return {
        "clinical_suitability_established": False,
        "total_points": total,
        "points_breakdown": breakdown,
        "three_year_growth_risk_pct": three_yr,
        "citation": "Backes D et al. Neurology. 2017;88(17):1600-1606. PMID:28363976",
        "table_crosscheck_url": "https://www.ars-neurochirurgica.com/en/scores-and-classifications/elapss-score",
        "evidence_boundary": "Published cohort risk-band lookup, not an individualized clinical prediction.",
    }


def compute_nascet_stenosis(
    *,
    minimal_lumen_diameter_mm: float,
    distal_normal_diameter_mm: float,
) -> dict[str, Any]:
    """Carotid NASCET diameter-reduction arithmetic; not coronary grading."""
    _number(minimal_lumen_diameter_mm, "minimal_lumen_diameter_mm", zero_allowed=True)
    _number(distal_normal_diameter_mm, "distal_normal_diameter_mm")
    stenosis_pct = max(
        0.0,
        min(100.0, (1.0 - (minimal_lumen_diameter_mm / distal_normal_diameter_mm)) * 100.0),
    )
    if stenosis_pct >= 99.0:
        band = "near_occlusion_or_occlusion"
    elif stenosis_pct >= 70.0:
        band = "severe_70_99"
    elif stenosis_pct >= 50.0:
        band = "moderate_50_69"
    else:
        band = "mild_under_50"
    return {
        "clinical_suitability_established": False,
        "minimal_lumen_diameter_mm": round(minimal_lumen_diameter_mm, 3),
        "distal_normal_diameter_mm": round(distal_normal_diameter_mm, 3),
        "stenosis_pct": round(stenosis_pct, 2),
        "severity_band": band,
        "citation": "NASCET Collaborators. N Engl J Med 1991;325:445-453.",
    }


def compute_tavr_annulus_sizing(
    *,
    annulus_area_mm2: float,
    annulus_perimeter_mm: float,
    left_coronary_height_mm: float | None = None,
    right_coronary_height_mm: float | None = None,
) -> dict[str, Any]:
    """Structural heart TAVR annular effective diameters and coronary clearance check."""
    _number(annulus_area_mm2, "annulus_area_mm2")
    _number(annulus_perimeter_mm, "annulus_perimeter_mm")
    for name, value in (
        ("left_coronary_height_mm", left_coronary_height_mm),
        ("right_coronary_height_mm", right_coronary_height_mm),
    ):
        if value is not None:
            _number(value, name, zero_allowed=True)
    area_diam = 2.0 * math.sqrt(annulus_area_mm2 / math.pi)
    perim_diam = annulus_perimeter_mm / math.pi
    eccentricity = abs(perim_diam - area_diam) / max(perim_diam, 1e-6)
    low_coronary = False
    for h in (left_coronary_height_mm, right_coronary_height_mm):
        if h is not None and h < 10.0:
            low_coronary = True
    return {
        "clinical_suitability_established": False,
        "annulus_area_mm2": round(annulus_area_mm2, 2),
        "annulus_perimeter_mm": round(annulus_perimeter_mm, 2),
        "area_derived_diameter_mm": round(area_diam, 3),
        "perimeter_derived_diameter_mm": round(perim_diam, 3),
        "annular_eccentricity_index": round(eccentricity, 4),
        "left_coronary_height_mm": left_coronary_height_mm,
        "right_coronary_height_mm": right_coronary_height_mm,
        "coronary_obstruction_flag": (
            True
            if low_coronary
            else False
            if left_coronary_height_mm is not None and right_coronary_height_mm is not None
            else None
        ),
        "heuristic_only": True,
        "device_specific_ifu_checked": False,
    }


def compute_evar_seal_zone(
    *,
    infrarenal_neck_diameter_mm: float,
    infrarenal_neck_length_mm: float,
    infrarenal_angle_deg: float,
    min_iliac_access_diameter_mm: float | None = None,
) -> dict[str, Any]:
    """Peripheral / Aortic EVAR infrarenal seal zone and oversizing (10-20%) arithmetic."""
    _number(infrarenal_neck_diameter_mm, "infrarenal_neck_diameter_mm")
    _number(infrarenal_neck_length_mm, "infrarenal_neck_length_mm", zero_allowed=True)
    _number(infrarenal_angle_deg, "infrarenal_angle_deg", zero_allowed=True)
    if infrarenal_angle_deg > 180:
        raise ValueError("Angle exceeds 180 degrees")
    if min_iliac_access_diameter_mm is not None:
        _number(min_iliac_access_diameter_mm, "min_iliac_access_diameter_mm")
    return {
        "clinical_suitability_established": False,
        "infrarenal_neck_diameter_mm": round(infrarenal_neck_diameter_mm, 2),
        "infrarenal_neck_length_mm": round(infrarenal_neck_length_mm, 2),
        "infrarenal_angle_deg": round(infrarenal_angle_deg, 1),
        "neck_length_10mm_heuristic_met": bool(infrarenal_neck_length_mm >= 10.0),
        "neck_angle_60deg_heuristic_met": bool(infrarenal_angle_deg <= 60.0),
        "illustrative_10_20pct_diameter_range_mm": (
            round(infrarenal_neck_diameter_mm * 1.10, 2),
            round(infrarenal_neck_diameter_mm * 1.20, 2),
        ),
        "min_iliac_access_diameter_mm": min_iliac_access_diameter_mm,
        "hostile_neck_flag": bool(infrarenal_neck_length_mm < 10.0 or infrarenal_angle_deg > 60.0),
        "heuristic_only": True,
        "device_specific_ifu_checked": False,
    }
