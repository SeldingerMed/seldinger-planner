#!/usr/bin/env python3
"""Extract a few frames of an angiography video as 8-bit grayscale PNG.

The planner admits PNG and DICOM XA frames only and carries no video decoder.
This helper runs outside the app: one ffmpeg pass selects the requested frame
indexes, strips container metadata, and writes an admission request template next
to the PNGs. The template is deliberately incomplete. Admission is refused
until an operator has looked at the frames, entered the crop and any redaction
rectangles, and set ``identifiers_removed`` to true.

ffmpeg is taken from PATH. If it is absent, a pinned static build is
downloaded from PyPI (the ``imageio-ffmpeg`` wheel for this platform),
checked against its recorded SHA-256, and installed under
``.runtime/tools/``. Pass ``--no-download`` to refuse the download.

Stdlib only. Example:
  python3 scripts/extract_angio_frames.py RUN.mp4 OUT_DIR --frames 120 133
"""

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

FFMPEG_BUILD = "imageio-ffmpeg-0.8.1"
_HOST = "https://files.pythonhosted.org/packages/"
# (system, machine) -> (wheel path on PyPI, SHA-256, bytes), from the PyPI
# release metadata of imageio-ffmpeg 0.8.1.
_NAME = "imageio_ffmpeg-0.8.1-py3-none-"
FFMPEG_WHEELS = {
    ("Darwin", "arm64"): (
        "2b/47/9f9b654f853598bae0850fa22bba168103e45d31b5a2a893ed474f28d54a/"
        + _NAME
        + "macosx_12_0_arm64.whl",
        "5636d691e36e5274b13fe38182b1f627b2e35dcecc63944012c2470f9484fc45",
        22625474,
    ),
    ("Darwin", "x86_64"): (
        "da/24/2c3a7c69453bfb8374ddbbb5007346bad4a4247bc86882f3521cd615f929/"
        + _NAME
        + "macosx_10_13_x86_64.whl",
        "9538a10e598257263b5de1a1c1b86e7603417bc219245b1e279b452e5e48cc20",
        26974382,
    ),
    ("Linux", "x86_64"): (
        "de/0f/49292fbef69ee10ebcf97bb741602521caafcc6966d5fa1a2b868cc15655/"
        + _NAME
        + "manylinux_2_28_x86_64.whl",
        "050d6850601c3b3890bd2b28306f3b842b3daea390a561101174375a1c460bda",
        67998402,
    ),
    ("Linux", "aarch64"): (
        "53/02/e139e53a71f33f728cb2ce6c1124edc29e4c008427923f01a4d37f9a1867/"
        + _NAME
        + "manylinux_2_28_aarch64.whl",
        "fad3176f859b25869e60a8ed79957d4e3ed74a97a95e5f0cdcb91455f6c6d00e",
        60956631,
    ),
    ("Windows", "AMD64"): (
        "82/0c/a1d49f3dd2688bd750b4986f8e271ad11f8e729a896070ea25f587b44da8/"
        + _NAME
        + "win_amd64.whl",
        "f27ca4cb85e2d4946deedbce1a81245dfd942a2bcf94b53676fb3956aa95bf1b",
        38893483,
    ),
}
MAX_FRAMES = 8
MAX_FRAME_INDEX = 1_000_000
DEFAULT_TOOLS = Path(__file__).resolve().parent.parent / ".runtime" / "tools"


class ExtractError(Exception):
    pass


def _wheel():
    key = (platform.system(), platform.machine())
    if key not in FFMPEG_WHEELS:
        raise ExtractError(
            f"No pinned ffmpeg build for {key[0]} {key[1]}; install ffmpeg and put it on PATH"
        )
    return FFMPEG_WHEELS[key]


def _works(binary):
    try:
        done = subprocess.run(
            [str(binary), "-version"], capture_output=True, timeout=30, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return done.returncode == 0 and done.stdout.startswith(b"ffmpeg version")


def install_ffmpeg(tools_dir, *, opener=urllib.request.urlopen):
    """Download the pinned build, verify it, and install it under ``tools_dir``."""
    path, digest, size = _wheel()
    tools_dir = Path(tools_dir)
    target_dir = tools_dir / FFMPEG_BUILD
    target = target_dir / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    tools_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=tools_dir, prefix=".ffmpeg-download-") as scratch:
        wheel = Path(scratch) / "ffmpeg.whl"
        sha, total = hashlib.sha256(), 0
        with opener(_HOST + path, timeout=120) as response, wheel.open("wb") as out:
            while chunk := response.read(1 << 20):
                total += len(chunk)
                if total > size:
                    raise ExtractError("ffmpeg download is larger than its recorded size")
                sha.update(chunk)
                out.write(chunk)
        if total != size or sha.hexdigest() != digest:
            raise ExtractError("ffmpeg download failed its SHA-256 check; nothing was installed")
        with zipfile.ZipFile(wheel) as archive:
            members = [
                name
                for name in archive.namelist()
                if name.startswith("imageio_ffmpeg/binaries/ffmpeg-") and not name.endswith("/")
            ]
            if len(members) != 1:
                raise ExtractError("ffmpeg download has an unexpected layout")
            staged = Path(scratch) / "ffmpeg"
            with archive.open(members[0]) as source, staged.open("wb") as out:
                shutil.copyfileobj(source, out)
        staged.chmod(0o755)
        if not _works(staged):
            raise ExtractError("the downloaded ffmpeg does not run on this computer")
        target_dir.mkdir(exist_ok=True)
        os.replace(staged, target)
    return target


def ensure_ffmpeg(tools_dir=DEFAULT_TOOLS, *, download=True, opener=urllib.request.urlopen):
    """Path of a working ffmpeg: PATH first, then the installed pinned build."""
    found = shutil.which("ffmpeg")
    if found and _works(found):
        return Path(found)
    cached = Path(tools_dir) / FFMPEG_BUILD / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    if cached.is_file() and _works(cached):
        return cached
    if not download:
        raise ExtractError("ffmpeg is not installed and --no-download was given")
    print(f"ffmpeg not found; installing the pinned {FFMPEG_BUILD} build", file=sys.stderr)
    return install_ffmpeg(tools_dir, opener=opener)


def _sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        while chunk := stream.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def extract(video, out_dir, frames, *, plane="single", ffmpeg=None):
    """Write ``frame-NNNNNN.png`` per index and a request template. Returns it."""
    video, out_dir = Path(video), Path(out_dir)
    if not video.is_file():
        raise ExtractError("the video is not a regular file")
    if plane not in ("single", "a", "b"):
        raise ExtractError("plane must be single, a or b")
    if (
        not 1 <= len(frames) <= MAX_FRAMES
        or len(set(frames)) != len(frames)
        or any(type(n) is not int or not 0 <= n <= MAX_FRAME_INDEX for n in frames)
    ):
        raise ExtractError(f"give one to {MAX_FRAMES} distinct frame indexes, counted from 0")
    ffmpeg = ffmpeg or ensure_ffmpeg()
    out_dir.mkdir(parents=True, exist_ok=True)
    if any(out_dir.glob("frame-*.png")) or any(
        os.path.lexists(out_dir / name) for name in ("extraction.json", "request.template.json")
    ):
        raise ExtractError(
            "output directory already contains extraction artifacts; choose a fresh directory"
        )
    with tempfile.TemporaryDirectory(prefix=".extract-staging-", dir=out_dir) as directory:
        staging = Path(directory)
        indexes = sorted(frames)
        selection = "+".join(f"eq(n\\,{index})" for index in indexes)
        done = subprocess.run(
            [
                str(ffmpeg), "-nostdin", "-v", "error", "-y",
                "-i", str(video),
                "-map", "0:v:0", "-vf", f"select={selection}",
                "-frames:v", str(len(indexes)), "-fps_mode", "passthrough", "-start_number", "0",
                "-pix_fmt", "gray",
                # No container, stream or encoder text reaches the PNG.
                "-map_metadata", "-1", "-map_chapters", "-1",
                "-fflags", "+bitexact", "-flags:v", "+bitexact",
                "-f", "image2", "-c:v", "png",
                str(staging / "selected-%06d.png"),
            ],
            capture_output=True,
            timeout=600,
            check=False,
        )  # fmt: skip
        if done.returncode != 0:
            raise ExtractError("requested frames could not be extracted")
        records = []
        for ordinal, index in enumerate(indexes):
            selected = staging / f"selected-{ordinal:06d}.png"
            if not selected.is_file() or selected.stat().st_size == 0:
                raise ExtractError(f"frame {index} could not be extracted; is it past the end?")
            png = staging / f"frame-{index:06d}.png"
            selected.rename(png)
            records.append({"path": png.name, "index": index})
        # The video is referenced by a relative link only when it sits beside the
        # frames; otherwise its hash is recorded here and no container is named.
        beside = video.resolve().parent == out_dir.resolve()
        template = {
            "scope": "REPLACE: synthetic, public or authorized",
            "planes": [
                {
                    "plane": plane,
                    "kind": "png",
                    **({"container": video.name} if beside else {}),
                    "frames": records,
                    "crop": None,
                    "redactions": [],
                    "identifiers_removed": False,
                }
            ],
        }
        (staging / "request.template.json").write_text(json.dumps(template, indent=2) + "\n")
        (staging / "extraction.json").write_text(
            json.dumps(
                {
                    "video_sha256": _sha256(video),
                    "video_bytes": video.stat().st_size,
                    "frames": [
                        {**record, "sha256": _sha256(staging / record["path"])}
                        for record in records
                    ],
                },
                indent=2,
            )
            + "\n"
        )
        published = []
        try:
            for name in [r["path"] for r in records] + ["extraction.json", "request.template.json"]:
                target = out_dir / name
                # Same-filesystem hard links publish without overwriting a path
                # created after preflight. The request template is visible last.
                os.link(staging / name, target)
                published.append(target)
        except BaseException:
            for target in reversed(published):
                target.unlink(missing_ok=True)
            raise
        return template


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Extract a few frames of an angiography video as 8-bit grayscale PNG."
    )
    parser.add_argument("video")
    parser.add_argument("out_dir")
    parser.add_argument("--frames", type=int, nargs="+", required=True, metavar="INDEX")
    parser.add_argument("--plane", default="single", choices=("single", "a", "b"))
    parser.add_argument("--tools-dir", default=str(DEFAULT_TOOLS))
    parser.add_argument("--no-download", action="store_true")
    args = parser.parse_args(argv)
    try:
        ffmpeg = ensure_ffmpeg(args.tools_dir, download=not args.no_download)
        extract(args.video, args.out_dir, args.frames, plane=args.plane, ffmpeg=ffmpeg)
    except ExtractError as error:
        print(f"Frame extraction failed: {error}", file=sys.stderr)
        return 1
    except (zipfile.BadZipFile, OSError, subprocess.SubprocessError) as error:
        # A corrupt download, an unwritable tools or output directory, a
        # network failure, or an ffmpeg that cannot be started or times out.
        print(f"Frame extraction failed: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    print(
        "Frames written. Review them, then complete request.template.json "
        "(scope, crop, redactions, identifiers_removed) before admission."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
