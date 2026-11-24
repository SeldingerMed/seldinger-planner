"""The RAM-disk studio launcher keeps every store under its root."""

import sys
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "research"))

import control_server


def test_every_store_lives_under_the_root(tmp_path, monkeypatch):
    from planner import image_source

    monkeypatch.setattr(image_source, "INSTALLED_SOURCES_ROOT", image_source.INSTALLED_SOURCES_ROOT)
    (tmp_path / "web").mkdir()
    (tmp_path / "web" / "index.html").write_text("<html>studio</html>")
    app = control_server.build(tmp_path)
    assert image_source.INSTALLED_SOURCES_ROOT == tmp_path.resolve() / "installed-sources"
    assert (tmp_path / "workspace.sqlite3").is_file()
    for name in ("installed-sources", "installed-frames", "installed-projections"):
        assert (tmp_path / name).is_dir()
    client = TestClient(app)
    assert "studio" in client.get("/").text
    assert client.get("/api/projection-frames/not-installed").status_code == 404
    assert client.get("/api/image-sources/not-installed").status_code == 404
