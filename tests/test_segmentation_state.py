"""Synthetic ledger fixtures: no image/model data or fake inference results."""

import pytest
from fastapi.testclient import TestClient

from planner.segmentation_state import SegmentationConflict, SegmentationLedger
from planner.workspace import create_app


def _case(client, suffix="a"):
    return client.post(
        "/api/cases",
        json={
            "title": "Synthetic ledger fixture",
            "image_sha256": suffix * 64,
            "dimensions": [8, 9, 10],
            "spacing_mm": [1, 1, 1],
            "spatial_units": "unknown",
        },
    ).json()


def test_preview_accept_and_new_preview_preserve_accepted_history(tmp_path):
    db = tmp_path / "workspace.db"
    client = TestClient(create_app(db))
    case = _case(client)
    ledger = SegmentationLedger(db)
    preview = ledger.preview(
        case["case_id"],
        "1",
        reference_revision="b" * 64,
        producer="sam2_prompted_slice",
        mask_sha256="c" * 64,
        provenance={"fixture": True},
    )
    assert preview["status"] == "preview"
    assert ledger.current(case["case_id"]) is None
    accepted = ledger.decide(case["case_id"], preview["candidate_id"], "1", "accept")
    assert accepted["status"] == "accepted"
    assert accepted["segmentation_revision"] == 1
    assert accepted["artifact_version"] == "2"
    assert accepted["derived_geometry_valid"] is False
    assert accepted["device_sizing_valid"] is False
    assert client.get(f"/api/cases/{case['case_id']}").json()["artifact_version"] == "2"
    second = ledger.preview(
        case["case_id"],
        "2",
        reference_revision="b" * 64,
        producer="sam2_prompted_slice",
        mask_sha256="d" * 64,
        provenance={"fixture": True},
    )
    rejected = ledger.decide(case["case_id"], second["candidate_id"], "2", "reject")
    assert rejected["status"] == "rejected"
    assert ledger.current(case["case_id"])["candidate_id"] == preview["candidate_id"]
    assert ledger.entry(case["case_id"], preview["candidate_id"])["mask_sha256"] == "c" * 64


def test_stale_candidate_cannot_change_case_or_accepted_segmentation(tmp_path):
    db = tmp_path / "workspace.db"
    client = TestClient(create_app(db))
    case = _case(client)
    ledger = SegmentationLedger(db)
    candidate = ledger.preview(
        case["case_id"],
        "1",
        reference_revision="b" * 64,
        producer="owned_vessel",
        mask_sha256="c" * 64,
        provenance={"fixture": True},
    )
    client.patch(
        f"/api/cases/{case['case_id']}/notes",
        json={"artifact_version": "1", "notes": "Changed during inference review"},
    )
    with pytest.raises(SegmentationConflict):
        ledger.decide(case["case_id"], candidate["candidate_id"], "2", "accept")
    assert ledger.current(case["case_id"]) is None
    assert client.get(f"/api/cases/{case['case_id']}").json()["artifact_version"] == "2"


def test_vessel_and_sac_acceptance_do_not_overwrite_each_other(tmp_path):
    db = tmp_path / "workspace.db"
    client = TestClient(create_app(db))
    case = _case(client)
    ledger = SegmentationLedger(db)
    vessel = ledger.preview(
        case["case_id"],
        "1",
        reference_revision="b" * 64,
        producer="owned_vessel",
        mask_sha256="c" * 64,
        provenance={"fixture": True},
    )
    ledger.decide(case["case_id"], vessel["candidate_id"], "1", "accept")
    sac = ledger.preview(
        case["case_id"],
        "2",
        reference_revision="b" * 64,
        producer="sam2_prompted_slice",
        mask_sha256="d" * 64,
        provenance={"fixture": True},
    )
    ledger.decide(case["case_id"], sac["candidate_id"], "2", "accept")
    assert ledger.current(case["case_id"], role="vessel")["candidate_id"] == vessel["candidate_id"]
    assert ledger.current(case["case_id"], role="aneurysm")["candidate_id"] == sac["candidate_id"]


def test_candidate_is_owned_by_exact_case_and_decisions_are_final(tmp_path):
    db = tmp_path / "workspace.db"
    client = TestClient(create_app(db))
    first, other = _case(client), _case(client, "d")
    ledger = SegmentationLedger(db)
    item = ledger.preview(
        first["case_id"],
        "1",
        reference_revision="b" * 64,
        producer="owned_vessel",
        mask_sha256="c" * 64,
        provenance={"fixture": True},
    )
    with pytest.raises(SegmentationConflict):
        ledger.decide(other["case_id"], item["candidate_id"], "1", "accept")
    ledger.decide(first["case_id"], item["candidate_id"], "1", "reject")
    with pytest.raises(SegmentationConflict):
        ledger.decide(first["case_id"], item["candidate_id"], "1", "accept")


def test_wrong_role_producers_are_rejected_before_insert(tmp_path):
    """RED first: ledger accepted sam2/aneurysm_model claiming the vessel role."""
    db = tmp_path / "workspace.db"
    client = TestClient(create_app(db))
    case = _case(client)
    ledger = SegmentationLedger(db)
    for producer in ("sam2_prompted_slice", "aneurysm_model"):
        with pytest.raises(ValueError):
            ledger.preview(
                case["case_id"],
                "1",
                reference_revision="b" * 64,
                producer=producer,
                role="vessel",
                mask_sha256="c" * 64,
                provenance={"fixture": True},
            )
        explicit = ledger.preview(
            case["case_id"],
            "1",
            reference_revision="b" * 64,
            producer=producer,
            role="aneurysm",
            mask_sha256="d" * 64,
            provenance={"fixture": True},
        )
        assert explicit["role"] == "aneurysm"
        assert explicit["producer"] == producer
        with pytest.raises(ValueError):
            ledger.preview(
                case["case_id"],
                "1",
                reference_revision="b" * 64,
                producer="owned_vessel",
                role="aneurysm",
                mask_sha256="e" * 64,
                provenance={"fixture": True},
            )
