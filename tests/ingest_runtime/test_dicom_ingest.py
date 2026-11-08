"""Bounded local DICOM converter vertical tracer (classic CT/MR, synthetic only).

Exercises the phase4 contract: a synthetic oblique classic CT series is
converted to a blank-header NIfTI bundle with a whitelisted safe manifest and
admitted through the real InstalledNiftiSourceStore. Synthetic data only; no
clinical reads, no patient data, no fixtures in git.

Run with:
  env -u PYTHONPATH -u PYTHONHOME SELDINGER_RUN_INGEST_TESTS=1 \
      .runtime/ingest-runtime/bin/python -m pytest \
      tests/ingest_runtime/test_dicom_ingest.py -q
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

import pytest

if os.environ.get("SELDINGER_RUN_INGEST_TESTS") != "1":
    pytest.skip("Requires isolated ingest runtime", allow_module_level=True)

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import numpy as np
import pydicom
from pydicom.uid import (
    CTImageStorage,
    ExplicitVRLittleEndian,
    MRImageStorage,
)

from planner.dicom_ingest import convert_series

SCOPE = "synthetic"

# Oblique LPS geometry: row/column direction cosines with non-trivial tilt.
ROW_DIR = np.array([0.8, 0.6, 0.0])
ROW_DIR = ROW_DIR / np.linalg.norm(ROW_DIR)
COL_DIR = np.array([-0.36, 0.48, 0.8])
COL_DIR = COL_DIR / np.linalg.norm(COL_DIR)
assert abs(float(np.dot(ROW_DIR, COL_DIR))) < 1e-9
NORMAL = np.cross(ROW_DIR, COL_DIR)
IPP0 = np.array([-23.4, 17.9, -5.2])
PS_ROW = 0.55  # spacing between rows (along COL_DIR)
PS_COL = 0.75  # spacing between columns (along ROW_DIR)
GAP = 1.1
ROWS, COLS, SLICES = 4, 5, 6
SLOPE, INTERCEPT = 2.0, -1024.0


def _expected_raw(j: int, i: int, k: int) -> int:
    return (j * 7 + i * 13 + k * 29) % 4096 - 2048


def _expected_value(j: int, i: int, k: int) -> float:
    return SLOPE * _expected_raw(j, i, k) + INTERCEPT


def _lps_of_voxel(j: int, i: int, k: int) -> np.ndarray:
    return IPP0 + i * PS_COL * ROW_DIR + j * PS_ROW * COL_DIR + k * GAP * NORMAL


def _make_slice(k: int) -> pydicom.dataset.FileDataset:
    raw = np.array(
        [[_expected_raw(j, i, k) for i in range(COLS)] for j in range(ROWS)],
        dtype="<i2",
    )
    from pydicom.dataset import Dataset

    ds = Dataset()
    ds.SOPClassUID = CTImageStorage
    ds.SOPInstanceUID = f"1.2.826.0.1.{k}"
    ds.Modality = "CT"
    ds.StudyInstanceUID = "1.2.826.0.10"
    ds.SeriesInstanceUID = "1.2.826.0.11"
    ds.FrameOfReferenceUID = "1.2.826.0.12"
    ds.Rows = ROWS
    ds.Columns = COLS
    ds.ImagePositionPatient = [float(v) for v in IPP0 + k * GAP * NORMAL]
    ds.ImageOrientationPatient = [float(v) for v in [*ROW_DIR, *COL_DIR]]
    ds.PixelSpacing = [PS_ROW, PS_COL]
    ds.SliceThickness = GAP
    ds.BitsAllocated = 16
    ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 1
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.RescaleSlope = SLOPE
    ds.RescaleIntercept = INTERCEPT
    ds.PixelData = raw.tobytes()
    ds.file_meta = pydicom.dataset.FileMetaDataset()
    ds.file_meta.MediaStorageSOPClassUID = CTImageStorage
    ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    return ds


@pytest.fixture()
def series_dir(tmp_path: Path) -> Path:
    """Synthetic oblique CT series with deliberately shuffled filenames."""
    d = tmp_path / "series"
    d.mkdir()
    for k in range(SLICES):
        name = f"scan-{((k * 37) % SLICES):02d}-x.dcm"
        pydicom.dcmwrite(d / name, _make_slice(k), enforce_file_format=True)
    return d


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_tracer_synthetic_oblique_series_admits_real_store(tmp_path: Path, series_dir: Path):
    output_root = tmp_path / "out"
    bundle = convert_series(series_dir, output_root, "tracer-ct", scope=SCOPE)
    assert bundle == output_root / "tracer-ct"
    assert bundle.is_dir()

    from planner.image_source import InstalledNiftiSourceStore

    manifest, manifest_sha, paths = InstalledNiftiSourceStore(bundle, source_id="tracer-ct").load()
    assert manifest["clinical_validation"] is False
    assert manifest_sha == _sha256(bundle / "manifest.json")
    image_path = paths["image"]
    assert image_path.name == manifest["image"]["filename"]
    assert _sha256(image_path) == manifest["image"]["sha256"]

    # Manifest is a whitelisted object with no filenames, paths, UIDs or
    # arbitrary operator text.
    allowed_top = {
        "version",
        "clinical_validation",
        "application_installation",
        "scope",
        "method",
        "image",
        "crop",
        "source_provenance",
    }
    assert set(manifest) <= allowed_top
    provenance = manifest["source_provenance"]
    assert set(provenance) <= {
        "type",
        "modality",
        "slice_count",
        "file_count",
        "input_aggregate_sha256",
        "rescale_mode",
        "rescale_slope",
        "rescale_intercept",
    }
    blob = json.dumps(manifest)
    assert "scan-" not in blob
    assert "1.2.840" not in blob
    assert ".dcm" not in blob
    assert str(series_dir) not in blob
    assert manifest["scope"] == SCOPE
    assert manifest["source_provenance"]["modality"] == "CT"
    assert manifest["source_provenance"]["slice_count"] == SLICES

    import nibabel as nib

    img = nib.load(image_path)  # type: ignore[no-untyped-call]
    assert img.shape == (COLS, ROWS, SLICES)
    assert manifest["image"]["shape_xyz"] == [COLS, ROWS, SLICES]
    assert manifest["image"]["dtype"] == "int32"
    assert manifest["image"]["spatial_units"] == "mm"

    # Exact LPS -> RAS affine: R = diag(-1,-1,1) applied to the composed
    # LPS mapping (column direction along IOP row vector, etc.).
    flip = np.diag([-1.0, -1.0, 1.0])
    expected_affine = np.eye(4)
    expected_affine[:3, :3] = flip @ np.column_stack(
        [ROW_DIR * PS_COL, COL_DIR * PS_ROW, NORMAL * GAP]
    )
    expected_affine[:3, 3] = flip @ IPP0
    assert np.array_equal(img.affine, expected_affine.astype("float32").astype("float64"))

    # Exact rescaled pixel values, native orientation.
    data = np.asanyarray(img.dataobj)
    for k in (0, SLICES - 1):
        for j in (0, ROWS - 1):
            for i in (0, COLS - 1):
                assert data[i, j, k] == _expected_value(j, i, k)
                world = img.affine @ np.array([i, j, k, 1.0])
                lps = np.array(_lps_of_voxel(j, i, k))
                assert np.allclose(world[:3], flip @ lps, atol=1e-5)

    # Sentinel metadata removed: blank free-text header fields, no extensions.
    header = img.header
    for field in ("descrip", "aux_file", "db_name"):
        assert bytes(header[field]).strip(b"\x00 ") == b""
    assert len(header.extensions) == 0


def test_tracer_mr_series_admits_real_store(tmp_path: Path):
    d = tmp_path / "mr"
    d.mkdir()
    for k in range(3):
        ds = _make_slice(k)
        ds.SOPClassUID = MRImageStorage
        ds.file_meta.MediaStorageSOPClassUID = MRImageStorage
        ds.Modality = "MR"
        ds.SOPInstanceUID = f"1.2.826.0.2.{k}"
        ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
        pydicom.dcmwrite(d / f"mr-{k}.dcm", ds, enforce_file_format=True)
    bundle = convert_series(d, tmp_path / "out", "tracer-mr", scope=SCOPE)
    from planner.image_source import InstalledNiftiSourceStore

    manifest, _, _ = InstalledNiftiSourceStore(bundle, source_id="tracer-mr").load()
    assert manifest["source_provenance"]["modality"] == "MR"


def test_convert_series_refuses_existing_destination(tmp_path: Path, series_dir: Path):
    output_root = tmp_path / "out"
    output_root.mkdir()
    (output_root / "tracer-ct").mkdir()
    with pytest.raises(ValueError, match="destination"):
        convert_series(series_dir, output_root, "tracer-ct", scope=SCOPE)


def test_convert_series_rejects_invalid_scope(tmp_path: Path, series_dir: Path):
    with pytest.raises(ValueError, match="scope"):
        convert_series(series_dir, tmp_path / "out", "x", scope="guess")


def test_convert_series_rejects_bad_source_id(tmp_path: Path, series_dir: Path):
    with pytest.raises(ValueError, match="source_id"):
        convert_series(series_dir, tmp_path / "out", "../escape", scope=SCOPE)


def test_deflated_syntax_is_rejected_before_any_dataset_decompression(tmp_path, monkeypatch):
    import io

    import pydicom.filereader
    from pydicom.uid import DeflatedExplicitVRLittleEndian

    from planner.dicom_ingest import _parse_file_meta

    ds = _make_slice(0)
    ds.file_meta.TransferSyntaxUID = DeflatedExplicitVRLittleEndian
    stream = io.BytesIO()
    pydicom.dcmwrite(stream, ds, enforce_file_format=True)
    calls = []

    def forbidden(*args, **kwargs):
        calls.append(True)
        raise AssertionError("Dataset decompression ran before admission")

    monkeypatch.setattr(pydicom.filereader.zlib, "decompress", forbidden)
    with pytest.raises(ValueError, match="transfer syntax"):
        _parse_file_meta(stream.getvalue())
    assert calls == []


@pytest.mark.parametrize(
    ("sop", "modality"),
    [
        ("1.2.840.10008.5.1.4.1.1.2.1", "CT"),
        ("1.2.840.10008.5.1.4.1.1.4.1", "MR"),
        ("1.2.840.10008.5.1.4.1.1.13.1.1", "XA"),
    ],
)
def test_enhanced_patient_geometry_frames_are_real_volume(tmp_path, sop, modality):
    from pydicom.dataset import Dataset
    from pydicom.sequence import Sequence

    ds = _make_slice(0)
    ds.SOPClassUID = sop
    ds.file_meta.MediaStorageSOPClassUID = ds.SOPClassUID
    ds.Modality = modality
    ds.NumberOfFrames = SLICES
    order = [3, 0, 5, 2, 1, 4]
    ds.PixelData = np.stack(
        [np.frombuffer(_make_slice(k).PixelData, dtype="<i2").reshape(ROWS, COLS) for k in order]
    ).tobytes()
    shared = Dataset()
    orientation = Dataset()
    orientation.ImageOrientationPatient = [*ROW_DIR, *COL_DIR]
    shared.PlaneOrientationSequence = Sequence([orientation])
    measures = Dataset()
    measures.PixelSpacing = [PS_ROW, PS_COL]
    shared.PixelMeasuresSequence = Sequence([measures])
    scaling = Dataset()
    scaling.RescaleSlope = SLOPE
    scaling.RescaleIntercept = INTERCEPT
    shared.PixelValueTransformationSequence = Sequence([scaling])
    ds.SharedFunctionalGroupsSequence = Sequence([shared])
    frames = []
    for k in order:
        frame = Dataset()
        position = Dataset()
        position.ImagePositionPatient = list(IPP0 + k * GAP * NORMAL)
        frame.PlanePositionSequence = Sequence([position])
        frames.append(frame)
    ds.PerFrameFunctionalGroupsSequence = Sequence(frames)
    for key in (
        "ImagePositionPatient",
        "ImageOrientationPatient",
        "PixelSpacing",
        "RescaleSlope",
        "RescaleIntercept",
    ):
        delattr(ds, key)
    source = tmp_path / "reconstruction"
    source.mkdir()
    pydicom.dcmwrite(source / "recon.dcm", ds, enforce_file_format=True)
    target = convert_series(source, tmp_path / "out", "x3d-reconstruction", scope="synthetic")
    import nibabel as nib

    image = nib.load(target / "volume.nii")
    data = np.asarray(image.dataobj)
    assert data.shape == (COLS, ROWS, SLICES)
    for k in range(SLICES):
        assert data[3, 2, k] == _expected_value(2, 3, k)
    assert (
        json.loads((target / "manifest.json").read_text())["source_provenance"]["modality"]
        == modality
    )


def test_lying_filemeta_group_length_cannot_hide_a_second_transfer_syntax(monkeypatch):
    import io
    import struct

    import pydicom.filereader

    from planner.dicom_ingest import _datasets

    ds = _make_slice(0)
    stream = io.BytesIO()
    pydicom.dcmwrite(stream, ds, enforce_file_format=True)
    data = stream.getvalue()
    end = 144 + struct.unpack_from("<I", data, 140)[0]
    uid = b"1.2.840.10008.1.2.1.99"
    uid += b"\0" * (len(uid) % 2)
    extra = struct.pack("<HH2sH", 2, 16, b"UI", len(uid)) + uid
    forged = data[:end] + extra + data[end:]
    calls = []

    def forbidden(*args, **kwargs):
        calls.append(True)
        raise AssertionError("Hidden transfer syntax triggered decompression")

    monkeypatch.setattr(pydicom.filereader.zlib, "decompress", forbidden)
    with pytest.raises(ValueError):
        _datasets([forged])
    assert calls == []


def test_native_pixel_data_with_extra_bytes_is_rejected_instead_of_trimmed(tmp_path):
    directory = tmp_path / "source"
    directory.mkdir()
    for k in range(SLICES):
        ds = _make_slice(k)
        ds.PixelData += b"\0\0"
        pydicom.dcmwrite(directory / f"frame-{k}.dcm", ds, enforce_file_format=True)
    with pytest.raises(ValueError, match="pixel"):
        convert_series(directory, tmp_path / "out", "excess-pixels", scope="synthetic")


def test_mixed_valid_bit_depths_are_not_one_consistent_encoding(tmp_path):
    directory = tmp_path / "source"
    directory.mkdir()
    for k in range(SLICES):
        ds = _make_slice(k)
        if k == 2:
            ds.BitsStored = 15
            ds.HighBit = 14
        pydicom.dcmwrite(directory / f"frame-{k}.dcm", ds, enforce_file_format=True)
    with pytest.raises(ValueError, match="encoding"):
        convert_series(directory, tmp_path / "out", "mixed-bits", scope="synthetic")


def test_real_cli_suppresses_lazy_parser_warnings_with_private_uid_values(tmp_path):
    import subprocess
    import sys

    source = tmp_path / "source"
    source.mkdir()
    needle = b"1.2.826.0.11"
    private = (b"PRIVATE" + b"X" * len(needle))[: len(needle)]
    for k in range(2):
        path = source / f"frame-{k}.dcm"
        pydicom.dcmwrite(path, _make_slice(k), enforce_file_format=True)
        data = path.read_bytes()
        assert needle in data
        path.write_bytes(data.replace(needle, private))
    env = {k: v for k, v in os.environ.items() if k not in {"PYTHONHOME", "PYTHONPATH"}}
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "planner.dicom_ingest",
            str(source),
            str(tmp_path / "out"),
            "--source-id",
            "bad-private-uid",
            "--scope",
            "synthetic",
        ],
        cwd=Path(__file__).resolve().parents[2],
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert result.returncode == 1
    assert result.stdout == ""
    assert private.decode() not in result.stderr
    assert (
        result.stderr
        == "DICOM conversion rejected; verify format, geometry, bounds and approved input scope.\n"
    )


def test_library_converter_sanitizes_internal_charset_failures(tmp_path):
    import struct

    from planner.dicom_ingest import IngestError

    source = tmp_path / "source"
    source.mkdir()
    value = b"abc\0xyz "
    for k in range(2):
        path = source / f"frame-{k}.dcm"
        pydicom.dcmwrite(path, _make_slice(k), enforce_file_format=True)
        data = path.read_bytes()
        end = 144 + struct.unpack_from("<I", data, 140)[0]
        element = struct.pack("<HH2sH", 8, 5, b"CS", len(value)) + value
        path.write_bytes(data[:end] + element + data[end:])
    with pytest.raises(IngestError, match="conversion rejected") as exc:
        convert_series(source, tmp_path / "out", "bad-charset", scope="synthetic")
    assert "abc" not in str(exc.value) and "xyz" not in str(exc.value)
