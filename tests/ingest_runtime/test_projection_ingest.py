"""Synthetic projection XA geometry extraction. No patient data, no pixels retained."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

if os.environ.get("SELDINGER_RUN_INGEST_TESTS") != "1":
    pytest.skip("Requires isolated ingest runtime", allow_module_level=True)

import pydicom
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.sequence import Sequence
from pydicom.uid import (
    CTImageStorage,
    EnhancedXAImageStorage,
    ExplicitVRBigEndian,
    ExplicitVRLittleEndian,
    JPEGLosslessSV1,
    XRayAngiographicImageStorage,
)

from planner.dicom_ingest import IngestError
from planner.projection_ingest import convert_projection, main
from planner.projection_source import InstalledProjectionStore, validate_manifest

STUDY = "1.2.826.0.1.3680043.8.498.1"
SENTINEL = "ZZSENTINEL"


def classic(uid_tail, **change):
    ds = Dataset()
    ds.SOPClassUID = XRayAngiographicImageStorage
    ds.SOPInstanceUID = f"1.2.826.0.1.3680043.8.498.2.{uid_tail}"
    ds.StudyInstanceUID = STUDY
    ds.SeriesInstanceUID = "1.2.826.0.1.3680043.8.498.3"
    ds.Modality = "XA"
    ds.ImageType = ["ORIGINAL", "PRIMARY", "SINGLE PLANE"]
    ds.PatientName = SENTINEL
    ds.PatientID = SENTINEL
    ds.InstitutionName = SENTINEL
    ds.Rows, ds.Columns, ds.NumberOfFrames = 8, 6, 4
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 8, 8, 7, 0
    ds.BurnedInAnnotation = "NO"
    ds.PositionerMotion = "STATIC"
    ds.PositionerPrimaryAngle = "-30.5"
    ds.PositionerSecondaryAngle = "20.25"
    ds.DistanceSourceToDetector = "1195.0"
    ds.DistanceSourceToPatient = "765.0"
    ds.ImagerPixelSpacing = ["0.308", "0.154"]
    ds.FrameTime = "66.67"
    ds.PixelData = bytes(8 * 6 * 4)
    for name, value in change.items():
        if value is None:
            if name in ds:
                delattr(ds, name)
        else:
            setattr(ds, name, value)
    return ds


def write(path: Path, ds, transfer_syntax=ExplicitVRLittleEndian):
    ds.file_meta = FileMetaDataset()
    ds.file_meta.MediaStorageSOPClassUID = ds.SOPClassUID
    ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    ds.file_meta.TransferSyntaxUID = transfer_syntax
    pydicom.dcmwrite(path, ds, enforce_file_format=True)
    return path


def load(bundle: Path):
    return InstalledProjectionStore(bundle.parent).load(bundle.name)[0]


def test_classic_single_plane_geometry_is_extracted_exactly(tmp_path):
    source = write(tmp_path / "run.dcm", classic(1))
    bundle = convert_projection([source], tmp_path / "out", "syn-xa", scope="synthetic")
    assert sorted(p.name for p in bundle.iterdir()) == ["projection.json"]
    manifest = load(bundle)
    assert manifest["kind"] == "projection_series" and manifest["pixels_retained"] is False
    assert manifest["clinical_validation"] is False and manifest["scope"] == "synthetic"
    assert manifest["biplane_linkage"] == "not_applicable"
    (plane,) = manifest["planes"]
    assert plane["plane"] == "single" and plane["sop_class"] == "xa"
    assert (plane["rows"], plane["columns"], plane["frame_count"]) == (8, 6, 4)
    assert plane["primary_angle_deg"] == -30.5 and plane["secondary_angle_deg"] == 20.25
    assert plane["source_detector_mm"] == 1195.0 and plane["source_isocenter_mm"] == 765.0
    assert plane["imager_pixel_spacing_mm"] == [0.308, 0.154]
    assert plane["frame_time_ms"] == 66.67 and plane["frame_time_vector_ms"] is None
    assert plane["positioner_motion"] == "static" and plane["burned_in_annotation"] == "no"
    assert plane["mask_operation"] == "none" and plane["mask_frame_numbers"] is None
    assert plane["calibration"] == {"status": "calibrated", "missing": []}
    text = (bundle / "projection.json").read_text()
    for forbidden in (SENTINEL, "1.2.826", "run.dcm", str(tmp_path)):
        assert forbidden not in text


@pytest.mark.parametrize(
    ("change", "missing"),
    [
        ({"PositionerPrimaryAngle": None}, ["primary_angle"]),
        ({"PositionerSecondaryAngle": "95"}, ["secondary_angle"]),
        ({"DistanceSourceToDetector": None}, ["source_detector_distance"]),
        ({"DistanceSourceToPatient": "0"}, ["source_isocenter_distance"]),
        ({"DistanceSourceToPatient": "1195.0"}, ["consistent_distances"]),
        ({"ImagerPixelSpacing": None}, ["imager_pixel_spacing"]),
        ({"PositionerMotion": "DYNAMIC"}, ["static_positioner"]),
        ({"PositionerMotion": None}, ["static_positioner"]),
        (
            {"PositionerPrimaryAngle": None, "ImagerPixelSpacing": None},
            ["primary_angle", "imager_pixel_spacing"],
        ),
    ],
)
def test_incomplete_geometry_is_admitted_as_uncalibrated(tmp_path, change, missing):
    source = write(tmp_path / "run.dcm", classic(1, **change))
    plane = load(convert_projection([source], tmp_path / "out", "syn-xa", scope="synthetic"))[
        "planes"
    ][0]
    assert plane["calibration"] == {"status": "uncalibrated", "missing": missing}


def test_pixel_spacing_is_never_substituted_for_imager_pixel_spacing(tmp_path):
    ds = classic(1, ImagerPixelSpacing=None)
    ds.PixelSpacing = ["0.2", "0.2"]
    plane = load(
        convert_projection([write(tmp_path / "r.dcm", ds)], tmp_path / "out", "s1", scope="public")
    )["planes"][0]
    assert plane["imager_pixel_spacing_mm"] is None
    assert plane["calibration"]["status"] == "uncalibrated"


def test_mask_and_frame_time_vector_are_retained(tmp_path):
    mask = Dataset()
    mask.MaskOperation = "AVG_SUB"
    mask.MaskFrameNumbers = [1, 2]
    ds = classic(1, FrameTime=None, FrameTimeVector=[0, 100, 100, 250])
    ds.MaskSubtractionSequence = Sequence([mask])
    plane = load(
        convert_projection([write(tmp_path / "r.dcm", ds)], tmp_path / "out", "s1", scope="public")
    )["planes"][0]
    assert plane["mask_operation"] == "avg_sub" and plane["mask_frame_numbers"] == [1, 2]
    assert plane["frame_time_vector_ms"] == [0.0, 100.0, 100.0, 250.0]
    assert plane["frame_time_ms"] is None


@pytest.mark.parametrize(
    ("declared", "kept"),
    [
        ([1, 2], [1, 2]),
        (3, [3]),
        ([1.9, 2], None),  # never truncated into a frame the header did not name
        ([2.0], None),
        (True, None),
        (["1"], None),
        ([1, 1], None),
        ([0], None),
        ([5], None),
        (None, None),
    ],
)
def test_mask_frame_numbers_are_kept_only_as_declared_integers(declared, kept):
    from types import SimpleNamespace

    from planner.projection_ingest import _mask

    item = SimpleNamespace(MaskOperation="AVG_SUB", MaskFrameNumbers=declared)
    assert _mask(SimpleNamespace(MaskSubtractionSequence=[item]), 4) == ("avg_sub", kept)


def test_compressed_headers_are_read_without_decoding_pixels(tmp_path):
    ds = classic(1)
    ds.PixelData = pydicom.encaps.encapsulate([b"\x00\x01"] * 4)
    source = write(tmp_path / "r.dcm", ds, JPEGLosslessSV1)
    plane = load(convert_projection([source], tmp_path / "out", "s1", scope="public"))["planes"][0]
    assert plane["calibration"]["status"] == "calibrated" and plane["frame_count"] == 4


def biplane_pair(tmp_path, *, link="both", same_study=True, labels=("BIPLANE A", "BIPLANE B")):
    a = classic(1, ImageType=["ORIGINAL", "PRIMARY", labels[0]])
    b = classic(
        2,
        ImageType=["ORIGINAL", "PRIMARY", labels[1]],
        PositionerPrimaryAngle="90",
        PositionerSecondaryAngle="0",
    )
    if not same_study:
        b.StudyInstanceUID = STUDY + ".9"
    # DICOM requires each plane of a biplane acquisition to reference the other.
    for source, target in ((a, b), (b, a))[: {"both": 2, "one_way": 1, "none": 0}[link]]:
        ref = Dataset()
        ref.ReferencedSOPClassUID = XRayAngiographicImageStorage
        ref.ReferencedSOPInstanceUID = target.SOPInstanceUID
        source.ReferencedImageSequence = Sequence([ref])
    return write(tmp_path / "a.dcm", a), write(tmp_path / "b.dcm", b)


def test_biplane_linkage_is_verified_and_ordered(tmp_path):
    a, b = biplane_pair(tmp_path)
    manifest = load(convert_projection([b, a], tmp_path / "out", "bi", scope="synthetic"))
    assert manifest["biplane_linkage"] == "cross_referenced"
    assert [p["plane"] for p in manifest["planes"]] == ["a", "b"]
    assert [p["primary_angle_deg"] for p in manifest["planes"]] == [-30.5, 90.0]
    assert "1.2.826" not in json.dumps(manifest)


@pytest.mark.parametrize(
    "options",
    [
        {"link": "none"},
        {"link": "one_way"},
        {"same_study": False},
        {"labels": ("BIPLANE A", "BIPLANE A")},
        {"labels": ("SINGLE PLANE", "BIPLANE B")},
    ],
)
def test_unverified_biplane_pairs_are_rejected(tmp_path, options):
    a, b = biplane_pair(tmp_path, **options)
    with pytest.raises(IngestError):
        convert_projection([a, b], tmp_path / "out", "bi", scope="synthetic")
    assert not (tmp_path / "out" / "bi").exists()


def enhanced(*, moving=False):
    ds = Dataset()
    ds.SOPClassUID = EnhancedXAImageStorage
    ds.SOPInstanceUID = "1.2.826.0.1.3680043.8.498.2.7"
    ds.StudyInstanceUID = STUDY
    ds.Modality = "XA"
    ds.PatientName = SENTINEL
    ds.Rows, ds.Columns, ds.NumberOfFrames = 8, 6, 2
    ds.PlaneIdentification = "MONOPLANE"
    ds.BurnedInAnnotation = "YES"
    position = Dataset()
    position.PositionerPrimaryAngle = 45.0
    position.PositionerSecondaryAngle = -25.0
    geometry = Dataset()
    geometry.DistanceSourceToDetector = 1100.0
    geometry.DistanceSourceToIsocenter = 720.0
    properties = Dataset()
    properties.ImagerPixelSpacing = [0.2, 0.2]
    shared = Dataset()
    shared.XRayGeometrySequence = Sequence([geometry])
    shared.FramePixelDataPropertiesSequence = Sequence([properties])
    frames = [Dataset(), Dataset()]
    if moving:
        for frame in frames:
            frame.PositionerPositionSequence = Sequence([position])
    else:
        shared.PositionerPositionSequence = Sequence([position])
    ds.SharedFunctionalGroupsSequence = Sequence([shared])
    ds.PerFrameFunctionalGroupsSequence = Sequence(frames)
    ds.PixelData = bytes(8 * 6 * 2)
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 8, 8, 7, 0
    return ds


def test_enhanced_xa_shared_geometry_is_extracted(tmp_path):
    source = write(tmp_path / "e.dcm", enhanced())
    plane = load(convert_projection([source], tmp_path / "out", "enh", scope="synthetic"))[
        "planes"
    ][0]
    assert plane["sop_class"] == "enhanced_xa" and plane["plane"] == "single"
    assert plane["primary_angle_deg"] == 45.0 and plane["secondary_angle_deg"] == -25.0
    assert plane["source_detector_mm"] == 1100.0 and plane["source_isocenter_mm"] == 720.0
    assert plane["imager_pixel_spacing_mm"] == [0.2, 0.2]
    assert plane["burned_in_annotation"] == "yes"
    assert plane["calibration"] == {"status": "calibrated", "missing": []}


def test_enhanced_xa_per_frame_positioner_is_uncalibrated_rotation(tmp_path):
    source = write(tmp_path / "e.dcm", enhanced(moving=True))
    plane = load(convert_projection([source], tmp_path / "out", "enh", scope="synthetic"))[
        "planes"
    ][0]
    assert plane["positioner_motion"] == "dynamic"
    assert plane["primary_angle_deg"] is None and plane["secondary_angle_deg"] is None
    assert plane["calibration"]["status"] == "uncalibrated"
    assert "static_positioner" in plane["calibration"]["missing"]


def conflicting(path: Path):
    """File meta declares XA while the dataset declares the equal-length XRF class."""
    raw = write(path, classic(1)).read_bytes()
    xa, xrf = b"1.2.840.10008.5.1.4.1.1.12.1", b"1.2.840.10008.5.1.4.1.1.12.2"
    first = raw.index(xa)
    second = raw.index(xa, first + len(xa))
    path.write_bytes(raw[:second] + xrf + raw[second + len(xa) :])
    return path


def test_rejections_leave_no_bundle_and_no_leak(tmp_path, capsys):
    out = tmp_path / "out"
    ct = classic(1, Modality="CT")
    ct.SOPClassUID = CTImageStorage
    cases = {
        "volume": write(tmp_path / "ct.dcm", ct),
        "conflict": conflicting(tmp_path / "c.dcm"),
        "modality": write(tmp_path / "m.dcm", classic(1, Modality="RF")),
        "big-endian": write(tmp_path / "be.dcm", classic(1), ExplicitVRBigEndian),
        "frames": write(tmp_path / "f.dcm", classic(1, NumberOfFrames=5000)),
        "study": write(tmp_path / "s.dcm", classic(1, StudyInstanceUID=None)),
    }
    (tmp_path / "junk.dcm").write_bytes(b"not dicom " + SENTINEL.encode())
    cases["junk"] = tmp_path / "junk.dcm"
    (tmp_path / "link.dcm").symlink_to(cases["volume"])
    cases["link"] = tmp_path / "link.dcm"
    for name, source in cases.items():
        with pytest.raises(IngestError):
            convert_projection([source], out, "rejected", scope="synthetic")
        assert not (out / "rejected").exists(), name
        assert main([str(out), str(source), "--source-id", "rejected", "--scope", "synthetic"]) == 1
        captured = capsys.readouterr()
        assert SENTINEL not in captured.out + captured.err
        assert str(tmp_path) not in captured.out + captured.err
    assert not out.exists() or not any(
        p.name.startswith(".projection-staging") for p in out.iterdir()
    )


def test_argument_and_destination_guards(tmp_path):
    source = write(tmp_path / "run.dcm", classic(1))
    out = tmp_path / "out"
    with pytest.raises(IngestError):
        convert_projection([source], out, "Bad Id", scope="synthetic")
    with pytest.raises(IngestError):
        convert_projection([source], out, "ok-id", scope="private")
    with pytest.raises(IngestError):
        convert_projection([], out, "ok-id", scope="synthetic")
    with pytest.raises(IngestError):
        convert_projection([source, source, source], out, "ok-id", scope="synthetic")
    first = convert_projection([source], out, "ok-id", scope="synthetic")
    before = (first / "projection.json").read_bytes()
    with pytest.raises(IngestError):
        convert_projection([source], out, "ok-id", scope="synthetic")
    assert (first / "projection.json").read_bytes() == before
    linked = tmp_path / "linked"
    linked.symlink_to(out, target_is_directory=True)
    with pytest.raises(IngestError):
        convert_projection([source], linked, "other", scope="synthetic")
    assert main([str(out), str(source), "--source-id", "cli-ok", "--scope", "synthetic"]) == 0
    validate_manifest(json.loads((out / "cli-ok" / "projection.json").read_text()))
