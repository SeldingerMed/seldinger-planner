"""Real temporary SQLite; every case, mask and number here is synthetic."""

import pytest
from test_device_inputs_state import MEASUREMENTS, PROVENANCE, SOURCE, fixture

from planner.device_calculation import (
    DEVICE_SIZING_CALCULATION_VERSION,
    calculate_reported_sizing,
)
from planner.device_results_state import DeviceResultsConflict, DeviceResultsLedger
from planner.workspace import _connect

DB_NAME = "workspace.sqlite3"


def payload():
    envelope = calculate_reported_sizing(MEASUREMENTS, PROVENANCE)
    # Pure calculation bound to the case snapshot by this layer; no clinical
    # or device-selection semantics are introduced by flipping the flag.
    return dict(envelope, binding_status="case_bound_calculation")


def seeded(tmp_path):
    client, case, masks, geometry, inputs, snapshot = fixture(tmp_path)
    results = DeviceResultsLedger(tmp_path / DB_NAME)
    saved = inputs.save_inputs(case["case_id"], snapshot, MEASUREMENTS, PROVENANCE, None)
    envelope = payload()
    geometry_env = geometry.store(case["case_id"], snapshot, {"synthetic_geometry_result": True})
    dependencies = {
        "geometry": snapshot,
        "geometry_result_id": geometry_env["result_id"],
        "input_revision": saved["input_revision"],
        "inputs_sha256": saved["inputs_sha256"],
        "catalog_version": envelope["catalog_version"],
        "calculation_version": DEVICE_SIZING_CALCULATION_VERSION,
    }
    return client, case, masks, geometry, inputs, results, snapshot, dependencies, envelope


def test_current_roundtrip_frozen_snapshot_no_case_bump(tmp_path):
    client, case, _masks, _geometry, _inputs, results, snapshot, deps, envelope = seeded(tmp_path)
    baseline_version = snapshot["artifact_version"]
    stored = results.store(case["case_id"], deps, envelope)
    assert stored["status"] == "current"
    assert stored["result"] == envelope
    current = results.current(case["case_id"], SOURCE, deps["catalog_version"])
    assert current["status"] == "current"
    assert current["result_id"] == stored["result_id"]
    assert current["dependencies"] == deps
    assert current["result"] == envelope
    # Frozen values: mutating the caller's objects changes nothing later.
    deps["geometry"]["artifact_version"] = "tampered"
    envelope["binding_status"] = "tampered"
    again = results.current(case["case_id"], SOURCE, deps["catalog_version"])
    assert again["dependencies"] == dict(current["dependencies"])
    # Storing results never bumps the case artifact_version.
    assert client.get(f"/api/cases/{case['case_id']}").json()["artifact_version"] == (
        baseline_version
    )


@pytest.mark.parametrize(
    "field,value",
    [
        ("catalog_version", "not-a-hash"),
        ("catalog_version", "A" * 64),
        ("calculation_version", "unsupported-version"),
    ],
)
def test_store_rejects_malformed_catalog_or_unsupported_calculation(tmp_path, field, value):
    _client, case, _masks, _geometry, _inputs, results, _snapshot, deps, envelope = seeded(tmp_path)
    deps[field] = value
    with pytest.raises(ValueError):
        results.store(case["case_id"], deps, envelope)


@pytest.mark.parametrize(
    "field,value",
    [("results_version", "unsupported"), ("result", '{"clinical_suitability_established":true}')],
)
def test_read_rechecks_stored_result_schema_and_safety_flags(tmp_path, field, value):
    _client, case, _masks, _geometry, _inputs, results, _snapshot, deps, envelope = seeded(tmp_path)
    results.store(case["case_id"], deps, envelope)
    with _connect(results.db_path) as conn:
        conn.execute(
            f"UPDATE device_results SET {field}=? WHERE case_id=?", (value, case["case_id"])
        )
    with pytest.raises(ValueError):
        results.current(case["case_id"], SOURCE, deps["catalog_version"])


@pytest.mark.parametrize("field", ["catalog_version", "calculation_version"])
def test_result_metadata_cannot_contradict_its_dependency_binding(tmp_path, field):
    _client, case, _masks, _geometry, _inputs, results, _snapshot, deps, envelope = seeded(tmp_path)
    envelope[field] = "contradictory"
    with pytest.raises(ValueError):
        results.store(case["case_id"], deps, envelope)


def test_input_replacement_invalidates(tmp_path):
    _client, case, _masks, _geometry, inputs, results, snapshot, deps, envelope = seeded(tmp_path)
    results.store(case["case_id"], deps, envelope)
    inputs.save_inputs(case["case_id"], snapshot, MEASUREMENTS, PROVENANCE, deps["input_revision"])
    stale = results.current(case["case_id"], SOURCE, deps["catalog_version"])
    assert stale["status"] == "stale"
    assert stale["result"] is None
    assert "dependencies" not in stale
    assert stale["stale_reasons"] == ["device_sizing_dependencies_changed"]


def test_notes_change_suppresses_results(tmp_path):
    client, case, _masks, _geometry, _inputs, results, _snapshot, deps, envelope = seeded(tmp_path)
    results.store(case["case_id"], deps, envelope)
    client.patch(
        f"/api/cases/{case['case_id']}/notes",
        json={
            "artifact_version": client.get(f"/api/cases/{case['case_id']}").json()[
                "artifact_version"
            ],
            "notes": "Synthetic note edit",
        },
    )
    stale = results.current(case["case_id"], SOURCE, deps["catalog_version"])
    assert stale["status"] == "stale"
    assert stale["result"] is None


def test_accepted_mask_change_suppresses_results(tmp_path):
    _client, case, masks, _geometry, _inputs, results, _snapshot, deps, envelope = seeded(tmp_path)
    results.store(case["case_id"], deps, envelope)
    entry = masks.preview(
        case["case_id"],
        case["artifact_version"],
        reference_revision=SOURCE,
        producer="aneurysm_model",
        role="aneurysm",
        mask_sha256="9" * 64,
        provenance={"synthetic_fixture": True},
    )
    masks.decide(case["case_id"], entry["candidate_id"], case["artifact_version"], "accept")
    stale = results.current(case["case_id"], SOURCE, deps["catalog_version"])
    assert stale["status"] == "stale"
    assert stale["result"] is None


def test_rejected_preview_preserves_results(tmp_path):
    _client, case, masks, _geometry, _inputs, results, _snapshot, deps, envelope = seeded(tmp_path)
    stored = results.store(case["case_id"], deps, envelope)
    entry = masks.preview(
        case["case_id"],
        case["artifact_version"],
        reference_revision=SOURCE,
        producer="aneurysm_model",
        role="aneurysm",
        mask_sha256="8" * 64,
        provenance={"synthetic_fixture": True},
    )
    masks.decide(case["case_id"], entry["candidate_id"], case["artifact_version"], "reject")
    current = results.current(case["case_id"], SOURCE, deps["catalog_version"])
    assert current["status"] == "current"
    assert current["result_id"] == stored["result_id"]


def test_new_geometry_result_id_suppresses_results(tmp_path):
    _client, case, _masks, geometry, _inputs, results, snapshot, deps, envelope = seeded(tmp_path)
    results.store(case["case_id"], deps, envelope)
    # A newer materialized geometry result row, same capture, new opaque id.
    geometry.store(case["case_id"], snapshot, {"synthetic_geometry_result": True})
    stale = results.current(case["case_id"], SOURCE, deps["catalog_version"])
    assert stale["status"] == "stale"
    assert stale["result"] is None


def test_source_change_suppresses_results(tmp_path):
    _client, case, _masks, geometry, _inputs, results, _snapshot, deps, envelope = seeded(tmp_path)
    results.store(case["case_id"], deps, envelope)
    with _connect(geometry.db_path) as conn:
        conn.execute(
            "UPDATE geometry_inputs SET source_revision=? WHERE case_id=?",
            ("f" * 64, case["case_id"]),
        )
    stale = results.current(case["case_id"], SOURCE, deps["catalog_version"])
    assert stale["status"] == "stale"
    assert stale["result"] is None


def test_catalog_or_calculation_version_change_suppresses_results(tmp_path):
    _client, case, _masks, _geometry, _inputs, results, _snapshot, deps, envelope = seeded(tmp_path)
    results.store(case["case_id"], deps, envelope)
    stale = results.current(case["case_id"], SOURCE, "0" * 64, DEVICE_SIZING_CALCULATION_VERSION)
    assert stale["status"] == "stale"
    assert stale["result"] is None
    stale = results.current(
        case["case_id"], SOURCE, deps["catalog_version"], "other-calculation-v2"
    )
    assert stale["status"] == "stale"
    assert stale["result"] is None


def test_raced_store_refuses_write(tmp_path):
    _client, case, _masks, _geometry, inputs, results, snapshot, deps, envelope = seeded(tmp_path)
    inputs.save_inputs(case["case_id"], snapshot, MEASUREMENTS, PROVENANCE, deps["input_revision"])
    with pytest.raises(DeviceResultsConflict):
        results.store(case["case_id"], deps, envelope)
    with _connect(results.db_path) as conn:
        count = conn.execute("SELECT COUNT(*) FROM device_results").fetchone()[0]
    assert count == 0


def test_not_computed_and_missing_case(tmp_path):
    _client, case, _masks, _geometry, _inputs, results, _s, _d, _e = seeded(tmp_path)
    assert results.current(case["case_id"], SOURCE, "0" * 64) == {
        "status": "not_computed",
        "result": None,
    }
    with pytest.raises(DeviceResultsConflict):
        results.current("missing-case", SOURCE, "0" * 64)


@pytest.mark.parametrize(
    "result",
    [
        [],
        dict(payload(), validated_sizing=True),
        dict(payload(), clinical_suitability_established=True),
        dict(payload(), binding_status="unbound_pure_calculation"),
        dict(payload(), padding="x" * 70000),
        float("nan"),
    ],
)
def test_malformed_results_rejected(tmp_path, result):
    _client, case, _masks, _geometry, _inputs, results, _s, deps, _envelope = seeded(tmp_path)
    with pytest.raises(ValueError):
        results.store(case["case_id"], deps, result)
    assert (
        results.current(case["case_id"], SOURCE, deps["catalog_version"])["status"]
        == "not_computed"
    )


@pytest.mark.parametrize(
    "dependencies",
    [
        {},
        dict(payload(), extra="no"),
        {"geometry": {"source_revision": SOURCE}},
    ],
)
def test_malformed_dependencies_rejected(tmp_path, dependencies):
    _client, case, _masks, _geometry, _inputs, results, _s, deps, envelope = seeded(tmp_path)
    with pytest.raises(ValueError):
        results.store(case["case_id"], dependencies, envelope)
    assert (
        results.current(case["case_id"], SOURCE, deps["catalog_version"])["status"]
        == "not_computed"
    )


def test_read_in_transaction_matches_inputs_within_caller_transaction(tmp_path):
    from contextlib import closing

    from planner.workspace import _connect as connect

    _client, case, _masks, _geometry, inputs, results, _snapshot, deps, envelope = seeded(tmp_path)
    results.store(case["case_id"], deps, envelope)
    with closing(connect(results.db_path)) as conn:
        conn.execute("BEGIN")
        envelope_read = inputs.read_in_transaction(conn, case["case_id"], SOURCE)
        assert envelope_read["status"] == "current"
        assert envelope_read["input_revision"] == deps["input_revision"]
        assert envelope_read["inputs_sha256"] == deps["inputs_sha256"]
        assert conn.in_transaction
