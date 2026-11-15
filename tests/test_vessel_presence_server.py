"""Operator-confirmed vessel-presence reports, bound to one saved registration."""

import copy
import json
import sqlite3
from contextlib import closing

import pytest
from test_projection_registration_server import body as registration_body
from test_projection_registration_server import pair_body, pair_ready, ready

from planner.frame_source import frame_filename
from planner.projection_plan import PlanConflict
from planner.vessel_presence import (
    CLASSES,
    PresenceLedger,
    classify,
    summarize,
    validate_presence,
)

# Three segments: two of one unbranched run, then one of another.
SEGMENTS = [
    {"length_mm": 12.5, "mean_radius_mm": 2.0, "sample_count": 13, "run": 0},
    {"length_mm": 12.5, "mean_radius_mm": 1.5, "sample_count": 12, "run": 0},
    {"length_mm": 7.25, "mean_radius_mm": 1.0, "sample_count": 8, "run": 1},
]
# Per segment: in the field, clear of other vessels, supported.
SEEN = [
    {"presence": "supported", "in_field": 13, "clear": 10, "supported": 9},
    {"presence": "no_2d_support", "in_field": 12, "clear": 10, "supported": 1},
    {"presence": "outside_field", "in_field": 3, "clear": 3, "supported": 3},
]
OTHER = [
    {"presence": "indeterminate", "in_field": 13, "clear": 2, "supported": 2},
    {"presence": "supported", "in_field": 12, "clear": 12, "supported": 12},
    {"presence": "indeterminate", "in_field": 8, "clear": 8, "supported": 4},
]


def saved_registration(client, case, reference, mask, listed, pair=False, revision=0):
    route = f"/api/cases/{case['case_id']}/projection-registration"
    make = pair_body if pair else registration_body
    response = client.put(route, json=make(case, reference, mask, listed, revision))
    assert response.status_code == 200, response.text
    return response.json()


def report(registration, **change):
    current = registration["current"]
    entries = current["inputs"].get("planes") or [current["inputs"]]
    return {
        "confirmed": True,
        "registration_id": current["registration_id"],
        "registration_revision": registration["registration_revision"],
        "registration_input_sha256": current["input_sha256"],
        "method": "segment_centerline_support_v1",
        "segment_method": "mask_band_sweep_v1",
        "pooling": 1,
        "unassigned_fraction": 0.0125,
        "segments": copy.deepcopy(SEGMENTS),
        "planes": [
            {
                "plane": entry["plane"],
                "frame_sha256": entry["frame_sha256"],
                "segments": copy.deepcopy(SEEN if position == 0 else OTHER),
                "unmatched_mm": [21.5, 6.0] if position == 0 else [],
            }
            for position, entry in enumerate(entries)
        ],
        **change,
    }


def request(case, reference, registration, revision=0, **change):
    return {
        "artifact_version": case["artifact_version"],
        "reference_revision": reference,
        "report_revision": revision,
        "inputs": report(registration, **change),
    }


def with_plane(registration, position=0, **change):
    """Report inputs with one plane's entry changed."""
    planes = report(registration)["planes"]
    planes[position] = {**planes[position], **change}
    return {"planes": planes}


def with_entry(registration, index, **change):
    """Report inputs with one segment's entry in the first plane changed."""
    segments = copy.deepcopy(SEEN)
    segments[index] = {**segments[index], **change}
    return with_plane(registration, segments=segments)


def started(tmp_path, monkeypatch, pair=False):
    client, case, reference, mask, listed, directory = (pair_ready if pair else ready)(
        tmp_path, monkeypatch
    )
    registration = saved_registration(client, case, reference, mask, listed, pair)
    route = f"/api/cases/{case['case_id']}/vessel-presence"
    return client, case, reference, mask, listed, directory, registration, route


def test_the_class_follows_from_the_counts():
    # (samples, in the field, clear, supported)
    for counts, expected in (
        ((10, 4, 4, 4), "outside_field"),
        ((10, 5, 5, 5), "supported"),  # exactly half is inside
        ((10, 0, 0, 0), "outside_field"),
        ((0, 0, 0, 0), "indeterminate"),
        ((10, 10, 2, 2), "indeterminate"),  # too few clear samples
        ((10, 10, 3, 3), "supported"),
        ((20, 20, 5, 5), "indeterminate"),  # under three in ten are clear
        ((20, 20, 6, 6), "supported"),
        ((10, 10, 10, 7), "supported"),
        ((10, 10, 10, 6), "indeterminate"),
        ((10, 10, 10, 4), "indeterminate"),
        ((10, 10, 10, 3), "no_2d_support"),
        ((10, 10, 10, 0), "no_2d_support"),
    ):
        assert classify(*counts) == expected, counts
    assert CLASSES == ("supported", "no_2d_support", "outside_field", "indeterminate")


def test_confirmed_report_roundtrips_with_known_values(tmp_path, monkeypatch):
    client, case, reference, _, _, _, registration, route = started(tmp_path, monkeypatch)
    empty = client.get(route)
    assert empty.status_code == 200, empty.text
    assert empty.json()["report_revision"] == 0
    assert empty.json()["registration_revision"] == 1
    assert empty.json()["current"] == {"status": "not_confirmed"}
    sent = request(case, reference, registration)
    response = client.put(route, json=sent)
    assert response.status_code == 200, response.text
    assert response.headers["Cache-Control"] == "no-store"
    saved = response.json()
    assert saved["report_revision"] == 1
    current = saved["current"]
    assert current["status"] == "current"
    assert current["inputs"] == sent["inputs"]
    assert current["dependencies"] == {
        "case_id": case["case_id"],
        "image_sha256": case["image_sha256"],
        "artifact_version": case["artifact_version"],
        "reference_revision": reference,
        "version": "step-c3-vessel-presence-v1",
        "registration_id": registration["current"]["registration_id"],
        "registration_revision": 1,
        "registration_input_sha256": registration["current"]["input_sha256"],
    }
    assert current["result"] == {
        "version": "step-c3-vessel-presence-v1",
        "method": "segment_centerline_support_v1",
        "segment_method": "mask_band_sweep_v1",
        "status": "operator_confirmed_report",
        "validated": False,
        "cause": "not_asserted",
        "counts_source": "browser_reported_not_recomputed",
        "segment_count": 3,
        "segment_length_mm": 32.25,
        "unassigned_fraction": 0.0125,
        "planes": [
            {
                "plane": "single",
                "classes": {
                    "supported": {"count": 1, "length_mm": 12.5},
                    "no_2d_support": {"count": 1, "length_mm": 12.5},
                    "outside_field": {"count": 1, "length_mm": 7.25},
                    "indeterminate": {"count": 0, "length_mm": 0.0},
                },
                "unmatched_count": 2,
                "unmatched_length_mm": 27.5,
            }
        ],
    }
    assert client.get(route).json() == saved
    # Each confirmation is a new immutable row.
    again = client.put(route, json=request(case, reference, registration, 1, pooling=2))
    assert again.status_code == 200 and again.json()["report_revision"] == 2
    with closing(sqlite3.connect(tmp_path.resolve() / "case.sqlite3")) as conn:
        assert conn.execute("SELECT COUNT(*) FROM vessel_presence_reports").fetchone()[0] == 2


def test_a_two_plane_report_classes_every_segment_in_both_planes(tmp_path, monkeypatch):
    client, case, reference, _, _, _, registration, route = started(tmp_path, monkeypatch, True)
    response = client.put(route, json=request(case, reference, registration))
    assert response.status_code == 200, response.text
    planes = response.json()["current"]["result"]["planes"]
    assert [plane["plane"] for plane in planes] == ["a", "b"]
    assert planes[1]["classes"] == {
        "supported": {"count": 1, "length_mm": 12.5},
        "no_2d_support": {"count": 0, "length_mm": 0.0},
        "outside_field": {"count": 0, "length_mm": 0.0},
        "indeterminate": {"count": 2, "length_mm": 19.75},
    }
    assert planes[1]["unmatched_count"] == 0 and planes[1]["unmatched_length_mm"] == 0.0
    # One plane of a two-plane registration is not a report on it.
    one = report(registration)["planes"][:1]
    assert (
        client.put(route, json=request(case, reference, registration, 1, planes=one)).status_code
        == 422
    )
    swapped = report(registration)["planes"][::-1]
    assert (
        client.put(
            route, json=request(case, reference, registration, 1, planes=swapped)
        ).status_code
        == 422
    )


SHAPE_CHANGES = [
    lambda r: {"confirmed": False},
    lambda r: {"confirmed": "true"},
    lambda r: {"confirmed": 1},
    lambda r: {"method": "other"},
    lambda r: {"segment_method": "named_arteries"},
    lambda r: {"pooling": 0},
    lambda r: {"pooling": 9},
    lambda r: {"pooling": 1.0},
    lambda r: {"unassigned_fraction": 1.5},
    lambda r: {"unassigned_fraction": -0.1},
    lambda r: {"registration_id": "short"},
    lambda r: {"registration_revision": 0},
    lambda r: {"registration_input_sha256": "A" * 64},
    lambda r: {"segments": []},
    lambda r: {"segments": [{**SEGMENTS[0], "name": "M1"}, *SEGMENTS[1:]]},
    lambda r: {"segments": [{**SEGMENTS[0], "length_mm": 0.0}, *SEGMENTS[1:]]},
    lambda r: {"segments": [{**SEGMENTS[0], "length_mm": 10000.5}, *SEGMENTS[1:]]},
    lambda r: {"segments": [{**SEGMENTS[0], "mean_radius_mm": 0.0}, *SEGMENTS[1:]]},
    lambda r: {"segments": [{**SEGMENTS[0], "mean_radius_mm": 100.5}, *SEGMENTS[1:]]},
    lambda r: {"segments": [{**SEGMENTS[0], "sample_count": -1}, *SEGMENTS[1:]]},
    lambda r: {"segments": [{**SEGMENTS[0], "sample_count": 13.0}, *SEGMENTS[1:]]},
    # Runs are numbered from zero in listing order, without gaps.
    lambda r: {"segments": [{**SEGMENTS[0], "run": 1}, *SEGMENTS[1:]]},
    lambda r: {"segments": [*SEGMENTS[:2], {**SEGMENTS[2], "run": 2}]},
    lambda r: {"segments": [*SEGMENTS[:2], {**SEGMENTS[2], "run": 0}, {**SEGMENTS[2], "run": 1}]},
    lambda r: {"segments": SEGMENTS[:2]},  # the plane classes three
    lambda r: {"planes": []},
    lambda r: {"planes": report(r)["planes"] * 3},
    lambda r: with_plane(r, plane="c"),
    lambda r: with_plane(r, frame_sha256="0" * 63),
    lambda r: with_plane(r, segments=SEEN[:2]),
    lambda r: with_plane(r, segments=[]),
    lambda r: with_plane(r, pixels=[1, 2, 3]),
    lambda r: with_plane(r, unmatched_mm=[6.0, 21.5]),  # not longest first
    lambda r: with_plane(r, unmatched_mm=[21.5, 4.9]),  # shorter than a listed piece can be
    lambda r: with_plane(r, unmatched_mm=[10000.5]),
    lambda r: with_plane(r, unmatched_mm=[6.0] * 2001),
    lambda r: with_entry(r, 0, presence="present"),
    lambda r: with_entry(r, 0, presence="occluded"),
    lambda r: with_entry(r, 0, cause="occlusion"),
    # Counts that cannot be: more supported than clear, more clear than in the
    # field, more in the field than the segment has samples.
    lambda r: with_entry(r, 0, supported=11),
    lambda r: with_entry(r, 0, clear=14),
    lambda r: with_entry(r, 0, in_field=14),
    lambda r: with_entry(r, 0, in_field=-1),
    lambda r: with_entry(r, 0, clear=10.0),
    # A class its counts do not give.
    lambda r: with_entry(r, 0, presence="no_2d_support"),
    lambda r: with_entry(r, 0, presence="indeterminate"),
    lambda r: with_entry(r, 1, presence="supported"),
    lambda r: with_entry(r, 2, presence="supported"),
    lambda r: with_entry(r, 0, supported=6),  # 6 of 10 is indeterminate
    lambda r: with_entry(r, 1, supported=4),
    lambda r: {"note": "validated"},
    lambda r: {"volume_to_carm_ras": [[1.0, 0, 0, 0]]},
]


@pytest.mark.parametrize("position", range(len(SHAPE_CHANGES)))
def test_shape_and_consistency_rejections_do_not_store(tmp_path, monkeypatch, position):
    client, case, reference, _, _, _, registration, route = started(tmp_path, monkeypatch)
    change = SHAPE_CHANGES[position](registration)
    response = client.put(route, json=request(case, reference, registration, **change))
    assert response.status_code == 422, response.text
    assert client.get(route).json()["report_revision"] == 0


def test_count_and_class_bounds_are_inclusive(tmp_path, monkeypatch):
    client, case, reference, _, _, _, registration, route = started(tmp_path, monkeypatch)
    edges = [
        # Seven of ten supported, three of ten supported, half in the field.
        {"presence": "supported", "in_field": 13, "clear": 10, "supported": 7},
        {"presence": "no_2d_support", "in_field": 12, "clear": 10, "supported": 3},
        {"presence": "supported", "in_field": 4, "clear": 4, "supported": 4},
    ]
    change = {
        **with_plane(registration, segments=edges, unmatched_mm=[5.0, 5.0]),
        "unassigned_fraction": 1.0,
        "pooling": 8,
    }
    response = client.put(route, json=request(case, reference, registration, **change))
    assert response.status_code == 200, response.text
    classes = response.json()["current"]["result"]["planes"][0]["classes"]
    assert classes["supported"]["count"] == 2 and classes["no_2d_support"]["count"] == 1


def test_a_report_must_name_the_current_registration(tmp_path, monkeypatch):
    client, case, reference, mask, listed, _, registration, route = started(tmp_path, monkeypatch)
    for change in (
        {"registration_id": "A" * 22},
        {"registration_input_sha256": "0" * 64},
        with_plane(registration, plane="a"),
        with_plane(registration, frame_sha256="0" * 64),
    ):
        response = client.put(route, json=request(case, reference, registration, **change))
        assert response.status_code == 422, change
        assert "current registration" in response.json()["detail"]
    # Another revision is a conflict: the operator reloads.
    assert (
        client.put(
            route, json=request(case, reference, registration, registration_revision=2)
        ).status_code
        == 409
    )
    assert client.get(route).json()["report_revision"] == 0
    assert client.put(route, json=request(case, reference, registration)).status_code == 200
    # A new registration makes the saved report stale, and the old one cannot be reported on.
    newer = saved_registration(client, case, reference, mask, listed, revision=1)
    stale = client.get(route).json()
    assert stale["report_revision"] == 1 and stale["registration_revision"] == 2
    assert stale["current"]["status"] == "stale"
    assert stale["current"]["inputs"] is None and stale["current"]["result"] is None
    assert client.put(route, json=request(case, reference, registration, 1)).status_code == 409
    fresh = client.put(route, json=request(case, reference, newer, 1))
    assert fresh.status_code == 200, fresh.text
    assert fresh.json()["current"]["status"] == "current"
    assert fresh.json()["current"]["dependencies"]["registration_revision"] == 2


def test_there_is_no_report_without_a_registration(tmp_path, monkeypatch):
    client, case, reference, mask, listed, _ = ready(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/vessel-presence"
    assert client.get(route).json()["current"] == {"status": "not_confirmed"}
    registration = saved_registration(client, case, reference, mask, listed)
    with closing(sqlite3.connect(tmp_path.resolve() / "case.sqlite3")) as conn, conn:
        conn.execute("DELETE FROM projection_registrations")
    response = client.put(route, json=request(case, reference, registration))
    assert response.status_code == 409, response.text
    assert client.get(route).json()["report_revision"] == 0


def test_stale_source_and_revision_conflicts(tmp_path, monkeypatch):
    client, case, reference, _, _, _, registration, route = started(tmp_path, monkeypatch)
    assert client.put(route, json=request(case, "0" * 64, registration)).status_code == 409
    wrong_version = request(case, reference, registration)
    wrong_version["artifact_version"] = str(int(case["artifact_version"]) + 1)
    assert client.put(route, json=wrong_version).status_code == 409
    assert client.put(route, json=request(case, reference, registration, 3)).status_code == 409
    assert client.get(route).json()["report_revision"] == 0
    assert client.put(route, json=request(case, reference, registration)).status_code == 200
    # A replay of the same revision is refused.
    assert client.put(route, json=request(case, reference, registration)).status_code == 409
    note = client.patch(
        f"/api/cases/{case['case_id']}/notes",
        json={"artifact_version": case["artifact_version"], "notes": "revision"},
    )
    assert note.status_code == 200, note.text
    stale = client.get(route).json()
    assert stale["report_revision"] == 1
    assert stale["current"]["status"] == "stale"
    assert stale["current"]["inputs"] is None and stale["current"]["result"] is None


def test_a_report_needs_the_frame_on_hand(tmp_path, monkeypatch):
    client, case, reference, _, _, directory, registration, route = started(tmp_path, monkeypatch)
    target = directory / frame_filename("single", 3)
    original = target.read_bytes()
    target.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
    response = client.put(route, json=request(case, reference, registration))
    assert response.status_code == 422, response.text
    assert "unavailable" in response.json()["detail"]
    target.write_bytes(original)
    assert client.put(route, json=request(case, reference, registration)).status_code == 200
    # A saved report stays readable when the frame is later lost.
    target.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
    assert client.get(route).json()["current"]["status"] == "current"


def test_the_ledger_refuses_what_the_database_no_longer_backs(tmp_path, monkeypatch):
    client, case, reference, mask, listed, _, registration, _ = started(tmp_path, monkeypatch)
    ledger = PresenceLedger(tmp_path.resolve() / "case.sqlite3")
    identity = {
        "case_id": case["case_id"],
        "image_sha256": case["image_sha256"],
        "artifact_version": case["artifact_version"],
        "reference_revision": reference,
    }
    for wrong in (
        {**identity, "case_id": "missing"},
        {**identity, "image_sha256": "0" * 64},
        {**identity, "artifact_version": "999"},
    ):
        with pytest.raises(PlanConflict, match="Case changed"):
            ledger.save(wrong, 0, report(registration))
    # The registration is checked inside the write transaction.
    saved_registration(client, case, reference, mask, listed, revision=1)
    with pytest.raises(PlanConflict, match="Projection registration changed"):
        ledger.save(identity, 0, report(registration))
    with pytest.raises(ValueError, match="Class contradicts its counts"):
        ledger.save(identity, 0, report(registration, **with_entry(registration, 0, supported=6)))


def test_tampered_stored_report_fails_closed(tmp_path, monkeypatch):
    client, case, reference, _, _, _, registration, route = started(tmp_path, monkeypatch)
    assert client.put(route, json=request(case, reference, registration)).status_code == 200
    database = tmp_path.resolve() / "case.sqlite3"

    def reclassed(value):
        value["planes"][0]["segments"][1] = SEEN[0]
        return value

    def renamed(value):
        value["planes"][0]["frame_sha256"] = "0" * 64
        return value

    for column, edit in (
        ("result", lambda value: {**value, "validated": True}),
        ("result", lambda value: {**value, "cause": "occlusion"}),
        ("result", lambda value: {**value, "segment_count": 4}),
        ("inputs", lambda value: {**value, "pooling": 2}),
        ("inputs", lambda value: {**value, "confirmed": False}),
        ("inputs", reclassed),
        ("inputs", renamed),
        ("inputs", lambda value: {**value, "registration_id": "A" * 22}),
        ("inputs", lambda value: [value]),
        ("inputs", lambda value: None),
        ("result", lambda value: None),
        ("input_sha256", lambda value: "0" * 64),
        ("report_revision", lambda value: 0),
    ):
        with closing(sqlite3.connect(database)) as conn, conn:
            original = conn.execute(f"SELECT {column} FROM vessel_presence_reports").fetchone()[0]
            decoded = json.loads(original) if column in ("inputs", "result") else original
            changed = edit(decoded)
            conn.execute(
                f"UPDATE vessel_presence_reports SET {column}=?",
                (json.dumps(changed) if column in ("inputs", "result") else changed,),
            )
        response = client.get(route)
        assert response.status_code == 503, (column, response.text)
        assert "validated" not in response.text and "occlusion" not in response.text
        brief = client.get(f"/api/cases/{case['case_id']}/local-brief")
        assert brief.status_code == 503, column
        with closing(sqlite3.connect(database)) as conn, conn:
            conn.execute(f"UPDATE vessel_presence_reports SET {column}=?", (original,))
    assert client.get(route).status_code == 200
    # A stored row nested too deeply to decode.
    with closing(sqlite3.connect(database)) as conn, conn:
        conn.execute("UPDATE vessel_presence_reports SET inputs=?", ("[" * 100_000,))
    assert client.get(route).status_code == 503
    # Dependencies that are not this report's read as a stale report, not as a current one.
    with closing(sqlite3.connect(database)) as conn, conn:
        conn.execute("UPDATE vessel_presence_reports SET dependencies=?", ("[]",))
    assert client.get(route).json()["current"]["status"] == "stale"


@pytest.mark.parametrize("payload", [b"", b"[]", b"{", b'{"inputs": null}'])
def test_malformed_and_oversized_bodies_are_rejected(tmp_path, monkeypatch, payload):
    client, _, _, _, _, _, _, route = started(tmp_path, monkeypatch)
    headers = {"Content-Type": "application/json"}
    assert client.put(route, content=payload, headers=headers).status_code == 422
    assert client.put(route, content=b" " * 1_048_577, headers=headers).status_code == 413
    assert client.get(route).json()["report_revision"] == 0


def test_the_largest_report_fits_the_body_bound(tmp_path, monkeypatch):
    client, case, reference, _, _, _, registration, route = started(tmp_path, monkeypatch, True)
    count = 2000
    segments = [
        {
            "length_mm": 14.123456789012,
            "mean_radius_mm": 1.123456789012,
            "sample_count": 15,
            "run": k,
        }
        for k in range(count)
    ]
    entry = {"presence": "indeterminate", "in_field": 15, "clear": 10, "supported": 5}
    planes = [
        {**plane, "segments": [entry] * count, "unmatched_mm": [123.456789012345] * 2000}
        for plane in report(registration)["planes"]
    ]
    sent = request(case, reference, registration, segments=segments, planes=planes)
    assert len(json.dumps(sent)) < 1_048_576
    response = client.put(route, json=sent)
    assert response.status_code == 200, response.text
    result = response.json()["current"]["result"]
    assert result["segment_count"] == count
    assert result["planes"][0]["classes"]["indeterminate"]["count"] == count
    too_many = [*segments, {**segments[0], "run": count - 1}]
    assert (
        client.put(
            route, json=request(case, reference, registration, 1, segments=too_many)
        ).status_code
        == 422
    )


def test_summaries_and_validation_do_not_depend_on_the_route():
    registration = {
        "registration_revision": 4,
        "current": {
            "registration_id": "r" * 22,
            "input_sha256": "1" * 64,
            "inputs": {"plane": "a", "frame_sha256": "2" * 64},
        },
    }
    value = validate_presence(report(registration))
    assert value["planes"][0]["plane"] == "a"
    assert summarize(value)["planes"][0]["classes"]["supported"] == {"count": 1, "length_mm": 12.5}
    with pytest.raises(ValueError, match="Segment runs are out of order"):
        validate_presence(report(registration, segments=[{**SEGMENTS[0], "run": 1}, *SEGMENTS[1:]]))
    with pytest.raises(ValueError, match="Impossible sample counts"):
        validate_presence(report(registration, **with_entry(registration, 0, supported=11)))
    with pytest.raises(ValueError, match="Every plane classes every segment"):
        validate_presence(report(registration, segments=SEGMENTS[:2]))
    with pytest.raises(ValueError, match="longest first"):
        validate_presence(report(registration, **with_plane(registration, unmatched_mm=[6.0, 7.0])))
    doubled = report(registration)["planes"] * 2
    with pytest.raises(ValueError, match="one plane, or plane a then plane b"):
        validate_presence(report(registration, planes=doubled))


# The brief section.


def test_local_brief_reports_registration_and_presence_without_coordinates(tmp_path, monkeypatch):
    client, case, reference, mask, listed, directory = pair_ready(tmp_path, monkeypatch)
    base = f"/api/cases/{case['case_id']}"
    absent = client.get(base + "/local-brief")
    assert absent.status_code == 200, absent.text
    assert absent.json()["angiogram_fusion"] == {
        "status": "read",
        "registration": {"status": "not_confirmed", "registration_revision": 0},
        "vessel_presence": {"status": "not_confirmed", "report_revision": 0},
    }
    assert "## Angiogram registration and vessel presence" in absent.json()["markdown"]
    assert "No current confirmed registration is included." in absent.json()["markdown"]
    registration = saved_registration(client, case, reference, mask, listed, pair=True)
    registered = client.get(base + "/local-brief").json()
    assert registered["angiogram_fusion"]["registration"] == {
        "status": "current",
        "registration_revision": 1,
        "registration_id": registration["current"]["registration_id"],
        "input_sha256": registration["current"]["input_sha256"],
        "version": "step-c2-biplane-registration-v2",
        "method": "centerline_distance_compass_biplane_v1",
        "validated": False,
        "evidence": "verified",
        "same_position": "operator_attested_not_checked",
        "plane_angle_deg": 90.0,
        "planes": [
            {"plane": "a", "geometry_source": "operator_entered"},
            {"plane": "b", "geometry_source": "operator_entered"},
        ],
    }
    assert "- Planes: two, 90.0 degrees apart" in registered["markdown"]
    assert "attested by the operator, not checked" in registered["markdown"]
    assert "not a validated registration" in registered["markdown"]
    assert "No current confirmed vessel presence report is included." in registered["markdown"]
    saved = client.put(base + "/vessel-presence", json=request(case, reference, registration))
    assert saved.status_code == 200, saved.text
    response = client.get(base + "/local-brief")
    assert response.status_code == 200, response.text
    presence = response.json()["angiogram_fusion"]["vessel_presence"]
    # Closed scalar projection: a new key cannot reach the export unreviewed.
    assert presence == {
        "status": "current",
        "report_revision": 1,
        "report_id": saved.json()["current"]["report_id"],
        "input_sha256": saved.json()["current"]["input_sha256"],
        **{k: v for k, v in saved.json()["current"]["result"].items() if k != "status"},
    }
    assert set(presence) == {
        "status",
        "report_revision",
        "report_id",
        "input_sha256",
        "version",
        "method",
        "segment_method",
        "validated",
        "cause",
        "counts_source",
        "segment_count",
        "segment_length_mm",
        "unassigned_fraction",
        "planes",
    }
    assert all(
        set(plane) == {"plane", "classes", "unmatched_count", "unmatched_length_mm"}
        for plane in presence["planes"]
    )
    markdown = response.json()["markdown"]
    for line in (
        "- Segments: 3, 32.3 mm in all, unnamed",
        "- Mask volume in no segment: 1.3%",
        "#### Plane `a`",
        "- 2D support: 1 segments, 12.5 mm",
        "- No 2D support: 1 segments, 12.5 mm",
        "- Outside the field: 1 segments, 7.3 mm",
        "- Indeterminate: 0 segments, 0.0 mm",
        "- 2D vessel pieces with no segment near: 2, 27.5 mm",
        "#### Plane `b`",
        "- Indeterminate: 2 segments, 19.8 mm",
        "No cause is asserted",
    ):
        assert line in markdown, line
    section = markdown[markdown.index("## Angiogram registration") :]
    section = section[: section.index("## Saved device alternatives")]
    for forbidden in (
        "isocenter",
        "volume_to_carm",
        "frame_sha256",
        "reported_score",
        "matched_fraction",
        "in_field",
        "sample_count",
        registration["current"]["inputs"]["planes"][0]["frame_sha256"],
    ):
        assert forbidden not in section, forbidden
        assert forbidden not in json.dumps(response.json()["angiogram_fusion"]), forbidden
    # A lost frame is reported with the registration and does not hide the saved report.
    second = registration["current"]["inputs"]["planes"][1]
    target = directory / frame_filename("b", second["frame_index"])
    original = target.read_bytes()
    target.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
    lost = client.get(base + "/local-brief").json()
    assert lost["angiogram_fusion"]["registration"]["evidence"] == "unavailable"
    assert "- Frame and mask on hand: unavailable" in lost["markdown"]
    assert lost["angiogram_fusion"]["vessel_presence"]["status"] == "current"
    target.write_bytes(original)
    # A newer registration leaves the report stale and its counts out.
    saved_registration(client, case, reference, mask, listed, pair=True, revision=1)
    stale = client.get(base + "/local-brief").json()
    assert stale["angiogram_fusion"]["vessel_presence"] == {
        "status": "stale",
        "report_revision": 1,
        "report_id": presence["report_id"],
    }
    assert "No current confirmed vessel presence report is included." in stale["markdown"]
    assert "#### Plane" not in stale["markdown"]
    # A changed case leaves both stale.
    notes = client.patch(
        base + "/notes", json={"notes": "changed", "artifact_version": case["artifact_version"]}
    )
    assert notes.status_code == 200, notes.text
    changed = client.get(base + "/local-brief").json()["angiogram_fusion"]
    assert changed["registration"]["status"] == "stale"
    assert set(changed["registration"]) == {"status", "registration_revision", "registration_id"}
    assert changed["vessel_presence"]["status"] == "stale"


def test_local_brief_of_a_single_plane_registration(tmp_path, monkeypatch):
    client, case, reference, _, _, _, registration, route = started(tmp_path, monkeypatch)
    assert client.put(route, json=request(case, reference, registration)).status_code == 200
    brief = client.get(f"/api/cases/{case['case_id']}/local-brief").json()
    assert set(brief["angiogram_fusion"]["registration"]) == {
        "status",
        "registration_revision",
        "registration_id",
        "input_sha256",
        "version",
        "method",
        "validated",
        "evidence",
        "planes",
    }
    assert "- Planes: one" in brief["markdown"]
    assert "- Plane `single` geometry: operator entered" in brief["markdown"]
    assert "#### Plane `single`" in brief["markdown"]


def test_local_brief_fails_closed_on_a_tampered_registration(tmp_path, monkeypatch):
    client, case, reference, _, _, _, registration, route = started(tmp_path, monkeypatch)
    assert client.put(route, json=request(case, reference, registration)).status_code == 200
    with closing(sqlite3.connect(tmp_path.resolve() / "case.sqlite3")) as conn, conn:
        conn.execute("UPDATE projection_registrations SET input_sha256=?", ("0" * 64,))
    response = client.get(f"/api/cases/{case['case_id']}/local-brief")
    assert response.status_code == 503
    assert "markdown" not in response.json()
