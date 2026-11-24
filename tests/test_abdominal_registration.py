"""The aorta and iliac model and its bone line-up, on a generated native source."""

import copy
import math
import sqlite3

import pytest
from test_frame_source import manifest, png_plane
from test_projection_registration_server import square, write_frames
from test_territory_workflow_server import configured

from planner import frame_source
from planner.abdominal_registration import (
    METHOD,
    VERSION,
    ModelLedger,
    beam_from_front_deg,
    summarize,
    validate_lineup,
    validate_model,
)
from planner.frame_source import frame_filename

FRONT = {
    "primary_deg": 0.0,
    "secondary_deg": 0.0,
    "source_detector_mm": 1140.0,
    "source_isocenter_mm": 745.0,
    "detector_width_mm": 306.0,
    "detector_height_mm": 306.0,
}
SIDE = {**FRONT, "primary_deg": 90.0}
IDENTITY = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0, 0, 0, 1]]


def turn_z(degrees, shift=(0.0, 0.0, 0.0)):
    c, s = math.cos(math.radians(degrees)), math.sin(math.radians(degrees))
    return [[c, -s, 0.0, shift[0]], [s, c, 0.0, shift[1]], [0.0, 0.0, 1.0, shift[2]], [0, 0, 0, 1]]


def export(source_sha256, **change):
    """The shape `planner.aortoiliac_export` prints, inside the 32 mm cube."""
    line = [[16.0, 16.0, 30.0 - 2 * k] for k in range(8)]
    right = [[16.0 - k, 16.0, 16.0 - 2 * k] for k in range(6)]
    left = [[16.0 + k, 16.0, 16.0 - 2 * k] for k in range(6)]
    proposal = {
        "method": "aortoiliac_widest_path_model_v1",
        "branches": [
            {"name": "aorta", "path_ras": line, "radius_mm": [8.0] * 8, "length_mm": 14.0},
            {"name": "right_iliac", "path_ras": right, "radius_mm": [4.0] * 6, "length_mm": 11.2},
            {"name": "left_iliac", "path_ras": left, "radius_mm": [4.0] * 6, "length_mm": 11.2},
        ],
        "bifurcation_ras": [16.0, 16.0, 14.0],
        "bifurcation_below_meeting_mm": 2.0,
        "operator_confirmation_required": True,
        "clinical_validation": False,
        "spatial_units": "mm",
        "working_spacing_mm": [1.5, 1.5, 1.5],
        "working_grid_shape": [22, 22, 22],
        "skeleton_voxel_count": 40,
        "volume_apart_from_the_model_mm3": 0.0,
    }
    return {
        "source_sha256": source_sha256,
        "method": "aortoiliac_totalsegmentator_total_v1",
        "spatial_units": "mm",
        "operator_confirmation_required": True,
        "proposal": proposal,
        **change,
    }


def ready(tmp_path, monkeypatch, planes=None):
    frames_root = tmp_path.resolve() / "frames"
    monkeypatch.setattr(frame_source, "INSTALLED_FRAMES_ROOT", frames_root)
    client, case, reference = configured(tmp_path, monkeypatch)
    value = manifest(planes or [square(png_plane("a")), square(png_plane("b"))])
    directory = frames_root / "abdomen-01"
    directory.mkdir(parents=True)
    write_frames(directory, value)
    listed = client.get("/api/projection-frames/abdomen-01").json()
    return client, case, reference, listed, directory


def admit_model(client, case, reference, revision=0, **change):
    route = f"/api/cases/{case['case_id']}/aortoiliac-model"
    return client.put(
        route,
        json={
            "artifact_version": case["artifact_version"],
            "reference_revision": reference,
            "model_revision": revision,
            "export": export(case["image_sha256"], **change),
        },
    )


def plane_entry(listed, label, view, score=0.4):
    plane = next(p for p in listed["manifest"]["planes"] if p["plane"] == label)
    frame = plane["frames"][0]
    return {
        "plane": label,
        "frame_index": frame["index"],
        "frame_sha256": frame["sha256"],
        "geometry_source": "operator_entered",
        "view": dict(view),
        "reported_score": score,
    }


def lineup(listed, model, *, two=False, aside=None, **change):
    planes = [plane_entry(listed, "a", FRONT)]
    if two:
        planes.append(plane_entry(listed, "b", SIDE, 0.3))
    second = {"status": "not_given"}
    if aside:
        b = plane_entry(listed, "b", SIDE)
        second = {
            "status": "set_aside",
            "plane": "b",
            "frame_index": b["frame_index"],
            "frame_sha256": b["frame_sha256"],
            "reason": aside,
        }
    return {
        "confirmed": True,
        "method": METHOD,
        "engine_method": "bone_edge_compass_biplane_v1" if two else "bone_edge_compass_v1",
        "frame_source_id": "abdomen-01",
        "frame_manifest_revision": listed["manifest_revision"],
        "planes": planes,
        "second_view": second,
        "depth": "two_views" if two else "not_determined_single_view",
        "model_revision": model["model_revision"],
        "model_sha256": model["current"]["body_sha256"],
        "bone_threshold_hu": 250.0,
        "reported_start_score": 0.1,
        "isocenter": [16.0, 16.0, 16.0],
        "volume_to_carm_ras": turn_z(3.0, (1.0, -2.0, 4.0)),
        "same_position": two,
        **change,
    }


def put_lineup(client, case, reference, inputs, revision=0):
    return client.put(
        f"/api/cases/{case['case_id']}/bone-lineup-registration",
        json={
            "artifact_version": case["artifact_version"],
            "reference_revision": reference,
            "registration_revision": revision,
            "inputs": inputs,
        },
    )


def test_model_admitted_only_from_this_scan_and_inside_it(tmp_path, monkeypatch):
    client, case, reference, _, _ = ready(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/aortoiliac-model"
    assert client.get(route).json()["current"] == {"status": "not_confirmed"}
    other = export("e" * 64)
    other = client.put(
        route,
        json={
            "artifact_version": case["artifact_version"],
            "reference_revision": reference,
            "model_revision": 0,
            "export": other,
        },
    )
    assert other.status_code == 422
    assert other.json()["detail"] == "The model was made from another scan"
    outside = export(case["image_sha256"])
    outside["proposal"]["branches"][0]["path_ras"][0] = [16.0, 16.0, 90.0]
    response = client.put(
        route,
        json={
            "artifact_version": case["artifact_version"],
            "reference_revision": reference,
            "model_revision": 0,
            "export": outside,
        },
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "The model leaves the scan"
    good = admit_model(client, case, reference)
    assert good.status_code == 200, good.text
    body = good.json()
    assert body["model_revision"] == 1
    assert body["current"]["status"] == "current"
    assert body["current"]["body"]["source_sha256"] == case["image_sha256"]
    assert client.get(route).json() == body
    # A second save names the revision it replaces.
    assert admit_model(client, case, reference).status_code == 409
    assert admit_model(client, case, reference, revision=1).json()["model_revision"] == 2


def test_model_shape_is_closed():
    sha = "a" * 64
    validate_model(export(sha), sha)
    for change in (
        {"method": "aortoiliac_something_else"},
        {"operator_confirmation_required": False},
        {"spatial_units": "voxel"},
        {"extra": 1},
    ):
        with pytest.raises(ValueError):
            validate_model(export(sha, **change), sha)
    twice = export(sha)
    twice["proposal"]["branches"][2]["name"] = "right_iliac"
    with pytest.raises(ValueError, match="each branch once"):
        validate_model(twice, sha)
    short = export(sha)
    short["proposal"]["branches"][0]["radius_mm"].pop()
    with pytest.raises(ValueError, match="one radius"):
        validate_model(short, sha)


def test_single_frame_lineup_saves_and_reopens_with_depth_left_open(tmp_path, monkeypatch):
    client, case, reference, listed, _ = ready(tmp_path, monkeypatch)
    model = admit_model(client, case, reference).json()
    route = f"/api/cases/{case['case_id']}/bone-lineup-registration"
    assert client.get(route).json()["current"] == {"status": "not_confirmed"}
    inputs = lineup(listed, model, aside="bone_not_held")
    response = put_lineup(client, case, reference, inputs)
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["registration_revision"] == 1
    current = saved["current"]
    assert current["status"] == "current"
    assert current["evidence"] == "verified"
    assert current["inputs"] == validate_lineup(inputs)
    result = current["result"]
    assert result["version"] == VERSION
    assert result["method"] == METHOD
    assert result["engine_method"] == "bone_edge_compass_v1"
    assert result["depth"] == "not_determined_single_view"
    assert result["second_view"] == "set_aside"
    assert result["validated"] is False
    assert result["rotation_deg"] == pytest.approx(3.0, abs=1e-3)
    # Reopened, the same record.
    assert client.get(route).json() == saved


def test_two_frame_lineup_needs_both_frames_far_apart_and_attested(tmp_path, monkeypatch):
    client, case, reference, listed, _ = ready(tmp_path, monkeypatch)
    model = admit_model(client, case, reference).json()
    good = lineup(listed, model, two=True)
    for change, why in (
        ({"same_position": False}, "attested"),
        ({"depth": "not_determined_single_view"}, "depth"),
        ({"engine_method": "bone_edge_compass_v1"}, "engine"),
    ):
        assert put_lineup(client, case, reference, {**good, **change}).status_code == 422, why
    close = copy.deepcopy(good)
    close["planes"][1]["view"]["primary_deg"] = 20.0
    assert put_lineup(client, case, reference, close).status_code == 422
    response = put_lineup(client, case, reference, good)
    assert response.status_code == 200, response.text
    result = response.json()["current"]["result"]
    assert result["depth"] == "two_views"
    assert result["plane_angle_deg"] == pytest.approx(90.0)
    assert result["same_position"] == "operator_attested_not_checked"


def test_lone_side_frame_is_refused():
    sha = "b" * 64
    inputs = {
        "confirmed": True,
        "method": METHOD,
        "engine_method": "bone_edge_compass_v1",
        "frame_source_id": "abdomen-01",
        "frame_manifest_revision": sha,
        "planes": [
            {
                "plane": "a",
                "frame_index": 0,
                "frame_sha256": sha,
                "geometry_source": "operator_entered",
                "view": dict(SIDE),
                "reported_score": 0.3,
            }
        ],
        "second_view": {"status": "not_given"},
        "depth": "not_determined_single_view",
        "model_revision": 1,
        "model_sha256": sha,
        "bone_threshold_hu": 250.0,
        "reported_start_score": 0.1,
        "isocenter": [0.0, 0.0, 0.0],
        "volume_to_carm_ras": IDENTITY,
        "same_position": False,
    }
    with pytest.raises(ValueError, match="lone side frame"):
        validate_lineup(inputs)
    assert beam_from_front_deg(SIDE, IDENTITY) == pytest.approx(90.0)
    assert beam_from_front_deg(FRONT, IDENTITY) == pytest.approx(0.0)
    # The pose carries the scan's front-to-back axis: a scan turned a
    # quarter turn about its long axis is seen from its side by a front beam.
    assert beam_from_front_deg(FRONT, turn_z(90.0)) == pytest.approx(90.0)
    validate_lineup({**inputs, "planes": [{**inputs["planes"][0], "view": dict(FRONT)}]})


def test_lineup_is_tied_to_the_model_and_frames(tmp_path, monkeypatch):
    client, case, reference, listed, directory = ready(tmp_path, monkeypatch)
    model = admit_model(client, case, reference).json()
    stale = lineup(listed, model, model_sha256="f" * 64)
    response = put_lineup(client, case, reference, stale)
    assert response.status_code == 422
    assert response.json()["detail"] == "Line-up does not match the admitted frames or the model"
    inputs = lineup(listed, model)
    assert put_lineup(client, case, reference, inputs).status_code == 200
    route = f"/api/cases/{case['case_id']}/bone-lineup-registration"
    # A new model revision leaves the saved line-up without its evidence.
    admit_model(client, case, reference, revision=1)
    assert client.get(route).json()["current"]["evidence"] == "unavailable"
    # A changed frame does the same, and a new save against it is refused.
    used = plane_entry(listed, "a", FRONT)["frame_index"]
    (directory / frame_filename("a", used)).write_bytes(b"\x00" * 10)
    model = client.get(f"/api/cases/{case['case_id']}/aortoiliac-model").json()
    response = put_lineup(client, case, reference, lineup(listed, model), revision=1)
    assert response.status_code == 422


def test_frame_absent_from_the_source_is_a_mismatch(tmp_path, monkeypatch):
    client, case, reference, listed, _ = ready(tmp_path, monkeypatch)
    model = admit_model(client, case, reference).json()
    inputs = lineup(listed, model)
    inputs["planes"][0]["frame_index"] = 9999
    response = put_lineup(client, case, reference, inputs)
    assert response.status_code == 422
    assert response.json()["detail"] == "Line-up does not match the admitted frames or the model"


def test_unreadable_store_is_not_reported_as_a_mismatch(tmp_path, monkeypatch):
    client, case, reference, listed, _ = ready(tmp_path, monkeypatch)
    model = admit_model(client, case, reference).json()
    inputs = lineup(listed, model)

    def locked(self, identity):
        raise sqlite3.OperationalError("database is locked")

    # The model ledger cannot be read at the save-time check.
    monkeypatch.setattr(ModelLedger, "current", locked)
    response = put_lineup(client, case, reference, inputs)
    assert response.status_code == 503
    assert response.json()["detail"] == "Line-up save could not be confirmed; reload"


def test_summary_is_derived_on_the_server():
    sha = "c" * 64
    inputs = {
        "confirmed": True,
        "method": METHOD,
        "engine_method": "bone_edge_compass_v1",
        "frame_source_id": "abdomen-01",
        "frame_manifest_revision": sha,
        "planes": [
            {
                "plane": "single",
                "frame_index": 0,
                "frame_sha256": sha,
                "geometry_source": "operator_entered",
                "view": dict(FRONT),
                "reported_score": 0.4,
            }
        ],
        "second_view": {"status": "not_given"},
        "depth": "not_determined_single_view",
        "model_revision": 1,
        "model_sha256": sha,
        "bone_threshold_hu": 250.0,
        "reported_start_score": 0.1,
        "isocenter": [0.0, 0.0, 0.0],
        "volume_to_carm_ras": turn_z(10.0, (3.0, 4.0, 0.0)),
        "same_position": False,
    }
    value = summarize(validate_lineup(inputs))
    assert value["rotation_deg"] == pytest.approx(10.0, abs=1e-3)
    assert value["isocenter_shift_mm"] == pytest.approx(5.0, abs=1e-3)
    assert value["score_source"] == "browser_reported_not_recomputed"
    with pytest.raises(ValueError):
        validate_lineup({**inputs, "confirmed": False})
