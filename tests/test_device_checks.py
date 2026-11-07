"""Synthetic/catalog conformance, not clinical sizing validation."""

import copy
import json
from pathlib import Path

import pytest

from planner import device_checks
from planner.device_checks import device_catalog


@pytest.mark.parametrize(
    "field,value",
    [
        ("web_dome_family_range_mm", [10, 3]),
        ("web_dome_family_range_mm", [3]),
        ("web_dome_family_range_mm", [True, 10]),
        ("pipeline_coverage_margin_mm", 0),
        ("web_diameter_margin_mm", -1),
        ("web_height_margin_mm", True),
    ],
)
def test_catalog_rules_must_be_valid_even_when_hash_is_recomputed(field, value):
    catalog = device_catalog()
    catalog["rules"][field] = value
    catalog["catalog_version"] = device_checks.hashlib.sha256(
        device_checks.encoded({k: v for k, v in catalog.items() if k != "catalog_version"}).encode()
    ).hexdigest()
    with pytest.raises(ValueError):
        device_checks.validate_catalog(catalog)


def test_current_real_producer_exposes_only_explicit_partial_checks():
    env = geometry()
    result = device_checks.case_device_checks(env, device_catalog())
    assert result["status"] == "partial_inputs"
    assert result["geometry_status"] == "current"
    assert result["clinical_suitability_established"] is False
    assert result["validated_sizing"] is False
    assert result["dependencies"]["geometry_result_id"] == env["current"]["result_id"]
    assert result["dependencies"]["geometry"] == env["current"]["dependencies"]
    assert set(result["missing_dimensions"]) == {
        "neck_coverage_length",
        "average_sac_diameter",
        "smallest_sac_height",
        "dome_diameter",
    }
    proximal = result["checks"]["pipeline"]["parent_sections"]["proximal_parent"]
    assert (
        proximal["max_diameter_mm"] == env["current"]["result"]["proximal_parent"]["max_diameter"]
    )
    assert proximal["comparison"] == "outside_historical_range"
    assert result["checks"]["pipeline"]["sizing_status"] == "missing_inputs"
    assert result["checks"]["web"]["sizing_status"] == "missing_inputs"
    assert "nominal_target_diameter_mm" not in result["checks"]["web"]
    web_catalog_section = result["checks"]["web"]["catalog"]
    assert web_catalog_section["verified_specifications"] is False
    assert web_catalog_section["rows_available"] is True
    assert web_catalog_section["sku_count"] > 0


def test_frontend_web_catalog_is_an_unverified_listing_projection():
    catalog = device_checks.frontend_web_catalog()
    assert catalog["verified_specifications"] is False
    assert catalog["catalog_status"] in (
        "frontend_catalog_listing_unverified",
        "not_available",
    )
    for row in catalog["rows"]:
        assert row["category"] == "intrasaccular"
        for size in row["sizes"]:
            assert set(size) == {"sku", "diameter_mm", "height_mm", "catheter", "minimum_id_inch"}
            assert isinstance(size["sku"], str) and size["sku"]


def test_match_web_rows_uses_synthetic_rows_and_recorded_margins_only():
    rows = [
        {
            "id": "synthetic-web",
            "name": "Synthetic WEB (fixture)",
            "sizes": [
                {
                    "sku": "SYN-5-3",
                    "diameter_mm": 5.0,
                    "height_mm": 3.0,
                    "catheter": "SYN-17",
                    "minimum_id_inch": 0.017,
                },
                {
                    "sku": "SYN-7-2",
                    "diameter_mm": 7.0,
                    "height_mm": 2.0,
                    "catheter": "SYN-17",
                    "minimum_id_inch": 0.017,
                },
            ],
        }
    ]
    matches = device_checks.match_web_rows(rows, 5.8, 3.4)
    assert [m["sku"] for m in matches] == ["SYN-5-3"]
    assert matches[0]["diameter_difference_mm"] == pytest.approx(-0.8)
    assert matches[0]["height_difference_mm"] == pytest.approx(0.4)
    assert device_checks.match_web_rows(rows, 9.0, 2.0) == []
    for bad in ((0.0, 3.0), (5.0, -1), (float("nan"), 3.0), (True, 3.0)):
        with pytest.raises(ValueError):
            device_checks.match_web_rows(rows, *bad)


def geometry():
    return json.loads(
        (Path(__file__).parents[1] / "web/src/fixtures/geometry-current-metadata.json").read_text()
    )


def test_catalog_has_deterministic_independent_historical_rows():
    first = device_catalog()
    assert len(first["catalog_version"]) == 64
    assert first["catalog_version"] == device_catalog()["catalog_version"]
    assert first["version_basis"] == "canonical_catalog_and_rule_data_sha256"
    assert len(first["pipeline"]["rows"]) == 11
    assert first["pipeline"]["catalog_scope"] == "historical_source_only"
    assert first["web"]["rows"] == []
    assert first["web"]["catalog_status"] == "not_available"
    assert first["clinical_suitability_established"] is False
    assert first["validated_sizing"] is False
    first["pipeline"]["source"]["revision"] = "mutated consumer"
    first["pipeline"]["rows"].clear()
    assert len(device_catalog()["pipeline"]["rows"]) == 11
    assert device_catalog()["pipeline"]["source"]["revision"] != "mutated consumer"


@pytest.mark.parametrize("status", ["stale", "not_computed"])
def test_noncurrent_geometry_suppresses_all_case_numbers(status):
    env = geometry()
    env["current"] = {
        "status": status,
        "result": None,
        "stale_reasons": ["geometry_dependencies_changed"],
    }
    report = device_checks.case_device_checks(env, device_catalog())
    assert report["status"] == status
    assert report["checks"] is None
    assert report["dependencies"] is None
    assert report["stale_reasons"] == ["geometry_dependencies_changed"]


@pytest.mark.parametrize(
    "path,value",
    [
        (("current", "result", "spatial_units"), "unknown"),
        (("current", "result", "clinical_validation"), True),
        (("current", "result", "validated_morphometry"), True),
        (("current", "dependencies", "artifact_version"), "other"),
        (("current", "dependencies", "source_revision"), "other"),
        (("current", "result", "image_sha256"), "other"),
        (("current", "result", "proximal_parent", "method"), "manual_point_pair"),
        (("current", "result", "proximal_parent", "spatial_units"), "unknown"),
        (("current", "result", "proximal_parent", "validated_morphometry"), True),
        (("current", "result", "proximal_parent", "area"), float("nan")),
        (("current", "result", "proximal_parent", "max_diameter"), float("inf")),
        (("current", "result", "proximal_parent", "max_diameter"), True),
        (("current", "result", "proximal_parent", "max_diameter"), "5"),
        (("current", "result", "proximal_parent", "min_diameter"), 0),
        (("current", "result", "proximal_parent", "min_diameter"), 9),
    ],
)
def test_rejects_invalid_or_mismatched_current_geometry(path, value):
    env = geometry()
    field = env
    for key in path[:-1]:
        field = field[key]
    field[path[-1]] = value
    with pytest.raises(ValueError):
        device_checks.case_device_checks(env, device_catalog())


def test_catalog_version_binds_rule_data_and_rejects_modified_payload(monkeypatch):
    original = device_catalog()
    monkeypatch.setattr(device_checks, "COVERAGE_MARGIN_MM", 6.5)
    assert device_catalog()["catalog_version"] != original["catalog_version"]
    corrupted = copy.deepcopy(original)
    corrupted["pipeline"]["source"]["revision"] = "silently repinned"
    with pytest.raises(ValueError):
        device_checks.case_device_checks(geometry(), corrupted)
