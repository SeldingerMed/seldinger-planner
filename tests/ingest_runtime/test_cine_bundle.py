"""The local cine bundle: one XA cine read into one file for the browser."""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import stat
from pathlib import Path

import pytest

if os.environ.get("SELDINGER_RUN_INGEST_TESTS") != "1":
    pytest.skip("Requires isolated ingest runtime", allow_module_level=True)

import numpy as np
import pydicom
from pydicom.encaps import encapsulate
from pydicom.uid import ExplicitVRLittleEndian, JPEGLosslessSV1
from test_projection_ingest import SENTINEL, classic

from planner.cine_bundle import (
    FORMAT,
    MIN_VIEW_DEPTH_MM,
    VIEW_LIMITS,
    encode_bundle,
    main,
    read_cine,
)
from planner.dicom_ingest import IngestError

ROWS, COLUMNS, FRAMES = 64, 80, 5


def pixels():
    y, x = np.mgrid[0:ROWS, 0:COLUMNS]
    return np.stack([((x * 3 + y * 2 + 17 * k) % 251).astype(np.uint8) for k in range(FRAMES)])


def cine(syntax=ExplicitVRLittleEndian, data=None, **change):
    ds = classic(9, **change)
    ds.Rows, ds.Columns, ds.NumberOfFrames = ROWS, COLUMNS, FRAMES
    frames = pixels() if data is None else data
    if syntax == JPEGLosslessSV1:
        ds.PixelData = encapsulate([lossless_jpeg(f) for f in frames], has_bot=True)
    else:
        ds.PixelData = frames.tobytes()
    for name, value in change.items():
        if value is None:
            if name in ds:
                delattr(ds, name)
        else:
            setattr(ds, name, value)
    ds.file_meta = pydicom.dataset.FileMetaDataset()
    ds.file_meta.MediaStorageSOPClassUID = ds.SOPClassUID
    ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    ds.file_meta.TransferSyntaxUID = syntax
    out = io.BytesIO()
    pydicom.dcmwrite(out, ds, enforce_file_format=True)
    return out.getvalue()


def lossless_jpeg(frame: np.ndarray) -> bytes:
    """An 8-bit lossless JPEG (process 14, predictor 1), written here from
    ITU-T T.81 so the decoder under test is checked against an independent
    encoder."""
    rows, columns = frame.shape
    # Huffman table: categories 0 to 8, each a 4-bit code.
    bits = [0, 0, 0, 9] + [0] * 12
    codes = {category: (category, 4) for category in range(9)}
    out = bytearray(b"\xff\xd8")
    out += b"\xff\xc3" + (11).to_bytes(2, "big") + bytes([8])
    out += rows.to_bytes(2, "big") + columns.to_bytes(2, "big") + bytes([1, 1, 0x11, 0])
    table = bytes([0x00]) + bytes(bits) + bytes(range(9))
    out += b"\xff\xc4" + (2 + len(table)).to_bytes(2, "big") + table
    out += b"\xff\xda" + (8).to_bytes(2, "big") + bytes([1, 1, 0x00, 1, 0, 0])
    acc, count, data = 0, 0, bytearray()

    def put(value, length):
        nonlocal acc, count
        for i in range(length - 1, -1, -1):
            acc = (acc << 1) | ((value >> i) & 1)
            count += 1
            if count == 8:
                data.append(acc)
                if acc == 0xFF:
                    data.append(0)
                acc, count = 0, 0

    image = frame.astype(int)
    for y in range(rows):
        for x in range(columns):
            if x == 0 and y == 0:
                predicted = 128
            elif y == 0:
                predicted = image[y, x - 1]
            elif x == 0:
                predicted = image[y - 1, x]
            else:
                predicted = image[y, x - 1]
            diff = int(image[y, x]) - int(predicted)
            category = abs(diff).bit_length()
            put(*codes[category])
            if category:
                put(diff if diff >= 0 else diff + (1 << category) - 1, category)
    if count:
        put((1 << (8 - count)) - 1, 8 - count)
    out += data + b"\xff\xd9"
    return bytes(out)


# Row and column spacing for a detector the browser admits (56 by 62 mm).
DETECTOR = {"ImagerPixelSpacing": ["0.88", "0.77"]}


def test_a_cine_is_read_with_its_times_and_view():
    data = cine(**DETECTOR)
    header, frames = read_cine(data)
    assert header["format"] == FORMAT
    assert header["source_sha256"] == hashlib.sha256(data).hexdigest()
    assert (header["frames"], header["rows"], header["columns"]) == (FRAMES, ROWS, COLUMNS)
    assert header["timing"] == "frame_time"
    assert header["times_ms"] == pytest.approx([k * 66.67 for k in range(FRAMES)])
    assert header["view"] == {
        "primary_deg": -30.5,
        "secondary_deg": 20.25,
        "source_detector_mm": 1195.0,
        "source_isocenter_mm": 765.0,
        "detector_width_mm": pytest.approx(0.77 * COLUMNS),
        "detector_height_mm": pytest.approx(0.88 * ROWS),
    }
    assert header["geometry"] == "fixed"
    assert header["identifiers"] == "not_carried"
    assert frames.shape == (FRAMES, ROWS, COLUMNS) and frames.dtype == np.uint8
    # One window over the whole cine: the order of brightness is kept.
    source = pixels().astype(int)
    assert np.all(
        np.diff(frames.reshape(-1)[np.argsort(source.reshape(-1), kind="stable")].astype(int)) >= 0
    )


def test_the_bundle_names_nothing_of_the_patient():
    header, frames = read_cine(cine())
    bundle = encode_bundle(header, frames)
    first, text, body = bundle.split(b"\n", 2)
    assert first.decode() == FORMAT
    assert json.loads(text) == header
    assert body == frames.tobytes()
    for forbidden in (SENTINEL.encode(), b"1.2.826", b"StudyInstance"):
        assert forbidden not in bundle[: len(first) + len(text) + 2]


def test_frame_time_vector_gives_the_recorded_times():
    vector = ["0", "33.3", "33.4", "66.7", "33.3"]
    header, _ = read_cine(cine(FrameTimeVector=vector, FrameTime=None))
    assert header["timing"] == "frame_time_vector"
    assert header["times_ms"] == pytest.approx([0, 33.3, 66.7, 133.4, 166.7])


def test_a_display_rate_is_not_a_time():
    header, _ = read_cine(cine(FrameTime=None, CineRate="15"))
    assert header["timing"] == "cine_rate" and header["times_ms"] is None
    header, _ = read_cine(cine(FrameTime=None))
    assert header["timing"] is None and header["times_ms"] is None


@pytest.mark.parametrize(
    "missing", ["DistanceSourceToPatient", "ImagerPixelSpacing", "PositionerPrimaryAngle"]
)
def test_a_cine_without_its_whole_view_has_none(missing):
    header, _ = read_cine(cine(**{missing: None}))
    assert header["view"] is None


@pytest.mark.parametrize(
    "given",
    [
        # Source to isocenter less than 1 mm short of the detector.
        {"DistanceSourceToDetector": "1195", "DistanceSourceToPatient": "1194.5"},
        # Source to isocenter under 100 mm.
        {"DistanceSourceToPatient": "80"},
        # Source to detector over 2000 mm.
        {"DistanceSourceToDetector": "2100", "DistanceSourceToPatient": "900"},
        # A detector over 600 mm wide (2048 columns at 0.3 mm).
        {"Columns": 2048, "ImagerPixelSpacing": ["0.88", "0.3"]},
        # A detector under 50 mm high.
        {"ImagerPixelSpacing": ["0.5", "0.77"]},
    ],
)
def test_a_view_the_browser_would_refuse_is_left_out(given):
    # Each differs in one way from a view that is written.
    assert read_cine(cine(**DETECTOR))[0]["view"] is not None
    shape = (FRAMES, ROWS, given.get("Columns", COLUMNS))
    data = cine(data=np.zeros(shape, dtype=np.uint8) + 7, **{**DETECTOR, **given})
    header, _ = read_cine(data)
    assert header["view"] is None


def test_the_view_limits_are_the_browsers():
    source = (Path(__file__).parents[2] / "web" / "src" / "carmGeometry.ts").read_text()
    block = source[source.index("export const VIEW_LIMITS") :]
    block = block[: block.index("} as const;")]
    stated = {
        name: (float(low), float(high))
        for name, low, high in re.findall(r"(\w+): \[(-?\d+), (-?\d+)\]", block)
    }
    assert stated == {k: tuple(map(float, v)) for k, v in VIEW_LIMITS.items()}
    assert f"const MIN_DEPTH_MM = {MIN_VIEW_DEPTH_MM:g};" in source


def test_a_moving_or_undeclared_positioner_is_named():
    assert read_cine(cine(PositionerMotion="DYNAMIC"))[0]["geometry"] == "moving"
    assert read_cine(cine(PositionerMotion=None))[0]["geometry"] == "unknown"


def test_bright_contrast_is_turned_round():
    plain = read_cine(cine())[1]
    bright = read_cine(cine(PhotometricInterpretation="MONOCHROME1"))[1]
    assert np.abs(plain.astype(int) + bright.astype(int) - 255).max() <= 1


def reference_window(stored: np.ndarray, monochrome1: bool) -> np.ndarray:
    """The window as first written: one float copy of the whole cine."""
    values = np.asarray(stored, dtype=np.float64)
    if monochrome1:
        values = values.max() - values
    low, high = np.percentile(values, [0.5, 99.5])
    scaled = np.clip((values - low) / max(high - low, 1e-9) * 255.0, 0, 255)
    return np.round(scaled).astype(np.uint8)


@pytest.mark.parametrize("bits", [8, 12, 16])
@pytest.mark.parametrize("photometric", ["MONOCHROME2", "MONOCHROME1"])
def test_the_window_is_unchanged_to_the_byte(bits, photometric):
    random = np.random.default_rng(bits)
    dtype = np.uint8 if bits == 8 else np.uint16
    stored = random.integers(0, 2**bits, size=(FRAMES, ROWS, COLUMNS)).astype(dtype)
    stored[1, :8, :8] = 0  # a few values at the ends, as on real frames
    stored[2, :8, :8] = 2**bits - 1
    allocated = 8 if bits == 8 else 16
    data = cine(
        data=stored,
        PhotometricInterpretation=photometric,
        BitsAllocated=allocated,
        BitsStored=bits,
        HighBit=bits - 1,
    )
    out = read_cine(data)[1]
    assert np.array_equal(out, reference_window(stored, photometric == "MONOCHROME1"))


def test_reading_a_cine_holds_no_float_copy_of_the_whole_cine():
    import tracemalloc

    frames, rows, columns = 24, 512, 512
    random = np.random.default_rng(5)
    stored = random.integers(0, 4096, size=(frames, rows, columns)).astype(np.uint16)
    ds = classic(9)
    ds.Rows, ds.Columns, ds.NumberOfFrames = rows, columns, frames
    ds.BitsAllocated, ds.BitsStored, ds.HighBit = 16, 12, 11
    ds.PixelData = stored.tobytes()
    ds.file_meta = pydicom.dataset.FileMetaDataset()
    ds.file_meta.MediaStorageSOPClassUID = ds.SOPClassUID
    ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    out = io.BytesIO()
    pydicom.dcmwrite(out, ds, enforce_file_format=True)
    data = out.getvalue()
    del ds, out
    tracemalloc.start()
    try:
        read_cine(data)
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    # One float64 copy of the whole cine alone is four times its 16-bit
    # size; reading stays below five times, everything included.
    assert peak < 5 * stored.nbytes, peak / stored.nbytes


def test_jpeg_lossless_cines_are_decoded_exactly():
    plain = read_cine(cine())
    packed = read_cine(cine(JPEGLosslessSV1))
    assert packed[0]["transfer_syntax"] == str(JPEGLosslessSV1)
    assert np.array_equal(packed[1], plain[1])


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (
            {"SOPClassUID": "1.2.840.10008.5.1.4.1.1.2"},
            "A classic X-ray angiography cine is required",
        ),
        ({"NumberOfFrames": 7}, "Pixel data could not be decoded (Explicit VR Little Endian)"),
        ({"PhotometricInterpretation": "RGB"}, "Single-sample monochrome pixel data required"),
    ],
)
def test_other_files_are_refused(change, message):
    with pytest.raises(IngestError) as caught:
        read_cine(cine(**change))
    assert str(caught.value) == message
    assert SENTINEL not in str(caught.value)


def test_a_cine_of_one_frame_is_refused():
    data = cine(data=pixels()[:1], NumberOfFrames=1)
    with pytest.raises(IngestError, match="A cine of 2 to 600 frames is required"):
        read_cine(data)


def test_the_command_writes_a_new_private_file(tmp_path, capsys):
    source = tmp_path / "cine.dcm"
    source.write_bytes(cine())
    out = tmp_path / "cine.bundle"
    assert main([str(source), str(out)]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["bundle_sha256"] == hashlib.sha256(out.read_bytes()).hexdigest()
    assert stat.S_IMODE(out.stat().st_mode) == 0o600
    assert main([str(source), str(out)]) == 2
    assert "exists" in capsys.readouterr().err


def test_the_command_names_no_value_when_reading_fails(tmp_path, capsys, monkeypatch):
    import planner.cine_bundle as bundle

    def broken(_data):
        raise ValueError(SENTINEL)

    monkeypatch.setattr(bundle, "read_cine", broken)
    source = tmp_path / "cine.dcm"
    source.write_bytes(cine())
    assert main([str(source), str(tmp_path / "out")]) == 2
    err = capsys.readouterr().err
    assert err.strip() == "error: the cine could not be read"
    assert not (tmp_path / "out").exists()
