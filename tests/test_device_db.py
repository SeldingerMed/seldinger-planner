"""Tests for the unified SQLite device catalog & multi-territory seed DB."""

from pathlib import Path

import pytest

from planner.device_db import (
    CATEGORIES,
    connect,
    dedup_key,
    load_frontend_catalog,
    query_devices,
    seed_default_catalog,
    upsert_model,
    upsert_sku,
)


def synthetic_model(model_id="synthetic-coil", **overrides):
    return {
        "id": model_id,
        "name": "Synthetic coil",
        "vendor": "Synthetic",
        "category": "coil",
        **overrides,
    }


@pytest.mark.parametrize(
    "overrides", [{"vendor": "Other"}, {"category": "tavr"}, {"id": "other-id"}]
)
def test_model_identity_collision_is_rejected_without_overwrite(overrides):
    with connect() as conn:
        original = synthetic_model()
        upsert_model(conn, original)
        before = tuple(conn.execute("SELECT * FROM device_model").fetchone())
        with pytest.raises(ValueError, match="identity"):
            upsert_model(conn, original | overrides)
        assert tuple(conn.execute("SELECT * FROM device_model").fetchone()) == before


def test_sku_cannot_be_reassigned_to_another_model():
    with connect() as conn:
        upsert_model(conn, synthetic_model())
        upsert_model(conn, synthetic_model("other-coil", name="Other synthetic coil"))
        sku = {"di": "synthetic-di", "model_id": "synthetic-coil", "diameter_mm": 3}
        upsert_sku(conn, sku)
        before = tuple(conn.execute("SELECT * FROM device_sku").fetchone())
        with pytest.raises(ValueError, match="identity"):
            upsert_sku(conn, sku | {"model_id": "other-coil", "diameter_mm": 9})
        assert tuple(conn.execute("SELECT * FROM device_sku").fetchone()) == before


@pytest.mark.parametrize(
    "field,alias",
    [("primary_diameter_mm", "primaryDiameterMm"), ("min_catheter_id_in", "minimumIdInch")],
)
@pytest.mark.parametrize("value,expected", [(0.0, 0.0), (None, 0.3)])
def test_sku_numeric_alias_fallback_is_only_for_missing_values(field, alias, value, expected):
    with connect() as conn:
        upsert_model(conn, synthetic_model())
        upsert_sku(
            conn, {"di": "synthetic-di", "model_id": "synthetic-coil", field: value, alias: 0.3}
        )
        assert conn.execute(f"SELECT {field} FROM device_sku").fetchone()[0] == expected


def test_seed_does_not_replace_explicit_zero_sku_specification(tmp_path):
    import json

    path = tmp_path / "synthetic-catalog.json"
    path.write_text(
        json.dumps(
            {
                "devices": [
                    {
                        "id": "synthetic-coil",
                        "name": "Synthetic coil",
                        "manufacturer": "Synthetic",
                        "category": "coil",
                        "primaryDiameterMm": 0.3,
                        "sizes": [{"diameterMm": 3, "lengthMm": 10, "primaryDiameterMm": 0.0}],
                    }
                ]
            }
        )
    )
    with connect() as conn:
        seed_default_catalog(conn, frontend_path=path)
        row = query_devices(conn, model_id="synthetic-coil")[0]
        assert row["skus"][0]["primary_diameter_mm"] == 0.0


def test_dedup_key_is_deterministic_and_case_insensitive():
    k1 = dedup_key("Stryker Neurovascular", "Surpass Evolve", "flow_diverter")
    k2 = dedup_key("stryker-neurovascular", "SURPASS EVOLVE", "flow_diverter")
    assert k1 == k2
    assert len(k1) == 40


def test_seed_default_catalog_populates_all_categories_and_is_idempotent(tmp_path: Path):
    db_path = tmp_path / "devices.sqlite"
    conn = connect(db_path)
    first = seed_default_catalog(conn)
    assert first["models_total"] == len(load_frontend_catalog()["devices"]) + 6
    assert first["skus_total"] >= 40
    assert first["models_changed"] == first["models_total"]

    # Second run must be idempotent (0 dirty/changed model rows)
    second = seed_default_catalog(conn)
    assert second["models_total"] == first["models_total"]
    assert second["models_changed"] == 0
    assert second["skus_changed"] == 0

    # Check multi-territory coverage
    for territory in ("neurovascular", "coronary", "structural_heart", "peripheral_vascular"):
        rows = query_devices(conn, territory=territory)
        assert len(rows) >= 1, f"Expected devices for {territory}"

    # Category scaffolding covers the planned territories without invented product specs.
    for category in CATEGORIES:
        rows = query_devices(conn, category=category)
        assert len(rows) >= 1, f"Expected devices for category {category}"


def test_seed_retains_source_records_without_claiming_fresh_verification(tmp_path):
    import json

    from planner.device_db import content_hash

    with connect(tmp_path / "catalog.sqlite") as conn:
        seed_default_catalog(conn)
        records = conn.execute(
            "SELECT * FROM source_record WHERE source='frontend_catalog'"
        ).fetchall()
        assert len(records) == len(load_frontend_catalog()["devices"])
        for record in records:
            assert record["content_hash"] == content_hash(json.loads(record["payload_json"]))
        # Synchronizing a local listing is observation, not source/IFU verification.
        assert "last_seen" in {r[1] for r in conn.execute("PRAGMA table_info(device_model)")}
        seed_default_catalog(conn)
        assert conn.execute(
            "SELECT COUNT(*) FROM source_record WHERE source='frontend_catalog'"
        ).fetchone()[0] == len(records)


def test_frontend_catalog_syncs_coil_primary_diameters_and_web_skus(tmp_path: Path):
    frontend = load_frontend_catalog()
    assert frontend["catalogVersion"]
    by_id = {d["id"]: d for d in frontend["devices"]}
    assert "target-360" in by_id
    assert "axium-prime" in by_id
    assert by_id["target-360"].get("primaryDiameterMm") is None
    assert by_id["axium-prime"].get("primaryDiameterMm") is None
    assert by_id["target-360"]["sizes"] == []
    assert by_id["axium-prime"]["sizes"] == []

    db_path = tmp_path / "devices.sqlite"
    conn = connect(db_path)
    seed_default_catalog(conn)
    web_sl = query_devices(conn, model_id="web-sl")
    assert len(web_sl) == 1
    assert len(web_sl[0]["skus"]) >= 20
    assert any(s["catalog_number"] == "W5-4-2" for s in web_sl[0]["skus"])
