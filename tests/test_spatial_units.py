from fastapi.testclient import TestClient

from planner.workspace import create_app


def test_unspecified_source_units_cannot_produce_mm_measurements(tmp_path):
    client = TestClient(create_app(tmp_path / "units.sqlite3"))
    case = client.post(
        "/api/cases",
        json={
            "title": "Synthetic unknown-unit fixture",
            "image_sha256": "d" * 64,
            "dimensions": [10, 10, 10],
            "spacing_mm": [1, 1, 1],
            "spatial_units": "unknown",
        },
    ).json()
    assert case["spatial_units"] == "unknown"
    result = client.post(
        f"/api/cases/{case['case_id']}/measurements",
        json={
            "artifact_version": "1",
            "label": "must not be interpreted as mm",
            "point_a_mm": [0, 0, 0],
            "point_b_mm": [3, 4, 0],
        },
    )
    assert result.status_code == 422
    assert client.get(f"/api/cases/{case['case_id']}").json()["measurements"] == []
