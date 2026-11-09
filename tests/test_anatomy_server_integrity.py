"""Anatomy proposal admission, producer-shape and source-race regressions."""

import json
import sqlite3

import pytest
from test_anatomy_server import configured, proposal_result

from planner import anatomy_server
from planner.workspace import _connect


def request(client, case, revision, **overrides):
    return client.post(
        f"/api/cases/{case['case_id']}/anatomy-proposal",
        json={
            "artifact_version": case["artifact_version"],
            "reference_revision": revision,
            **overrides,
        },
    )


@pytest.mark.parametrize("target", [[3.5, 2, 2], [3.6, 2, 2], [1, 4.5, 2], [1, 2, 5.5]])
def test_fractional_target_beyond_last_center_is_422_before_runner(tmp_path, monkeypatch, target):
    calls = []
    client, case, revision, _, _, _ = configured(
        tmp_path, monkeypatch, lambda job: calls.append(job)
    )
    response = request(client, case, revision, target_ras=target)
    assert response.status_code == 422, response.text
    assert calls == []


def test_contradictory_provider_dimensions_are_sanitized_before_runner_or_write(
    tmp_path, monkeypatch, caplog
):
    calls = []
    client, case, revision, directory, _, _ = configured(
        tmp_path, monkeypatch, lambda job: calls.append(job)
    )
    trusted = anatomy_server.trusted_grid

    def contradict(bundle):
        grid = trusted(bundle)
        return {**grid, "shape": [4, 5, 7]}

    monkeypatch.setattr(anatomy_server, "trusted_grid", contradict)
    response = request(client, case, revision)
    assert response.status_code == 503, response.text
    assert response.json() == {
        "detail": "Anatomy proposal is unavailable; no inputs were confirmed"
    }
    assert calls == [] and str(directory) not in response.text
    messages = [
        record.getMessage() for record in caplog.records if record.name == "planner.anatomy_server"
    ]
    assert messages == ["Anatomy source dimensions contradict case metadata"]
    assert str(directory) not in " ".join(messages)
    with _connect(tmp_path / "workspace.sqlite3") as conn:
        assert conn.execute("SELECT COUNT(*) FROM geometry_inputs").fetchone()[0] == 0


def test_default_supervisor_uses_server_configured_blob_root(tmp_path, monkeypatch):
    seen = []

    def run(job, *, blob_dir):
        seen.append((job, blob_dir))
        return proposal_result(job)

    monkeypatch.setattr(anatomy_server, "default_anatomy_runner", lambda: run)
    client, case, revision, directory, _, _ = configured(tmp_path, monkeypatch)
    response = request(client, case, revision)
    assert response.status_code == 200, response.text
    assert seen[0][1] == directory and "blob_dir" not in seen[0][0]


@pytest.mark.parametrize(
    "change",
    [
        {"target_ras": [True, 1, 2]},
        {"target_ras": [1, 2]},
        {"target_ras": [1, 2, 999]},
        {"image_path": "/arbitrary"},
        {"checkpoint_path": "/arbitrary"},
    ],
)
def test_bad_target_or_path_selectors_never_call_runner(tmp_path, monkeypatch, change):
    calls = []
    client, case, revision, _, _, _ = configured(
        tmp_path, monkeypatch, lambda job: calls.append(job)
    )
    response = request(client, case, revision, **change)
    assert response.status_code == 422, response.text
    assert calls == []


def test_changed_case_during_generation_discards_proposal_without_confirming(tmp_path, monkeypatch):
    client = case = None

    def run(job):
        response = client.patch(
            f"/api/cases/{case['case_id']}/notes",
            json={
                "artifact_version": case["artifact_version"],
                "notes": "Synthetic concurrent note",
            },
        )
        assert response.status_code == 200
        return proposal_result(job)

    client, case, revision, _, _, _ = configured(tmp_path, monkeypatch, run)
    assert request(client, case, revision).status_code == 409
    assert client.get(f"/api/cases/{case['case_id']}/morphometry").json()["operator_inputs"] is None


def test_changed_mask_bytes_during_generation_is_integrity_failure_not_snapshot_conflict(
    tmp_path, monkeypatch
):
    directory = entries = None

    def run(job):
        path = directory / "blobs" / f"{entries['vessel']['mask_sha256']}.nii.gz"
        path.write_bytes(b"tampered actual mask bytes")
        return proposal_result(job)

    client, case, revision, directory, entries, _ = configured(tmp_path, monkeypatch, run)
    assert request(client, case, revision).status_code == 503


def test_bare_prompted_slice_has_no_3d_lineage_for_geometry_proposals(tmp_path, monkeypatch):
    calls = []
    client, case, revision, directory, entries, _ = configured(
        tmp_path, monkeypatch, lambda job: calls.append(job)
    )
    with _connect(directory.parent / "workspace.sqlite3") as conn:
        conn.execute(
            "UPDATE segmentation_candidates SET producer='sam2_prompted_slice' WHERE candidate_id=?",
            (entries["aneurysm"]["candidate_id"],),
        )
    response = request(client, case, revision)
    assert response.status_code == 409
    assert response.json() == {"detail": "A three-dimensional aneurysm model lineage is required"}
    assert calls == []


def test_missing_accepted_mask_reports_the_prerequisite_without_running(tmp_path, monkeypatch):
    calls = []
    client, case, revision, directory, entries, _ = configured(
        tmp_path, monkeypatch, lambda job: calls.append(job)
    )
    with _connect(directory.parent / "workspace.sqlite3") as conn:
        conn.execute(
            "DELETE FROM segmentation_candidates WHERE candidate_id=?",
            (entries["vessel"]["candidate_id"],),
        )
    response = request(client, case, revision)
    assert response.status_code == 409
    assert response.json() == {"detail": "Accept current vessel and aneurysm masks first"}
    assert response.headers["cache-control"] == "no-store"
    assert calls == []


@pytest.mark.parametrize(
    "mutate",
    [
        lambda value: value.update(operator_confirmation_required=1),
        lambda value: value.update(extra="unrecognized"),
        lambda value: value["diagnostics"].update(extra="unrecognized"),
        lambda value: value["diagnostics"].update(parent_length_mm="three"),
        lambda value: value["diagnostics"].update(parent_point_count=32),
        lambda value: value["diagnostics"].update(grid_shape=[3, 4, 5]),
        lambda value: value["diagnostics"].update(neck_plane_rms_residual_mm=-1),
        lambda value: value["diagnostics"].update(target_component_selected=1),
    ],
)
def test_invalid_worker_evidence_is_wholly_rejected(tmp_path, monkeypatch, mutate):
    def run(job):
        value = proposal_result(job)
        mutate(value)
        return value

    client, case, revision, _, _, _ = configured(tmp_path, monkeypatch, run)
    response = request(client, case, revision)
    assert response.status_code == 503, response.text
    with _connect(tmp_path / "workspace.sqlite3") as conn:
        assert conn.execute("SELECT COUNT(*) FROM geometry_inputs").fetchone()[0] == 0


def test_body_cap_is_prework_and_does_not_hold_inference_gate(tmp_path, monkeypatch):
    client, case, revision, _, _, _ = configured(tmp_path, monkeypatch, proposal_result)
    path = f"/api/cases/{case['case_id']}/anatomy-proposal"
    response = client.post(
        path,
        content=json.dumps(
            {"artifact_version": case["artifact_version"], "reference_revision": revision}
        ).encode()
        + b" " * 8192,
        headers={"content-type": "application/json"},
    )
    assert response.status_code == 413
    assert request(client, case, revision).status_code == 200


def test_mask_hashing_does_not_hold_the_metadata_snapshot_open(tmp_path, monkeypatch):
    client, case, revision, _, _, _ = configured(tmp_path, monkeypatch, proposal_result)
    connections = []
    checks = []
    connect = anatomy_server._connect
    verify = anatomy_server.verified_bytes

    def tracked_connect(path):
        conn = connect(path)
        connections.append(conn)
        return conn

    def verify_outside_snapshot(path, sha):
        for conn in connections:
            try:
                active = conn.in_transaction
            except sqlite3.ProgrammingError:
                active = False  # The snapshot connection is already closed.
            assert not active, "Mask I/O held an open metadata snapshot"
        checks.append(sha)
        return verify(path, sha)

    monkeypatch.setattr(anatomy_server, "_connect", tracked_connect)
    monkeypatch.setattr(anatomy_server, "verified_bytes", verify_outside_snapshot)
    response = request(client, case, revision)
    assert response.status_code == 200, response.text
    assert len(checks) == 4  # Both roles, before and after the actual proposal call.
