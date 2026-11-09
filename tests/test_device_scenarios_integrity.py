"""Parent verification of exact identity, immutable acknowledgement and integrity."""

import hashlib
import json

import pytest
from test_device_scenarios import scenario, seeded

from planner.device_scenarios import DeviceScenarioConflict, validate_identity, validate_scenarios
from planner.workspace import _connect


@pytest.mark.parametrize(
    "patch",
    [
        {"reference_revision": "x" * 64},
        {"catalog_version": "not-a-hash"},
        {"artifact_version": "-1"},
        {"artifact_version": "0"},
        {"case_id": "../../other"},
        {"geometry_result_id": "x" * 101},
    ],
)
def test_identity_requires_exact_bounded_hashes_and_positive_version(tmp_path, patch):
    _, _, _, _, _, identity = seeded(tmp_path)
    with pytest.raises(ValueError):
        validate_identity({**identity, **patch})


def test_optional_braid_angle_cannot_be_explicit_null():
    with pytest.raises(ValueError):
        validate_scenarios([scenario(braidAngle=None)])


def test_corrupt_latest_payload_does_not_hide_behind_identity_staleness(tmp_path):
    _, _, _, ledger, _, identity = seeded(tmp_path)
    saved = ledger.store(identity, 0, [scenario()])
    with _connect(ledger.db_path) as conn:
        conn.execute(
            "UPDATE device_scenario_sets SET scenarios=? WHERE set_id=?",
            ("[]", saved["current"]["set_id"]),
        )
    with pytest.raises(ValueError, match="digest|Corrupt"):
        ledger.read({**identity, "catalog_version": "d" * 64})


def test_store_returns_its_exact_committed_record_not_whichever_is_read_later(
    tmp_path, monkeypatch
):
    _, _, _, ledger, _, identity = seeded(tmp_path)
    # No postcommit self.read may replace the just-written record with an
    # unrelated later envelope. HTTP coherence will do its own authoritative read.
    monkeypatch.setattr(
        ledger, "read", lambda _: {"scenario_revision": 400, "current": {"set_id": "later-result"}}
    )
    saved = ledger.store(identity, 0, [scenario()])
    assert saved["scenario_revision"] == 1
    with _connect(ledger.db_path) as conn:
        row = conn.execute(
            "SELECT * FROM device_scenario_sets WHERE case_id=?", (identity["case_id"],)
        ).fetchone()
    assert saved["current"]["set_id"] == row["set_id"]
    assert saved["current"]["scenarios"] == json.loads(row["scenarios"])
    assert (
        saved["current"]["scenarios_sha256"]
        == hashlib.sha256(row["scenarios"].encode()).hexdigest()
    )


def test_geometry_recompute_same_case_revision_stales_old_scenario_identity(tmp_path):
    _, case, geometry, ledger, capture, identity = seeded(tmp_path)
    ledger.store(identity, 0, [scenario()])
    replacement = geometry.store(case["case_id"], capture, {"synthetic_geometry_result": True})
    assert replacement["result_id"] != identity["geometry_result_id"]
    assert ledger.read(identity)["current"]["status"] == "stale"
    with pytest.raises(DeviceScenarioConflict):
        ledger.store(identity, 1, [scenario()])


def test_changed_then_restored_inputs_cannot_resurrect_an_old_scenario_row(tmp_path):
    _, _, _, ledger, _, identity = seeded(tmp_path)
    first = ledger.store(identity, 0, [scenario()])
    changed = {**identity, "catalog_version": "e" * 64}
    ledger.store(changed, 1, [scenario(name="Different catalog identity")])
    restored = ledger.read(identity)
    assert restored["scenario_revision"] == 2
    assert restored["current"]["status"] == "stale"
    assert restored["current"]["set_id"] != first["current"]["set_id"]
