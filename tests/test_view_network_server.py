"""The one route that serves the view network's weights to the studio."""

import hashlib
import re
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from planner import view_network_server
from planner.model_assets import VIEW_NETWORK, VIEW_NETWORK_REVISION, CheckpointSpec
from planner.view_network_server import VIEW_NETWORK_FILE, register_view_network_routes

REPO = Path(__file__).resolve().parents[1]
BYTES = b"SLDVIEW1" + bytes(range(256)) * 4


def spec(data=BYTES):
    return CheckpointSpec(len(data), hashlib.sha256(data).hexdigest())


def client(path, expected):
    app = FastAPI()
    register_view_network_routes(app, path=path, expected=expected)
    return TestClient(app)


def test_the_verified_file_is_served_whole_and_never_cached(tmp_path):
    path = tmp_path / "view-network.bin"
    path.write_bytes(BYTES)
    answer = client(path, spec()).get("/api/view-network")
    assert answer.status_code == 200
    assert answer.content == BYTES
    assert answer.headers["content-type"] == "application/octet-stream"
    assert answer.headers["cache-control"] == "no-store"
    # The browser refuses a declared length that is not the fixed size.
    assert answer.headers["content-length"] == str(spec().size_bytes)
    assert answer.headers["x-view-network-sha256"] == spec().sha256


def test_a_request_cannot_name_a_file_or_a_hash(tmp_path):
    path = tmp_path / "view-network.bin"
    path.write_bytes(BYTES)
    other = tmp_path / "other.bin"
    other.write_bytes(b"other")
    served = client(path, spec())
    asked = served.get(
        "/api/view-network",
        params={"path": str(other), "sha256": hashlib.sha256(b"other").hexdigest(), "size": 5},
    )
    assert asked.status_code == 200
    assert asked.content == BYTES
    assert served.get("/api/view-network/other.bin").status_code == 404
    assert served.post("/api/view-network", content=b"other").status_code == 405


def test_absent_weights_are_not_installed(tmp_path):
    answer = client(tmp_path / "view-network.bin", spec()).get("/api/view-network")
    assert answer.status_code == 404
    assert answer.json() == {"detail": "View network is not installed"}


@pytest.mark.parametrize(
    "stored",
    [BYTES[:-1] + b"x", BYTES + b"x", BYTES[:-1], b""],
    ids=["one byte changed", "one byte longer", "one byte shorter", "empty"],
)
def test_bytes_that_are_not_the_fixed_file_are_refused(tmp_path, stored):
    path = tmp_path / "view-network.bin"
    path.write_bytes(stored)
    answer = client(path, spec()).get("/api/view-network")
    assert answer.status_code == 503
    assert answer.json() == {"detail": "View network failed integrity checks"}
    assert BYTES[:8] not in answer.content


def test_a_link_in_place_of_the_file_is_refused(tmp_path):
    real = tmp_path / "real.bin"
    real.write_bytes(BYTES)
    path = tmp_path / "view-network.bin"
    path.symlink_to(real)
    assert client(path, spec()).get("/api/view-network").status_code == 503


def test_a_link_to_nothing_is_a_fault_and_not_an_absence(tmp_path):
    path = tmp_path / "view-network.bin"
    path.symlink_to(tmp_path / "gone.bin")
    answer = client(path, spec()).get("/api/view-network")
    assert answer.status_code == 503
    assert answer.json() == {"detail": "View network failed integrity checks"}


def test_a_file_that_goes_while_it_is_being_read_is_not_installed(tmp_path, monkeypatch):
    """Absence is decided where the read fails, not by a look beforehand."""
    path = tmp_path / "view-network.bin"
    path.write_bytes(BYTES)

    def gone(file, *, expected):
        file.unlink()
        raise view_network_server.ModelArtifactError("Cannot open registered checkpoint")

    monkeypatch.setattr(view_network_server, "verified_checkpoint", gone)
    answer = client(path, spec()).get("/api/view-network")
    assert answer.status_code == 404
    assert answer.json() == {"detail": "View network is not installed"}


def test_a_file_that_fails_its_check_and_stays_is_a_fault(tmp_path, monkeypatch):
    path = tmp_path / "view-network.bin"
    path.write_bytes(BYTES)

    def refused(file, *, expected):
        raise view_network_server.ModelArtifactError("Checkpoint hash mismatch")

    monkeypatch.setattr(view_network_server, "verified_checkpoint", refused)
    answer = client(path, spec()).get("/api/view-network")
    assert answer.status_code == 503
    assert answer.json() == {"detail": "View network failed integrity checks"}


def test_bytes_that_cannot_be_read_are_a_fault_and_none_are_served(tmp_path, monkeypatch):
    """The file is on an external volume. A read error there is not a crash."""
    path = tmp_path / "view-network.bin"
    path.write_bytes(BYTES)

    def unreadable(file, *, expected):
        raise OSError(5, "Input/output error")

    monkeypatch.setattr(view_network_server, "verified_checkpoint", unreadable)
    answer = client(path, spec()).get("/api/view-network")
    assert answer.status_code == 503
    assert answer.json() == {"detail": "View network failed integrity checks"}


def test_a_path_that_cannot_be_looked_at_is_a_fault(tmp_path, monkeypatch):
    """Deciding absence looks at the same volume the read failed on."""
    path = tmp_path / "view-network.bin"
    path.write_bytes(BYTES)

    def refused(file, *, expected):
        raise view_network_server.ModelArtifactError("Cannot open registered checkpoint")

    def only_this_path(name):
        # Every other path is looked at as usual.
        real = getattr(type(path), name)

        def look(self, *args, **kwargs):
            if self == path:
                raise OSError(5, "Input/output error")
            return real(self, *args, **kwargs)

        monkeypatch.setattr(type(path), name, look)

    monkeypatch.setattr(view_network_server, "verified_checkpoint", refused)
    app = client(path, spec())
    only_this_path("is_symlink")
    only_this_path("exists")
    answer = app.get("/api/view-network")
    assert answer.status_code == 503
    assert answer.json() == {"detail": "View network failed integrity checks"}


def test_the_record_of_the_weights_names_the_same_file_and_training_commit():
    record = (REPO / "docs" / "research" / "view-network-v1.md").read_text()
    assert f"{VIEW_NETWORK.size_bytes:,} bytes" in record
    assert f"`{VIEW_NETWORK.sha256}`" in record
    assert re.fullmatch(r"[0-9a-f]{40}", VIEW_NETWORK_REVISION)
    assert f"commit `{VIEW_NETWORK_REVISION}`" in record


def test_the_file_and_its_fixed_identity():
    assert (
        VIEW_NETWORK_FILE == REPO / ".runtime" / "models" / "view-network-v1" / "view-network.bin"
    )
    assert VIEW_NETWORK == CheckpointSpec(
        7097120, "1c76811cc68707e9a55c8ad99b75e13eeaf9b292c1fb10db75c0e7872a2b8b56"
    )


def test_the_browser_fixes_the_same_size_and_hash():
    source = (REPO / "web" / "src" / "viewNetworkFile.ts").read_text()
    size = re.search(r"size_bytes: ([0-9_]+),", source)
    sha = re.search(r'sha256: "([a-f0-9]{64})",', source)
    assert size and sha
    assert CheckpointSpec(int(size.group(1).replace("_", "")), sha.group(1)) == VIEW_NETWORK


def test_the_planner_serves_it(tmp_path, monkeypatch):
    from planner import server, view_network_server

    monkeypatch.setattr(view_network_server, "VIEW_NETWORK_FILE", tmp_path / "absent.bin")
    app = server.build_app(tmp_path / "workspace.sqlite3")
    answer = TestClient(app).get("/api/view-network")
    assert answer.status_code == 404
    assert answer.json() == {"detail": "View network is not installed"}
