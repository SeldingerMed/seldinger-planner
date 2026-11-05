import pytest
from fastapi.testclient import TestClient

from planner.server import build_app


def test_configured_tailnet_origin_can_use_workspace_without_allowing_other_origins(
    tmp_path, monkeypatch
):
    origin = "http://100.123.164.98:5173"
    monkeypatch.setenv("SELDINGER_BROWSER_ORIGINS", origin)
    client = TestClient(build_app(tmp_path / "synthetic.sqlite3"))
    assert client.get("/api/device-catalog", headers={"Origin": origin}).status_code == 200
    assert client.post("/api/not-a-route", headers={"Origin": origin}, json={}).status_code == 404
    for denied in (
        "http://100.123.164.99:5173",
        "http://100.123.164.98:5174",
        "https://untrusted.example",
    ):
        assert client.get("/api/device-catalog", headers={"Origin": denied}).status_code == 403


@pytest.mark.parametrize(
    "origin",
    [
        "*",
        "http://0.0.0.0:5173",
        "http://203.0.113.4:5173",
        "http://user@100.123.164.98:5173",
        "http://100.123.164.98:5173/path",
        "http://100.123.164.98:0",
        "HTTPS://100.123.164.98:5173",
    ],
)
def test_tailnet_origin_configuration_rejects_broad_or_malformed_grants(
    tmp_path, monkeypatch, origin
):
    monkeypatch.setenv("SELDINGER_BROWSER_ORIGINS", origin)
    with pytest.raises(ValueError, match="tailnet origin"):
        build_app(tmp_path / "synthetic.sqlite3")
