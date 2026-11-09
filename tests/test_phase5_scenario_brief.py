"""Actual default-app brief export including saved device alternatives.

Everything here is synthetic; no clinical claim is exercised or asserted.
"""

import hashlib
import json
import struct

import pytest
from fastapi.testclient import TestClient
from test_device_scenarios import scenario
from test_geometry_server import input_body, metrics
from test_native_grid import header_bytes

from planner.device_scenarios import DeviceScenarioLedger
from planner.segmentation_state import SegmentationLedger
from planner.server import build_app

IDENTITY_FIELDS = (
    "image_sha256",
    "artifact_version",
    "reference_revision",
    "geometry_result_id",
    "catalog_version",
)


def configured(tmp_path, monkeypatch, runner):
    """Real build_app over an installed synthetic millimeter source."""
    from planner import image_source

    root = tmp_path.resolve()
    sources = root / "sources"
    directory = sources / "phase3-synthetic"
    directory.mkdir(parents=True)
    affine = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
    raw = bytearray(header_bytes([32, 32, 32], affine[:3]))
    struct.pack_into("<2h", raw, 70, 4, 16)
    struct.pack_into("<8f", raw, 76, 1, 1, 1, 1, 1, 1, 1, 1)
    struct.pack_into("<2f", raw, 112, 1, 0)
    voxels = bytes(32 * 32 * 32 * 2)
    payload = gzip_compress(raw + voxels)
    digest = hashlib.sha256(payload).hexdigest()
    manifest = {
        "clinical_validation": False,
        "source_provenance": {"scope": "synthetic"},
        "image": {
            "filename": "context-cta.nii.gz",
            "sha256": digest,
            "bytes": len(payload),
            "shape_xyz": [32, 32, 32],
            "dtype": "int16",
            "spatial_units": "mm",
            "affine_ras": affine,
        },
    }
    (directory / "manifest.json").write_text(json.dumps(manifest))
    path = directory / "context-cta.nii.gz"
    path.write_bytes(payload)
    monkeypatch.setattr(image_source, "INSTALLED_SOURCES_ROOT", sources)
    db = root / "case.sqlite3"

    def declared_native_contract(job):
        # Synthetic scalar fixture, explicitly not an image/model result. Match
        # the native producer's source identity and section-method contract.
        result = runner(job)
        result["image_sha256"] = job["image_sha256"]
        result["reference_revision"] = job["reference_revision"]
        for name in ("proximal_parent", "distal_parent"):
            result[name]["method"] = "operator_path_normal_native_mask_section"
        return result

    app = build_app(
        db,
        reference_dir=root / "missing-reference",
        sample_dir=root / "missing-sample",
        client_factory=lambda: (_ for _ in ()).throw(
            RuntimeError("Model calls disabled in synthetic tests")
        ),
        inference_results_dir=root / "results",
        geometry_runner=declared_native_contract,
    )
    client = TestClient(app)
    case = client.post(
        "/api/cases",
        json={
            "title": "Synthetic scenario brief",
            "image_sha256": digest,
            "dimensions": [32, 32, 32],
            "spacing_mm": [1, 1, 1],
            "spatial_units": "mm",
        },
    ).json()
    metadata = client.get(f"/api/cases/{case['case_id']}/image-source")
    assert metadata.status_code == 200, metadata.text
    reference = metadata.json()["reference_revision"]
    masks = SegmentationLedger(db)
    for role, producer, mask in [
        ("vessel", "owned_vessel", "c" * 64),
        ("aneurysm", "aneurysm_model", "d" * 64),
    ]:
        entry = masks.preview(
            case["case_id"],
            case["artifact_version"],
            reference_revision=reference,
            producer=producer,
            role=role,
            mask_sha256=mask,
            provenance={"synthetic_fixture": True},
        )
        masks.decide(case["case_id"], entry["candidate_id"], case["artifact_version"], "accept")
        case = client.get(f"/api/cases/{case['case_id']}").json()
    return client, case, reference, db


def gzip_compress(payload):
    import gzip

    return gzip.compress(payload, mtime=0)


def current_geometry(client, case, reference):
    route = f"/api/cases/{case['case_id']}/morphometry"
    request = input_body(case["artifact_version"])
    request["reference_revision"] = reference
    saved = client.put(route + "-inputs", json=request)
    assert saved.status_code == 200, saved.text
    computed = client.post(
        route,
        json={
            "artifact_version": saved.json()["artifact_version"],
            "reference_revision": reference,
        },
    )
    assert computed.status_code == 200, computed.text
    return computed.json()


def save_alternatives(client, case, envelope):
    scenarios_url = f"/api/cases/{case['case_id']}/device-scenarios"
    initial = client.get(scenarios_url)
    assert initial.status_code == 200, initial.text
    payload = {key: initial.json()[key] for key in IDENTITY_FIELDS}
    payload.update(
        confirmed=True,
        scenario_revision=0,
        scenarios=[scenario(), scenario(id="second-123456", name="Second")],
    )
    saved = client.put(scenarios_url, json=payload)
    assert saved.status_code == 200, saved.text
    return initial.json(), saved.json()


def test_actual_api_save_then_default_brief_projects_saved_alternatives(tmp_path, monkeypatch):
    client, case, reference, _db = configured(tmp_path, monkeypatch, lambda job: metrics())
    geometry = current_geometry(client, case, reference)
    before, saved = save_alternatives(client, case, geometry)
    brief = client.get(f"/api/cases/{case['case_id']}/local-brief")
    assert brief.status_code == 200, brief.text
    body = brief.json()
    projection = body["device_scenarios"]
    assert projection["status"] == "current"
    assert projection["scenario_revision"] == 1
    assert projection["set_id"] == saved["current"]["set_id"]
    assert before["current"]["status"] == "not_computed"
    assert projection["scenarios_sha256"] == saved["current"]["scenarios_sha256"]
    assert projection["geometry_result_id"] == before["geometry_result_id"]
    assert projection["catalog_version"] == before["catalog_version"]
    assert projection["dependencies"] == saved["current"]["dependencies"]
    rows = projection["scenarios"]
    assert [row["id"] for row in rows] == ["abcd1234ef", "second-123456"]
    assert [row["name"] for row in rows] == ["Synthetic scenario", "Second"]
    assert rows[0]["placement"]["diameter"] == 7.5
    assert rows[0]["placement"]["deviceId"] == "synthetic-device-01"
    markdown = body["markdown"]
    assert "## Saved device alternatives" in markdown
    assert f"`{projection['set_id']}`" in markdown
    assert "`abcd1234ef`" in markdown and "Second" in markdown
    assert "Operator-selected procedural parameters" in markdown
    assert "not verified commercial specifications" in markdown
    assert '"path"' not in markdown and '"center"' not in markdown
    assert brief.headers["cache-control"] == "no-store"


def test_absent_scenarios_keep_existing_brief_modes_exportable(tmp_path, monkeypatch):
    client, case, _reference, _db = configured(tmp_path, monkeypatch, lambda job: metrics())
    response = client.get(f"/api/cases/{case['case_id']}/local-brief")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["device_scenarios"]["status"] in ("not_computed", "unavailable")
    assert "diameter" not in body["markdown"]
    assert "## Reformat scene" in body["markdown"]


def test_stale_alternatives_are_suppressed_not_projected(tmp_path, monkeypatch):
    client, case, reference, _db = configured(tmp_path, monkeypatch, lambda job: metrics())
    current_geometry(client, case, reference)
    _, saved = save_alternatives(client, case, None)
    scenarios_url = f"/api/cases/{case['case_id']}/device-scenarios"
    bumped = client.patch(
        f"/api/cases/{case['case_id']}/notes",
        json={
            "artifact_version": saved["artifact_version"],
            "notes": "Synthetic concurrent edit",
        },
    )
    assert bumped.status_code == 200, bumped.text
    # The scenario reader requires current geometry, even when a saved set
    # exists. Unavailable is a prerequisite status, not a claim of no records.
    blocked = client.get(scenarios_url)
    assert blocked.status_code == 409, blocked.text
    unavailable = client.get(f"/api/cases/{case['case_id']}/local-brief")
    assert unavailable.status_code == 200, unavailable.text
    projection = unavailable.json()["device_scenarios"]
    assert projection == {"status": "unavailable"}
    alternatives_text = unavailable.json()["markdown"].split("## Saved device alternatives", 1)[1]
    assert "Synthetic scenario" not in alternatives_text and "diameter" not in alternatives_text
    recomputed = client.post(
        f"/api/cases/{case['case_id']}/morphometry",
        json={
            "artifact_version": bumped.json()["artifact_version"],
            "reference_revision": reference,
        },
    )
    assert recomputed.status_code == 200, recomputed.text
    stale = client.get(scenarios_url)
    assert stale.status_code == 200, stale.text
    assert stale.json()["current"]["status"] == "stale"
    assert stale.json()["current"]["scenarios"] is None
    brief = client.get(f"/api/cases/{case['case_id']}/local-brief")
    assert brief.status_code == 200, brief.text
    body = brief.json()
    projection = body["device_scenarios"]
    assert projection["status"] == "stale"
    assert projection["set_id"] == stale.json()["current"]["set_id"]
    assert "scenarios" not in projection
    markdown = body["markdown"]
    assert "stale" in markdown
    alternatives_text = markdown.split("## Saved device alternatives", 1)[1]
    assert '"placement"' not in alternatives_text and "diameter" not in alternatives_text
    assert projection["scenario_revision"] == 1


def test_ledger_replacement_during_projection_is_a_conflict(tmp_path, monkeypatch):
    client, case, reference, db = configured(tmp_path, monkeypatch, lambda job: metrics())
    current_geometry(client, case, reference)
    _, saved = save_alternatives(client, case, None)
    ledger = DeviceScenarioLedger(db)
    original = DeviceScenarioLedger.read
    state = {"reads": 0}

    def interleaved(self, identity):
        state["reads"] += 1
        if state["reads"] == 3:
            # Replace the set exactly between the brief's two snapshots.
            ledger.store(
                identity,
                saved["scenario_revision"],
                [scenario(id="replacement00", name="Replacement")],
            )
        return original(self, identity)

    monkeypatch.setattr(DeviceScenarioLedger, "read", interleaved)
    brief = client.get(f"/api/cases/{case['case_id']}/local-brief")
    assert brief.status_code == 409, brief.text
    assert state["reads"] >= 3


def test_same_version_geometry_replacement_during_projection_is_a_conflict(tmp_path, monkeypatch):
    from planner import local_brief
    from planner.geometry_state import GeometryLedger

    client, case, reference, db = configured(tmp_path, monkeypatch, lambda job: metrics())
    geometry = current_geometry(client, case, reference)
    save_alternatives(client, case, geometry)
    ledger = GeometryLedger(db)
    original = local_brief.project_scenarios
    replacements = []

    def interleaved(*args):
        projection = original(*args)
        if not replacements:
            snapshot = ledger.snapshot(case["case_id"], geometry["artifact_version"], reference)
            replacements.append(
                ledger.store(case["case_id"], snapshot, geometry["current"]["result"])["result_id"]
            )
        return projection

    monkeypatch.setattr(local_brief, "project_scenarios", interleaved)
    rejected = client.get(f"/api/cases/{case['case_id']}/local-brief")
    assert rejected.status_code == 409, rejected.text
    assert "markdown" not in rejected.json()
    assert replacements[0] != geometry["current"]["result_id"]
    assert (
        client.get(f"/api/cases/{case['case_id']}").json()["artifact_version"]
        == geometry["artifact_version"]
    )
    recovered = client.get(f"/api/cases/{case['case_id']}/local-brief")
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["device_scenarios"]["status"] == "stale"


@pytest.mark.parametrize(
    "mutation", ["extra_dependency", "extra_mask_field", "extra_mask_role", "wrong_calculation"]
)
def test_projection_keeps_dependency_metadata_closed(tmp_path, monkeypatch, mutation):
    from copy import deepcopy

    from planner.local_brief import project_scenarios

    client, case, reference, _db = configured(tmp_path, monkeypatch, lambda job: metrics())
    geometry = current_geometry(client, case, reference)
    _, saved = save_alternatives(client, case, geometry)
    identity = {
        key: saved[key]
        for key in ("case_id", "image_sha256", "artifact_version", "reference_revision")
    }
    summary = {"result_id": geometry["current"]["result_id"]}
    assert project_scenarios(identity, saved, summary)["status"] == "current"
    bad = deepcopy(saved)
    deps = bad["current"]["dependencies"]
    if mutation == "extra_dependency":
        deps["unapproved_metadata"] = "must not escape into export"
    elif mutation == "extra_mask_field":
        deps["masks"]["vessel"]["unapproved_metadata"] = "must not escape"
    elif mutation == "extra_mask_role":
        deps["masks"]["unrecognized"] = deps["masks"]["vessel"]
    else:
        deps["calculation_version"] = "unsupported"
    with pytest.raises(ValueError):
        project_scenarios(identity, bad, summary)


@pytest.mark.parametrize("offender", ["clinically recommended", "validated fit"])
def test_brief_never_claims_fit_or_recommendation(tmp_path, monkeypatch, offender):
    client, case, reference, _db = configured(tmp_path, monkeypatch, lambda job: metrics())
    current_geometry(client, case, reference)
    save_alternatives(client, case, None)
    response = client.get(f"/api/cases/{case['case_id']}/local-brief")
    assert response.status_code == 200, response.text
    assert response.json()["device_scenarios"]["status"] == "current"
    assert offender not in response.text
