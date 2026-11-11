"""Synthetic pixel-frame admission: PNG frames and uncompressed DICOM XA frames."""

from __future__ import annotations

import errno
import hashlib
import json
import os
import struct
import subprocess
import sys
import zlib

import pytest

if os.environ.get("SELDINGER_RUN_INGEST_TESTS") != "1":
    pytest.skip("Requires isolated ingest runtime", allow_module_level=True)

import numpy as np
import pydicom
from pydicom.encaps import encapsulate
from pydicom.uid import (
    ExplicitVRBigEndian,
    ImplicitVRLittleEndian,
    JPEG2000Lossless,
    JPEGBaseline8Bit,
    JPEGLosslessSV1,
    RLELossless,
)
from test_projection_ingest import SENTINEL, classic, write

from planner import frame_ingest
from planner.dicom_ingest import IngestError
from planner.frame_ingest import admit_frames, decode_png, main
from planner.frame_source import InstalledFrameStore

ROWS, COLUMNS = 96, 128


@pytest.mark.parametrize("kind", ["fifo", "directory"])
def test_container_hash_refuses_nonregular_inputs_within_a_deadline(tmp_path, kind):
    target = tmp_path / "container"
    if kind == "fifo":
        if not hasattr(os, "mkfifo"):
            pytest.skip("POSIX FIFO required")
        os.mkfifo(target)
    else:
        target.mkdir()
    probe = """
import sys
from pathlib import Path
from planner.frame_ingest import _hash_file, IngestError
try:
    _hash_file(Path(sys.argv[1]))
except IngestError as error:
    assert 'Select a regular container file, without links' in str(error), str(error)
else:
    raise AssertionError('Non-regular container was accepted')
"""
    result = subprocess.run(
        [sys.executable, "-c", probe, str(target)],
        timeout=5,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def test_container_hash_closes_a_descriptor_when_stream_construction_fails(tmp_path, monkeypatch):
    target = tmp_path / "container"
    target.write_bytes(b"synthetic-container")
    captured = {}

    def fails(fd, *_, **__):
        captured["fd"] = fd
        raise RuntimeError("synthetic stream-construction failure")

    monkeypatch.setattr(frame_ingest.os, "fdopen", fails)
    with pytest.raises(RuntimeError, match="synthetic stream-construction failure"):
        frame_ingest._hash_file(target)
    with pytest.raises(OSError) as error:
        os.fstat(captured["fd"])
    assert error.value.errno == errno.EBADF


def image(seed, rows=ROWS, columns=COLUMNS):
    rng = np.random.default_rng(seed)
    return rng.integers(0, 256, size=(rows, columns), dtype=np.uint8)


def _chunk(kind, body):
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))


def png(array, *, filters=(0,), depth=8, color=0, interlace=0, text=None, split=False):
    """Stdlib PNG writer for 8-bit grayscale, with a chosen filter per row."""
    rows, columns = array.shape
    raw, previous = bytearray(), np.zeros(columns, dtype=np.int64)
    for r in range(rows):
        line = array[r].astype(np.int64)
        kind = filters[r % len(filters)]
        left = np.concatenate(([0], line[:-1]))
        up_left = np.concatenate(([0], previous[:-1]))
        if kind == 0:
            out = line
        elif kind == 1:
            out = line - left
        elif kind == 2:
            out = line - previous
        elif kind == 3:
            out = line - ((left + previous) >> 1)
        else:
            p = left + previous - up_left
            pa, pb, pc = abs(p - left), abs(p - previous), abs(p - up_left)
            predictor = np.where(
                (pa <= pb) & (pa <= pc), left, np.where(pb <= pc, previous, up_left)
            )
            out = line - predictor
        raw.append(kind)
        raw.extend((out & 255).astype(np.uint8).tobytes())
        previous = line
    data = zlib.compress(bytes(raw))
    parts = [data[: len(data) // 2], data[len(data) // 2 :]] if split else [data]
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", struct.pack(">IIBBBBB", columns, rows, depth, color, 0, 0, interlace))
        + (_chunk(b"tEXt", text) if text else b"")
        + b"".join(_chunk(b"IDAT", part) for part in parts)
        + _chunk(b"IEND", b"")
    )


def png_request(tmp_path, *, planes=None, scope="synthetic", **change):
    frames = []
    for index in (40, 7):
        (tmp_path / f"frame-{index:06d}.png").write_bytes(png(image(index)))
        frames.append({"path": f"frame-{index:06d}.png", "index": index})
    (tmp_path / "run.mp4").write_bytes(b"not decoded, only hashed" * 10)
    plane = {
        "plane": "single",
        "kind": "png",
        "container": "run.mp4",
        "crop": [8, 4, 100, 80],
        "redactions": [[0, 0, COLUMNS, 10], [20, 30, 5, 6]],
        "identifiers_removed": True,
        "frames": frames,
        **change,
    }
    path = tmp_path / "request.json"
    path.write_text(json.dumps({"scope": scope, "planes": [plane] if planes is None else planes}))
    return path


def expected(array, crop, redactions):
    out = array.copy()
    for x, y, width, height in redactions:
        out[y : y + height, x : x + width] = 0
    if crop:
        x, y, width, height = crop
        out = out[y : y + height, x : x + width]
    return out.tobytes()


@pytest.mark.parametrize("filters", [(0,), (1,), (2,), (3,), (4,), (0, 1, 2, 3, 4)])
def test_png_decoder_matches_every_filter(filters):
    array = image(3, 37, 53)
    rows, columns, data = decode_png(png(array, filters=filters, split=True, text=b"k\0" + b"v"))
    assert (rows, columns) == (37, 53)
    assert data == array.tobytes()


def test_png_decoder_rejects_what_it_does_not_admit():
    array = image(1, 16, 16)
    good = png(array)
    bad = [
        b"",
        b"GIF89a" + good,
        good[:-5],
        good[:40],
        png(array, depth=16),
        png(array, color=2),
        png(array, color=3),
        png(array, interlace=1),
        png(array, filters=(5,)),
        good.replace(b"IDAT", b"IDAT", 1)[:-20] + b"\0" * 20,
        # A flipped pixel byte breaks the chunk checksum.
        good[:50] + bytes([good[50] ^ 1]) + good[51:],
        # A row short.
        png(array)[:33] + _chunk(b"IDAT", zlib.compress(bytes(17 * 15))) + _chunk(b"IEND", b""),
        # More pixel data than the header declares.
        png(array)[:33] + _chunk(b"IDAT", zlib.compress(bytes(17 * 17))) + _chunk(b"IEND", b""),
        b"\x89PNG\r\n\x1a\n" + _chunk(b"IDAT", b"") + _chunk(b"IEND", b""),
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", struct.pack(">IIBBBBB", 5000, 16, 8, 0, 0, 0, 0))
        + _chunk(b"IDAT", zlib.compress(b""))
        + _chunk(b"IEND", b""),
    ]
    for data in bad:
        with pytest.raises(IngestError):
            decode_png(data)


def test_png_frames_are_redacted_cropped_and_bound(tmp_path):
    request = png_request(tmp_path)
    bundle = admit_frames(request, tmp_path / "installed", "tair-smoke")
    store = InstalledFrameStore(bundle.parent)
    manifest, _ = store.load("tair-smoke")
    assert manifest["method"] == "admitted_png_frames" and manifest["scope"] == "synthetic"
    assert manifest["clinical_validation"] is False
    assert manifest["biplane_linkage"] == "not_applicable"
    (plane,) = manifest["planes"]
    container = (tmp_path / "run.mp4").read_bytes()
    assert plane["container_sha256"] == hashlib.sha256(container).hexdigest()
    assert plane["container_bytes"] == len(container)
    assert (plane["rows"], plane["columns"]) == (80, 100) and plane["geometry"] is None
    assert plane["deidentification"] == {
        "basis": "operator_attested_crop_and_redaction",
        "burned_in_annotation": "not_declared",
        "source_rows": ROWS,
        "source_columns": COLUMNS,
        "crop": [8, 4, 100, 80],
        "redactions": [[0, 0, COLUMNS, 10], [20, 30, 5, 6]],
    }
    assert [frame["index"] for frame in plane["frames"]] == [7, 40]
    for frame in plane["frames"]:
        source = (tmp_path / f"frame-{frame['index']:06d}.png").read_bytes()
        assert frame["input_sha256"] == hashlib.sha256(source).hexdigest()
        want = expected(
            image(frame["index"]), [8, 4, 100, 80], [[0, 0, COLUMNS, 10], [20, 30, 5, 6]]
        )
        assert store.frame("tair-smoke", "single", frame["index"])[0] == want
        assert frame["sha256"] == hashlib.sha256(want).hexdigest()
    # Only the manifest and the processed frames are installed, privately.
    assert sorted(path.name for path in bundle.iterdir()) == [
        "frames.json",
        "single-000007.gray",
        "single-000040.gray",
    ]
    assert all(path.stat().st_mode & 0o077 == 0 for path in [bundle, *bundle.iterdir()])
    assert not [p for p in (tmp_path / "installed").iterdir() if p.name.startswith(".")]


def test_two_png_planes_and_cli(tmp_path, capsys):
    base = png_request(tmp_path)
    plane = json.loads(base.read_text())["planes"][0]
    request = png_request(
        tmp_path, planes=[{**plane, "plane": "a"}, {**plane, "plane": "b", "container": None}]
    )
    assert main([str(tmp_path / "out"), str(request), "--source-id", "bi-01"]) == 0
    manifest, _ = InstalledFrameStore(tmp_path / "out").load("bi-01")
    assert [p["plane"] for p in manifest["planes"]] == ["a", "b"]
    assert manifest["biplane_linkage"] == "operator_declared"
    assert manifest["planes"][1]["container_sha256"] is None
    # The destination is never replaced.
    assert main([str(tmp_path / "out"), str(request), "--source-id", "bi-01"]) == 1
    assert "rejected" in capsys.readouterr().err


ATTEST = "Operator attestation that identifiers were removed is required"
OUTSIDE = "Crop or redaction is outside the frame"
COUNT = "One to eight frames per plane required"
RELATIVE = "Input paths are relative to the request file"
SEVEN = {"path": "frame-000007.png", "index": 7}


# Each case names the guard that must refuse it. A later, more general check
# would refuse most of these too, and that is not the behavior under test.
@pytest.mark.parametrize(
    "change,message",
    [
        ({"identifiers_removed": False}, ATTEST),
        ({"identifiers_removed": "yes"}, "Invalid identifier attestation"),
        ({"identifiers_removed": 1}, "Invalid identifier attestation"),
        ({"crop": None}, "A PNG plane needs a recorded crop"),
        ({"crop": None, "redactions": []}, "A PNG plane needs a recorded crop"),
        ({"crop": [8, 4, 200, 80]}, OUTSIDE),
        ({"crop": [-1, 4, 100, 80]}, OUTSIDE),
        ({"crop": [8, 4, 100, 93]}, OUTSIDE),  # one row past the bottom edge
        ({"crop": [8, 4, 100.0, 80]}, OUTSIDE),
        ({"crop": [8, 4, 100]}, OUTSIDE),
        ({"crop": [8, 4, 60, 80]}, "Stored frames must be 64 to 1024 pixels per side"),
        ({"crop": [8, 4, 100, 63]}, "Stored frames must be 64 to 1024 pixels per side"),
        ({"redactions": [[0, 0, 500, 10]]}, OUTSIDE),
        ({"redactions": [[0, 0, 0, 10]]}, OUTSIDE),
        ({"redactions": [[127, 95, 2, 1]]}, OUTSIDE),  # one column past the right edge
        ({"redactions": [[0, 0, 4, 4]] * 17}, "Invalid redactions"),
        ({"redactions": None}, "Invalid redactions"),
        ({"frames": []}, COUNT),
        ({"frames": [SEVEN] * 2}, "Frame indexes must be distinct"),
        ({"frames": [{**SEVEN, "index": i} for i in range(9)]}, COUNT),
        ({"frames": [{**SEVEN, "index": -1}]}, "Invalid frame index"),
        ({"frames": [{**SEVEN, "index": 1_000_001}]}, "Invalid frame index"),
        ({"frames": [{**SEVEN, "index": 7.0}]}, "Invalid frame index"),
        ({"frames": [{**SEVEN, "index": True}]}, "Invalid frame index"),
        ({"frames": [{"path": "frame-000007.png"}]}, "Invalid frame request"),
        ({"frames": [{**SEVEN, "name": "x"}]}, "Invalid frame request"),
        ({"frames": [{**SEVEN, "path": "../frame-000007.png"}]}, RELATIVE),
        ({"frames": [{**SEVEN, "path": "sub/../frame-000007.png"}]}, RELATIVE),
        ({"frames": [{**SEVEN, "path": "/frame-000007.png"}]}, RELATIVE),
        ({"frames": [{**SEVEN, "path": ""}]}, RELATIVE),
        ({"frames": [{**SEVEN, "path": 7}]}, RELATIVE),
        ({"frames": [{**SEVEN, "path": "absent.png"}]}, "Select a regular projection file"),
        ({"frames": [{**SEVEN, "path": "run.mp4"}]}, "Select an 8-bit grayscale PNG frame"),
        ({"container": "absent.mp4"}, "Select a regular container file"),
        ({"container": "../run.mp4"}, RELATIVE),
        ({"plane": "c"}, "Invalid plane label"),
        ({"kind": "mp4"}, "Invalid plane request"),
        ({"path": "x.dcm"}, "Invalid plane request"),  # a DICOM field on a PNG plane
    ],
)
def test_png_requests_are_rejected_without_installing(tmp_path, change, message):
    (tmp_path / "sub").mkdir()
    request = png_request(tmp_path, **change)
    with pytest.raises(IngestError) as caught:
        admit_frames(request, tmp_path / "installed", "run-01")
    assert str(caught.value).startswith(message)
    assert not (tmp_path / "installed" / "run-01").exists()
    installed = tmp_path / "installed"
    assert not installed.exists() or not list(installed.iterdir())


def test_the_frame_index_bound_is_inclusive(tmp_path):
    request = png_request(tmp_path, frames=[{"path": "frame-000007.png", "index": 1_000_000}])
    bundle = admit_frames(request, tmp_path / "installed", "run-01")
    manifest = json.loads((bundle / "frames.json").read_text())
    assert [f["index"] for f in manifest["planes"][0]["frames"]] == [1_000_000]


def test_byte_bounds_refuse_before_installing(tmp_path, monkeypatch):
    request = png_request(tmp_path)
    size = (tmp_path / "frame-000007.png").stat().st_size
    monkeypatch.setattr(frame_ingest, "MAX_PNG_BYTES", size - 1)
    with pytest.raises(IngestError, match="Select an 8-bit grayscale PNG frame"):
        admit_frames(request, tmp_path / "installed", "run-01")
    monkeypatch.setattr(frame_ingest, "MAX_PNG_BYTES", size + 64)
    monkeypatch.setattr(frame_ingest, "MAX_MANIFEST_BYTES", 256)
    with pytest.raises(IngestError, match="Frame manifest byte bound exceeded"):
        admit_frames(request, tmp_path / "installed", "run-01")
    monkeypatch.setattr(frame_ingest, "MAX_REQUEST_BYTES", request.stat().st_size - 1)
    with pytest.raises(IngestError, match="Request byte bound exceeded"):
        admit_frames(request, tmp_path / "installed", "run-01")
    assert not (tmp_path / "installed").exists()
    monkeypatch.undo()
    assert admit_frames(request, tmp_path / "installed", "run-01").is_dir()


def test_a_published_bundle_that_fails_the_installed_reader_is_withdrawn(tmp_path, monkeypatch):
    request = png_request(tmp_path)
    read = frame_ingest.InstalledFrameStore.frame
    calls = []

    def second_frame_is_damaged(self, source_id, plane, index):
        calls.append(index)
        if len(calls) == 2:
            raise ValueError("frame failed its digest")
        return read(self, source_id, plane, index)

    monkeypatch.setattr(frame_ingest.InstalledFrameStore, "frame", second_frame_is_damaged)
    with pytest.raises(IngestError, match="Frame admission rejected"):
        admit_frames(request, tmp_path / "installed", "run-01")
    # Every published frame is read back, and a failure leaves nothing behind.
    assert calls == [7, 40]
    assert list((tmp_path / "installed").iterdir()) == []
    monkeypatch.undo()
    assert admit_frames(request, tmp_path / "installed", "run-01").is_dir()


def test_an_occupied_destination_is_never_replaced(tmp_path):
    request = png_request(tmp_path)
    installed = tmp_path / "installed"
    (installed / "run-01").mkdir(parents=True)  # empty, so a rename could replace it
    (tmp_path / "elsewhere").mkdir()
    os.symlink(tmp_path / "elsewhere", installed / "run-02")
    os.symlink(tmp_path / "nowhere", installed / "run-03")  # dangling
    for source_id in ("run-01", "run-02", "run-03"):
        with pytest.raises(IngestError, match="destination already exists"):
            admit_frames(request, installed, source_id)
    assert list((installed / "run-01").iterdir()) == []
    assert list((tmp_path / "elsewhere").iterdir()) == []
    assert not (tmp_path / "nowhere").exists()
    assert sorted(p.name for p in installed.iterdir()) == ["run-01", "run-02", "run-03"]


def test_request_level_rejections(tmp_path):
    base = png_request(tmp_path)
    plane = json.loads(base.read_text())["planes"][0]
    for body, message in (
        ({"scope": "private", "planes": [plane]}, "Invalid declared scope"),
        ({"scope": "synthetic", "planes": []}, "One or two planes required"),
        ({"scope": "synthetic", "planes": [plane, plane, plane]}, "One or two planes required"),
        ({"scope": "synthetic", "planes": [plane], "extra": 1}, "Invalid request fields"),
        ({"planes": [plane]}, "Invalid request fields"),
        # single + b
        ({"scope": "synthetic", "planes": [plane, {**plane, "plane": "b"}]}, "Frame admission"),
        ({"scope": "synthetic", "planes": [plane, plane]}, "Frame admission rejected"),
        ({"scope": "synthetic", "planes": ["single"]}, "Invalid plane request"),
        ([], "Invalid request fields"),
    ):
        base.write_text(json.dumps(body))
        with pytest.raises(IngestError) as caught:
            admit_frames(base, tmp_path / "installed", "run-01")
        assert str(caught.value).startswith(message), body
    base.write_text(json.dumps({"scope": "synthetic", "planes": [plane]}))
    for source_id in ("Run", "../x", "a", ""):
        with pytest.raises(IngestError, match="Invalid opaque source_id"):
            admit_frames(base, tmp_path / "installed", source_id)
    # Frames of one plane share their size.
    (tmp_path / "small.png").write_bytes(png(image(1, 90, 128)))
    odd = {**plane, "frames": [*plane["frames"], {"path": "small.png", "index": 99}]}
    base.write_text(json.dumps({"scope": "synthetic", "planes": [odd]}))
    with pytest.raises(IngestError, match="Frames of one plane must share their dimensions"):
        admit_frames(base, tmp_path / "installed", "run-01")
    link = tmp_path / "link.json"
    os.symlink(base, link)
    with pytest.raises(IngestError, match="Select a regular projection file"):
        admit_frames(link, tmp_path / "installed", "run-01")
    assert not (tmp_path / "installed").exists()


def xa(tmp_path, name="run.dcm", *, bits=8, frames=4, syntax=None, **change):
    rows, columns = 72, 64
    rng = np.random.default_rng(11)
    if bits == 8:
        stack = rng.integers(0, 256, size=(frames, rows, columns), dtype=np.uint8)
    else:
        stack = rng.integers(100, 3000, size=(frames, rows, columns), dtype=np.uint16)
    fields = {
        "Rows": rows,
        "Columns": columns,
        "NumberOfFrames": frames,
        "BitsAllocated": bits,
        "BitsStored": bits if bits == 8 else 12,
        "HighBit": 7 if bits == 8 else 11,
        "ImagerPixelSpacing": ["1.0", "1.0"],
        "PixelData": stack.astype("<u2" if bits == 16 else "u1").tobytes(),
        **change,
    }
    ds = classic(7, **fields)
    path = write(tmp_path / name, ds, *([syntax] if syntax else []))
    return path, stack


def dicom_request(tmp_path, **change):
    plane = {
        "plane": "single",
        "kind": "dicom",
        "path": "run.dcm",
        "frame_indexes": [2, 0],
        "crop": None,
        "redactions": [],
        "identifiers_removed": False,
        **change,
    }
    path = tmp_path / "request.json"
    path.write_text(json.dumps({"scope": "synthetic", "planes": [plane]}))
    return path


def test_dicom_frames_keep_calibrated_geometry_and_no_metadata(tmp_path):
    path, stack = xa(tmp_path)
    bundle = admit_frames(dicom_request(tmp_path), tmp_path / "installed", "xa-01")
    store = InstalledFrameStore(bundle.parent)
    manifest, _ = store.load("xa-01")
    (plane,) = manifest["planes"]
    assert manifest["method"] == "admitted_dicom_xa_frames"
    assert plane["container_sha256"] == hashlib.sha256(path.read_bytes()).hexdigest()
    assert plane["deidentification"]["basis"] == "dicom_declared_no_burned_in_annotation"
    assert plane["geometry"] == {
        "primary_deg": -30.5,
        "secondary_deg": 20.25,
        "source_detector_mm": 1195.0,
        "source_isocenter_mm": 765.0,
        "detector_width_mm": 64.0,
        "detector_height_mm": 72.0,
    }
    assert [frame["index"] for frame in plane["frames"]] == [0, 2]
    # 8-bit data is rescaled over the selected frames' own range, here 0..255.
    for index in (0, 2):
        assert store.frame("xa-01", "single", index)[0] == stack[index].tobytes()
    for item in bundle.iterdir():
        assert SENTINEL.encode() not in item.read_bytes()
        assert b"1.2.826" not in item.read_bytes()


def test_dicom_sixteen_bit_and_inverted_photometric(tmp_path):
    _, stack = xa(tmp_path, bits=16)
    bundle = admit_frames(dicom_request(tmp_path), tmp_path / "installed", "xa-16")
    chosen = stack[[0, 2]].astype(np.float64)
    low, high = chosen.min(), chosen.max()
    want = np.rint((stack[2] - low) * 255.0 / (high - low)).astype(np.uint8)
    store = InstalledFrameStore(bundle.parent)
    assert store.frame("xa-16", "single", 2)[0] == want.tobytes()

    (tmp_path / "m1").mkdir()
    _, stack = xa(tmp_path / "m1", PhotometricInterpretation="MONOCHROME1")
    bundle = admit_frames(dicom_request(tmp_path / "m1"), tmp_path / "installed", "xa-m1")
    assert (
        InstalledFrameStore(bundle.parent).frame("xa-m1", "single", 0)[0]
        == (255 - stack[0]).tobytes()
    )


def test_dicom_burned_in_annotation_needs_attested_redaction(tmp_path):
    for value in ("YES", None):
        directory = tmp_path / str(value)
        directory.mkdir()
        _, stack = xa(directory, BurnedInAnnotation=value)
        for change, message in (
            ({}, ATTEST),
            # Attested, but nothing was removed.
            ({"identifiers_removed": True}, "An attested plane needs a recorded crop or redaction"),
            ({"redactions": [[0, 0, 64, 8]]}, ATTEST),  # removed, but not attested
        ):
            with pytest.raises(IngestError) as caught:
                admit_frames(dicom_request(directory, **change), tmp_path / "installed", "burned")
            assert str(caught.value) == message
        request = dicom_request(directory, identifiers_removed=True, redactions=[[0, 0, 64, 8]])
        bundle = admit_frames(request, tmp_path / "installed", f"burned-{str(value).lower()}")
        manifest, _ = InstalledFrameStore(bundle.parent).load(bundle.name)
        record = manifest["planes"][0]["deidentification"]
        assert record["basis"] == "operator_attested_crop_and_redaction"
        assert record["burned_in_annotation"] == ("yes" if value else "unknown")
        data = InstalledFrameStore(bundle.parent).frame(bundle.name, "single", 0)[0]
        assert data == expected(stack[0], None, [[0, 0, 64, 8]])
        # Uncropped, so the calibrated geometry is kept.
        assert manifest["planes"][0]["geometry"] is not None


def test_dicom_crop_or_incomplete_geometry_is_uncalibrated(tmp_path):
    xa(tmp_path)
    cropped = admit_frames(
        dicom_request(tmp_path, crop=[0, 4, 64, 64]), tmp_path / "installed", "cropped"
    )
    plane = InstalledFrameStore(cropped.parent).load("cropped")[0]["planes"][0]
    assert plane["geometry"] is None and (plane["rows"], plane["columns"]) == (64, 64)
    for name, change in (
        ("no-angle", {"PositionerPrimaryAngle": None}),
        ("moving", {"PositionerMotion": "DYNAMIC"}),
        ("short-sid", {"DistanceSourceToDetector": "250.0", "DistanceSourceToPatient": "200.0"}),
    ):
        directory = tmp_path / name
        directory.mkdir()
        xa(directory, **change)
        bundle = admit_frames(dicom_request(directory), tmp_path / "installed", name)
        assert InstalledFrameStore(bundle.parent).load(name)[0]["planes"][0]["geometry"] is None


OUTSIDE_INSTANCE = "Frame index is outside the instance"
MONOCHROME = "Unsigned single-sample monochrome pixel data required"
LENGTH = "Pixel data length contradicts the frame dimensions"
RAW = "Uncompressed little-endian pixel data required"


@pytest.mark.parametrize(
    "request_change,dataset_change,syntax,message",
    [
        ({"frame_indexes": [4]}, {}, None, OUTSIDE_INSTANCE),
        ({"frame_indexes": [-1]}, {}, None, OUTSIDE_INSTANCE),
        ({"frame_indexes": []}, {}, None, COUNT),
        ({"frame_indexes": [0, 0]}, {}, None, "Frame indexes must be distinct"),
        ({"frame_indexes": [0.0]}, {}, None, COUNT),
        ({"frame_indexes": [True]}, {}, None, COUNT),
        (
            {"frame_indexes": list(range(9))},
            {"NumberOfFrames": 9, "PixelData": bytes(72 * 64 * 9)},
            None,
            COUNT,
        ),
        ({"frames": []}, {}, None, "Invalid plane request"),  # a PNG field on a DICOM plane
        ({"path": "../run.dcm"}, {}, None, RELATIVE),
        ({}, {"SamplesPerPixel": 3}, None, MONOCHROME),
        ({}, {"PhotometricInterpretation": "RGB"}, None, MONOCHROME),
        ({}, {"PixelRepresentation": 1}, None, MONOCHROME),
        ({}, {"BitsAllocated": 32}, None, MONOCHROME),
        ({}, {"BitsStored": 9}, None, MONOCHROME),
        ({}, {"PixelData": bytes(72 * 64 * 3)}, None, LENGTH),
        ({}, {"PixelData": bytes(72 * 64 * 4 + 2)}, None, LENGTH),
        # An odd total is padded to even on disk; two more bytes is not padding.
        (
            {"frame_indexes": [0]},
            {"Rows": 65, "Columns": 65, "NumberOfFrames": 1, "PixelData": bytes(65 * 65 + 3)},
            None,
            LENGTH,
        ),
        ({}, {"Modality": "CT"}, None, "Conflicting storage/modality identifiers"),
        ({}, {"PixelData": encapsulate([bytes(64)])}, JPEGLosslessSV1, RAW),
        ({}, {"PixelData": encapsulate([bytes(64)])}, JPEGBaseline8Bit, RAW),
        ({}, {"PixelData": encapsulate([bytes(64)])}, JPEG2000Lossless, RAW),
        ({}, {"PixelData": encapsulate([bytes(64)])}, RLELossless, RAW),
        ({}, {}, ExplicitVRBigEndian, "Unsupported transfer syntax"),
    ],
)
def test_dicom_requests_are_rejected(tmp_path, request_change, dataset_change, syntax, message):
    xa(tmp_path, syntax=syntax, **dataset_change)
    with pytest.raises(IngestError) as caught:
        admit_frames(dicom_request(tmp_path, **request_change), tmp_path / "installed", "xa-01")
    assert str(caught.value) == message
    assert SENTINEL not in str(caught.value) and "1.2.826" not in str(caught.value)
    assert not (tmp_path / "installed" / "xa-01").exists()


def test_dicom_odd_length_pixel_data_carries_one_padding_byte(tmp_path):
    stack = np.random.default_rng(5).integers(0, 256, size=(65, 65), dtype=np.uint8)
    fields = {"Rows": 65, "Columns": 65, "NumberOfFrames": 1, "PixelData": stack.tobytes()}
    path, _ = xa(tmp_path, **fields)
    # The writer padded the 4,225 pixel bytes to an even length.
    assert len(pydicom.dcmread(path).PixelData) == 65 * 65 + 1
    bundle = admit_frames(
        dicom_request(tmp_path, frame_indexes=[0]), tmp_path / "installed", "odd-01"
    )
    data = InstalledFrameStore(bundle.parent).frame(bundle.name, "single", 0)[0]
    assert data == stack.tobytes()


def test_dicom_implicit_little_endian_is_admitted(tmp_path):
    _, stack = xa(tmp_path, syntax=ImplicitVRLittleEndian)
    bundle = admit_frames(dicom_request(tmp_path), tmp_path / "installed", "implicit")
    assert (
        InstalledFrameStore(bundle.parent).frame("implicit", "single", 2)[0] == stack[2].tobytes()
    )


def test_mixed_kinds_are_rejected(tmp_path):
    xa(tmp_path)
    base = png_request(tmp_path)
    plane = json.loads(base.read_text())["planes"][0]
    dicom = json.loads(dicom_request(tmp_path).read_text())["planes"][0]
    base.write_text(
        json.dumps(
            {"scope": "synthetic", "planes": [{**plane, "plane": "a"}, {**dicom, "plane": "b"}]}
        )
    )
    with pytest.raises(IngestError):
        admit_frames(base, tmp_path / "installed", "mixed")
