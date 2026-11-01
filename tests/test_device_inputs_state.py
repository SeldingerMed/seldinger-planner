"""Real temporary SQLite; every case, mask and number here is synthetic."""

import pytest
from fastapi.testclient import TestClient

from planner.device_inputs_state import (
    DEVICE_INPUTS_VERSION,
    DeviceInputsConflict,
    DeviceInputsLedger,
)
from planner.geometry_state import GeometryLedger
from planner.segmentation_state import SegmentationLedger
from planner.workspace import create_app

SOURCE = "b" * 64
MEASUREMENTS = {
    "proximal_parent": 8.0,
    "distal_parent": 9.0,
    "neck_coverage_length": 15.0,
    "average_sac_diameter": 20.0,
    "smallest_sac_height": 18.0,
    "dome_diameter": 22.0,
}
PROVENANCE = {"kind": "operator_reported", "note": "synthetic operator tape values"}


def fixture(tmp_path):
    db = tmp_path / "workspace.sqlite3"
    client = TestClient(create_app(db))
    case = client.post(
        "/api/cases",
        json={
            "title": "Synthetic device inputs",
            "image_sha256": "a" * 64,
            "dimensions": [20, 20, 20],
            "spacing_mm": [1, 1, 1],
            "spatial_units": "mm",
        },
    ).json()
    masks = SegmentationLedger(db)
    for role, producer, digest in [
        ("vessel", "owned_vessel", "c" * 64),
        ("aneurysm", "aneurysm_model", "d" * 64),
    ]:
        entry = masks.preview(
            case["case_id"],
            case["artifact_version"],
            reference_revision=SOURCE,
            producer=producer,
            role=role,
            mask_sha256=digest,
            provenance={"synthetic_fixture": True},
        )
        masks.decide(case["case_id"], entry["candidate_id"], case["artifact_version"], "accept")
        case = client.get(f"/api/cases/{case['case_id']}").json()
    geometry = GeometryLedger(db)
    geometry.save_inputs(
        case["case_id"], case["artifact_version"], SOURCE, {"synthetic_operator_input": [1, 2, 3]}
    )
    case = client.get(f"/api/cases/{case['case_id']}").json()
    snapshot = geometry.snapshot(case["case_id"], case["artifact_version"], SOURCE)
    return client, case, masks, geometry, DeviceInputsLedger(db), snapshot


def test_snapshot_is_frozen_before_database_entry_even_if_caller_alias_changes(
    tmp_path, monkeypatch
):
    import planner.device_inputs_state as state

    client, case, _masks, _geometry, ledger, snapshot = fixture(tmp_path)
    original = state._connect
    changed = False

    def connect(path):
        nonlocal changed
        if not changed:
            changed = True
            newer = client.patch(
                f"/api/cases/{case['case_id']}/notes",
                json={
                    "artifact_version": case["artifact_version"],
                    "notes": "Synthetic concurrent edit",
                },
            ).json()
            snapshot["artifact_version"] = newer["artifact_version"]
        return original(path)

    monkeypatch.setattr(state, "_connect", connect)
    with pytest.raises(DeviceInputsConflict):
        ledger.save_inputs(case["case_id"], snapshot, MEASUREMENTS, PROVENANCE, None)
    assert ledger.inputs(case["case_id"], SOURCE)["status"] == "not_saved"


def test_current_inputs_can_be_read_without_ending_the_callers_transaction(tmp_path):
    from contextlib import closing

    from planner.workspace import _connect

    _client, case, _masks, _geometry, ledger, snapshot = fixture(tmp_path)
    saved = ledger.save_inputs(case["case_id"], snapshot, MEASUREMENTS, PROVENANCE, None)
    with closing(_connect(ledger.db_path)) as conn:
        conn.execute("BEGIN")
        assert ledger.read_in_transaction(conn, case["case_id"], SOURCE) == saved
        assert conn.in_transaction
        assert conn.execute("SELECT 1").fetchone()[0] == 1


@pytest.mark.parametrize(
    "field,value",
    [
        ("measurements", '{"proximal_parent":42}'),
        ("inputs_sha256", "0" * 64),
        ("inputs_version", "unsupported"),
    ],
)
def test_current_input_integrity_is_verified_on_read(tmp_path, field, value):
    from planner.workspace import _connect

    _client, case, _masks, _geometry, ledger, snapshot = fixture(tmp_path)
    ledger.save_inputs(case["case_id"], snapshot, MEASUREMENTS, PROVENANCE, None)
    with _connect(ledger.db_path) as conn:
        conn.execute(
            f"UPDATE device_inputs SET {field}=? WHERE case_id=?", (value, case["case_id"])
        )
    with pytest.raises(ValueError):
        ledger.inputs(case["case_id"], SOURCE)


def test_save_acknowledges_its_own_write_not_a_postcommit_latest_read(tmp_path, monkeypatch):
    _client, case, _masks, _geometry, ledger, snapshot = fixture(tmp_path)
    monkeypatch.setattr(
        ledger,
        "inputs",
        lambda *_: {
            "status": "current",
            "input_revision": "another-writers-revision",
            "measurements": {},
        },
    )
    saved = ledger.save_inputs(case["case_id"], snapshot, MEASUREMENTS, PROVENANCE, None)
    assert saved["measurements"] == MEASUREMENTS
    assert saved["input_revision"] != "another-writers-revision"


def test_save_current_roundtrip_hash_independence_no_case_bump(tmp_path):
    client, case, _masks, _geometry, ledger, snapshot = fixture(tmp_path)
    envelope = ledger.save_inputs(case["case_id"], snapshot, MEASUREMENTS, PROVENANCE, None)
    assert envelope["status"] == "current"
    assert envelope["measurements"] == MEASUREMENTS
    assert envelope["provenance"] == PROVENANCE
    assert envelope["inputs_version"] == DEVICE_INPUTS_VERSION
    assert len(envelope["inputs_sha256"]) == 64
    reopened = ledger.inputs(case["case_id"], SOURCE)
    assert reopened == envelope
    # Independent parsed JSON, not mutable internal aliases.
    reopened["measurements"]["proximal_parent"] = 1.0
    assert ledger.inputs(case["case_id"], SOURCE)["measurements"] == MEASUREMENTS
    # Saving inputs never bumps the case artifact_version.
    assert (
        client.get(f"/api/cases/{case['case_id']}").json()["artifact_version"]
        == (snapshot["artifact_version"])
    )


def test_optimistic_input_revision_conflict(tmp_path):
    _client, case, _masks, _geometry, ledger, snapshot = fixture(tmp_path)
    first = ledger.save_inputs(case["case_id"], snapshot, MEASUREMENTS, PROVENANCE, None)
    with pytest.raises(DeviceInputsConflict):
        ledger.save_inputs(case["case_id"], snapshot, MEASUREMENTS, PROVENANCE, None)
    again = ledger.save_inputs(
        case["case_id"], snapshot, MEASUREMENTS, PROVENANCE, first["input_revision"]
    )
    assert again["status"] == "current"
    assert again["input_revision"] != first["input_revision"]


def test_wrong_or_tampered_snapshot_refuses_save(tmp_path):
    _client, case, _masks, _geometry, ledger, snapshot = fixture(tmp_path)
    wrong = dict(snapshot, operator_sha256="e" * 64)
    with pytest.raises(DeviceInputsConflict):
        ledger.save_inputs(case["case_id"], wrong, MEASUREMENTS, PROVENANCE, None)
    stale = dict(snapshot, source_revision="f" * 64)
    with pytest.raises(DeviceInputsConflict):
        ledger.save_inputs(case["case_id"], stale, MEASUREMENTS, PROVENANCE, None)
    assert ledger.inputs(case["case_id"], SOURCE)["status"] == "not_saved"


@pytest.mark.parametrize("change", ["mask", "operator_inputs", "source"])
def test_dependency_changes_suppress_numbers(tmp_path, change):
    _client, case, masks, geometry, ledger, snapshot = fixture(tmp_path)
    ledger.save_inputs(case["case_id"], snapshot, MEASUREMENTS, PROVENANCE, None)
    if change == "mask":
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
    elif change == "operator_inputs":
        geometry.save_inputs(
            case["case_id"],
            case["artifact_version"],
            SOURCE,
            {"synthetic_operator_input": [4, 5]},
        )
    else:
        from planner.workspace import _connect

        with _connect(geometry.db_path) as conn:
            conn.execute(
                "UPDATE geometry_inputs SET source_revision=? WHERE case_id=?",
                ("f" * 64, case["case_id"]),
            )
    stale = ledger.inputs(case["case_id"], SOURCE)
    assert stale["status"] == "stale"
    assert stale["input_revision"] is not None
    assert stale["inputs_sha256"] is None
    assert stale["measurements"] is None
    assert stale["provenance"] is None
    assert stale["inputs_version"] == DEVICE_INPUTS_VERSION


@pytest.mark.parametrize(
    "measurements",
    [
        {"proximal_parent": "8"},
        {"proximal_parent": True},
        {"proximal_parent": -1.0},
        {"dome_diameter": 101},
        {"dome_diameter": 10**400},
        {"average_sac_diameter": float("nan")},
        {"bogus_key": 1.0},
    ],
)
def test_malformed_measurements_rejected(tmp_path, measurements):
    _client, case, _masks, _geometry, ledger, snapshot = fixture(tmp_path)
    with pytest.raises(ValueError):
        ledger.save_inputs(case["case_id"], snapshot, measurements, PROVENANCE, None)
    assert ledger.inputs(case["case_id"], SOURCE)["status"] == "not_saved"


@pytest.mark.parametrize(
    "provenance",
    [
        {"kind": "verified_measurement", "note": "x"},
        {"kind": "operator_reported", "note": "  "},
        {"kind": "operator_reported", "note": "x" * 513},
        {"kind": "operator_reported", "note": "x", "clinician": "a"},
        "operator_reported",
        {"kind": "operator_reported"},
    ],
)
def test_malformed_provenance_rejected(tmp_path, provenance):
    _client, case, _masks, _geometry, ledger, snapshot = fixture(tmp_path)
    with pytest.raises(ValueError):
        ledger.save_inputs(case["case_id"], snapshot, MEASUREMENTS, provenance, None)
    assert ledger.inputs(case["case_id"], SOURCE)["status"] == "not_saved"


def test_immutable_history_and_no_resurrection(tmp_path):
    _client, case, _masks, _geometry, ledger, snapshot = fixture(tmp_path)
    first = ledger.save_inputs(case["case_id"], snapshot, MEASUREMENTS, PROVENANCE, None)
    updated = ledger.save_inputs(
        case["case_id"],
        snapshot,
        {key: 5.0 for key in MEASUREMENTS},
        PROVENANCE,
        first["input_revision"],
    )
    latest = ledger.inputs(case["case_id"], SOURCE)
    assert latest["input_revision"] == updated["input_revision"]
    assert latest["measurements"]["proximal_parent"] == 5.0
    from planner.workspace import _connect

    with _connect(ledger.db_path) as conn:
        rows = conn.execute(
            "SELECT input_id FROM device_inputs WHERE case_id=? ORDER BY rowid",
            (case["case_id"],),
        ).fetchall()
    assert [row["input_id"] for row in rows] == [first["input_revision"], updated["input_revision"]]
    # After dependencies change, the old history row must not be resurrected.
    with _connect(ledger.db_path) as conn:
        conn.execute("UPDATE cases SET image_sha256=? WHERE case_id=?", ("f" * 64, case["case_id"]))
    stale = ledger.inputs(case["case_id"], SOURCE)
    assert stale["status"] == "stale"
    assert stale["measurements"] is None
