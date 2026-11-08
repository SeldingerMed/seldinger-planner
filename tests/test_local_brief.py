"""Source-bound local export through the actual app and immutable ledgers."""

from test_territory_workflow_server import configured
from test_territory_workflows import tavr_inputs


def test_local_brief_composes_current_scalars_without_arrays(tmp_path, monkeypatch):
    client, case, reference = configured(tmp_path, monkeypatch)
    identity = {k: case[k] for k in ("case_id", "image_sha256", "artifact_version")}
    identity["reference_revision"] = reference
    path = f"/api/cases/{case['case_id']}"
    territory = client.put(
        path + "/territory-workflows/tavr",
        json={
            "artifact_version": case["artifact_version"],
            "reference_revision": reference,
            "workflow_revision": 0,
            "inputs": tavr_inputs(),
        },
    )
    assert territory.status_code == 200, territory.text
    scene = client.put(
        path + "/reformat-scene",
        json={
            "artifact_version": case["artifact_version"],
            "reference_revision": reference,
            "scene_revision": 0,
            "inputs": {"confirmed": True, "path": [[5, 16, 16], [10, 16, 16]], "secondary": None},
        },
    )
    assert scene.status_code == 200, scene.text
    response = client.get(path + "/local-brief")
    assert response.status_code == 200, response.text
    body = response.json()
    assert all(body[k] == v for k, v in identity.items())
    assert body["scene"]["scene_id"] == scene.json()["current"]["scene_id"]
    assert body["scene"]["path_length_mm"] == 5
    area = territory.json()["current"]["result"]["area_mm2"]
    assert body["territories"]["tavr"]["metrics"]["area_mm2"] == area == 6
    assert "Area (mm2): 6" in body["markdown"]
    assert body["territories"]["tavr"]["result_id"] == territory.json()["current"]["result_id"]
    for forbidden in (
        '"inputs"',
        '"path"',
        '"contour"',
        '"secondary_to_primary_ras"',
        '"profiles"',
        '"source_provenance"',
    ):
        assert forbidden not in response.text
    assert response.headers["Cache-Control"] == "no-store"


def test_local_brief_marks_absence_instead_of_old_numbers(tmp_path, monkeypatch):
    client, case, _ = configured(tmp_path, monkeypatch)
    response = client.get(f"/api/cases/{case['case_id']}/local-brief")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["scene"]["status"] == "not_confirmed"
    assert body["territories"]["tavr"]["status"] == "not_computed"
    assert "area_mm2" not in body["markdown"]


def test_local_brief_reports_missing_evidence_without_repeated_boilerplate(tmp_path, monkeypatch):
    client, case, _ = configured(tmp_path, monkeypatch)
    markdown = client.get(f"/api/cases/{case['case_id']}/local-brief").json()["markdown"]
    assert "- Accepted segmentations: unavailable" in markdown
    assert "- Computed morphometry: unavailable" in markdown
    assert "- Saved device sizing: unavailable" in markdown
    assert "Unavailable in this workspace" not in markdown
