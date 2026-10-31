"""Workspace layer contract tests: new FastAPI/SQLite planning workspace.

Real temporary SQLite database + real TestClient. API-shaped synthetic
metadata only; no patient data, no images, no legacy code.
"""

from __future__ import annotations

import math
import pathlib

import pytest
from fastapi.testclient import TestClient

from planner.workspace import create_app

CASE = {
    "title": "Public demo case",
    "image_sha256": "a" * 64,
    "source_url": "https://example.org/demo/cta.nii.gz",
    "dimensions": [256, 256, 128],
    "spacing_mm": [0.8, 0.8, 1.0],
}


@pytest.fixture()
def db_path(tmp_path: pathlib.Path) -> pathlib.Path:
    return tmp_path / "workspace.sqlite"


def make_client(db_path: pathlib.Path) -> TestClient:
    return TestClient(create_app(db_path))


def create_case(client: TestClient, **overrides) -> dict:
    payload = {**CASE, **overrides}
    response = client.post("/api/cases", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


# ---------------------------------------------------------------- health


def test_health_ok(db_path):
    client = make_client(db_path)
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


# ------------------------------------------------------------ create case


def test_create_case_shape(db_path):
    client = make_client(db_path)
    body = create_case(client)
    assert body["title"] == CASE["title"]
    assert body["image_sha256"] == CASE["image_sha256"]
    assert body["source_url"] == CASE["source_url"]
    assert body["dimensions"] == CASE["dimensions"]
    assert body["spacing_mm"] == CASE["spacing_mm"]
    assert body["artifact_version"] == "1"
    assert body["notes"] == ""
    assert body["measurements"] == []
    case_id = body["case_id"]
    assert isinstance(case_id, str) and case_id and "/" not in case_id


def test_create_case_defaults_source_url_none(db_path):
    client = make_client(db_path)
    body = create_case(client, source_url=None)
    assert body["source_url"] is None


@pytest.mark.parametrize(
    "bad",
    [
        {"title": ""},
        {"title": "x" * 101},
        {"image_sha256": "A" * 64},
        {"image_sha256": "z" * 64},
        {"image_sha256": "a" * 63},
        {"source_url": "http://insecure.example.org/x"},
        {"dimensions": [0, 10, 10]},
        {"dimensions": [2049, 10, 10]},
        {"dimensions": [10, 10]},
        {"spacing_mm": [0.0, 1.0, 1.0]},
        {"spacing_mm": [-1.0, 1.0, 1.0]},
        {"spacing_mm": [101.0, 1.0, 1.0]},
    ],
)
def test_create_case_rejects_invalid(db_path, bad):
    client = make_client(db_path)
    response = client.post("/api/cases", json={**CASE, **bad})
    assert response.status_code == 422


# ---------------------------------------------------------------- get case


def test_get_case(db_path):
    client = make_client(db_path)
    body = create_case(client)
    fetched = client.get(f"/api/cases/{body['case_id']}")
    assert fetched.status_code == 200
    assert fetched.json() == body


def test_get_missing_case_404(db_path):
    client = make_client(db_path)
    assert client.get("/api/cases/nope").status_code == 404


def test_case_id_cannot_become_path(db_path):
    client = make_client(db_path)
    assert client.get("/api/cases/..%2F..%2Fetc%2Fpasswd").status_code == 404


# ------------------------------------------------------------- persistence


def test_persistence_after_app_recreation(db_path):
    client = make_client(db_path)
    body = create_case(client)
    client.post(
        f"/api/cases/{body['case_id']}/measurements",
        json={
            "artifact_version": "1",
            "label": "span",
            "point_a_mm": [0.0, 0.0, 0.0],
            "point_b_mm": [3.0, 4.0, 0.0],
        },
    )
    client.patch(
        f"/api/cases/{body['case_id']}/notes",
        json={"artifact_version": "2", "notes": "persisted note"},
    )
    # Recreate the app against the same SQLite file.
    client2 = make_client(db_path)
    fetched = client2.get(f"/api/cases/{body['case_id']}")
    assert fetched.status_code == 200
    data = fetched.json()
    assert data["notes"] == "persisted note"
    assert data["artifact_version"] == "3"
    assert len(data["measurements"]) == 1


# ------------------------------------------------------------- measurements


def create_with_measurement(client: TestClient, case_id: str, **overrides) -> dict:
    payload = {
        "artifact_version": "1",
        "label": "span",
        "point_a_mm": [0.0, 0.0, 0.0],
        "point_b_mm": [3.0, 4.0, 0.0],
        **overrides,
    }
    response = client.post(f"/api/cases/{case_id}/measurements", json=payload)
    return response


def test_measurement_distance_and_revision(db_path):
    client = make_client(db_path)
    body = create_case(client)
    response = create_with_measurement(client, body["case_id"])
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["artifact_version"] == "2"
    measurement = data["measurements"][0]
    assert measurement["coordinate_system"] == "RAS"
    assert measurement["label"] == "span"
    assert math.isclose(measurement["distance_mm"], 5.0)


def test_measurement_stale_revision_409_no_write(db_path):
    client = make_client(db_path)
    body = create_case(client)
    response = create_with_measurement(client, body["case_id"], artifact_version="9")
    assert response.status_code == 409
    fetched = client.get(f"/api/cases/{body['case_id']}")
    data = fetched.json()
    assert data["measurements"] == []
    assert data["artifact_version"] == "1"


def test_measurement_coincident_points_422(db_path):
    client = make_client(db_path)
    body = create_case(client)
    response = create_with_measurement(
        client,
        body["case_id"],
        point_a_mm=[1.0, 2.0, 3.0],
        point_b_mm=[1.0, 2.0, 3.0],
    )
    assert response.status_code == 422


@pytest.mark.parametrize(
    "bad",
    [
        {"label": ""},
        {"label": "x" * 81},
        {"point_a_mm": [0.0, 0.0]},
        {"point_a_mm": [float("nan"), 0.0, 0.0]},
        {"point_b_mm": [float("inf"), 0.0, 0.0]},
    ],
)
def test_measurement_rejects_invalid(db_path, bad):
    client = make_client(db_path)
    body = create_case(client)
    payload = {
        "artifact_version": "1",
        "label": "span",
        "point_a_mm": [0, 0, 0],
        "point_b_mm": [0, 0, 0],
        **bad,
    }
    import json as _json

    response = client.post(
        f"/api/cases/{body['case_id']}/measurements",
        content=_json.dumps(payload),  # allow NaN/Infinity literals
        headers={"content-type": "application/json"},
    )
    assert response.status_code == 422


# ---------------------------------------------------------------- notes


def test_notes_update_and_revision(db_path):
    client = make_client(db_path)
    body = create_case(client)
    response = client.patch(
        f"/api/cases/{body['case_id']}/notes",
        json={"artifact_version": "1", "notes": "first note"},
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["notes"] == "first note"
    assert data["artifact_version"] == "2"


def test_notes_stale_revision_409_no_write(db_path):
    client = make_client(db_path)
    body = create_case(client)
    assert (
        client.patch(
            f"/api/cases/{body['case_id']}/notes",
            json={"artifact_version": "7", "notes": "stale"},
        ).status_code
        == 409
    )
    assert client.get(f"/api/cases/{body['case_id']}").json()["notes"] == ""


def test_notes_rejects_too_long(db_path):
    client = make_client(db_path)
    body = create_case(client)
    response = client.patch(
        f"/api/cases/{body['case_id']}/notes",
        json={"artifact_version": "1", "notes": "x" * 8001},
    )
    assert response.status_code == 422


# ---------------------------------------------------------------- brief


def test_brief_markdown_from_persisted_state(db_path):
    client = make_client(db_path)
    body = create_case(client)
    create_with_measurement(client, body["case_id"])
    client.patch(
        f"/api/cases/{body['case_id']}/notes",
        json={"artifact_version": "2", "notes": "clinician note"},
    )
    response = client.get(f"/api/cases/{body['case_id']}/brief")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/markdown")
    text = response.text
    assert "Public demo case" in text
    assert "a" * 64 in text
    assert "1" in text  # revision
    assert "5.0" in text  # distance
    assert "point-to-point" in text.lower()
    assert "not validated" in text.lower()
    assert "clinician note" in text


def test_brief_missing_case_404(db_path):
    client = make_client(db_path)
    assert client.get("/api/cases/nope/brief").status_code == 404


def test_error_responses_do_not_leak_db_paths(db_path):
    client = make_client(db_path)
    response = client.post("/api/cases", json={"title": "x"})
    assert str(db_path) not in response.text
