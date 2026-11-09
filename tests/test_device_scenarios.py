"""Synthetic Phase5 device-scenario ledger tests; no clinical or image data."""

import json

import pytest
from test_device_inputs_state import SOURCE, fixture

from planner.device_scenarios import (
    DeviceScenarioConflict,
    DeviceScenarioLedger,
)
from planner.workspace import _connect

DB_NAME = "workspace.sqlite3"


def identity(case, geometry_result_id):
    return {
        "case_id": case["case_id"],
        "image_sha256": case["image_sha256"],
        "artifact_version": str(case["artifact_version"]),
        "reference_revision": SOURCE,
        "geometry_result_id": geometry_result_id,
        "catalog_version": "c" * 64,
    }


def placement(**overrides):
    row = {
        "deviceId": "synthetic-device-01",
        "diameter": 7.5,
        "length": 20.0,
        "height": 18.0,
        "center": [1.0, 2.0, 3.0],
        "axis": [0.0, 0.0, 1.0],
        "path": [[0.0, 0.0, 0.0], [0.0, 0.0, 10.0]],
        "offset": 1.0,
        "roll": 45.0,
        "coilLength": 30.0,
    }
    row.update(overrides)
    return row


def scenario(name="Synthetic scenario", **overrides):
    ident = {"id": overrides.pop("id", "abcd1234ef"), "name": overrides.pop("name", name)}
    return dict(ident, placement=placement(**overrides))


def seeded(tmp_path):
    client, case, _masks, geometry, _inputs, snapshot = fixture(tmp_path)
    geometry_env = geometry.store(case["case_id"], snapshot, {"synthetic_geometry_result": True})
    ledger = DeviceScenarioLedger(tmp_path / DB_NAME)
    return client, case, geometry, ledger, snapshot, identity(case, geometry_env["result_id"])


def test_positive_tracer_store_read_roundtrip_no_case_bump(tmp_path):
    client, case, _geometry, ledger, snapshot, ident = seeded(tmp_path)
    baseline = snapshot["artifact_version"]
    stored = ledger.store(ident, 0, [scenario()])
    assert stored["current"]["status"] == "current"
    assert stored["scenario_revision"] == 1
    assert stored["current"]["set_id"]
    assert len(stored["current"]["scenarios_sha256"]) == 64
    read = ledger.read(ident)
    assert read == {
        "scenario_revision": 1,
        "current": {
            "status": "current",
            "set_id": stored["current"]["set_id"],
            "dependencies": stored["current"]["dependencies"],
            "scenarios_sha256": stored["current"]["scenarios_sha256"],
            "scenarios": [scenario()],
        },
    }
    # Frozen values: caller mutation changes nothing.
    read["current"]["scenarios"][0]["placement"]["diameter"] = 999.0
    assert ledger.read(ident)["current"]["scenarios"] == [scenario()]
    # Storing scenarios never bumps the case artifact_version.
    assert client.get(f"/api/cases/{case['case_id']}").json()["artifact_version"] == baseline


def test_empty_batch_and_revision_monotonicity(tmp_path):
    _client, _case, _geometry, ledger, _snapshot, ident = seeded(tmp_path)
    empty = ledger.store(ident, 0, [])
    assert empty["scenario_revision"] == 1
    second = ledger.store(ident, 1, [scenario()])
    assert second["scenario_revision"] == 2
    # CAS: stale expected_revision is refused.
    with pytest.raises(DeviceScenarioConflict):
        ledger.store(ident, 1, [scenario(id="zzzz9999yy")])
    read = ledger.read(ident)
    assert read["scenario_revision"] == 2
    assert read["current"]["scenarios"][0]["id"] == scenario()["id"]


def test_case_bump_elsewhere_stales_read(tmp_path):
    client, case, geometry, ledger, _snapshot, ident = seeded(tmp_path)
    ledger.store(ident, 0, [scenario()])
    # An unrelated case edit bumps artifact_version; scenario rows never do.
    client.patch(
        f"/api/cases/{case['case_id']}/notes",
        json={
            "artifact_version": case["artifact_version"],
            "notes": "Synthetic concurrent edit",
        },
    )
    stale = ledger.read(ident)
    assert stale["current"]["status"] == "stale"
    assert stale["current"]["scenarios"] is None
    # Refreshing only the caller version is insufficient: geometry itself
    # materialized before the edit is stale and must be recomputed.
    current_case = client.get(f"/api/cases/{case['case_id']}").json()
    refreshed = dict(ident, artifact_version=current_case["artifact_version"])
    with pytest.raises(DeviceScenarioConflict):
        ledger.store(refreshed, stale["scenario_revision"], [scenario()])
    capture = geometry.snapshot(case["case_id"], current_case["artifact_version"], SOURCE)
    new_geometry = geometry.store(case["case_id"], capture, {"synthetic_geometry_result": True})
    refreshed["geometry_result_id"] = new_geometry["result_id"]
    current = ledger.store(refreshed, stale["scenario_revision"], [scenario()])
    assert current["current"]["status"] == "current"
    assert current["scenario_revision"] == 2
    assert ledger.read(ident)["current"]["status"] == "stale"


def test_geometry_dependency_change_stales_read(tmp_path):
    _client, case, _geometry, ledger, _snapshot, ident = seeded(tmp_path)
    ledger.store(ident, 0, [scenario()])
    with _connect(ledger.db_path) as conn:
        conn.execute("UPDATE cases SET image_sha256=? WHERE case_id=?", ("f" * 64, case["case_id"]))
    stale = ledger.read(ident)
    assert stale["current"]["status"] == "stale"
    assert stale["current"]["scenarios"] is None


@pytest.mark.parametrize(
    "mutator",
    [
        lambda ident: ident.pop("catalog_version"),
        lambda ident: ident.update(extra="x"),
        lambda ident: ident.update(image_sha256="A" * 64),
        lambda ident: ident.update(image_sha256="z" * 64),
        lambda ident: ident.update(artifact_version="one"),
        lambda ident: ident.update(geometry_result_id=""),
        lambda ident: ident.update(geometry_result_id="x" * 501),
    ],
)
def test_malformed_identity_rejected(tmp_path, mutator):
    _client, _case, _geometry, ledger, _snapshot, ident = seeded(tmp_path)
    mutator(ident)
    with pytest.raises(ValueError):
        ledger.store(ident, 0, [scenario()])
    with pytest.raises(ValueError):
        ledger.read(ident)


def test_value_changed_identity_stales_read_but_refuses_store(tmp_path):
    _client, _case, _geometry, ledger, _snapshot, ident = seeded(tmp_path)
    ledger.store(ident, 0, [scenario()])
    wrong_version = dict(ident, artifact_version="1")
    with pytest.raises(DeviceScenarioConflict):
        ledger.store(wrong_version, 0, [scenario()])
    stale = ledger.read(wrong_version)
    assert stale["current"]["status"] == "stale"
    assert stale["current"]["scenarios"] is None


@pytest.mark.parametrize(
    "row",
    [
        {"id": "short", "name": "x", "placement": placement()},
        {"id": "a b c d e f g", "name": "x", "placement": placement()},
        {"id": "abcd1234ef", "name": "", "placement": placement()},
        {"id": "abcd1234ef", "name": "x" * 81, "placement": placement()},
        {"id": "abcd1234ef", "name": "bad\x07name", "placement": placement()},
        {"id": "abcd1234ef", "name": "ok", "placement": placement(deviceId=True)},
        {"id": "abcd1234ef", "name": "ok", "placement": placement(diameter="7.5")},
        {"id": "abcd1234ef", "name": "ok", "placement": placement(diameter=0.0)},
        {"id": "abcd1234ef", "name": "ok", "placement": placement(diameter=1001.0)},
        {"id": "abcd1234ef", "name": "ok", "placement": placement(offset=100.5)},
        {"id": "abcd1234ef", "name": "ok", "placement": placement(roll=361.0)},
        {"id": "abcd1234ef", "name": "ok", "placement": placement(braidAngle=34.0)},
        {"id": "abcd1234ef", "name": "ok", "placement": placement(braidAngle=75.5)},
        {"id": "abcd1234ef", "name": "ok", "placement": placement(axis=[0, 0, 0])},
        {
            "id": "abcd1234ef",
            "name": "ok",
            "placement": placement(center=[200000.0, 0, 0]),
        },
        {
            "id": "abcd1234ef",
            "name": "ok",
            "placement": placement(path=[[0.0, 0.0, float("nan")], [0, 0, 1]]),
        },
        {"id": "abcd1234ef", "name": "ok", "placement": placement(path=[[0.0, 0.0]])},
        {"id": "abcd1234ef", "name": "ok", "placement": placement(bogus=1)},
        {"id": "abcd1234ef", "name": "ok", "placement": "not-a-placement"},
    ],
)
def test_malformed_scenarios_rejected(tmp_path, row):
    _client, _case, _geometry, ledger, _snapshot, ident = seeded(tmp_path)
    with pytest.raises(ValueError):
        ledger.store(ident, 0, [row])
    assert ledger.read(ident)["scenario_revision"] == 0


def test_batch_limits(tmp_path):
    _client, _case, _geometry, ledger, _snapshot, ident = seeded(tmp_path)
    with pytest.raises(ValueError):
        ledger.store(ident, 0, [scenario() for _ in range(13)])
    with pytest.raises(ValueError):
        ledger.store(ident, 0, "not-a-list")
    # Duplicate ids rejected.
    with pytest.raises(ValueError):
        ledger.store(ident, 0, [scenario(), scenario()])
    # Coordinate triple budget: 2 + path length per row; a row with 64-point
    # paths x32 rows exceeds 2048.
    big = [
        scenario(id=f"row{i:012d}"[:10] + "abcde", path=[[0.0, 0.0, 0.0]] * 64) for i in range(32)
    ]
    with pytest.raises(ValueError):
        ledger.store(ident, 0, big)


def test_corrupt_latest_row_is_valueerror_not_stale_or_empty(tmp_path):
    _client, case, _geometry, ledger, _snapshot, ident = seeded(tmp_path)
    stored = ledger.store(ident, 0, [scenario()])
    with _connect(ledger.db_path) as conn:
        row = conn.execute(
            "SELECT rowid FROM device_scenario_sets WHERE set_id=?",
            (stored["current"]["set_id"],),
        ).fetchone()
        conn.execute(
            "UPDATE device_scenario_sets SET scenarios=? WHERE rowid=?",
            (json.dumps([{"id": "tampered-row-xx"}]), row["rowid"]),
        )
    with pytest.raises(ValueError):
        ledger.read(ident)
    # Corrupt digest too.
    ledger.store(ident, 1, [scenario()])
    with _connect(ledger.db_path) as conn:
        conn.execute(
            "UPDATE device_scenario_sets SET scenarios_sha256=? WHERE case_id=?",
            ("0" * 64, case["case_id"]),
        )
    with pytest.raises(ValueError):
        ledger.read(ident)
    # Shape corruption with a matching digest is still an error.
    ledger.store(ident, 2, [scenario()])
    import hashlib

    with _connect(ledger.db_path) as conn:
        tampered = json.dumps([{"id": "tampered-row-xx", "name": "x", "placement": {}}])
        conn.execute(
            "UPDATE device_scenario_sets SET scenarios=?, scenarios_sha256=? WHERE case_id=?",
            (
                tampered,
                hashlib.sha256(tampered.encode()).hexdigest(),
                case["case_id"],
            ),
        )
    with pytest.raises(ValueError):
        ledger.read(ident)
