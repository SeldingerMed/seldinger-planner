from fastapi.testclient import TestClient

from planner.server import build_app


def test_other_web_origins_cannot_invoke_local_workspace(tmp_path):
    client = TestClient(build_app(tmp_path / "local.sqlite3"))
    response = client.post("/api/cases", headers={"Origin": "https://untrusted.example"}, json={})
    assert response.status_code == 403


def test_demo_sample_missing_is_404_not_filesystem_error(tmp_path):
    client = TestClient(build_app(tmp_path / "local.sqlite3", sample_dir=tmp_path / "absent"))
    response = client.get("/api/sample")
    assert response.status_code == 404
    assert str(tmp_path) not in response.text
