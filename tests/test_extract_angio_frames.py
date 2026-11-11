"""Frame extraction helper: pinned ffmpeg install and extraction. Synthetic video only."""

import hashlib
import importlib.util
import io
import json
import shutil
import struct
import subprocess
import urllib.error
import zipfile
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "extract_angio_frames.py"
spec = importlib.util.spec_from_file_location("extract_angio_frames", SCRIPT)
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)

FAKE = b'#!/bin/sh\necho "ffmpeg version fake-1.0"\n'


def wheel(payload=FAKE, member="imageio_ffmpeg/binaries/ffmpeg-fake-v1"):
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as archive:
        archive.writestr("imageio_ffmpeg/__init__.py", "")
        if member:
            archive.writestr(member, payload)
    return data.getvalue()


class Opener:
    def __init__(self, data):
        self.data, self.urls = data, []

    def __call__(self, url, timeout):
        self.urls.append(url)
        return io.BytesIO(self.data)


def pin(monkeypatch, data, *, digest=None, size=None):
    monkeypatch.setattr(tool.platform, "system", lambda: "Linux")
    monkeypatch.setattr(tool.platform, "machine", lambda: "x86_64")
    monkeypatch.setitem(
        tool.FFMPEG_WHEELS,
        ("Linux", "x86_64"),
        (
            "aa/bb/fake.whl",
            digest or hashlib.sha256(data).hexdigest(),
            len(data) if size is None else size,
        ),
    )


def test_pinned_wheels_are_well_formed():
    assert set(tool.FFMPEG_WHEELS) == {
        ("Darwin", "arm64"),
        ("Darwin", "x86_64"),
        ("Linux", "x86_64"),
        ("Linux", "aarch64"),
        ("Windows", "AMD64"),
    }
    for path, digest, size in tool.FFMPEG_WHEELS.values():
        assert path.endswith(".whl") and "imageio_ffmpeg-0.8.1-" in path
        assert len(digest) == 64 and int(digest, 16) >= 0 and size > 10_000_000
    assert len({digest for _, digest, _ in tool.FFMPEG_WHEELS.values()}) == 5


def test_path_ffmpeg_is_preferred_and_nothing_is_downloaded(tmp_path, monkeypatch):
    binary = tmp_path / "ffmpeg"
    binary.write_bytes(FAKE)
    binary.chmod(0o755)
    monkeypatch.setattr(tool.shutil, "which", lambda name: str(binary))
    opener = Opener(b"")
    assert tool.ensure_ffmpeg(tmp_path / "tools", opener=opener) == binary
    assert opener.urls == [] and not (tmp_path / "tools").exists()


def test_missing_ffmpeg_is_downloaded_verified_installed_and_reused(tmp_path, monkeypatch):
    monkeypatch.setattr(tool.shutil, "which", lambda name: None)
    data = wheel()
    pin(monkeypatch, data)
    opener = Opener(data)
    tools = tmp_path / "tools"
    installed = tool.ensure_ffmpeg(tools, opener=opener)
    assert installed == tools / "imageio-ffmpeg-0.8.1" / "ffmpeg"
    assert installed.read_bytes() == FAKE and installed.stat().st_mode & 0o111
    assert opener.urls == ["https://files.pythonhosted.org/packages/aa/bb/fake.whl"]
    # Nothing but the binary is left behind, and the second call reuses it.
    assert [p.name for p in tools.iterdir()] == ["imageio-ffmpeg-0.8.1"]
    assert tool.ensure_ffmpeg(tools, opener=opener) == installed
    assert len(opener.urls) == 1
    # A PATH entry that does not run is not trusted over the installed build.
    broken = tmp_path / "broken"
    broken.write_bytes(b"#!/bin/sh\nexit 3\n")
    broken.chmod(0o755)
    monkeypatch.setattr(tool.shutil, "which", lambda name: str(broken))
    assert tool.ensure_ffmpeg(tools, opener=opener) == installed


@pytest.mark.parametrize(
    "data,pinned",
    [
        (wheel(), {"digest": "0" * 64}),  # wrong hash
        (wheel(), {"size": 10}),  # larger than recorded
        (wheel(), {"size": 10_000_000}),  # shorter than recorded
        (wheel(member=None), {}),  # no binary inside
        (wheel(b"#!/bin/sh\nexit 1\n"), {}),  # does not run
        (wheel(b"#!/bin/sh\necho other tool\n"), {}),  # is not ffmpeg
        (b"not a zip", {}),
    ],
)
def test_bad_downloads_install_nothing(tmp_path, monkeypatch, data, pinned):
    monkeypatch.setattr(tool.shutil, "which", lambda name: None)
    pin(monkeypatch, data, **pinned)
    tools = tmp_path / "tools"
    with pytest.raises((tool.ExtractError, zipfile.BadZipFile)):
        tool.ensure_ffmpeg(tools, opener=Opener(data))
    assert not list(tools.rglob("ffmpeg")) and not list(tools.glob(".ffmpeg-download-*"))


def test_download_can_be_refused_and_unknown_platforms_are_named(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(tool.shutil, "which", lambda name: None)
    opener = Opener(wheel())
    with pytest.raises(tool.ExtractError, match="--no-download"):
        tool.ensure_ffmpeg(tmp_path / "tools", download=False, opener=opener)
    monkeypatch.setattr(tool.platform, "system", lambda: "Plan9")
    with pytest.raises(tool.ExtractError, match="No pinned ffmpeg build for Plan9"):
        tool.ensure_ffmpeg(tmp_path / "tools", opener=opener)
    assert opener.urls == []
    video = tmp_path / "v.mp4"
    video.write_bytes(b"x")
    code = tool.main(
        [str(video), str(tmp_path / "o"), "--frames", "1", "--no-download", "--tools-dir", "t"]
    )
    assert code == 1 and "Frame extraction failed" in capsys.readouterr().err


@pytest.mark.parametrize(
    "error",
    [
        zipfile.BadZipFile("File is not a zip file"),
        NotADirectoryError(20, "Not a directory"),
        urllib.error.URLError("no route"),
        subprocess.TimeoutExpired("ffmpeg", 600),
    ],
)
def test_the_command_reports_anticipated_failures_without_a_traceback(
    tmp_path, monkeypatch, capsys, error
):
    def fails(*_, **__):
        raise error

    video = tmp_path / "v.mp4"
    video.write_bytes(b"x")
    arguments = [str(video), str(tmp_path / "o"), "--frames", "1"]
    monkeypatch.setattr(tool, "ensure_ffmpeg", fails)
    assert tool.main(arguments) == 1
    assert capsys.readouterr().err.startswith("Frame extraction failed: ")
    monkeypatch.setattr(tool, "ensure_ffmpeg", lambda *_, **__: "ffmpeg")
    monkeypatch.setattr(tool, "extract", fails)
    assert tool.main(arguments) == 1
    assert capsys.readouterr().err.startswith("Frame extraction failed: ")


def test_an_oversized_download_is_abandoned_at_its_recorded_size(tmp_path, monkeypatch):
    class Endless:
        served = 0

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def read(self, count):
            Endless.served += count
            return bytes(count)

    monkeypatch.setattr(tool.shutil, "which", lambda name: None)
    pin(monkeypatch, b"", digest="0" * 64, size=3 << 20)
    tools = tmp_path / "tools"
    with pytest.raises(tool.ExtractError, match="larger than its recorded size"):
        tool.ensure_ffmpeg(tools, opener=lambda url, timeout: Endless())
    # Reading stops with the first chunk past the recorded size.
    assert Endless.served == 4 << 20
    assert not list(tools.rglob("ffmpeg")) and not list(tools.glob(".ffmpeg-download-*"))


@pytest.mark.parametrize("frames", [[], list(range(9)), [3, 3], [-1], [1_000_001], [1.0], [True]])
def test_frame_requests_are_bounded(tmp_path, frames):
    video = tmp_path / "v.mp4"
    video.write_bytes(b"x")
    with pytest.raises(tool.ExtractError):
        tool.extract(video, tmp_path / "out", frames, ffmpeg="/nonexistent")
    assert not (tmp_path / "out").exists()


def test_other_argument_rejections(tmp_path):
    video = tmp_path / "v.mp4"
    video.write_bytes(b"x")
    with pytest.raises(tool.ExtractError, match="not a regular file"):
        tool.extract(tmp_path / "absent.mp4", tmp_path / "out", [0], ffmpeg="/nonexistent")
    (tmp_path / "folder.mp4").mkdir()
    with pytest.raises(tool.ExtractError, match="not a regular file"):
        tool.extract(tmp_path / "folder.mp4", tmp_path / "out", [0], ffmpeg="/nonexistent")
    with pytest.raises(tool.ExtractError, match="plane must be single, a or b"):
        tool.extract(video, tmp_path / "out", [0], plane="c", ffmpeg="/nonexistent")
    assert not (tmp_path / "out").exists()


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg on PATH")
def test_real_extraction_writes_gray_pngs_and_an_unattested_template(tmp_path, monkeypatch):
    ffmpeg = tool.ensure_ffmpeg(tmp_path / "tools", download=False)
    video = tmp_path / "clip.mp4"
    made = subprocess.run(
        [
            str(ffmpeg), "-nostdin", "-v", "error", "-f", "lavfi",
            "-i", "testsrc=size=160x120:rate=10:duration=2",
            "-metadata", "title=SENTINEL-NAME", "-pix_fmt", "yuv420p", str(video),
        ],
        capture_output=True,
        check=False,
    )  # fmt: skip
    if made.returncode != 0:
        pytest.skip("this ffmpeg cannot encode the synthetic clip")
    out = tmp_path / "out"
    commands = []
    real = subprocess.run

    def recorded(command, **options):
        commands.append(command)
        return real(command, **options)

    monkeypatch.setattr(tool.subprocess, "run", recorded)
    template = tool.extract(video, out, [12, 3], ffmpeg=ffmpeg)
    monkeypatch.undo()
    # Some ffmpeg builds copy container text into a PNG unless told not to, so
    # the request itself is checked as well as the bytes this build wrote.
    assert len(commands) == 2
    for command in commands:
        text = " ".join(command)
        assert "-map_metadata -1" in text and "-map_chapters -1" in text
        assert "-fflags +bitexact" in text and "-flags:v +bitexact" in text
    names = sorted(p.name for p in out.iterdir())
    assert names == [
        "extraction.json",
        "frame-000003.png",
        "frame-000012.png",
        "request.template.json",
    ]
    for name in names[1:3]:
        data = (out / name).read_bytes()
        assert data[:8] == b"\x89PNG\r\n\x1a\n" and b"SENTINEL" not in data
        width, height, depth, color = struct.unpack(">IIBB", data[16:26])
        assert (width, height, depth, color) == (160, 120, 8, 0)
    assert (out / "frame-000003.png").read_bytes() != (out / "frame-000012.png").read_bytes()
    assert json.loads((out / "request.template.json").read_text()) == template
    (plane,) = template["planes"]
    # The helper never attests, crops or declares a scope for the operator.
    assert plane["identifiers_removed"] is False and plane["crop"] is None
    assert template["scope"].startswith("REPLACE") and "container" not in plane
    assert plane["frames"] == [
        {"path": "frame-000003.png", "index": 3},
        {"path": "frame-000012.png", "index": 12},
    ]
    record = json.loads((out / "extraction.json").read_text())
    assert record["video_sha256"] == hashlib.sha256(video.read_bytes()).hexdigest()
    assert (
        record["frames"][0]["sha256"]
        == hashlib.sha256((out / "frame-000003.png").read_bytes()).hexdigest()
    )
    # Deterministic: a second run writes the same bytes.
    again = tmp_path / "again"
    tool.extract(video, again, [3], ffmpeg=ffmpeg)
    assert (again / "frame-000003.png").read_bytes() == (out / "frame-000003.png").read_bytes()
    with pytest.raises(tool.ExtractError, match="past the end"):
        tool.extract(video, tmp_path / "late", [500], ffmpeg=ffmpeg)
    assert not list((tmp_path / "late").glob("*.png"))
    # A video beside its frames is named as the container to hash at admission.
    shutil.copy(video, again / "clip.mp4")
    beside = tool.extract(again / "clip.mp4", again, [3], ffmpeg=ffmpeg)
    assert beside["planes"][0]["container"] == "clip.mp4"
