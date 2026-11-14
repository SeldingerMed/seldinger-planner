"""Research data helpers for the Ljubljana evaluation. No network, no dataset files."""

import hashlib
import importlib.util
import json
import struct
import sys
from pathlib import Path

import pytest

RESEARCH = Path(__file__).resolve().parent.parent / "scripts" / "research"


def load(name):
    spec = importlib.util.spec_from_file_location(name, RESEARCH / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


fetch = load("fetch_ljubljana")
prepare = load("prepare_ljubljana")


def test_the_destination_must_be_outside_the_repository_and_off_its_device(tmp_path):
    repository = tmp_path / "repo"
    repository.mkdir()
    for inside in (repository, repository / "data" / "ljubljana"):
        with pytest.raises(fetch.FetchError, match="outside the repository"):
            fetch.outside_repository(inside, repository)
    # A sibling directory is outside, and still on the same device.
    with pytest.raises(fetch.FetchError, match="different storage device"):
        fetch.outside_repository(tmp_path / "elsewhere" / "ljubljana", repository)
    # The real repository is refused through a symlink as well.
    link = tmp_path / "link"
    link.symlink_to(fetch.REPOSITORY)
    with pytest.raises(fetch.FetchError, match="outside the repository"):
        fetch.outside_repository(link / "web")


def entry(path, data, lfs=True):
    item = {"type": "file", "path": path, "size": len(data)}
    if lfs:
        item["lfs"] = {"oid": hashlib.sha256(data).hexdigest()}
    return item


def test_listing_keeps_files_of_the_folder_and_refuses_anything_else(monkeypatch):
    good = [
        entry("ljubljana/subject01/volume.nii.gz", b"abc"),
        {"type": "directory", "path": "ljubljana/subject01"},
        entry("ljubljana/README.md", b"read me", lfs=False),
    ]
    seen = []
    served = {"entries": good}

    def get(url, limit):
        seen.append(url)
        return json.dumps(served["entries"]).encode()

    monkeypatch.setattr(fetch, "_get", get)
    files = fetch.listing("rev1")
    assert "/tree/rev1/ljubljana?" in seen[0]
    assert [item["path"] for item in files] == [
        "ljubljana/README.md",
        "ljubljana/subject01/volume.nii.gz",
    ]
    assert files[0]["listed_sha256"] is None
    assert files[1]["listed_sha256"] == hashlib.sha256(b"abc").hexdigest()
    for bad in (
        {"type": "file", "path": "ljubljana/../secrets", "size": 1},
        {"type": "file", "path": "other/file", "size": 1},
        {"type": "file", "path": "ljubljana", "size": 1},  # the folder itself as a file
        {"type": "file", "path": "/ljubljana/file", "size": 1},
        {"type": "file", "path": "ljubljana/file", "size": fetch.MAX_FILE_BYTES + 1},
        {"type": "file", "path": "ljubljana/file", "size": -1},
        {"type": "file", "path": "ljubljana/file", "size": True},
        {"type": "file", "path": None, "size": 1},
    ):
        served["entries"] = [*good, bad]
        with pytest.raises(fetch.FetchError, match="Unexpected listing entry"):
            fetch.listing("rev1")
    served["entries"] = [{"type": "directory", "path": "ljubljana/subject01"}]
    with pytest.raises(fetch.FetchError, match="Unexpected number of files"):
        fetch.listing("rev1")


def test_fetch_checks_every_file_and_records_a_manifest(tmp_path, monkeypatch):
    store = {
        "ljubljana/README.md": b"read me",
        "ljubljana/subject01/volume.nii.gz": b"volume bytes",
    }
    served = dict(store)
    calls = []

    def get(url, limit):
        calls.append(url)
        if "/api/" in url:
            return json.dumps(
                [entry(path, store[path], lfs=path.endswith(".gz")) for path in store]
            ).encode()
        path = url.split("/resolve/rev1/")[1]
        return served[path]

    monkeypatch.setattr(fetch, "_get", get)
    monkeypatch.setattr(fetch, "outside_repository", lambda destination, *_: destination)
    manifest = fetch.fetch(tmp_path / "out", "rev1")
    assert (tmp_path / "out" / "subject01" / "volume.nii.gz").read_bytes() == b"volume bytes"
    assert manifest == json.loads((tmp_path / "out" / "MANIFEST.json").read_text())
    assert manifest["revision"] == "rev1"
    assert manifest["total_bytes"] == 19
    assert manifest["files"] == [
        {"path": "README.md", "bytes": 7, "sha256": hashlib.sha256(b"read me").hexdigest()},
        {
            "path": "subject01/volume.nii.gz",
            "bytes": 12,
            "sha256": hashlib.sha256(b"volume bytes").hexdigest(),
        },
    ]
    # A second run keeps files that already match and downloads nothing.
    calls.clear()
    fetch.fetch(tmp_path / "out", "rev1")
    assert [url for url in calls if "/resolve/" in url] == []
    # A file whose bytes do not match the listed digest is not kept.
    (tmp_path / "out" / "subject01" / "volume.nii.gz").write_bytes(b"volume bytez")
    served["ljubljana/subject01/volume.nii.gz"] = b"wrong bytes!"
    with pytest.raises(fetch.FetchError, match="Size or digest mismatch"):
        fetch.fetch(tmp_path / "out", "rev1")
    assert not (tmp_path / "out" / "subject01" / "volume.nii.gz.partial").exists()
    # Nor is one of the wrong size, for a file the listing gives no digest for.
    served["ljubljana/README.md"] = b"read me, longer"
    (tmp_path / "out" / "README.md").unlink()
    with pytest.raises(fetch.FetchError, match="Size or digest mismatch"):
        fetch.fetch(tmp_path / "out", "rev1")
    assert not (tmp_path / "out" / "README.md").exists()


def frame_file(height, width, pixels=None, syntax=b"1.2.840.10008.1.2.1\x00"):
    pixels = pixels if pixels is not None else bytes(range(256)) * (height * width * 2 // 256 + 1)
    pixels = pixels[: height * width * 2]
    meta = b"\x02\x00\x10\x00UI" + struct.pack("<H", len(syntax)) + syntax
    header = bytes.fromhex("e07f1000") + b"OW\x00\x00" + struct.pack("<I", len(pixels))
    size = b"".join(
        bytes.fromhex(tag) + b"US\x02\x00" + struct.pack("<H", value)
        for tag, value in (("28001000", height), ("28001100", width))
    )
    return b"\x00" * 128 + b"DICM" + meta + size + header + pixels


def test_frame_pixels_reads_only_an_uncompressed_frame_of_the_stated_size(tmp_path):
    path = tmp_path / "frontal.dcm"
    path.write_bytes(frame_file(4, 6))
    pixels = prepare.frame_pixels(path, 4, 6)
    assert len(pixels) == 48
    assert pixels == (bytes(range(256)) * 2)[:48]
    # The same number of pixels in another shape is still the wrong frame.
    for height, width in ((4, 5), (6, 4), (8, 6), (3, 8), (400, 600)):
        with pytest.raises(prepare.PrepareError, match="Not an uncompressed 16-bit frame"):
            prepare.frame_pixels(path, height, width)
    # A file cut short inside the pixel data element's header is refused as
    # a frame, not passed on as a decoding error.
    short = bytearray(138)
    short[:8] = bytes.fromhex("e07f1000") + b"OW\x00\x00"
    short[128:132] = b"DICM"
    path.write_bytes(bytes(short))
    with pytest.raises(prepare.PrepareError, match="Not an uncompressed 16-bit frame"):
        prepare.frame_pixels(path, 8, 8)
    path.write_bytes(frame_file(4, 6))
    # A compressed transfer syntax, or a file that is not DICOM, is refused.
    path.write_bytes(frame_file(4, 6, syntax=b"1.2.840.10008.1.2.4.70"))
    with pytest.raises(prepare.PrepareError):
        prepare.frame_pixels(path, 4, 6)
    path.write_bytes(b"\x00" * 132 + frame_file(4, 6)[132:])
    with pytest.raises(prepare.PrepareError):
        prepare.frame_pixels(path, 4, 6)


def test_prepare_needs_all_ten_subjects_and_an_outside_destination(tmp_path, monkeypatch):
    with pytest.raises(fetch.FetchError):
        prepare.prepare(tmp_path, fetch.REPOSITORY / "data")
    monkeypatch.setattr(prepare, "outside_repository", lambda destination: destination)
    (tmp_path / "subject01").mkdir()
    with pytest.raises(prepare.PrepareError, match="Expected 10 subjects, found 1"):
        prepare.prepare(tmp_path, tmp_path / "out")
    assert not (tmp_path / "out").exists()


def test_the_destination_is_checked_again_once_it_exists(tmp_path, monkeypatch):
    # The first check sees a missing directory's ancestor. If the directory
    # then appears on the repository's device, the second check refuses it.
    repository = tmp_path / "repo"
    repository.mkdir()
    target = tmp_path / "mounted-later" / "ljubljana"
    with pytest.raises(fetch.FetchError, match="different storage device"):
        fetch.created_outside(target, repository)
    assert target.is_dir()
    seen = []

    def checked(destination, repository=None):
        seen.append(destination.exists())
        return destination

    monkeypatch.setattr(fetch, "outside_repository", checked)
    monkeypatch.setattr(
        fetch, "_get", lambda url, limit: json.dumps([entry("ljubljana/README.md", b"x")]).encode()
    )
    # The stand-in serves the listing for every request, so the fetch stops at
    # the first file. Both checks have run by then.
    with pytest.raises(fetch.FetchError, match="Size or digest mismatch"):
        fetch.fetch(tmp_path / "fresh", "rev1")
    assert seen == [False, True]


def test_prepare_reads_only_the_files_the_fetch_recorded(tmp_path, monkeypatch):
    monkeypatch.setattr(prepare, "outside_repository", lambda destination: destination)
    source = tmp_path / "raw"
    records = []
    for n in range(1, 11):
        for name in prepare.USED:
            path = source / f"subject{n:02d}" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            data = f"{n} {name}".encode()
            path.write_bytes(data)
            records.append(
                {
                    "path": f"subject{n:02d}/{name}",
                    "bytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                }
            )
    decoded = []
    monkeypatch.setattr(
        prepare, "prepare_subject", lambda subject, destination: decoded.append(subject.name)
    )
    with pytest.raises(prepare.PrepareError, match="no readable fetch manifest"):
        prepare.prepare(source, tmp_path / "out")
    (source / "MANIFEST.json").write_text(json.dumps({"files": records}))
    prepare.prepare(source, tmp_path / "out")
    assert decoded == [f"subject{n:02d}" for n in range(1, 11)]
    # One byte changed with the size kept, a file missing, and a file the
    # manifest does not list: each stops before anything is decoded.
    changed = source / "subject07" / "xrays" / "lateral.dcm"
    original = changed.read_bytes()
    for spoil, restore in (
        (lambda: changed.write_bytes(original[:-1] + b"?"), lambda: changed.write_bytes(original)),
        (changed.unlink, lambda: changed.write_bytes(original)),
        (
            lambda: (source / "MANIFEST.json").write_text(json.dumps({"files": records[:-1]})),
            lambda: (source / "MANIFEST.json").write_text(json.dumps({"files": records})),
        ),
    ):
        decoded.clear()
        spoil()
        with pytest.raises(prepare.PrepareError, match="Not the fetched file: subject"):
            prepare.prepare(source, tmp_path / "out")
        assert decoded == []
        restore()
    prepare.prepare(source, tmp_path / "out")
    assert len(decoded) == 10
