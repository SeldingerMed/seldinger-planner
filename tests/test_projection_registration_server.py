"""Operator-confirmed 2D-to-3D registration proposals on a generated native source."""

import copy
import hashlib
import json
import math
import sqlite3
from contextlib import closing

import pytest
from test_frame_source import ROWS, dicom_plane, install, manifest, pixels, png_plane
from test_territory_workflow_server import configured

from planner import frame_source
from planner.frame_source import frame_filename
from planner.projection_plan import PlanConflict
from planner.projection_registration import RegistrationLedger
from planner.segmentation_state import SegmentationLedger

SQUARE = {"rows": ROWS, "columns": ROWS}
VIEW = {
    "primary_deg": 30.0,
    "secondary_deg": -20.0,
    "source_detector_mm": 1200.0,
    "source_isocenter_mm": 750.0,
    "detector_width_mm": 128.0,
    "detector_height_mm": 128.0,
}
SCORE = {
    "mean_distance_mm": 0.4,
    "matched_fraction": 0.95,
    "in_field_fraction": 1.0,
    "uncovered_fraction": 0.1,
}


def turn(degrees, shift=(0.0, 0.0, 0.0)):
    c, s = math.cos(math.radians(degrees)), math.sin(math.radians(degrees))
    return [[c, -s, 0.0, shift[0]], [s, c, 0.0, shift[1]], [0.0, 0.0, 1.0, shift[2]], [0, 0, 0, 1]]


def square(plane):
    # 64 by 64 stored pixels; the fixture's pixel bytes are longer and unused here.
    plane = {**plane, **SQUARE}
    plane["deidentification"] = {**plane["deidentification"]}
    if plane["deidentification"]["crop"] is None:
        plane["deidentification"].update(source_rows=ROWS, source_columns=ROWS)
    else:
        plane["deidentification"]["crop"] = [100, 50, ROWS, ROWS]
    return plane


def write_frames(directory, value):
    for plane in value["planes"]:
        for item in plane["frames"]:
            data = pixels(item["index"])[: ROWS * ROWS]
            item["sha256"] = hashlib.sha256(data).hexdigest()
            (directory / frame_filename(plane["plane"], item["index"])).write_bytes(data)
    (directory / "frames.json").write_text(json.dumps(value))


def ready(tmp_path, monkeypatch, *, value=None):
    """A case with an accepted vessel mask and one installed frame bundle."""
    frames_root = tmp_path.resolve() / "frames"
    monkeypatch.setattr(frame_source, "INSTALLED_FRAMES_ROOT", frames_root)
    client, case, reference = configured(tmp_path, monkeypatch)
    ledger = SegmentationLedger(tmp_path.resolve() / "case.sqlite3")
    mask = ledger.preview(
        case["case_id"],
        case["artifact_version"],
        reference_revision=reference,
        producer="rsna_vessel_model",
        role="vessel",
        mask_sha256="5" * 64,
        provenance={"synthetic_fixture": True},
    )
    ledger.decide(case["case_id"], mask["candidate_id"], case["artifact_version"], "accept")
    case = client.get(f"/api/cases/{case['case_id']}").json()
    value = value or manifest([square(png_plane())])
    directory = install(frames_root, "run-01", value, skip=True)
    write_frames(directory, value)
    listed = client.get("/api/projection-frames/run-01").json()
    return client, case, reference, mask, listed, directory


def inputs(mask, listed, **change):
    plane = listed["manifest"]["planes"][0]
    frame = plane["frames"][0]
    return {
        "confirmed": True,
        "frame_source_id": "run-01",
        "frame_manifest_revision": listed["manifest_revision"],
        "plane": plane["plane"],
        "frame_index": frame["index"],
        "frame_sha256": frame["sha256"],
        "mask_candidate_id": mask["candidate_id"],
        "mask_sha256": mask["mask_sha256"],
        "geometry_source": "operator_entered",
        "view": dict(VIEW),
        "fit_detector_scale": False,
        "detector_scale": 1.0,
        "isocenter": [16.0, 16.0, 16.0],
        "volume_to_carm_ras": turn(90.0, (3.0, 4.0, 0.0)),
        "method": "centerline_distance_compass_v1",
        "polarity": "dark",
        "sensitivity": 0.5,
        "reported_score": dict(SCORE),
        "reported_start_score": {**SCORE, "mean_distance_mm": 5.5, "matched_fraction": 0.1},
        **change,
    }


def body(case, reference, mask, listed, revision=0, **change):
    return {
        "artifact_version": case["artifact_version"],
        "reference_revision": reference,
        "registration_revision": revision,
        "inputs": inputs(mask, listed, **change),
    }


def test_confirmed_registration_roundtrips_with_known_values(tmp_path, monkeypatch):
    client, case, reference, mask, listed, _ = ready(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-registration"
    empty = client.get(route)
    assert empty.status_code == 200, empty.text
    assert empty.json()["registration_revision"] == 0
    assert empty.json()["current"] == {"status": "not_confirmed"}
    request = body(case, reference, mask, listed)
    response = client.put(route, json=request)
    assert response.status_code == 200, response.text
    assert response.headers["Cache-Control"] == "no-store"
    saved = response.json()
    assert saved["registration_revision"] == 1
    current = saved["current"]
    assert current["status"] == "current" and current["evidence"] == "verified"
    assert current["inputs"] == request["inputs"]
    assert current["dependencies"] == {
        "case_id": case["case_id"],
        "image_sha256": case["image_sha256"],
        "artifact_version": case["artifact_version"],
        "reference_revision": reference,
        "version": "step-c1-projection-registration-v1",
    }
    result = current["result"]
    assert result["status"] == "operator_confirmed_proposal" and result["validated"] is False
    assert result["convention"] == "dicom_xa_patient_longitude_latitude_ras_v1"
    assert result["method"] == "centerline_distance_compass_v1"
    assert result["geometry_source"] == "operator_entered"
    # A quarter turn about z moves (16, 16, 16) to (-16, 16, 16), then by (3, 4, 0).
    assert result["rotation_deg"] == 90.0
    assert result["isocenter_shift_mm"] == pytest.approx(math.hypot(-29, 4), abs=1e-3)
    assert result["score_source"] == "browser_reported_not_recomputed"
    assert result["reported_score"] == SCORE
    assert client.get(route).json() == saved
    # Each confirmation is a new immutable row.
    again = client.put(route, json=body(case, reference, mask, listed, 1, polarity="bright"))
    assert again.status_code == 200 and again.json()["registration_revision"] == 2
    with closing(sqlite3.connect(tmp_path.resolve() / "case.sqlite3")) as conn:
        assert conn.execute("SELECT COUNT(*) FROM projection_registrations").fetchone()[0] == 2


@pytest.mark.parametrize(
    "change",
    [
        {"confirmed": False},
        {"confirmed": "true"},
        {"confirmed": 1},
        {"method": "other"},
        {"polarity": "inverted"},
        {"sensitivity": 1.5},
        {"plane": "c"},
        {"frame_index": -1},
        {"frame_index": 3.0},
        {"frame_sha256": "A" * 64},
        {"frame_source_id": "../run-01"},
        {"mask_candidate_id": "a/b"},
        {"geometry_source": "guessed"},
        {"detector_scale": 1.5},
        {"detector_scale": 1.1},  # a scale other than one without a fit
        {"fit_detector_scale": True, "detector_scale": 1.46},
        {"fit_detector_scale": True, "detector_scale": 0.69},
        {"fit_detector_scale": 1},
        {"isocenter": [16.0, 16.0]},
        {"isocenter": [16.0, 16.0, "16"]},
        {"volume_to_carm_ras": turn(10.0)[:3]},
        {"volume_to_carm_ras": [[2.0, 0, 0, 0], [0, 1.0, 0, 0], [0, 0, 1.0, 0], [0, 0, 0, 1]]},
        {"volume_to_carm_ras": [[-1.0, 0, 0, 0], [0, 1.0, 0, 0], [0, 0, 1.0, 0], [0, 0, 0, 1]]},
        {"volume_to_carm_ras": [*turn(10.0)[:3], [0, 0, 0, 2]]},
        {"view": {**VIEW, "source_isocenter_mm": 1300.0}},
        {"view": {**VIEW, "primary_deg": 190.0}},
        {"view": {**VIEW, "name": "AP"}},
        {"view": {k: v for k, v in VIEW.items() if k != "secondary_deg"}},
        {"reported_score": {**SCORE, "matched_fraction": 1.2}},
        {"reported_score": {**SCORE, "matched_fraction": -0.1}},
        {"reported_score": {**SCORE, "in_field_fraction": 1.2}},
        {"reported_score": {**SCORE, "in_field_fraction": -0.1}},
        {"reported_score": {**SCORE, "uncovered_fraction": 1.2}},
        {"reported_score": {**SCORE, "uncovered_fraction": -0.1}},
        {"reported_score": {**SCORE, "mean_distance_mm": -1.0}},
        {"reported_score": {**SCORE, "mean_distance_mm": 1000.5}},
        {"reported_start_score": {**SCORE, "mean_distance_mm": 1000.5}},
        {"reported_start_score": {**SCORE, "uncovered_fraction": 1.2}},
        {"reported_score": {**SCORE, "accuracy_mm": 1.0}},
        {"reported_start_score": None},
        {"pixels": "AAAA"},
        {"note": "validated"},
    ],
)
def test_shape_and_confirmation_rejections_do_not_store(tmp_path, monkeypatch, change):
    client, case, reference, mask, listed, _ = ready(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-registration"
    response = client.put(route, json=body(case, reference, mask, listed, **change))
    assert response.status_code == 422, response.text
    assert client.get(route).json()["registration_revision"] == 0


@pytest.mark.parametrize(
    "change",
    [
        {"frame_source_id": "run-02"},
        {"frame_manifest_revision": "0" * 64},
        {"plane": "a"},
        {"frame_index": 4},
        {"frame_sha256": "0" * 64},
        {"mask_candidate_id": "another"},
        {"mask_sha256": "0" * 64},
        {"isocenter": [40.0, 16.0, 16.0]},  # outside the 32-voxel source
        {"view": {**VIEW, "detector_height_mm": 160.0}},  # pixels would not be square
        {"geometry_source": "frame_manifest"},  # the PNG plane carries no geometry
    ],
)
def test_bindings_must_match_the_admitted_frame_and_accepted_mask(tmp_path, monkeypatch, change):
    client, case, reference, mask, listed, _ = ready(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-registration"
    response = client.put(route, json=body(case, reference, mask, listed, **change))
    assert response.status_code == 422, response.text
    assert "admitted frame or accepted mask" in response.json()["detail"]
    assert client.get(route).json()["registration_revision"] == 0


def test_scalar_bounds_are_inclusive(tmp_path, monkeypatch):
    client, case, reference, mask, listed, _ = ready(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-registration"
    edge = {"mean_distance_mm": 1000.0, "matched_fraction": 0.0, "in_field_fraction": 1.0}
    for revision, scale in enumerate((0.7, 1.45)):
        change = {
            "fit_detector_scale": True,
            "detector_scale": scale,
            "reported_score": {**edge, "uncovered_fraction": 1.0},
            "reported_start_score": {**edge, "uncovered_fraction": 0.0},
        }
        response = client.put(route, json=body(case, reference, mask, listed, revision, **change))
        assert response.status_code == 200, response.text
        assert response.json()["current"]["inputs"]["detector_scale"] == scale


def test_the_ledger_refuses_an_identity_the_case_no_longer_has(tmp_path, monkeypatch):
    client, case, reference, mask, listed, _ = ready(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-registration"
    assert client.put(route, json=body(case, reference, mask, listed)).status_code == 200
    saved = client.get(route).json()["current"]["dependencies"]
    identity = {k: v for k, v in saved.items() if k != "version"}
    ledger = RegistrationLedger(tmp_path.resolve() / "case.sqlite3")
    assert ledger.current(identity)[0] == 1
    for change in (
        {"image_sha256": "0" * 64},
        {"artifact_version": str(int(identity["artifact_version"]) + 1)},
        {"case_id": "absent"},
    ):
        with pytest.raises(PlanConflict):
            ledger.current({**identity, **change})


def test_manifest_geometry_must_be_used_as_admitted(tmp_path, monkeypatch):
    plane = square(dicom_plane())
    plane["geometry"] = dict(VIEW)
    value = manifest([plane], method="admitted_dicom_xa_frames")
    client, case, reference, mask, listed, _ = ready(tmp_path, monkeypatch, value=value)
    route = f"/api/cases/{case['case_id']}/projection-registration"
    for change in (
        {"view": {**VIEW, "primary_deg": 31.0}},
        {"view": {**VIEW, "detector_width_mm": 140.0, "detector_height_mm": 140.0}},
    ):
        bad = body(case, reference, mask, listed, geometry_source="frame_manifest", **change)
        assert client.put(route, json=bad).status_code == 422
    # A fitted scale is only meaningful for geometry the operator entered.
    fitted = body(
        case,
        reference,
        mask,
        listed,
        geometry_source="frame_manifest",
        fit_detector_scale=True,
        detector_scale=1.1,
    )
    assert client.put(route, json=fitted).status_code == 422
    good = body(case, reference, mask, listed, geometry_source="frame_manifest")
    saved = client.put(route, json=good)
    assert saved.status_code == 200, saved.text
    assert saved.json()["current"]["result"]["geometry_source"] == "frame_manifest"
    # The operator may still override admitted geometry, labelled as entered.
    entered = body(
        case,
        reference,
        mask,
        listed,
        1,
        view={**VIEW, "detector_width_mm": 140.8, "detector_height_mm": 140.8},
        fit_detector_scale=True,
        detector_scale=1.1,
    )
    assert client.put(route, json=entered).status_code == 200


def test_stale_source_revision_conflicts_and_mask_change(tmp_path, monkeypatch):
    client, case, reference, mask, listed, _ = ready(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-registration"
    wrong_reference = body(case, "0" * 64, mask, listed)
    assert client.put(route, json=wrong_reference).status_code == 409
    wrong_version = body(case, reference, mask, listed)
    wrong_version["artifact_version"] = str(int(case["artifact_version"]) + 1)
    assert client.put(route, json=wrong_version).status_code == 409
    assert client.put(route, json=body(case, reference, mask, listed, 3)).status_code == 409
    assert client.get(route).json()["registration_revision"] == 0
    assert client.put(route, json=body(case, reference, mask, listed)).status_code == 200
    # A replay of the same revision is refused.
    assert client.put(route, json=body(case, reference, mask, listed)).status_code == 409
    note = client.patch(
        f"/api/cases/{case['case_id']}/notes",
        json={"artifact_version": case["artifact_version"], "notes": "revision"},
    )
    assert note.status_code == 200, note.text
    stale = client.get(route).json()
    assert stale["registration_revision"] == 1
    assert stale["current"]["status"] == "stale"
    assert stale["current"]["inputs"] is None and stale["current"]["result"] is None


def test_saved_registration_reports_lost_frame_evidence_without_blocking(tmp_path, monkeypatch):
    client, case, reference, mask, listed, directory = ready(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-registration"
    assert client.put(route, json=body(case, reference, mask, listed)).status_code == 200
    target = directory / frame_filename("single", 3)
    original = target.read_bytes()
    target.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
    lost = client.get(route)
    assert lost.status_code == 200
    assert lost.json()["current"]["status"] == "current"
    assert lost.json()["current"]["evidence"] == "unavailable"
    # Nothing new can be confirmed against the changed frame.
    assert client.put(route, json=body(case, reference, mask, listed, 1)).status_code == 422
    target.write_bytes(original)
    assert client.get(route).json()["current"]["evidence"] == "verified"
    # A changed manifest is a different revision.
    value = copy.deepcopy(listed["manifest"])
    value["scope"] = "public"
    (directory / "frames.json").write_text(json.dumps(value))
    assert client.get(route).json()["current"]["evidence"] == "unavailable"
    relisted = client.get("/api/projection-frames/run-01").json()
    fresh = client.put(route, json=body(case, reference, mask, relisted, 1))
    assert fresh.status_code == 200, fresh.text
    assert fresh.json()["current"]["evidence"] == "verified"


def test_registration_requires_an_accepted_vessel_mask(tmp_path, monkeypatch):
    frames_root = tmp_path.resolve() / "frames"
    monkeypatch.setattr(frame_source, "INSTALLED_FRAMES_ROOT", frames_root)
    client, case, reference = configured(tmp_path, monkeypatch)
    value = manifest([square(png_plane())])
    write_frames(install(frames_root, "run-01", value, skip=True), value)
    listed = client.get("/api/projection-frames/run-01").json()
    mask = {"candidate_id": "none", "mask_sha256": "5" * 64}
    route = f"/api/cases/{case['case_id']}/projection-registration"
    assert client.put(route, json=body(case, reference, mask, listed)).status_code == 422


def test_tampered_stored_registration_fails_closed(tmp_path, monkeypatch):
    client, case, reference, mask, listed, _ = ready(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-registration"
    assert client.put(route, json=body(case, reference, mask, listed)).status_code == 200
    database = tmp_path.resolve() / "case.sqlite3"
    for column, edit in (
        ("result", lambda value: {**value, "validated": True}),
        ("result", lambda value: {**value, "rotation_deg": 1.0}),
        ("inputs", lambda value: {**value, "polarity": "bright"}),
        ("inputs", lambda value: {**value, "confirmed": False}),
    ):
        with closing(sqlite3.connect(database)) as conn, conn:
            original = conn.execute(f"SELECT {column} FROM projection_registrations").fetchone()[0]
            conn.execute(
                f"UPDATE projection_registrations SET {column}=?",
                (json.dumps(edit(json.loads(original))),),
            )
        response = client.get(route)
        assert response.status_code == 503, column
        assert "validated" not in response.text and "rotation" not in response.text
        with closing(sqlite3.connect(database)) as conn, conn:
            conn.execute(f"UPDATE projection_registrations SET {column}=?", (original,))
    assert client.get(route).status_code == 200


@pytest.mark.parametrize("payload", [b"", b"[]", b"{", b'{"inputs": null}'])
def test_malformed_and_oversized_bodies_are_rejected(tmp_path, monkeypatch, payload):
    client, case, _, _, _, _ = ready(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-registration"
    headers = {"Content-Type": "application/json"}
    assert client.put(route, content=payload, headers=headers).status_code == 422
    assert client.put(route, content=b" " * 65537, headers=headers).status_code == 413
    assert client.get(route).json()["registration_revision"] == 0
