"""The CT coronary tree and its confirmed correspondence with a paired cine,
on a generated native source."""

import copy
import math

import pytest
from test_territory_workflow_server import configured

from planner.coronary_correspondence import (
    METHOD,
    TREE_METHOD,
    TREE_VERSION,
    VERSION,
    TreeLedger,
    validate_correspondence,
    validate_tree,
)

VIEW = {
    "primary_deg": -30.0,
    "secondary_deg": 20.0,
    "source_detector_mm": 1100.0,
    "source_isocenter_mm": 750.0,
    "detector_width_mm": 250.0,
    "detector_height_mm": 250.0,
}
CINE = "c" * 64
BUNDLE = "d" * 64


def turn_z(degrees, shift=(0.0, 0.0, 0.0)):
    c, s = math.cos(math.radians(degrees)), math.sin(math.radians(degrees))
    return [[c, -s, 0.0, shift[0]], [s, c, 0.0, shift[1]], [0.0, 0.0, 1.0, shift[2]], [0, 0, 0, 1]]


def tree(source, **change):
    """A small left tree inside the 32 mm cube."""
    lm = [[16.0, 16.0, 26.0 - k] for k in range(4)]
    lad = [[16.0 + k, 16.0, 22.0 - 2 * k] for k in range(6)]
    lcx = [[16.0 - k, 16.0 + k, 22.0 - k] for k in range(6)]
    return {
        "source_sha256": source,
        "method": TREE_METHOD,
        "provenance": "curated_annotation",
        "spatial_units": "mm",
        "ct_phase_percent": 75.0,
        "operator_confirmation_required": True,
        "branches": [
            {"id": "lm", "label": "left main", "parent": None, "path_ras": lm},
            {"id": "lad", "label": "anterior descending", "parent": "lm", "path_ras": lad},
            {"id": "lcx", "label": "circumflex", "parent": "lm", "path_ras": lcx},
        ],
        **change,
    }


def admit_tree(client, case, reference, revision=0, **change):
    return client.put(
        f"/api/cases/{case['case_id']}/coronary-tree",
        json={
            "artifact_version": case["artifact_version"],
            "reference_revision": reference,
            "tree_revision": revision,
            "export": tree(case["image_sha256"], **change),
        },
    )


def inputs(current, **change):
    value = {
        "confirmed": True,
        "method": METHOD,
        "pair": {
            "stated_by": "operator",
            "tree_revision": current["tree_revision"],
            "tree_sha256": current["current"]["body_sha256"],
            "cine_source_sha256": CINE,
            "cine_bundle_sha256": BUNDLE,
        },
        "phase": {
            "method": "cine_heart_period_v2",
            "ct_phase_percent": 75.0,
            "period_ms": 860.0,
            "quiet_frames": [8, 21, 34],
            "frame": 21,
        },
        "view": dict(VIEW),
        "ct_to_carm_ras": turn_z(4.0, (2.0, -3.0, 5.0)),
        "reported_fit_score": 0.62,
        "branches": [
            {"id": "lm", "status": "matched", "reported_score": 0.7},
            {"id": "lad", "status": "matched", "reported_score": 0.66},
            {"id": "lcx", "status": "ambiguous", "reported_score": 0.5},
        ],
        "motion": {
            "method": "coronary_tree_tracking_v1",
            "frames": 64,
            "followed": 50,
            "refused": 13,
        },
        "clinical_validation": False,
    }
    for key, part in change.items():
        if isinstance(part, dict) and isinstance(value.get(key), dict):
            value[key] = {**value[key], **part}
        else:
            value[key] = part
    return value


def ready(tmp_path, monkeypatch):
    client, case, reference = configured(tmp_path, monkeypatch)
    assert admit_tree(client, case, reference).status_code == 200
    current = client.get(f"/api/cases/{case['case_id']}/coronary-tree").json()
    return client, case, reference, current


def confirm(client, case, reference, body, revision=0):
    return client.put(
        f"/api/cases/{case['case_id']}/coronary-correspondence",
        json={
            "artifact_version": case["artifact_version"],
            "reference_revision": reference,
            "correspondence_revision": revision,
            "inputs": body,
        },
    )


# The tree.


def test_a_tree_from_this_scan_is_admitted_and_bound(tmp_path, monkeypatch):
    client, case, reference = configured(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/coronary-tree"
    empty = client.get(route).json()
    assert empty["tree_revision"] == 0 and empty["current"] == {"status": "not_confirmed"}
    saved = admit_tree(client, case, reference)
    assert saved.status_code == 200
    body = saved.json()
    assert body["tree_revision"] == 1
    assert body["image_sha256"] == case["image_sha256"]
    assert body["current"]["status"] == "current"
    assert body["current"]["body"]["provenance"] == "curated_annotation"
    assert len(body["current"]["body_sha256"]) == 64
    assert saved.headers["cache-control"] == "no-store"


def test_a_tree_from_another_scan_is_refused(tmp_path, monkeypatch):
    client, case, reference = configured(tmp_path, monkeypatch)
    refused = admit_tree(client, case, reference, source_sha256="e" * 64)
    assert refused.status_code == 422
    assert refused.json()["detail"] == "The tree was made from another scan"


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"ct_phase_percent": 100.0}, "Invalid tree"),
        ({"provenance": "guessed"}, "Invalid tree"),
        ({"branches": []}, "Invalid tree"),
    ],
)
def test_malformed_trees_are_refused(tmp_path, monkeypatch, change, message):
    client, case, reference = configured(tmp_path, monkeypatch)
    refused = admit_tree(client, case, reference, **change)
    assert refused.status_code == 422
    assert refused.json()["detail"] == message


def test_branch_names_are_each_once_and_parents_are_in_the_tree():
    value = tree("a" * 64)
    twice = copy.deepcopy(value)
    twice["branches"][2]["id"] = "lad"
    with pytest.raises(ValueError, match="The tree names each branch once"):
        validate_tree(twice, "a" * 64)
    orphan = copy.deepcopy(value)
    orphan["branches"][1]["parent"] = "rca"
    with pytest.raises(ValueError, match="A branch's parent is in the tree"):
        validate_tree(orphan, "a" * 64)
    loop = copy.deepcopy(value)
    loop["branches"][0]["parent"] = "lad"
    with pytest.raises(ValueError, match="The tree has one root and no loop"):
        validate_tree(loop, "a" * 64)


def test_a_tree_leaving_the_scan_is_refused(tmp_path, monkeypatch):
    client, case, reference = configured(tmp_path, monkeypatch)
    value = tree(case["image_sha256"])
    value["branches"][1]["path_ras"][-1] = [16.0, 16.0, 400.0]
    refused = client.put(
        f"/api/cases/{case['case_id']}/coronary-tree",
        json={
            "artifact_version": case["artifact_version"],
            "reference_revision": reference,
            "tree_revision": 0,
            "export": value,
        },
    )
    assert refused.status_code == 422
    assert refused.json()["detail"] == "The tree leaves the scan"


def test_a_stale_tree_revision_is_a_conflict(tmp_path, monkeypatch):
    client, case, reference, _ = ready(tmp_path, monkeypatch)
    again = admit_tree(client, case, reference, revision=0)
    assert again.status_code == 409


def test_the_ledger_names_its_version():
    assert TreeLedger.version == TREE_VERSION


# The confirmed correspondence.


def test_a_confirmed_correspondence_is_saved_against_the_current_tree(tmp_path, monkeypatch):
    client, case, reference, current = ready(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/coronary-correspondence"
    assert client.get(route).json()["current"] == {"status": "not_confirmed"}
    saved = confirm(client, case, reference, inputs(current))
    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert body["correspondence_revision"] == 1
    record = body["current"]
    assert record["status"] == "current"
    assert record["evidence"] == "verified"
    assert record["inputs"]["pair"]["cine_source_sha256"] == CINE
    assert record["result"] == {
        "branches": 3,
        "matched": ["lm", "lad"],
        "not_matched": {"lcx": "ambiguous"},
        "followed_frames": 50,
        "refused_frames": 13,
        "cine": "held_in_the_browser_not_verified_here",
        "clinical_validation": False,
    }
    assert saved.headers["cache-control"] == "no-store"


def test_a_pair_for_another_tree_is_refused(tmp_path, monkeypatch):
    client, case, reference, current = ready(tmp_path, monkeypatch)
    body = inputs(current)
    body["pair"]["tree_sha256"] = "f" * 64
    refused = confirm(client, case, reference, body)
    assert refused.status_code == 422
    assert refused.json()["detail"] == "Correspondence does not match the current tree"


def test_a_correspondence_goes_stale_when_the_tree_changes(tmp_path, monkeypatch):
    client, case, reference, current = ready(tmp_path, monkeypatch)
    assert confirm(client, case, reference, inputs(current)).status_code == 200
    assert admit_tree(client, case, reference, revision=1, ct_phase_percent=72.0).status_code == 200
    record = client.get(f"/api/cases/{case['case_id']}/coronary-correspondence").json()["current"]
    assert record["status"] == "current"
    assert record["evidence"] == "unavailable"


def test_branches_must_be_the_trees_own_in_order(tmp_path, monkeypatch):
    client, case, reference, current = ready(tmp_path, monkeypatch)
    swapped = inputs(current)
    swapped["branches"][1]["id"], swapped["branches"][2]["id"] = "lcx", "lad"
    assert confirm(client, case, reference, swapped).status_code == 422
    missing = inputs(current)
    missing["branches"] = missing["branches"][:2]
    assert confirm(client, case, reference, missing).status_code == 422


def test_the_phase_must_be_the_trees(tmp_path, monkeypatch):
    client, case, reference, current = ready(tmp_path, monkeypatch)
    refused = confirm(client, case, reference, inputs(current, phase={"ct_phase_percent": 40.0}))
    assert refused.status_code == 422


def test_nothing_is_confirmed_without_a_matched_branch():
    body = inputs({"tree_revision": 1, "current": {"body_sha256": "a" * 64}})
    for branch in body["branches"]:
        branch["status"] = "not_found"
    with pytest.raises(ValueError, match="At least one branch is matched"):
        validate_correspondence(body)


@pytest.mark.parametrize(
    "change",
    [
        {"confirmed": False},
        {"clinical_validation": True},
        {"pair": {"stated_by": "name_match"}},
        {"ct_to_carm_ras": [[2.0, 0, 0, 0], [0, 1.0, 0, 0], [0, 0, 1.0, 0], [0, 0, 0, 1]]},
        {"phase": {"frame": 5}},
        {"motion": {"followed": 60}},
        {"truth": {"lad": [1, 2]}},
    ],
)
def test_malformed_correspondences_are_refused(change):
    body = inputs({"tree_revision": 1, "current": {"body_sha256": "a" * 64}}, **change)
    with pytest.raises((ValueError, TypeError)):
        validate_correspondence(body)


def test_the_record_names_its_version():
    assert VERSION.startswith("step-e-")
