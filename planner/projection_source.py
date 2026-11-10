"""Projection-series (2D angiography) geometry contract and installed store.

Stdlib only. A projection series is a different source kind from a calibrated
volume: it has no patient-space affine. This release admits acquisition
geometry only. Pixel frames are not retained, so nothing here can display an
angiogram, and no registration to a volume is implied.

The calibration gate mirrors the millimeter gate for volumes. A plane is
``calibrated`` only when its positioner angles, both distances and the imager
pixel spacing are present, mutually consistent and the positioner was static.
Anything else is ``uncalibrated`` with the missing terms listed.
"""

import hashlib
import json
import math
import os
import re
import stat
from pathlib import Path
from typing import NoReturn

MANIFEST_VERSION = 1
MANIFEST_FILENAME = "projection.json"
MAX_MANIFEST_BYTES = 262144
MAX_FRAMES = 2048
MAX_DIMENSION = 4096
INSTALLED_PROJECTIONS_ROOT = (
    Path(__file__).resolve().parent.parent / ".runtime" / "installed-projections"
)
ANGLE_CONVENTION = "dicom_xa_patient_positioner_angles"
MISSING_TERMS = (
    "primary_angle",
    "secondary_angle",
    "source_detector_distance",
    "source_isocenter_distance",
    "consistent_distances",
    "imager_pixel_spacing",
    "static_positioner",
)
_SOURCE_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{1,63}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_TOP_KEYS = {
    "version",
    "kind",
    "clinical_validation",
    "scope",
    "method",
    "pixels_retained",
    "angle_convention",
    "biplane_linkage",
    "planes",
}
_PLANE_KEYS = {
    "plane",
    "sop_class",
    "input_sha256",
    "input_bytes",
    "rows",
    "columns",
    "frame_count",
    "burned_in_annotation",
    "positioner_motion",
    "primary_angle_deg",
    "secondary_angle_deg",
    "source_detector_mm",
    "source_isocenter_mm",
    "imager_pixel_spacing_mm",
    "frame_time_ms",
    "frame_time_vector_ms",
    "mask_operation",
    "mask_frame_numbers",
    "calibration",
}


def _fail(message) -> NoReturn:
    raise ValueError("projection series: " + message)


def _integer(value, low, high, label):
    if type(value) is not int or not low <= value <= high:
        _fail("invalid " + label)
    return value


def _optional_number(value, low, high, label, *, low_open=False):
    if value is None:
        return None
    if (
        type(value) not in (int, float)
        or not math.isfinite(value)
        or not low <= value <= high
        or (low_open and value == low)
    ):
        _fail("invalid " + label)
    return float(value)


def calibration(plane):
    """Derive the calibration gate from a plane's geometry values."""
    missing = []
    if plane["primary_angle_deg"] is None:
        missing.append("primary_angle")
    if plane["secondary_angle_deg"] is None:
        missing.append("secondary_angle")
    sid, sod = plane["source_detector_mm"], plane["source_isocenter_mm"]
    if sid is None:
        missing.append("source_detector_distance")
    if sod is None:
        missing.append("source_isocenter_distance")
    if sid is not None and sod is not None and not sod < sid:
        missing.append("consistent_distances")
    if plane["imager_pixel_spacing_mm"] is None:
        missing.append("imager_pixel_spacing")
    if plane["positioner_motion"] != "static":
        missing.append("static_positioner")
    return {"status": "uncalibrated" if missing else "calibrated", "missing": missing}


def _validate_plane(plane):
    if not isinstance(plane, dict) or set(plane) != _PLANE_KEYS:
        _fail("invalid plane fields")
    if plane["plane"] not in ("single", "a", "b", "unknown"):
        _fail("invalid plane label")
    if plane["sop_class"] not in ("xa", "enhanced_xa"):
        _fail("invalid storage class")
    if not isinstance(plane["input_sha256"], str) or not _SHA256.fullmatch(plane["input_sha256"]):
        _fail("invalid input hash")
    _integer(plane["input_bytes"], 1, 2**40, "input byte count")
    for field in ("rows", "columns"):
        _integer(plane[field], 1, MAX_DIMENSION, field)
    frames = _integer(plane["frame_count"], 1, MAX_FRAMES, "frame count")
    if plane["burned_in_annotation"] not in ("yes", "no", "unknown"):
        _fail("invalid burned-in annotation state")
    if plane["positioner_motion"] not in ("static", "dynamic", "unknown"):
        _fail("invalid positioner motion")
    _optional_number(plane["primary_angle_deg"], -180, 180, "primary angle")
    _optional_number(plane["secondary_angle_deg"], -90, 90, "secondary angle")
    _optional_number(plane["source_detector_mm"], 0, 1e4, "source-detector distance", low_open=True)
    _optional_number(
        plane["source_isocenter_mm"], 0, 1e4, "source-isocenter distance", low_open=True
    )
    spacing = plane["imager_pixel_spacing_mm"]
    if spacing is not None:
        if not isinstance(spacing, list) or len(spacing) != 2:
            _fail("invalid imager pixel spacing")
        for value in spacing:
            if value is None:
                _fail("invalid imager pixel spacing")
            _optional_number(value, 0, 10, "imager pixel spacing", low_open=True)
    _optional_number(plane["frame_time_ms"], 0, 1e5, "frame time", low_open=True)
    vector = plane["frame_time_vector_ms"]
    if vector is not None:
        if not isinstance(vector, list) or len(vector) != frames:
            _fail("invalid frame time vector")
        for value in vector:
            if value is None:
                _fail("invalid frame time vector")
            _optional_number(value, 0, 1e5, "frame time vector")
    if plane["mask_operation"] not in ("none", "avg_sub", "tid", "rev_tid", "unknown"):
        _fail("invalid mask operation")
    numbers = plane["mask_frame_numbers"]
    if numbers is not None:
        if (
            plane["mask_operation"] != "avg_sub"
            or not isinstance(numbers, list)
            or not 1 <= len(numbers) <= frames
            or len(set(numbers)) != len(numbers)
        ):
            _fail("invalid mask frame numbers")
        for value in numbers:
            _integer(value, 1, frames, "mask frame number")
    if plane["calibration"] != calibration(plane):
        _fail("calibration gate contradicts geometry")
    return plane


def validate_manifest(manifest):
    """Strict closed-schema admission of one geometry-only projection manifest."""
    if not isinstance(manifest, dict) or set(manifest) != _TOP_KEYS:
        _fail("invalid manifest fields")
    if (
        manifest["version"] != MANIFEST_VERSION
        or type(manifest["version"]) is not int
        or manifest["kind"] != "projection_series"
        or manifest["clinical_validation"] is not False
        or manifest["pixels_retained"] is not False
        or manifest["scope"] not in ("synthetic", "public", "authorized")
        or manifest["method"] != "converted_dicom_xa_geometry"
        or manifest["angle_convention"] != ANGLE_CONVENTION
    ):
        _fail("unsupported manifest declaration")
    planes = manifest["planes"]
    if not isinstance(planes, list) or len(planes) not in (1, 2):
        _fail("one or two planes required")
    for plane in planes:
        _validate_plane(plane)
    labels = [plane["plane"] for plane in planes]
    if len(planes) == 2:
        if labels != ["a", "b"] or manifest["biplane_linkage"] != "cross_referenced":
            _fail("a two-plane bundle requires verified A and B planes")
        if planes[0]["input_sha256"] == planes[1]["input_sha256"]:
            _fail("biplane inputs must be distinct")
    elif manifest["biplane_linkage"] != "not_applicable":
        _fail("a one-plane bundle carries no biplane linkage")
    return manifest


class InstalledProjectionStore:
    """Reads ``ROOT/SOURCE_ID/projection.json`` without following links."""

    def __init__(self, root=None):
        self._root = root

    def root(self):
        return Path(self._root) if self._root is not None else INSTALLED_PROJECTIONS_ROOT

    def load(self, source_id):
        if not isinstance(source_id, str) or not _SOURCE_ID.fullmatch(source_id):
            raise FileNotFoundError("projection series: unknown source")
        root = self.root()
        if root.is_symlink() or any(parent.is_symlink() for parent in root.parents):
            _fail("installed root or ancestor is a symlink")
        directory = root / source_id
        if directory.is_symlink():
            _fail("installed source is a symlink")
        if not directory.is_dir():
            raise FileNotFoundError("projection series: unknown source")
        try:
            fd = os.open(directory / MANIFEST_FILENAME, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            raise
        except OSError:
            _fail("manifest is not a regular file")
        with os.fdopen(fd, "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                _fail("manifest is not a regular file")
            raw = stream.read(MAX_MANIFEST_BYTES + 1)
        if not 0 < len(raw) <= MAX_MANIFEST_BYTES:
            _fail("manifest byte bound exceeded")
        manifest = validate_manifest(json.loads(raw))
        return manifest, hashlib.sha256(raw).hexdigest()
