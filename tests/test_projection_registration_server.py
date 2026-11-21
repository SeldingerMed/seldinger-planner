"""Operator-confirmed 2D-to-3D registration proposals on a generated native source."""

import copy
import hashlib
import json
import math
import sqlite3
from contextlib import closing
from pathlib import Path

import pytest
from test_frame_source import ROWS, dicom_plane, install, manifest, pixels, png_plane
from test_territory_workflow_server import configured

from planner import frame_source
from planner.frame_source import frame_filename
from planner.projection_plan import PlanConflict
from planner.projection_registration import (
    RegistrationLedger,
    plane_angle_deg,
    record_version,
    summarize,
    validate_registration,
)
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
            # Plane b holds other pixels than plane a at the same index.
            data = pixels(item["index"] + (97 if plane["plane"] == "b" else 0))[: ROWS * ROWS]
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


# Two-plane records (version 2).

FRONTAL = {**VIEW, "primary_deg": 0.0, "secondary_deg": 0.0}
LATERAL = {**VIEW, "primary_deg": 90.0, "secondary_deg": 0.0}
PAIR_VERSION = "step-c2-biplane-registration-v2"
PAIR_METHOD = "centerline_distance_compass_biplane_v1"


def pair_ready(tmp_path, monkeypatch, planes=None):
    planes = planes or [square(png_plane("a")), square(png_plane("b"))]
    return ready(tmp_path, monkeypatch, value=manifest(planes))


def pair_inputs(mask, listed, a=None, b=None, **change):
    def entry(position, view, edits):
        plane = listed["manifest"]["planes"][position]
        frame = plane["frames"][0]
        return {
            "plane": plane["plane"],
            "frame_index": frame["index"],
            "frame_sha256": frame["sha256"],
            "geometry_source": "operator_entered",
            "view": dict(view),
            "fit_detector_scale": False,
            "detector_scale": 1.0,
            "polarity": "dark",
            "sensitivity": 0.5,
            "reported_score": dict(SCORE),
            "reported_start_score": {**SCORE, "mean_distance_mm": 5.5 + position},
            **(edits or {}),
        }

    return {
        "confirmed": True,
        "same_position_attested": True,
        "frame_source_id": "run-01",
        "frame_manifest_revision": listed["manifest_revision"],
        "mask_candidate_id": mask["candidate_id"],
        "mask_sha256": mask["mask_sha256"],
        "isocenter": [16.0, 16.0, 16.0],
        "volume_to_carm_ras": turn(90.0, (3.0, 4.0, 0.0)),
        "method": PAIR_METHOD,
        "planes": [entry(0, FRONTAL, a), entry(1, LATERAL, b)],
        **change,
    }


def pair_body(case, reference, mask, listed, revision=0, **change):
    return {
        "artifact_version": case["artifact_version"],
        "reference_revision": reference,
        "registration_revision": revision,
        "inputs": pair_inputs(mask, listed, **change),
    }


def test_plane_angle_is_the_angle_between_central_rays():
    assert plane_angle_deg(FRONTAL, LATERAL) == pytest.approx(90)
    assert plane_angle_deg(FRONTAL, {**FRONTAL, "primary_deg": 31.0}) == pytest.approx(31)
    # Opposite directions along one line are the same plane.
    assert plane_angle_deg(FRONTAL, {**FRONTAL, "primary_deg": 151.0}) == pytest.approx(29)
    assert plane_angle_deg(FRONTAL, {**FRONTAL, "primary_deg": 180.0}) == pytest.approx(0, abs=1e-6)
    assert plane_angle_deg(FRONTAL, {**FRONTAL, "secondary_deg": 40.0}) == pytest.approx(40)


def test_two_plane_registration_roundtrips_and_binds_both_frames(tmp_path, monkeypatch):
    client, case, reference, mask, listed, _ = pair_ready(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-registration"
    request = pair_body(case, reference, mask, listed)
    response = client.put(route, json=request)
    assert response.status_code == 200, response.text
    saved = response.json()
    current = saved["current"]
    assert saved["registration_revision"] == 1
    assert current["status"] == "current" and current["evidence"] == "verified"
    assert current["inputs"] == request["inputs"]
    assert [entry["plane"] for entry in current["inputs"]["planes"]] == ["a", "b"]
    assert current["dependencies"]["version"] == PAIR_VERSION
    assert current["result"] == {
        "version": PAIR_VERSION,
        "convention": "dicom_xa_patient_longitude_latitude_ras_v1",
        "method": PAIR_METHOD,
        "status": "operator_confirmed_proposal",
        "validated": False,
        "same_position": "operator_attested_not_checked",
        "plane_angle_deg": 90.0,
        "rotation_deg": 90.0,
        "isocenter_shift_mm": round(math.hypot(-29, 4), 3),
        "score_source": "browser_reported_not_recomputed",
        "planes": [
            {
                "plane": label,
                "geometry_source": "operator_entered",
                "reported_score": SCORE,
                "reported_start_score": {**SCORE, "mean_distance_mm": 5.5 + position},
            }
            for position, label in enumerate("ab")
        ],
    }
    assert client.get(route).json() == saved
    # A single-plane confirmation on plane b follows as revision 2, and reads
    # back as a version 1 record.
    plane_b = listed["manifest"]["planes"][1]
    single = body(
        case,
        reference,
        mask,
        listed,
        1,
        plane="b",
        frame_index=plane_b["frames"][0]["index"],
        frame_sha256=plane_b["frames"][0]["sha256"],
    )
    after = client.put(route, json=single)
    assert after.status_code == 200, after.text
    assert after.json()["current"]["dependencies"]["version"] == (
        "step-c1-projection-registration-v1"
    )
    assert after.json()["current"]["result"]["method"] == "centerline_distance_compass_v1"


@pytest.mark.parametrize(
    "change",
    [
        {"confirmed": False},
        {"same_position_attested": False},
        {"same_position_attested": "true"},
        {"same_position_attested": 1},
        {"plane": "a"},  # a version 1 field
        {"view": dict(FRONTAL)},
        {"polarity": "dark"},
        {"note": "validated"},
        {"isocenter": [16.0, 16.0]},
        {"volume_to_carm_ras": [[2.0, 0, 0, 0], [0, 1.0, 0, 0], [0, 0, 1.0, 0], [0, 0, 0, 1]]},
        {"a": {"plane": "single"}},
        {"a": {"plane": "b"}},  # plane b twice
        {"a": {"plane": "b"}, "b": {"plane": "a"}},  # out of order
        {"b": {"frame_sha256": "SAME_AS_A"}},  # one image under both planes
        {"b": {"frame_index": -1}},
        {"b": {"frame_sha256": "A" * 64}},
        {"b": {"geometry_source": "guessed"}},
        {"b": {"detector_scale": 1.1}},  # a scale other than one without a fit
        {"b": {"fit_detector_scale": True, "detector_scale": 1.46}},
        {"b": {"polarity": "inverted"}},
        {"b": {"sensitivity": 1.5}},
        {"b": {"reported_score": {**SCORE, "matched_fraction": 1.2}}},
        {"b": {"reported_score": {**SCORE, "accuracy_mm": 1.0}}},
        {"b": {"reported_start_score": None}},
        {"b": {"view": {**LATERAL, "source_isocenter_mm": 1300.0}}},
        {"b": {"pixels": "AAAA"}},
        # Planes 29 degrees apart, directly and through the opposite direction.
        {"b": {"view": {**FRONTAL, "primary_deg": 29.0}}},
        {"b": {"view": {**FRONTAL, "primary_deg": 151.0}}},
    ],
)
def test_two_plane_shape_rejections_do_not_store(tmp_path, monkeypatch, change):
    client, case, reference, mask, listed, _ = pair_ready(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-registration"
    if change.get("b", {}).get("frame_sha256") == "SAME_AS_A":
        change = {"b": {"frame_sha256": listed["manifest"]["planes"][0]["frames"][0]["sha256"]}}
    response = client.put(route, json=pair_body(case, reference, mask, listed, **change))
    assert response.status_code == 422, response.text
    assert "admitted frame or accepted mask" not in response.text
    assert client.get(route).json()["registration_revision"] == 0


def test_two_plane_inputs_with_one_or_three_planes_are_refused(tmp_path, monkeypatch):
    client, case, reference, mask, listed, _ = pair_ready(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-registration"
    for keep in (slice(0, 1), slice(0, 0)):
        request = pair_body(case, reference, mask, listed)
        request["inputs"]["planes"] = request["inputs"]["planes"][keep]
        assert client.put(route, json=request).status_code == 422
    request = pair_body(case, reference, mask, listed)
    request["inputs"]["planes"].append(request["inputs"]["planes"][1])
    assert client.put(route, json=request).status_code == 422
    assert client.get(route).json()["registration_revision"] == 0


def test_planes_exactly_at_the_smallest_angle_are_accepted(tmp_path, monkeypatch):
    client, case, reference, mask, listed, _ = pair_ready(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-registration"
    edge = pair_body(case, reference, mask, listed, b={"view": {**FRONTAL, "primary_deg": 30.0}})
    saved = client.put(route, json=edge)
    assert saved.status_code == 200, saved.text
    assert saved.json()["current"]["result"]["plane_angle_deg"] == 30.0


@pytest.mark.parametrize(
    "change",
    [
        {"frame_source_id": "run-02"},
        {"frame_manifest_revision": "0" * 64},
        {"mask_sha256": "0" * 64},
        {"isocenter": [40.0, 16.0, 16.0]},
        {"a": {"frame_sha256": "0" * 64}},
        {"b": {"frame_sha256": "0" * 64}},
        {"b": {"frame_index": 4}},
        {"b": {"view": {**LATERAL, "detector_height_mm": 160.0}}},
        {"b": {"geometry_source": "frame_manifest"}},  # the PNG plane carries no geometry
    ],
)
def test_two_plane_bindings_must_match_both_admitted_frames(tmp_path, monkeypatch, change):
    client, case, reference, mask, listed, _ = pair_ready(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-registration"
    response = client.put(route, json=pair_body(case, reference, mask, listed, **change))
    assert response.status_code == 422, response.text
    assert "admitted frame or accepted mask" in response.json()["detail"]
    assert client.get(route).json()["registration_revision"] == 0


def test_a_two_plane_record_needs_a_declared_pair(tmp_path, monkeypatch):
    client, case, reference, mask, listed, _ = ready(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-registration"
    request = pair_body(
        case,
        reference,
        mask,
        {
            **listed,
            "manifest": {
                "planes": [
                    {**listed["manifest"]["planes"][0], "plane": "a"},
                    {**listed["manifest"]["planes"][0], "plane": "b"},
                ]
            },
        },
        # Other pixels than plane a, so that only the missing pair refuses it.
        b={"frame_sha256": "1" * 64},
    )
    response = client.put(route, json=request)
    assert response.status_code == 422, response.text
    assert "admitted frame or accepted mask" in response.json()["detail"]


def test_losing_either_frame_makes_two_plane_evidence_unavailable(tmp_path, monkeypatch):
    client, case, reference, mask, listed, directory = pair_ready(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-registration"
    assert client.put(route, json=pair_body(case, reference, mask, listed)).status_code == 200
    for label in "ab":
        target = directory / frame_filename(label, 3)
        original = target.read_bytes()
        target.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
        assert client.get(route).json()["current"]["evidence"] == "unavailable", label
        target.write_bytes(original)
        assert client.get(route).json()["current"]["evidence"] == "verified"


def test_tampered_two_plane_record_fails_closed(tmp_path, monkeypatch):
    client, case, reference, mask, listed, _ = pair_ready(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-registration"
    assert client.put(route, json=pair_body(case, reference, mask, listed)).status_code == 200
    database = tmp_path.resolve() / "case.sqlite3"

    def relabel(value):
        return {**value, "version": "step-c1-projection-registration-v1"}

    for column, edit in (
        ("result", lambda value: {**value, "validated": True}),
        ("result", lambda value: {**value, "plane_angle_deg": 45.0}),
        ("result", lambda value: {**value, "same_position": "checked"}),
        ("inputs", lambda value: {**value, "same_position_attested": False}),
        ("inputs", lambda value: {**value, "planes": value["planes"][::-1]}),
        # The record's version must be the one its method belongs to.
        ("dependencies", relabel),
    ):
        with closing(sqlite3.connect(database)) as conn, conn:
            original = conn.execute(f"SELECT {column} FROM projection_registrations").fetchone()[0]
            conn.execute(
                f"UPDATE projection_registrations SET {column}=?",
                (json.dumps(edit(json.loads(original))),),
            )
        response = client.get(route)
        assert response.status_code == 503, edit(json.loads(original))
        with closing(sqlite3.connect(database)) as conn, conn:
            conn.execute(f"UPDATE projection_registrations SET {column}=?", (original,))
    assert client.get(route).status_code == 200
    # An unknown record version is not read at all.
    with closing(sqlite3.connect(database)) as conn, conn:
        original = conn.execute("SELECT dependencies FROM projection_registrations").fetchone()[0]
        conn.execute(
            "UPDATE projection_registrations SET dependencies=?",
            (json.dumps({**json.loads(original), "version": "step-c9"}),),
        )
    unknown = client.get(route).json()["current"]
    assert unknown["status"] == "stale" and unknown["inputs"] is None


@pytest.mark.parametrize("pair", [False, True])
@pytest.mark.parametrize(
    "stored",
    [
        "[]",
        '"text"',
        "7",
        "null",
        '{"method": 5}',
        # A method that cannot be looked up by.
        '{"method": []}',
        '{"method": {}}',
        "[" * 100_000 + "]" * 100_000,
    ],
)
def test_a_stored_row_that_is_not_a_record_fails_closed(tmp_path, monkeypatch, pair, stored):
    if pair:
        client, case, reference, mask, listed, _ = pair_ready(tmp_path, monkeypatch)
        request = pair_body(case, reference, mask, listed)
    else:
        client, case, reference, mask, listed, _ = ready(tmp_path, monkeypatch)
        request = body(case, reference, mask, listed)
    route = f"/api/cases/{case['case_id']}/projection-registration"
    assert client.put(route, json=request).status_code == 200
    with closing(sqlite3.connect(tmp_path.resolve() / "case.sqlite3")) as conn, conn:
        conn.execute("UPDATE projection_registrations SET inputs=?", (stored,))
    response = client.get(route)
    assert response.status_code == 503, response.text
    assert response.json()["detail"] == "Projection registration is unavailable; reload"


@pytest.mark.parametrize("method", [[], {}, 5, None, ["vessel_evidence_compass_v1"]])
def test_a_method_that_is_not_a_name_is_refused_as_invalid(method):
    """The method picks the record's model and version. A stored value that is
    not a name is an invalid record like any other, whoever reads it."""
    with pytest.raises(ValueError):
        validate_registration({"method": method})
    assert record_version({"method": method}) == "step-c1-projection-registration-v1"


# Vessel evidence methods (Step C4). The same records with another score, no
# sensitivity (the 2D target has no threshold) and what became of a requested
# detector-size fit.

EVIDENCE_METHOD = "vessel_evidence_compass_v1"
EVIDENCE_VERSION = "step-c4-evidence-registration-v3"
EVIDENCE_PAIR_METHOD = "vessel_evidence_compass_biplane_v1"
EVIDENCE_PAIR_VERSION = "step-c4-evidence-biplane-registration-v4"
EVIDENCE = {"mean_evidence": 0.21, "in_field_fraction": 1.0, "uncovered_fraction": 0.1}
EVIDENCE_START = {**EVIDENCE, "mean_evidence": 0.12}


def evidence_inputs(mask, listed, **change):
    value = inputs(
        mask,
        listed,
        method=EVIDENCE_METHOD,
        detector_fit="not_requested",
        reported_score=dict(EVIDENCE),
        reported_start_score=dict(EVIDENCE_START),
    )
    del value["sensitivity"]
    return {**value, **change}


def evidence_pair_inputs(mask, listed, a=None, b=None, **change):
    value = pair_inputs(mask, listed, method=EVIDENCE_PAIR_METHOD, detector_fit="not_requested")
    for entry, edits in zip(value["planes"], (a, b), strict=True):
        del entry["sensitivity"]
        entry["reported_score"] = dict(EVIDENCE)
        entry["reported_start_score"] = dict(EVIDENCE_START)
        entry.update(edits or {})
    return {**value, **change}


def request_for(case, reference, value, revision=0):
    return {
        "artifact_version": case["artifact_version"],
        "reference_revision": reference,
        "registration_revision": revision,
        "inputs": value,
    }


def test_single_plane_evidence_registration_roundtrips(tmp_path, monkeypatch):
    client, case, reference, mask, listed, _ = ready(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-registration"
    request = request_for(case, reference, evidence_inputs(mask, listed))
    response = client.put(route, json=request)
    assert response.status_code == 200, response.text
    current = response.json()["current"]
    assert current["status"] == "current" and current["evidence"] == "verified"
    assert current["inputs"] == request["inputs"]
    assert current["dependencies"]["version"] == EVIDENCE_VERSION
    assert current["result"] == {
        "version": EVIDENCE_VERSION,
        "convention": "dicom_xa_patient_longitude_latitude_ras_v1",
        "method": EVIDENCE_METHOD,
        "status": "operator_confirmed_proposal",
        "validated": False,
        "geometry_source": "operator_entered",
        "rotation_deg": 90.0,
        "isocenter_shift_mm": pytest.approx(math.hypot(-29, 4), abs=1e-3),
        "detector_fit": "not_requested",
        "score_source": "browser_reported_not_recomputed",
        "score_kind": "mean_vessel_evidence_under_projected_points",
        "reported_score": EVIDENCE,
        "reported_start_score": EVIDENCE_START,
    }
    assert client.get(route).json() == response.json()
    # A record of the older method follows it as the next revision, and reads back.
    older = client.put(route, json=body(case, reference, mask, listed, 1))
    assert older.status_code == 200, older.text
    assert older.json()["current"]["result"]["method"] == "centerline_distance_compass_v1"


def test_two_plane_evidence_registration_roundtrips(tmp_path, monkeypatch):
    client, case, reference, mask, listed, _ = pair_ready(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-registration"
    kept = {"fit_detector_scale": True, "detector_scale": 1.18}
    request = request_for(
        case, reference, evidence_pair_inputs(mask, listed, b=kept, detector_fit="kept")
    )
    response = client.put(route, json=request)
    assert response.status_code == 200, response.text
    current = response.json()["current"]
    assert current["status"] == "current" and current["evidence"] == "verified"
    assert current["inputs"] == request["inputs"]
    assert current["dependencies"]["version"] == EVIDENCE_PAIR_VERSION
    result = current["result"]
    assert result["version"] == EVIDENCE_PAIR_VERSION and result["method"] == EVIDENCE_PAIR_METHOD
    assert result["validated"] is False
    assert result["same_position"] == "operator_attested_not_checked"
    assert result["plane_angle_deg"] == 90.0
    assert result["detector_fit"] == "kept"
    assert result["score_kind"] == "mean_vessel_evidence_under_projected_points"
    assert [entry["plane"] for entry in result["planes"]] == ["a", "b"]
    assert result["planes"][1]["reported_score"] == EVIDENCE
    assert result["planes"][1]["reported_start_score"] == EVIDENCE_START
    assert client.get(route).json() == response.json()


@pytest.mark.parametrize(
    "change",
    [
        # Each method keeps its own score.
        {"reported_score": dict(SCORE)},
        {"reported_start_score": dict(SCORE)},
        {"reported_score": {**EVIDENCE, "mean_distance_mm": 0.4}},
        {"reported_score": {**EVIDENCE, "mean_evidence": 1.2}},
        {"reported_score": {**EVIDENCE, "mean_evidence": -0.1}},
        {"reported_score": {**EVIDENCE, "accuracy_mm": 1.0}},
        {"reported_score": {k: v for k, v in EVIDENCE.items() if k != "mean_evidence"}},
        # The evidence target has no threshold to record.
        {"sensitivity": 0.5},
        # What became of a fit has to agree with what was requested and stored.
        {"detector_fit": "guessed"},
        {"detector_fit": None},
        {"detector_fit": "kept"},  # nothing was requested
        {"detector_fit": "dropped"},  # nothing was requested
        {"fit_detector_scale": True},  # requested, and reported as not requested
        {"fit_detector_scale": True, "detector_fit": "dropped", "detector_scale": 1.1},
        {"fit_detector_scale": True, "detector_fit": "kept", "detector_scale": 1.46},
        {"detector_scale": 1.1},
        {"fit_detector_scale": True, "detector_fit": "kept", "geometry_source": "frame_manifest"},
        {"confirmed": False},
        {"same_position_attested": True},  # a two-plane field
        {"note": "validated"},
    ],
)
def test_single_plane_evidence_rejections_do_not_store(tmp_path, monkeypatch, change):
    client, case, reference, mask, listed, _ = ready(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-registration"
    value = evidence_inputs(mask, listed, **change)
    response = client.put(route, json=request_for(case, reference, value))
    assert response.status_code == 422, response.text
    assert client.get(route).json()["registration_revision"] == 0


def test_a_fit_that_was_kept_or_dropped_is_stored_as_such(tmp_path, monkeypatch):
    client, case, reference, mask, listed, _ = ready(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-registration"
    kept = evidence_inputs(
        mask, listed, fit_detector_scale=True, detector_fit="kept", detector_scale=0.9
    )
    first = client.put(route, json=request_for(case, reference, kept))
    assert first.status_code == 200, first.text
    assert first.json()["current"]["result"]["detector_fit"] == "kept"
    dropped = evidence_inputs(
        mask, listed, fit_detector_scale=True, detector_fit="dropped", detector_scale=1.0
    )
    second = client.put(route, json=request_for(case, reference, dropped, 1))
    assert second.status_code == 200, second.text
    assert second.json()["current"]["result"]["detector_fit"] == "dropped"


@pytest.mark.parametrize(
    "change",
    [
        {"same_position_attested": False},
        {"detector_fit": "kept"},  # no plane requested a fit
        {"sensitivity": 0.5},
        {"b": {"sensitivity": 0.5}},
        {"b": {"reported_score": dict(SCORE)}},
        {"b": {"reported_score": {**EVIDENCE, "mean_evidence": 1.2}}},
        {"b": {"fit_detector_scale": True}},  # requested, and reported as not requested
        # A dropped fit leaves every plane at its entered size.
        {"detector_fit": "dropped", "b": {"fit_detector_scale": True, "detector_scale": 1.1}},
        # A kept fit changes only the planes that asked for one.
        {
            "detector_fit": "kept",
            "a": {"detector_scale": 1.1},
            "b": {"fit_detector_scale": True, "detector_scale": 1.1},
        },
        {"b": {"view": {**FRONTAL, "primary_deg": 29.0}}},
        {"b": {"frame_sha256": "SAME_AS_A"}},
        {"a": {"plane": "b"}, "b": {"plane": "a"}},
        {"method": PAIR_METHOD},  # the older method with this record's fields
    ],
)
def test_two_plane_evidence_rejections_do_not_store(tmp_path, monkeypatch, change):
    client, case, reference, mask, listed, _ = pair_ready(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-registration"
    if change.get("b", {}).get("frame_sha256") == "SAME_AS_A":
        change = {"b": {"frame_sha256": listed["manifest"]["planes"][0]["frames"][0]["sha256"]}}
    value = evidence_pair_inputs(mask, listed, **change)
    response = client.put(route, json=request_for(case, reference, value))
    assert response.status_code == 422, response.text
    assert client.get(route).json()["registration_revision"] == 0


def test_an_evidence_record_relabelled_as_the_older_method_fails_closed(tmp_path, monkeypatch):
    client, case, reference, mask, listed, _ = ready(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-registration"
    saved = client.put(route, json=request_for(case, reference, evidence_inputs(mask, listed)))
    assert saved.status_code == 200, saved.text
    with closing(sqlite3.connect(tmp_path.resolve() / "case.sqlite3")) as conn, conn:
        stored = json.loads(
            conn.execute("SELECT dependencies FROM projection_registrations").fetchone()[0]
        )
        stored["version"] = "step-c1-projection-registration-v1"
        conn.execute("UPDATE projection_registrations SET dependencies=?", (json.dumps(stored),))
    assert client.get(route).status_code == 503


EVIDENCE_RECORDS = json.loads(
    (
        Path(__file__).resolve().parents[1]
        / "web"
        / "src"
        / "__fixtures__"
        / "evidence-registration-records.json"
    ).read_text()
)["cases"]


@pytest.mark.parametrize("case", EVIDENCE_RECORDS, ids=lambda case: case["name"])
def test_the_studio_s_own_vessel_evidence_records_are_accepted_as_sent(case):
    """Records the studio saved on the phantom, and this module's summary of each.

    The browser tests read the same file, so the two sides cannot drift apart
    on a field name, a version or a fit outcome without one of them failing.
    """
    value = validate_registration(case["inputs"])
    assert value == case["inputs"]
    assert summarize(value) == case["result"]
    assert case["result"]["version"] == record_version(value)
    assert case["result"]["validated"] is False


def test_the_shared_records_cover_both_methods_and_every_fit_outcome():
    seen = {(case["inputs"]["method"], case["inputs"]["detector_fit"]) for case in EVIDENCE_RECORDS}
    assert {method for method, _ in seen} == {EVIDENCE_METHOD, EVIDENCE_PAIR_METHOD}
    assert {outcome for _, outcome in seen} == {"not_requested", "kept", "dropped"}


# The best-start methods: the vessel evidence search run from several starts,
# the result with the most evidence kept. Their records have the fields of
# versions 3 and 4 under their own method names and versions.

BEST_START = [
    ("vessel_evidence_best_start_v1", "step-c4-evidence-best-start-registration-v5"),
    (
        "vessel_evidence_best_start_biplane_v1",
        "step-c4-evidence-best-start-biplane-registration-v6",
    ),
]


@pytest.mark.parametrize(("method", "version"), BEST_START)
def test_best_start_registration_roundtrips_under_its_own_version(
    tmp_path, monkeypatch, method, version
):
    two = "biplane" in method
    client, case, reference, mask, listed, _ = (pair_ready if two else ready)(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-registration"
    value = (evidence_pair_inputs if two else evidence_inputs)(mask, listed, method=method)
    older = dict(value, method=EVIDENCE_PAIR_METHOD if two else EVIDENCE_METHOD)
    response = client.put(route, json=request_for(case, reference, value))
    assert response.status_code == 200, response.text
    current = response.json()["current"]
    assert current["status"] == "current" and current["evidence"] == "verified"
    assert current["inputs"] == value
    assert current["dependencies"]["version"] == version
    # The same numbers under the single-start method differ only in the names.
    again = client.put(route, json=request_for(case, reference, older, 1))
    assert again.status_code == 200, again.text
    result = again.json()["current"]["result"]
    assert result["version"] == (EVIDENCE_PAIR_VERSION if two else EVIDENCE_VERSION)
    assert current["result"] == {**result, "version": version, "method": method}
    assert client.get(route).json() == again.json()


@pytest.mark.parametrize(("method", "version"), BEST_START)
def test_a_best_start_record_is_held_to_the_rules_of_its_kind(
    tmp_path, monkeypatch, method, version
):
    two = "biplane" in method
    client, case, reference, mask, listed, _ = (pair_ready if two else ready)(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-registration"
    value = (evidence_pair_inputs if two else evidence_inputs)(mask, listed, method=method)
    # A sensitivity is no field of a vessel evidence record.
    if two:
        wrong = {
            **value,
            "planes": [{**value["planes"][0], "sensitivity": 0.5}, value["planes"][1]],
        }
        other = dict(evidence_inputs(mask, listed), method=method)
    else:
        wrong = {**value, "sensitivity": 0.5}
        other = {**value, "method": "vessel_evidence_best_start_biplane_v1"}
    for bad in (wrong, other):
        assert client.put(route, json=request_for(case, reference, bad)).status_code == 422
    assert client.get(route).json()["current"]["status"] == "not_confirmed"


# The size-search methods: a requested fit of the field size searched from
# several entered sizes. Their records have the fields of versions 3 and 4
# under their own method names and versions, and always a requested fit.

SIZE_SEARCH = [
    ("vessel_evidence_size_search_v1", "step-c4-evidence-size-search-registration-v7"),
    (
        "vessel_evidence_size_search_biplane_v1",
        "step-c4-evidence-size-search-biplane-registration-v8",
    ),
]
FITTED = {"fit_detector_scale": True, "geometry_source": "operator_entered", "detector_scale": 1.2}


def size_search_inputs(mask, listed, method, **change):
    if "biplane" in method:
        return evidence_pair_inputs(
            mask, listed, a=FITTED, method=method, detector_fit="kept", **change
        )
    return evidence_inputs(mask, listed, method=method, detector_fit="kept", **FITTED, **change)


@pytest.mark.parametrize(("method", "version"), SIZE_SEARCH)
def test_size_search_registration_roundtrips_under_its_own_version(
    tmp_path, monkeypatch, method, version
):
    two = "biplane" in method
    client, case, reference, mask, listed, _ = (pair_ready if two else ready)(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-registration"
    value = size_search_inputs(mask, listed, method)
    older = dict(value, method=EVIDENCE_PAIR_METHOD if two else EVIDENCE_METHOD)
    response = client.put(route, json=request_for(case, reference, value))
    assert response.status_code == 200, response.text
    current = response.json()["current"]
    assert current["status"] == "current" and current["evidence"] == "verified"
    assert current["inputs"] == value
    assert current["dependencies"]["version"] == version
    # The same numbers under the single-start method differ only in the names.
    again = client.put(route, json=request_for(case, reference, older, 1))
    assert again.status_code == 200, again.text
    result = again.json()["current"]["result"]
    assert current["result"] == {**result, "version": version, "method": method}
    assert current["result"]["detector_fit"] == "kept"


@pytest.mark.parametrize(("method", "version"), SIZE_SEARCH)
def test_a_size_search_record_is_held_to_the_rules_of_its_kind(
    tmp_path, monkeypatch, method, version
):
    two = "biplane" in method
    client, case, reference, mask, listed, _ = (pair_ready if two else ready)(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/projection-registration"
    value = size_search_inputs(mask, listed, method)
    # With no fit requested there was no size to search.
    unfitted = (evidence_pair_inputs if two else evidence_inputs)(mask, listed, method=method)
    # A sensitivity is no field of a vessel evidence record.
    if two:
        wrong = {
            **value,
            "planes": [{**value["planes"][0], "sensitivity": 0.5}, value["planes"][1]],
        }
        other = size_search_inputs(mask, listed, "vessel_evidence_size_search_v1") | {
            "method": method
        }
        past = {
            **value,
            "planes": [{**value["planes"][0], "detector_scale": 1.5}, value["planes"][1]],
        }
    else:
        wrong = {**value, "sensitivity": 0.5}
        other = {**value, "method": "vessel_evidence_size_search_biplane_v1"}
        past = {**value, "detector_scale": 1.5}
    for bad in (unfitted, wrong, other, past):
        assert client.put(route, json=request_for(case, reference, bad)).status_code == 422
    assert client.get(route).json()["current"]["status"] == "not_confirmed"
    # A fit that was requested and dropped is a size-search record too.
    if two:
        dropped = {
            **value,
            "detector_fit": "dropped",
            "planes": [{**value["planes"][0], "detector_scale": 1.0}, value["planes"][1]],
        }
    else:
        dropped = {**value, "detector_fit": "dropped", "detector_scale": 1.0}
    assert client.put(route, json=request_for(case, reference, dropped)).status_code == 200
