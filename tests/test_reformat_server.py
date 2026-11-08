"""Real default-app reformat confirmations using generated native image sources."""

from test_territory_workflow_server import configured


def test_confirmed_path_roundtrip_has_independent_revision(tmp_path, monkeypatch):
    client, case, reference = configured(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/reformat-scene"
    inputs = {
        "confirmed": True,
        "path": [[5, 16, 16], [10, 16, 16], [10, 21, 16]],
        "secondary": None,
    }
    body = {
        "artifact_version": case["artifact_version"],
        "reference_revision": reference,
        "scene_revision": 0,
        "inputs": inputs,
    }
    response = client.put(route, json=body)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["scene_revision"] == 1 and result["current"]["status"] == "current"
    assert result["current"]["result"]["path_length_mm"] == 5 + 5
    assert result["current"]["inputs"]["path"] == inputs["path"]
    assert client.get(route).json() == result
    assert client.put(route, json=body).status_code == 409
    assert (
        client.get(f"/api/cases/{case['case_id']}").json()["artifact_version"]
        == case["artifact_version"]
    )


def test_confirmation_must_be_actual_true_and_rejections_do_not_store(tmp_path, monkeypatch):
    client, case, reference = configured(tmp_path, monkeypatch)
    route = f"/api/cases/{case['case_id']}/reformat-scene"
    body = {
        "artifact_version": case["artifact_version"],
        "reference_revision": reference,
        "scene_revision": 0,
        "inputs": {"confirmed": True, "path": [[5, 16, 16], [10, 16, 16]], "secondary": None},
    }
    assert client.put(route, json=body).status_code == 200
    body["scene_revision"] = 1
    for value in (False, 1, "true"):
        body["inputs"]["confirmed"] = value
        response = client.put(route, json=body)
        assert response.status_code == 422, (value, response.text)
        assert client.get(route).json()["scene_revision"] == 1


def test_rigid_secondary_requires_current_metadata_and_proper_rotation(tmp_path, monkeypatch):
    client, case, reference = configured(tmp_path, monkeypatch)
    metadata = client.get(f"/api/cases/{case['case_id']}/image-source").json()
    route = f"/api/cases/{case['case_id']}/reformat-scene"
    matrix = [[1, 0, 0, 2], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
    secondary = {
        "source_id": metadata["source_id"],
        "image_sha256": case["image_sha256"],
        "reference_revision": reference,
        "secondary_to_primary_ras": matrix,
    }
    body = {
        "artifact_version": case["artifact_version"],
        "reference_revision": reference,
        "scene_revision": 0,
        "inputs": {"confirmed": True, "path": [[5, 16, 16], [10, 16, 16]], "secondary": secondary},
    }
    response = client.put(route, json=body)
    assert response.status_code == 200, response.text
    assert (
        response.json()["current"]["result"]["registration_method"]
        == "operator_confirmed_rigid_ras"
    )
    assert response.json()["secondary_metadata"]["image_sha256"] == case["image_sha256"]
    body["scene_revision"] = 1
    matrix[0][0] = 2
    assert client.put(route, json=body).status_code == 422
    assert client.get(route).json()["scene_revision"] == 1
    matrix[0][0] = -1
    assert client.put(route, json=body).status_code == 422
    assert client.get(route).json()["scene_revision"] == 1
