"""Local projection XA geometry extraction, with fresh metadata only.

This operator CLI reads one projection X-ray angiography instance, or the two
cross-referenced instances of one biplane acquisition, and writes a
geometry-only manifest. Pixel data is never decoded or retained, so compressed
transfer syntaxes are accepted for their little-endian explicit headers. The
scope argument declares the operator's data-use scope, not deidentification.
Optional imaging dependencies are imported only during conversion.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
import re
import shutil
import stat
import sys
import tempfile
import warnings
from pathlib import Path

from planner.dicom_ingest import IngestError, _fail, _open_directory, _parse_file_meta
from planner.projection_source import (
    ANGLE_CONVENTION,
    MANIFEST_FILENAME,
    MANIFEST_VERSION,
    MAX_DIMENSION,
    MAX_FRAMES,
    MAX_MANIFEST_BYTES,
    calibration,
    validate_manifest,
)

MAX_INPUT_FILE_BYTES = 512 * 1024 * 1024
XA = "1.2.840.10008.5.1.4.1.1.12.1"
ENHANCED_XA = "1.2.840.10008.5.1.4.1.1.12.1.1"
# Little-endian datasets whose headers parse identically. Pixel data stays opaque.
HEADER_TRANSFER_SYNTAXES = {
    "1.2.840.10008.1.2",
    "1.2.840.10008.1.2.1",
    "1.2.840.10008.1.2.4.50",
    "1.2.840.10008.1.2.4.51",
    "1.2.840.10008.1.2.4.57",
    "1.2.840.10008.1.2.4.70",
    "1.2.840.10008.1.2.4.80",
    "1.2.840.10008.1.2.4.81",
    "1.2.840.10008.1.2.4.90",
    "1.2.840.10008.1.2.4.91",
    "1.2.840.10008.1.2.5",
}
_UID = re.compile(r"[0-9]+(?:\.[0-9]+)+")
_TAGS = [
    "SOPClassUID",
    "SOPInstanceUID",
    "StudyInstanceUID",
    "Modality",
    "ImageType",
    "Rows",
    "Columns",
    "NumberOfFrames",
    "BurnedInAnnotation",
    "PositionerMotion",
    "PositionerPrimaryAngle",
    "PositionerSecondaryAngle",
    "DistanceSourceToDetector",
    "DistanceSourceToPatient",
    "ImagerPixelSpacing",
    "FrameTime",
    "FrameTimeVector",
    "MaskSubtractionSequence",
    "ReferencedImageSequence",
    "PlaneIdentification",
    "SharedFunctionalGroupsSequence",
    "PerFrameFunctionalGroupsSequence",
]


def _read_input(path: Path) -> bytes:
    path = Path(path).absolute()
    fd = _open_directory(path.parent)
    try:
        file_fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
    except OSError:
        _fail("Select a regular projection file, without links")
    finally:
        os.close(fd)
    with os.fdopen(file_fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_INPUT_FILE_BYTES:
            _fail("Input file byte bound exceeded")
        data = stream.read(MAX_INPUT_FILE_BYTES + 1)
    if not 0 < len(data) <= MAX_INPUT_FILE_BYTES:
        _fail("Input file byte bound exceeded")
    return data


def _number(value, low, high, *, low_open=False):
    """A finite bounded float, or None when the attribute is absent or unusable."""
    if value is None or value == "":
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(result) or not low <= result <= high or (low_open and result == low):
        return None
    return result


def _single_item(sequence):
    return sequence[0] if sequence is not None and len(sequence) == 1 else None


def _classic_geometry(ds, frames):
    motion = str(getattr(ds, "PositionerMotion", "")).strip().upper()
    if motion == "STATIC" or (motion == "" and frames == 1):
        motion = "static"
    else:
        motion = "dynamic" if motion == "DYNAMIC" else "unknown"
    plane = {"SINGLE PLANE": "single", "BIPLANE A": "a", "BIPLANE B": "b"}.get(
        (list(getattr(ds, "ImageType", [])) + ["", "", ""])[2].strip().upper(), "unknown"
    )
    vector = getattr(ds, "FrameTimeVector", None)
    if vector is not None:
        values = [_number(x, 0, 1e5) for x in (vector if frames > 1 else [vector])]
        vector = values if len(values) == frames and None not in values else None
    return {
        "plane": plane,
        "positioner_motion": motion,
        "primary_angle_deg": _number(getattr(ds, "PositionerPrimaryAngle", None), -180, 180),
        "secondary_angle_deg": _number(getattr(ds, "PositionerSecondaryAngle", None), -90, 90),
        "source_detector_mm": _number(
            getattr(ds, "DistanceSourceToDetector", None), 0, 1e4, low_open=True
        ),
        "source_isocenter_mm": _number(
            getattr(ds, "DistanceSourceToPatient", None), 0, 1e4, low_open=True
        ),
        "imager_pixel_spacing_mm": _spacing(getattr(ds, "ImagerPixelSpacing", None)),
        "frame_time_ms": _number(getattr(ds, "FrameTime", None), 0, 1e5, low_open=True),
        "frame_time_vector_ms": vector,
    }


def _spacing(value):
    try:
        values = [_number(x, 0, 10, low_open=True) for x in value]
    except TypeError:
        return None
    return values if len(values) == 2 and None not in values else None


def _enhanced_geometry(ds, frames):
    shared = _single_item(getattr(ds, "SharedFunctionalGroupsSequence", None))
    per_frame = getattr(ds, "PerFrameFunctionalGroupsSequence", None)
    if shared is None or per_frame is None or len(per_frame) != frames:
        _fail("Complete shared/per-frame functional groups required")

    def per_frame_has(name):
        return any(getattr(frame, name, None) is not None for frame in per_frame)

    # A positioner or geometry macro in the per-frame groups signals motion.
    moving = per_frame_has("PositionerPositionSequence") or per_frame_has("XRayGeometrySequence")
    position = _single_item(getattr(shared, "PositionerPositionSequence", None))
    geometry = _single_item(getattr(shared, "XRayGeometrySequence", None))
    properties = _single_item(getattr(shared, "FramePixelDataPropertiesSequence", None))
    plane = {"MONOPLANE": "single", "PLANE A": "a", "PLANE B": "b"}.get(
        str(getattr(ds, "PlaneIdentification", "")).strip().upper(), "unknown"
    )
    static = not moving and position is not None
    return {
        "plane": plane,
        "positioner_motion": "static" if static else "dynamic" if moving else "unknown",
        "primary_angle_deg": _number(getattr(position, "PositionerPrimaryAngle", None), -180, 180)
        if static
        else None,
        "secondary_angle_deg": _number(getattr(position, "PositionerSecondaryAngle", None), -90, 90)
        if static
        else None,
        "source_detector_mm": _number(
            getattr(geometry, "DistanceSourceToDetector", None), 0, 1e4, low_open=True
        )
        if not moving
        else None,
        "source_isocenter_mm": _number(
            getattr(geometry, "DistanceSourceToIsocenter", None), 0, 1e4, low_open=True
        )
        if not moving
        else None,
        "imager_pixel_spacing_mm": _spacing(getattr(properties, "ImagerPixelSpacing", None)),
        "frame_time_ms": None,
        "frame_time_vector_ms": None,
    }


def _mask(ds, frames):
    item = getattr(ds, "MaskSubtractionSequence", None)
    if item is None or len(item) == 0:
        return "none" if item is None else "unknown", None
    operation = str(getattr(item[0], "MaskOperation", "")).strip().upper()
    operation = {"NONE": "none", "AVG_SUB": "avg_sub", "TID": "tid", "REV_TID": "rev_tid"}.get(
        operation, "unknown"
    )
    numbers = None
    if operation == "avg_sub" and len(item) == 1:
        raw = getattr(item[0], "MaskFrameNumbers", None)
        try:
            values = [int(x) for x in ([raw] if isinstance(raw, int) else raw)]
        except (TypeError, ValueError):
            values = []
        if values and len(set(values)) == len(values) and all(1 <= x <= frames for x in values):
            numbers = values
    return operation, numbers


def _plane(data: bytes):
    import pydicom

    meta = _parse_file_meta(data, HEADER_TRANSFER_SYNTAXES)
    if meta[2] not in (XA, ENHANCED_XA):
        _fail("Projection X-ray angiography storage required")
    ds = pydicom.dcmread(io.BytesIO(data), stop_before_pixels=True, specific_tags=_TAGS)
    if (
        str(ds.SOPClassUID) != meta[2]
        or str(ds.SOPInstanceUID) != meta[3]
        or str(ds.Modality) != "XA"
    ):
        _fail("Conflicting storage/modality identifiers")
    study = str(getattr(ds, "StudyInstanceUID", ""))
    if not _UID.fullmatch(study) or len(study) > 64:
        _fail("Explicit study identifier required")
    rows, columns = int(ds.Rows), int(ds.Columns)
    frames = int(getattr(ds, "NumberOfFrames", 1))
    if not (
        1 <= rows <= MAX_DIMENSION and 1 <= columns <= MAX_DIMENSION and 1 <= frames <= MAX_FRAMES
    ):
        _fail("Unsupported or unbounded frame dimensions")
    geometry = (_classic_geometry if meta[2] == XA else _enhanced_geometry)(ds, frames)
    operation, numbers = _mask(ds, frames)
    burned = str(getattr(ds, "BurnedInAnnotation", "")).strip().upper()
    plane = {
        **geometry,
        "sop_class": "xa" if meta[2] == XA else "enhanced_xa",
        "input_sha256": hashlib.sha256(data).hexdigest(),
        "input_bytes": len(data),
        "rows": rows,
        "columns": columns,
        "frame_count": frames,
        "burned_in_annotation": {"YES": "yes", "NO": "no"}.get(burned, "unknown"),
        "mask_operation": operation,
        "mask_frame_numbers": numbers,
    }
    plane["calibration"] = calibration(plane)
    references = set()
    for item in getattr(ds, "ReferencedImageSequence", None) or []:
        references.add(str(getattr(item, "ReferencedSOPInstanceUID", "")))
    # Raw identifiers stay inside this process; they only verify biplane linkage.
    return plane, {"instance": meta[3], "study": study, "references": references}


def _manifest(blobs, scope):
    parsed = [_plane(data) for data in blobs]
    planes = [plane for plane, _ in parsed]
    linkage = "not_applicable"
    if len(parsed) == 2:
        (first, a), (second, b) = parsed
        if {first["plane"], second["plane"]} != {"a", "b"}:
            _fail("A biplane bundle requires one plane A and one plane B instance")
        if a["study"] != b["study"] or a["instance"] == b["instance"]:
            _fail("Biplane instances must be distinct and share one study")
        if b["instance"] not in a["references"] or a["instance"] not in b["references"]:
            _fail("Biplane instances must cross-reference each other")
        planes.sort(key=lambda plane: plane["plane"])
        linkage = "cross_referenced"
    return {
        "version": MANIFEST_VERSION,
        "kind": "projection_series",
        "clinical_validation": False,
        "scope": scope,
        "method": "converted_dicom_xa_geometry",
        "pixels_retained": False,
        "angle_convention": ANGLE_CONVENTION,
        "biplane_linkage": linkage,
        "planes": planes,
    }


def convert_projection(inputs, output_root: Path, source_id: str, *, scope: str) -> Path:
    # Lazy DataElement conversion also warns outside dcmread. Treat every warning
    # as rejection before a parser can print a raw UID or other source value.
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            return _convert_projection(inputs, output_root, source_id, scope=scope)
    except IngestError:
        raise
    except Exception:  # noqa: BLE001 - sanitize the public metadata boundary
        # Parser internals can include source metadata in their exceptions.
        raise IngestError("Projection conversion rejected") from None


def _convert_projection(inputs, output_root: Path, source_id: str, *, scope: str) -> Path:
    if scope not in {"synthetic", "public", "authorized"}:
        _fail("Invalid declared scope")
    if not isinstance(source_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{1,63}", source_id):
        _fail("Invalid opaque source_id")
    inputs = [Path(path) for path in inputs]
    if len(inputs) not in (1, 2):
        _fail("Select one projection instance, or the two instances of one biplane run")
    root = Path(output_root).absolute()
    destination = root / source_id
    # Reject unsafe existing ancestry before creating directories or reading input.
    if destination.exists() or destination.is_symlink():
        _fail("destination already exists")
    if any(p.is_symlink() for p in (root, *root.parents)):
        _fail("Output ancestry must not contain links")
    manifest = _manifest([_read_input(path) for path in inputs], scope)
    root.mkdir(parents=True, exist_ok=True)
    os.close(_open_directory(root))
    staging = Path(tempfile.mkdtemp(prefix=".projection-staging-", dir=root))
    claimed = False
    try:
        staged = staging / MANIFEST_FILENAME
        staged.write_text(json.dumps(manifest, sort_keys=True, allow_nan=False))
        staged.chmod(0o600)
        # The staged bytes must pass the installed-reader schema before publication.
        _admit(staged)
        # Exclusive directory claim; the manifest rename is the atomic admission point.
        destination.mkdir(mode=0o700)
        claimed = True
        os.rename(staged, destination / MANIFEST_FILENAME)
    except BaseException:
        if claimed:
            shutil.rmtree(destination)
        raise
    finally:
        shutil.rmtree(staging)
    return destination


def _admit(staged: Path):
    raw = staged.read_bytes()
    if not 0 < len(raw) <= MAX_MANIFEST_BYTES:
        _fail("Projection manifest byte bound exceeded")
    validate_manifest(json.loads(raw))


def main(argv=None):
    parser = argparse.ArgumentParser(description="Local projection XA geometry converter")
    parser.add_argument("output_root")
    parser.add_argument("inputs", nargs="+")
    parser.add_argument("--source-id", required=True)
    parser.add_argument("--scope", required=True, choices=("synthetic", "public", "authorized"))
    args = parser.parse_args(argv)
    try:
        convert_projection(
            [Path(path) for path in args.inputs],
            Path(args.output_root),
            args.source_id,
            scope=args.scope,
        )
    except Exception:  # noqa: BLE001 - outer CLI privacy boundary never exposes parser values
        print(
            "Projection conversion rejected; verify format, bounds and approved input scope.",
            file=sys.stderr,
        )
        return 1
    print("Projection geometry bundle installed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
