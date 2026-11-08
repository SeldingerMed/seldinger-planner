"""Negative/bound/cleanup/CLI guard tests for planner.dicom_ingest (synthetic only).

All data is generated locally as synthetic CT slices — no clinical reads, no
patient data. Runs in the isolated ingest runtime; heavy imports are gated
behind SELDINGER_RUN_INGEST_TESTS=1 like its sibling tracer module.

Run with:
  env -u PYTHONPATH -u PYTHONHOME SELDINGER_RUN_INGEST_TESTS=1 \
      .runtime/ingest-runtime/bin/python -m pytest \
      tests/ingest_runtime/test_dicom_guards.py -q
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
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian

import planner.dicom_ingest as ingest
from planner.dicom_ingest import IngestError, convert_series

SCOPE = "synthetic"
ROWS, COLS, SLICES = 4, 5, 6
SLOPE, INTERCEPT = 2.0, -1024.0
GAP = 1.1


def _raw(j: int, i: int, k: int) -> int:
    return (j * 7 + i * 13 + k * 29) % 4096 - 2048


def _make_slice(k: int) -> pydicom.dataset.FileDataset:
    """Axis-aligned LPS CT slice; per-slice geometry derived from k."""
    ds = pydicom.dataset.Dataset()
    ds.SOPClassUID = CTImageStorage
    ds.SOPInstanceUID = f"1.2.826.0.1.{k}"
    ds.Modality = "CT"
    ds.StudyInstanceUID = "1.2.826.0.10"
    ds.SeriesInstanceUID = "1.2.826.0.11"
    ds.FrameOfReferenceUID = "1.2.826.0.12"
    ds.Rows = ROWS
    ds.Columns = COLS
    ds.ImagePositionPatient = [0.0, 0.0, k * GAP]
    ds.ImageOrientationPatient = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
    ds.PixelSpacing = [0.5, 0.7]
    ds.BitsAllocated = 16
    ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 1
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.RescaleSlope = SLOPE
    ds.RescaleIntercept = INTERCEPT
    ds.PixelData = np.array(
        [[_raw(j, i, k) for i in range(COLS)] for j in range(ROWS)], dtype="<i2"
    ).tobytes()
    ds.file_meta = pydicom.dataset.FileMetaDataset()
    ds.file_meta.MediaStorageSOPClassUID = CTImageStorage
    ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    return ds


def _write_series(d: Path, slices) -> Path:
    d.mkdir(parents=True, exist_ok=True)
    for k, ds in enumerate(slices):
        pydicom.dcmwrite(d / f"slice-{k:02d}.dcm", ds, enforce_file_format=True)
    return d


@pytest.fixture()
def series_dir(tmp_path: Path) -> Path:
    return _write_series(tmp_path / "series", [_make_slice(k) for k in range(SLICES)])


@pytest.fixture()
def admitted_baseline(tmp_path: Path, series_dir: Path) -> Path:
    """Required successful baseline: guard negatives must not be vacuous."""
    bundle = convert_series(series_dir, tmp_path / "out", "guard-base", scope=SCOPE)
    assert (bundle / "volume.nii").is_file()
    assert (bundle / "manifest.json").is_file()
    return bundle


# ---------------------------------------------------------------- baselines


def test_baseline_success_required_before_negatives(admitted_baseline: Path):
    """A passing baseline proves every negative below exercises real pipeline."""
    manifest = (admitted_baseline / "manifest.json").read_text()
    assert '"slice_count": 6' in manifest


# ------------------------------------------------------------ format guards


def test_inconsistent_pixel_spacing_is_rejected(tmp_path: Path, series_dir: Path):
    ds = _make_slice(3)
    ds.PixelSpacing = [0.9, 0.7]  # differs from the rest of the series
    _write_series(
        tmp_path / "bad",
        [*[_make_slice(k) for k in range(6)]][:3] + [ds] + [_make_slice(k) for k in range(4, 6)],
    )
    with pytest.raises(IngestError, match="Mixed slice geometry"):
        convert_series(tmp_path / "bad", tmp_path / "out", "guard-spacing", scope=SCOPE)


def test_bitsstored_highbit_mismatch_is_rejected(tmp_path: Path, series_dir: Path):
    ds = _make_slice(0)
    ds.BitsStored = 12  # HighBit stays 15; stored-1 != HighBit
    _write_series(tmp_path / "bad", [ds, _make_slice(1), _make_slice(2)])
    with pytest.raises(IngestError, match="native scalar encoding"):
        convert_series(tmp_path / "bad", tmp_path / "out", "guard-bits", scope=SCOPE)


def test_missing_pixel_data_is_rejected(tmp_path: Path):
    ds = _make_slice(0)
    del ds.PixelData
    _write_series(tmp_path / "bad", [ds, _make_slice(1), _make_slice(2)])
    # Reject before any decoder attempts to access the missing pixel element.
    with pytest.raises(IngestError, match="pixel"):
        convert_series(tmp_path / "bad", tmp_path / "out", "guard-nopx", scope=SCOPE)


# -------------------------------------------------------- identity guards


def test_mixed_series_uid_is_rejected(tmp_path: Path, series_dir: Path):
    ds = _make_slice(3)
    ds.SeriesInstanceUID = "1.2.826.0.999"
    _write_series(
        tmp_path / "bad",
        [_make_slice(k) for k in range(3)] + [ds] + [_make_slice(k) for k in range(4, 6)],
    )
    with pytest.raises(IngestError, match="Mixed series"):
        convert_series(tmp_path / "bad", tmp_path / "out", "guard-mixeduid", scope=SCOPE)


# -------------------------------------------------------- geometry guards


def test_duplicate_slice_positions_are_rejected(tmp_path: Path, series_dir: Path):
    ds = _make_slice(5)
    ds.ImagePositionPatient = [0.0, 0.0, 4 * GAP]  # duplicates slice 4
    _write_series(tmp_path / "bad", [_make_slice(k) for k in range(5)] + [ds])
    with pytest.raises(IngestError, match="Duplicate or nonuniform"):
        convert_series(tmp_path / "bad", tmp_path / "out", "guard-dup", scope=SCOPE)


def test_nonuniform_slice_positions_are_rejected(tmp_path: Path, series_dir: Path):
    ds = _make_slice(5)
    ds.ImagePositionPatient = [0.0, 0.0, 5 * GAP + 0.05]  # off-grid gap
    _write_series(tmp_path / "bad", [_make_slice(k) for k in range(5)] + [ds])
    with pytest.raises(IngestError, match="Duplicate or nonuniform"):
        convert_series(tmp_path / "bad", tmp_path / "out", "guard-nonuni", scope=SCOPE)


def test_symlink_in_input_dir_is_rejected(tmp_path: Path, series_dir: Path):
    real = _make_slice(9)
    real.SOPInstanceUID = "1.2.826.0.1.9"
    real.file_meta.MediaStorageSOPInstanceUID = real.SOPInstanceUID
    pydicom.dcmwrite(tmp_path / "real.dcm", real, enforce_file_format=True)
    os.symlink(tmp_path / "real.dcm", series_dir / "linked.dcm")
    with pytest.raises(IngestError, match="links"):
        convert_series(series_dir, tmp_path / "out", "guard-linkin", scope=SCOPE)


def test_symlink_in_output_ancestry_is_rejected(tmp_path: Path, series_dir: Path):
    outside = tmp_path / "outside"
    outside.mkdir()
    root = tmp_path / "outlink"
    root.symlink_to(outside)
    with pytest.raises(IngestError, match="links"):
        convert_series(series_dir, root, "guard-linkout", scope=SCOPE)


# ------------------------------------------------------------- bound caps


def test_max_files_cap_is_enforced(tmp_path: Path, monkeypatch, series_dir: Path):
    monkeypatch.setattr(ingest, "MAX_FILES", 3)
    with pytest.raises(IngestError, match="file-count bound"):
        convert_series(series_dir, tmp_path / "out", "guard-capfiles", scope=SCOPE)


def test_max_total_voxels_cap_is_enforced(tmp_path: Path, monkeypatch, series_dir: Path):
    monkeypatch.setattr(ingest, "MAX_TOTAL_VOXELS", ROWS * COLS * 3)
    with pytest.raises(IngestError, match="voxel bound"):
        convert_series(series_dir, tmp_path / "out", "guard-capvox", scope=SCOPE)


def test_max_image_bytes_cap_is_enforced(tmp_path: Path, monkeypatch, series_dir: Path):
    monkeypatch.setattr(ingest, "MAX_IMAGE_BYTES", 100)
    with pytest.raises(IngestError, match="image byte bound"):
        convert_series(series_dir, tmp_path / "out", "guard-capbytes", scope=SCOPE)


# --------------------------------------------------- staging/cleanup guards


def test_failed_store_admission_cleans_staging_and_claims_nothing(
    tmp_path: Path, monkeypatch, series_dir: Path
):
    from planner import image_source

    def exploding_load(self):
        raise RuntimeError("simulated admission failure")

    monkeypatch.setattr(image_source.InstalledNiftiSourceStore, "load", exploding_load)
    output_root = tmp_path / "out"
    with pytest.raises(IngestError, match="conversion rejected"):
        convert_series(series_dir, output_root, "guard-cleanup", scope=SCOPE)
    assert not (output_root / "guard-cleanup").exists()
    leftovers = [p for p in output_root.glob("*") if p.name.startswith(".dicom-staging-")]
    assert leftovers == []


# ------------------------------------------------------- destination guards


def test_existing_destination_sentinel_is_untouched(tmp_path: Path, series_dir: Path):
    output_root = tmp_path / "out"
    output_root.mkdir()
    sentinel = output_root / "guard-sentinel"
    sentinel.write_text("do-not-touch")
    with pytest.raises(IngestError, match="destination"):
        convert_series(series_dir, output_root, "guard-sentinel", scope=SCOPE)
    assert sentinel.read_text() == "do-not-touch"


# -------------------------------------------------------------- CLI privacy


def test_cli_failure_output_is_sanitized(tmp_path: Path, capsys):
    secret_root = tmp_path / "root-PRIVATE-sentinel"
    secret_series = tmp_path / "series-topsecret-sentinel"
    rc = ingest.main(
        [
            str(secret_series),
            str(secret_root),
            "--source-id",
            "cli-guard",
            "--scope",
            "synthetic",
        ]
    )
    captured = capsys.readouterr()
    assert rc == 1
    assert captured.out == ""
    assert captured.err == (
        "DICOM conversion rejected; verify format, geometry, bounds and approved input scope.\n"
    )
    assert "Traceback" not in captured.err
    assert "PRIVATE" not in captured.err
    assert "topsecret" not in captured.err
    assert str(tmp_path) not in captured.err


# --------------------------------------------- per-slice rescale descriptor


def test_variable_rescale_is_described_accurately_not_as_constant(
    tmp_path: Path,
):
    """Per-slice linear rescale must not be summarized as one constant.

    Baked output pixels can use different linear coefficients per slice.
    The provenance must say per_frame_linear rather than publishing the first
    frame's coefficients as if they described the whole volume.
    """
    slices = []
    for k in range(4):
        ds = _make_slice(k)
        ds.RescaleSlope = 1.0 if k % 2 == 0 else 2.0
        ds.RescaleIntercept = 0.0 if k % 2 == 0 else -1024.0
        slices.append(ds)
    source = _write_series(tmp_path / "varrescale", slices)
    bundle = convert_series(source, tmp_path / "out", "guard-varrescale", scope=SCOPE)
    import json

    manifest = json.loads((bundle / "manifest.json").read_text())
    provenance = manifest["source_provenance"]
    assert provenance.get("rescale_mode") == "per_frame_linear", (
        "variable per-slice rescale must be declared per_frame_linear; "
        f"got provenance keys {sorted(provenance)}"
    )
    # A single fixed coefficient must not be published for variable series.
    for key in ("rescale_slope", "rescale_intercept"):
        assert provenance.get(key) is None, (
            f"constant {key} is misleading for variable-rescale series"
        )
