"""PR4 repro: BitsStored<BitsAllocated masking/sign-extension through pydicom.

Bounded independent repro of the PR4 reviewer allegation that pydicom 3.0.2
``pixel_array`` fails to mask unused high bits / sign-extend BitsStored=12
words when BitsAllocated=16. Uses only synthetic native little-endian
classic and enhanced datasets and the real ``convert_series`` output.

Run with:
  env -u PYTHONPATH -u PYTHONHOME SELDINGER_RUN_INGEST_TESTS=1 \
      .runtime/ingest-runtime/bin/python -m pytest \
      tests/ingest_runtime/test_dicom_stored_bits.py -q
"""

from __future__ import annotations

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
from pydicom.dataset import Dataset
from pydicom.sequence import Sequence
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian

from planner.dicom_ingest import convert_series

ROWS, COLS, SLICES = 3, 4, 2
SLOPE, INTERCEPT = 2.0, -1024.0
BITS_STORED, HIGH_BIT = 12, 11
# Non-zero garbage bits strictly above HighBit=11, deliberately varying.
GARBAGE = [0x0000, 0x1000, 0xF000, 0xE000, 0x8000, 0x7000]


def _stored_word(j: int, i: int, k: int) -> int:
    """A 12-bit stored word spanning both halves of the range (incl. >2047)."""
    return (j * 511 + i * 257 + k * 619 + 777) % 4096


def _raw_word(j: int, i: int, k: int) -> int:
    """Stored word OR'd with non-zero high garbage bits (must be ignored)."""
    return _stored_word(j, i, k) | GARBAGE[(j * COLS + i + k) % len(GARBAGE)]


def _expected_native(j: int, i: int, k: int, signed: bool) -> int:
    v = _stored_word(j, i, k)
    if signed and v >= (1 << BITS_STORED - 1):
        v -= 1 << BITS_STORED
    return v


def _expected_baked(j: int, i: int, k: int, signed: bool) -> float:
    return SLOPE * _expected_native(j, i, k, signed) + INTERCEPT


def _base_ds(signed: bool) -> Dataset:
    ds = Dataset()
    ds.SOPClassUID = CTImageStorage
    ds.Modality = "CT"
    ds.StudyInstanceUID = "1.2.826.0.20"
    ds.SeriesInstanceUID = "1.2.826.0.21"
    ds.FrameOfReferenceUID = "1.2.826.0.22"
    ds.SOPInstanceUID = "1.2.826.0.23"
    ds.Rows = ROWS
    ds.Columns = COLS
    ds.ImagePositionPatient = [-1.0, -2.0, 0.0]
    ds.ImageOrientationPatient = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
    ds.PixelSpacing = [1.0, 1.0]
    ds.SliceThickness = 1.0
    ds.BitsAllocated = 16
    ds.BitsStored = BITS_STORED
    ds.HighBit = HIGH_BIT
    ds.PixelRepresentation = 1 if signed else 0
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.RescaleSlope = SLOPE
    ds.RescaleIntercept = INTERCEPT
    ds.file_meta = pydicom.dataset.FileMetaDataset()
    ds.file_meta.MediaStorageSOPClassUID = CTImageStorage
    ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    return ds


def _classic_ds(signed: bool) -> Dataset:
    ds = _base_ds(signed)
    raw = np.array(
        [[_raw_word(j, i, 0) for i in range(COLS)] for j in range(ROWS)],
        dtype="<u2",
    )
    ds.PixelData = raw.tobytes()
    return ds


def _expected_classic_plane(signed: bool) -> np.ndarray:
    return np.array(
        [[_expected_baked(j, i, 0, signed) for i in range(COLS)] for j in range(ROWS)],
        dtype=np.int32,
    )


def _assert_plane(data, expected: np.ndarray) -> None:
    # NIfTI is (x=column, y=row, slice) with axes swapped from DICOM.
    np.testing.assert_array_equal(data[:, :, 0].T, expected)


@pytest.mark.parametrize("signed", [False, True])
def test_pydicom_pixel_array_masks_unused_high_bits(signed: bool):
    ds = _classic_ds(signed)
    pixels = ds.pixel_array
    expected = np.array(
        [[_expected_native(j, i, 0, signed) for i in range(COLS)] for j in range(ROWS)]
    )
    np.testing.assert_array_equal(pixels, expected)
    assert pixels.dtype == (np.int16 if signed else np.uint16)


@pytest.mark.parametrize("signed", [False, True])
def test_convert_series_classic_bakes_masked_values(tmp_path: Path, signed: bool):
    d = tmp_path / "series"
    d.mkdir()
    pydicom.dcmwrite(d / "s0.dcm", _classic_ds(signed), enforce_file_format=True)
    ds = _classic_ds(signed)
    ds.SOPInstanceUID = "1.2.826.0.24"
    ds.ImagePositionPatient = [-1.0, -2.0, 1.0]
    ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    pydicom.dcmwrite(d / "s1.dcm", ds, enforce_file_format=True)

    bundle = convert_series(
        d, tmp_path / "out", f"bits-{'s' if signed else 'u'}", scope="synthetic"
    )

    import nibabel as nib

    img = nib.load(bundle / "volume.nii")
    data = np.asanyarray(img.dataobj)
    assert data.shape == (COLS, ROWS, SLICES)
    _assert_plane(data[:, :, :1], _expected_classic_plane(signed))
    _assert_plane(data[:, :, 1:2], _expected_classic_plane(signed))


def test_convert_series_enhanced_bakes_masked_values(tmp_path: Path):
    """Enhanced multi-frame CT with BitsStored=12 and garbage high bits."""
    signed = True
    frames = [0, 1, 2, 3, 4, 5]
    planes = [
        np.array(
            [[_raw_word(j, i, k) for i in range(COLS)] for j in range(ROWS)],
            dtype="<u2",
        )
        for k in frames
    ]
    ds = _base_ds(signed)
    ds.SOPClassUID = "1.2.840.10008.5.1.4.1.1.2.1"
    ds.file_meta.MediaStorageSOPClassUID = ds.SOPClassUID
    ds.NumberOfFrames = len(frames)
    ds.PixelData = np.stack(planes).tobytes()

    shared = Dataset()
    orientation = Dataset()
    orientation.ImageOrientationPatient = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
    shared.PlaneOrientationSequence = Sequence([orientation])
    measures = Dataset()
    measures.PixelSpacing = [1.0, 1.0]
    shared.PixelMeasuresSequence = Sequence([measures])
    scaling = Dataset()
    scaling.RescaleSlope = SLOPE
    scaling.RescaleIntercept = INTERCEPT
    shared.PixelValueTransformationSequence = Sequence([scaling])
    ds.SharedFunctionalGroupsSequence = Sequence([shared])

    per_frame = []
    for k in frames:
        position = Dataset()
        position.ImagePositionPatient = [-1.0, -2.0, float(k)]
        frame = Dataset()
        frame.PlanePositionSequence = Sequence([position])
        per_frame.append(frame)
    ds.PerFrameFunctionalGroupsSequence = Sequence(per_frame)
    for key in (
        "ImagePositionPatient",
        "ImageOrientationPatient",
        "PixelSpacing",
        "RescaleSlope",
        "RescaleIntercept",
    ):
        delattr(ds, key)

    # Direct evidence at the pixel_array level for the enhanced dataset.
    pixels = ds.pixel_array
    expected_native = np.stack(
        [
            np.array(
                [[_expected_native(j, i, k, signed) for i in range(COLS)] for j in range(ROWS)]
            )
            for k in frames
        ]
    )
    np.testing.assert_array_equal(pixels, expected_native)

    source = tmp_path / "reconstruction"
    source.mkdir()
    pydicom.dcmwrite(source / "recon.dcm", ds, enforce_file_format=True)
    bundle = convert_series(source, tmp_path / "out", "bits-enhanced", scope="synthetic")

    import nibabel as nib

    data = np.asanyarray(nib.load(bundle / "volume.nii").dataobj)
    assert data.shape == (COLS, ROWS, len(frames))
    for k in frames:
        expected = np.array(
            [[_expected_baked(j, i, k, signed) for i in range(COLS)] for j in range(ROWS)],
            dtype=np.int32,
        )
        np.testing.assert_array_equal(data[:, :, k].T, expected)
