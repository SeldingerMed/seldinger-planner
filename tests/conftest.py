import pytest


@pytest.fixture(autouse=True)
def _no_installed_occlusion_model(monkeypatch, tmp_path_factory):
    """Keep every app build independent of a model file installed on the developer's machine."""
    absent = tmp_path_factory.mktemp("no-occlusion-model") / "absent.json"
    monkeypatch.setenv("SELDINGER_OCCLUSION_MODEL", str(absent))
