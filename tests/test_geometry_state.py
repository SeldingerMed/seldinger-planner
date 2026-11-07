"""Real SQLite dependencies; all numbers and masks here are synthetic fixtures."""

import pytest
from fastapi.testclient import TestClient

from planner.segmentation_state import SegmentationLedger
from planner.workspace import create_app


def prepared(tmp_path):
    from planner.geometry_state import GeometryLedger

    db = tmp_path / "workspace.sqlite3"
    client = TestClient(create_app(db))
    case = client.post(
        "/api/cases",
        json={
            "title": "Synthetic geometry",
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
            reference_revision="b" * 64,
            producer=producer,
            role=role,
            mask_sha256=digest,
            provenance={"synthetic_fixture": True},
        )
        masks.decide(case["case_id"], entry["candidate_id"], case["artifact_version"], "accept")
        case = client.get(f"/api/cases/{case['case_id']}").json()
    geometry = GeometryLedger(db)
    return client, case, masks, geometry


@pytest.mark.parametrize("change", ["source", "image"])
def test_operator_inputs_are_not_replayed_in_another_source_frame(tmp_path, change):
    from planner.workspace import _connect

    _client, case, _masks, geometry, _version, _snapshot = materialized(tmp_path)
    assert geometry.inputs(case["case_id"], "b" * 64) is not None
    revision = "f" * 64 if change == "source" else "b" * 64
    if change == "image":
        with _connect(geometry.db_path) as conn:
            conn.execute(
                "UPDATE cases SET image_sha256=? WHERE case_id=?", ("f" * 64, case["case_id"])
            )
    assert geometry.inputs(case["case_id"], revision) is None


def test_materialized_geometry_roundtrip_does_not_invalidate_itself(tmp_path):
    client, case, _masks, geometry = prepared(tmp_path)
    version = geometry.save_inputs(
        case["case_id"], case["artifact_version"], "b" * 64, {"synthetic_operator_input": [1, 2, 3]}
    )
    snapshot = geometry.snapshot(case["case_id"], version, "b" * 64)
    output = {"spatial_units": "mm", "validated_morphometry": False, "sac": {"height": 3.0}}
    stored = geometry.store(case["case_id"], snapshot, output)
    restored = geometry.current(case["case_id"], "b" * 64)
    assert restored["status"] == "current"
    assert restored["result"] == output
    assert restored["result_id"] == stored["result_id"]
    assert restored["dependencies"]["masks"]["aneurysm"]["mask_sha256"] == "d" * 64
    assert client.get(f"/api/cases/{case['case_id']}").json()["artifact_version"] == version


def materialized(tmp_path):
    client, case, masks, geometry = prepared(tmp_path)
    version = geometry.save_inputs(
        case["case_id"], case["artifact_version"], "b" * 64, {"synthetic_operator_input": [1, 2, 3]}
    )
    snapshot = geometry.snapshot(case["case_id"], version, "b" * 64)
    geometry.store(
        case["case_id"],
        snapshot,
        {"spatial_units": "mm", "validated_morphometry": False, "sac": {"height": 3.0}},
    )
    return client, case, masks, geometry, version, snapshot


@pytest.mark.parametrize("change", ["mask", "operator_inputs", "notes", "source", "image"])
def test_live_dependency_change_suppresses_materialized_numbers(tmp_path, change):
    client, case, masks, geometry, version, _snapshot = materialized(tmp_path)
    source_revision = "b" * 64
    if change == "mask":
        replacement = masks.preview(
            case["case_id"],
            version,
            reference_revision=source_revision,
            producer="aneurysm_model",
            mask_sha256="e" * 64,
            provenance={"synthetic_fixture": True},
        )
        masks.decide(case["case_id"], replacement["candidate_id"], version, "accept")
    elif change == "operator_inputs":
        geometry.save_inputs(
            case["case_id"], version, source_revision, {"synthetic_operator_input": [4, 5, 6]}
        )
    elif change == "notes":
        assert (
            client.patch(
                f"/api/cases/{case['case_id']}/notes",
                json={"artifact_version": version, "notes": "Synthetic edit"},
            ).status_code
            == 200
        )
    elif change == "source":
        source_revision = "e" * 64
    else:
        from planner.workspace import _connect

        with _connect(geometry.db_path) as conn:
            conn.execute(
                "UPDATE cases SET image_sha256=? WHERE case_id=?", ("f" * 64, case["case_id"])
            )
    stale = geometry.current(case["case_id"], source_revision)
    assert stale["status"] == "stale"
    assert stale["result"] is None
    assert "3.0" not in str(stale)


def test_racing_case_edit_refuses_geometry_persistence(tmp_path):
    from planner.geometry_state import GeometryConflict

    client, case, _masks, geometry, version, snapshot = materialized(tmp_path)
    client.patch(
        f"/api/cases/{case['case_id']}/notes",
        json={"artifact_version": version, "notes": "Racing edit"},
    )
    with pytest.raises(GeometryConflict):
        geometry.store(case["case_id"], snapshot, {"spatial_units": "mm", "sac": {"height": 999.0}})


def test_rejected_preview_preserves_materialized_geometry(tmp_path):
    _client, case, masks, geometry, version, _snapshot = materialized(tmp_path)
    preview = masks.preview(
        case["case_id"],
        version,
        reference_revision="b" * 64,
        producer="aneurysm_model",
        mask_sha256="e" * 64,
        provenance={"synthetic_fixture": True},
    )
    masks.decide(case["case_id"], preview["candidate_id"], version, "reject")
    result = geometry.current(case["case_id"], "b" * 64)
    assert result["status"] == "current"
    assert result["result"]["sac"]["height"] == 3.0


@pytest.mark.parametrize(
    "change", ["input_source", "input_image", "mask_source", "mask_image", "units"]
)
def test_snapshot_rejects_incoherent_source_dependencies(tmp_path, change):
    from planner.geometry_state import GeometryConflict
    from planner.workspace import _connect

    _client, case, _masks, geometry, version, _snapshot = materialized(tmp_path)
    with _connect(geometry.db_path) as conn:
        if change == "units":
            conn.execute(
                "UPDATE cases SET spatial_units='unknown' WHERE case_id=?", (case["case_id"],)
            )
        else:
            table = "geometry_inputs" if change.startswith("input") else "segmentation_candidates"
            field = (
                ("source_revision" if table == "geometry_inputs" else "reference_revision")
                if change.endswith("source")
                else "image_sha256"
            )
            conn.execute(
                f"UPDATE {table} SET {field}=? WHERE case_id=?", ("f" * 64, case["case_id"])
            )
    with pytest.raises(GeometryConflict):
        geometry.snapshot(case["case_id"], version, "b" * 64)
    assert geometry.current(case["case_id"], "b" * 64)["result"] is None


def test_unseeded_single_slice_sam_cannot_become_volumetric_sac_input(tmp_path):
    from planner.geometry_state import GeometryConflict

    _client, case, masks, geometry, version, _snapshot = materialized(tmp_path)
    preview = masks.preview(
        case["case_id"],
        version,
        reference_revision="b" * 64,
        producer="sam2_prompted_slice",
        mask_sha256="e" * 64,
        provenance={"segmentation_extent": "single_slice_only"},
    )
    decided = masks.decide(case["case_id"], preview["candidate_id"], version, "accept")
    with pytest.raises(GeometryConflict):
        geometry.snapshot(case["case_id"], decided["artifact_version"], "b" * 64)


def test_seeded_sam_preserves_3d_lineage_and_invalidates_previous_numbers(tmp_path):
    _client, case, masks, geometry, version, _snapshot = materialized(tmp_path)
    base = masks.current(case["case_id"])
    assert base is not None
    preview = masks.preview(
        case["case_id"],
        version,
        reference_revision="b" * 64,
        producer="sam2_prompted_slice",
        mask_sha256="e" * 64,
        provenance={
            "segmentation_extent": "single_slice_edit_of_existing_mask",
            "correction_base": {
                "candidate_id": base["candidate_id"],
                "mask_sha256": base["mask_sha256"],
            },
        },
    )
    decided = masks.decide(case["case_id"], preview["candidate_id"], version, "accept")
    assert geometry.current(case["case_id"], "b" * 64)["status"] == "stale"
    snapshot = geometry.snapshot(case["case_id"], decided["artifact_version"], "b" * 64)
    assert snapshot["masks"]["aneurysm"]["candidate_id"] == preview["candidate_id"]
