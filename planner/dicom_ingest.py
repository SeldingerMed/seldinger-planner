"""Local native-scalar DICOM volume conversion, with fresh metadata only.

This operator CLI does not expose filesystem paths to HTTP/model tools. The
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
import struct
import sys
import tempfile
import warnings
from pathlib import Path
from typing import NoReturn

MAX_FILES = 512
MAX_INPUT_FILE_BYTES = 16 * 1024 * 1024
MAX_INPUT_AGGREGATE_BYTES = 256 * 1024 * 1024
MAX_TOTAL_VOXELS = 8_000_000
MAX_IMAGE_BYTES = 16 * 1024 * 1024
NATIVE_TRANSFER_SYNTAXES = {"1.2.840.10008.1.2", "1.2.840.10008.1.2.1"}
SOPS = {
    "1.2.840.10008.5.1.4.1.1.2": "CT",
    "1.2.840.10008.5.1.4.1.1.4": "MR",
    "1.2.840.10008.5.1.4.1.1.2.1": "CT",
    "1.2.840.10008.5.1.4.1.1.4.1": "MR",
    "1.2.840.10008.5.1.4.1.1.13.1.1": "XA",
}
IMAGE_FILENAME = "volume.nii"


class IngestError(ValueError):
    """Sanitized operator-facing format/admission failure."""


def _fail(message) -> NoReturn:
    raise IngestError(message)


def _open_directory(path: Path):
    path = path.absolute()
    if ".." in path.parts:
        _fail("Directory must have canonical ancestry")
    fd = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def _collect_input_files(input_dir):
    fd = _open_directory(input_dir)
    blobs = []
    total = 0
    try:
        with os.scandir(fd) as entries:
            for entry in entries:
                if len(blobs) >= MAX_FILES:
                    _fail("Input file-count bound exceeded")
                if not entry.is_file(follow_symlinks=False):
                    _fail("Select a flat series directory of regular files, without links")
                file_fd = os.open(entry.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
                with os.fdopen(file_fd, "rb") as stream:
                    info = os.fstat(stream.fileno())
                    if (
                        not stat.S_ISREG(info.st_mode)
                        or not 0 < info.st_size <= MAX_INPUT_FILE_BYTES
                    ):
                        _fail("Input file byte bound exceeded")
                    data = stream.read(MAX_INPUT_FILE_BYTES + 1)
                if not 0 < len(data) <= MAX_INPUT_FILE_BYTES:
                    _fail("Input file byte bound exceeded")
                total += len(data)
                if total > MAX_INPUT_AGGREGATE_BYTES:
                    _fail("Input aggregate byte bound exceeded")
                blobs.append(data)
    finally:
        os.close(fd)
    if not blobs:
        _fail("Series directory is empty")
    return blobs


def _parse_file_meta(data: bytes, transfer_syntaxes=NATIVE_TRANSFER_SYNTAXES):
    """Bounded explicit-LE group0002 parsing BEFORE pydicom can inflate a dataset."""
    if len(data) < 144 or data[128:132] != b"DICM":
        _fail("DICOM Part10 file meta required")
    if data[132:140] != b"\x02\x00\x00\x00UL\x04\x00":
        _fail("Bounded DICOM file meta group length required")
    end = 144 + struct.unpack_from("<I", data, 140)[0]
    if end > len(data) or end > 132 + 16384:
        _fail("DICOM file meta byte bound exceeded")
    pos = 144
    found = {}
    long_vr = {
        b"OB",
        b"OD",
        b"OF",
        b"OL",
        b"OV",
        b"OW",
        b"SQ",
        b"SV",
        b"UC",
        b"UN",
        b"UR",
        b"UT",
        b"UV",
    }
    while pos < end:
        if pos + 8 > end:
            _fail("Malformed file meta")
        group, element = struct.unpack_from("<HH", data, pos)
        vr = data[pos + 4 : pos + 6]
        if group != 2:
            _fail("Malformed file meta group")
        header = 12 if vr in long_vr else 8
        if pos + header > end:
            _fail("Malformed file meta length")
        length = struct.unpack_from(
            "<I" if header == 12 else "<H", data, pos + (8 if header == 12 else 6)
        )[0]
        if pos + header + length > end:
            _fail("Malformed file meta value")
        if element in (2, 3, 16):
            if vr != b"UI" or length > 66 or element in found:
                _fail("Malformed file meta UID")
            try:
                value = data[pos + header : pos + header + length].rstrip(b"\x00 ").decode("ascii")
            except UnicodeError:
                _fail("Malformed file meta UID")
            if not re.fullmatch(r"[0-9]+(?:\.[0-9]+)+", value) or len(value) > 64:
                _fail("Malformed file meta UID")
            found[element] = value
        pos += header + length
    if pos != end or not {2, 3, 16} <= found.keys():
        _fail("Missing required file meta identifiers")
    if found[16] not in transfer_syntaxes:
        _fail("Unsupported transfer syntax")
    if end + 8 > len(data) or struct.unpack_from("<H", data, end)[0] == 2:
        _fail("File meta group length does not match the actual boundary")
    return found


def _vector(value, count, label):
    try:
        result = [float(x) for x in value]
    except (ValueError, TypeError):
        _fail("Missing or invalid " + label)
    if len(result) != count or any(not math.isfinite(v) or abs(v) > 1e6 for v in result):
        _fail("Invalid " + label)
    return result


def _pixels(ds):
    return ds._ingest_pixels if hasattr(ds, "_ingest_pixels") else ds.pixel_array


def _expand_enhanced(ds, frame_count):
    from pydicom.dataset import Dataset

    shared = getattr(ds, "SharedFunctionalGroupsSequence", None)
    frames = getattr(ds, "PerFrameFunctionalGroupsSequence", None)
    if shared is None or len(shared) != 1 or frames is None or len(frames) != frame_count:
        _fail("Complete shared/per-frame functional groups required")
    pixels = ds.pixel_array
    if pixels.shape != (frame_count, int(ds.Rows), int(ds.Columns)):
        _fail("Enhanced decoded frame shape mismatch")
    slices = []
    acquisitions = set()
    for index, frame in enumerate(frames):

        def group(name, frame=frame):
            per = getattr(frame, name, None)
            common = getattr(shared[0], name, None)
            if per is not None and common is not None:
                _fail("Conflicting shared/per-frame macros")
            sequence = per if per is not None else common
            if sequence is None:
                return None
            if len(sequence) != 1:
                _fail("Invalid functional-group cardinality")
            return sequence[0]

        position = group("PlanePositionSequence")
        orientation = group("PlaneOrientationSequence")
        measures = group("PixelMeasuresSequence")
        rescale = group("PixelValueTransformationSequence")
        if position is None or orientation is None or measures is None:
            _fail("Explicit patient-coordinate volume geometry required")
        if group("RealWorldValueMappingSequence") is not None:
            _fail("Unsupported enhanced intensity mapping")
        content = group("FrameContentSequence")
        acquisitions.add(
            (
                str(getattr(content, "StackID", "")),
                str(getattr(content, "TemporalPositionIndex", "")),
            )
        )
        out = Dataset()
        for name in (
            "Rows",
            "Columns",
            "BitsAllocated",
            "BitsStored",
            "HighBit",
            "PixelRepresentation",
            "Modality",
        ):
            setattr(out, name, getattr(ds, name))
        out.ImagePositionPatient = position.ImagePositionPatient
        out.ImageOrientationPatient = orientation.ImageOrientationPatient
        out.PixelSpacing = measures.PixelSpacing
        out.RescaleSlope = getattr(rescale, "RescaleSlope", 1)
        out.RescaleIntercept = getattr(rescale, "RescaleIntercept", 0)
        out._ingest_pixels = pixels[index]
        slices.append(out)
    if len(acquisitions) != 1:
        _fail("Mixed enhanced stacks or temporal states")
    return slices


def _datasets(blobs):
    import pydicom

    datasets = []
    keys = []
    voxels = 0
    for data in blobs:
        meta = _parse_file_meta(data)
        if meta[2] not in SOPS:
            _fail("Unsupported volumetric SOP class; projection XA is not a reconstructed volume")
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            ds = pydicom.dcmread(
                io.BytesIO(data),
                specific_tags=[
                    "SOPClassUID",
                    "SOPInstanceUID",
                    "StudyInstanceUID",
                    "SeriesInstanceUID",
                    "FrameOfReferenceUID",
                    "Modality",
                    "Rows",
                    "Columns",
                    "SamplesPerPixel",
                    "PhotometricInterpretation",
                    "BitsAllocated",
                    "BitsStored",
                    "HighBit",
                    "PixelRepresentation",
                    "NumberOfFrames",
                    "ImagePositionPatient",
                    "ImageOrientationPatient",
                    "PixelSpacing",
                    "RescaleSlope",
                    "RescaleIntercept",
                    "PixelData",
                    "ModalityLUTSequence",
                    "RealWorldValueMappingSequence",
                    "ImageType",
                    "TemporalPositionIdentifier",
                    "EchoNumbers",
                    "SharedFunctionalGroupsSequence",
                    "PerFrameFunctionalGroupsSequence",
                ],
            )
        if (
            str(ds.SOPClassUID) != meta[2]
            or str(ds.SOPInstanceUID) != meta[3]
            or str(ds.Modality) != SOPS[meta[2]]
        ):
            _fail("Conflicting storage/modality identifiers")
        key = tuple(
            str(getattr(ds, k, ""))
            for k in ("StudyInstanceUID", "SeriesInstanceUID", "FrameOfReferenceUID")
        )
        if any(not re.fullmatch(r"[0-9]+(?:\.[0-9]+)+", v) or len(v) > 64 for v in key):
            _fail("Explicit study, series and patient frame identifiers required")
        keys.append(
            (
                meta[2],
                *key,
                str(getattr(ds, "TemporalPositionIdentifier", "")),
                str(getattr(ds, "EchoNumbers", "")),
            )
        )
        rows, cols = int(ds.Rows), int(ds.Columns)
        frame_count = int(getattr(ds, "NumberOfFrames", 1))
        classic = meta[2] in {"1.2.840.10008.5.1.4.1.1.2", "1.2.840.10008.5.1.4.1.1.4"}
        if not (1 <= rows <= 2048 and 1 <= cols <= 2048 and 1 <= frame_count <= 2048) or (
            classic and frame_count != 1
        ):
            _fail("Unsupported or unbounded frame dimensions")
        voxels += rows * cols * frame_count
        if voxels > MAX_TOTAL_VOXELS:
            _fail("Output voxel bound exceeded")
        bits = int(ds.BitsAllocated)
        stored = int(ds.BitsStored)
        if (
            bits not in (8, 16)
            or not 1 <= stored <= bits
            or int(ds.HighBit) != stored - 1
            or int(ds.PixelRepresentation) not in (0, 1)
        ):
            _fail("Unsupported native scalar encoding")
        pixel = ds.get(0x7FE00010)
        expected_bytes = rows * cols * frame_count * (bits // 8)
        if (
            pixel is None
            or pixel.is_undefined_length
            or not isinstance(pixel.value, bytes)
            or len(pixel.value) != expected_bytes + expected_bytes % 2
        ):
            _fail("Native pixel byte count/encoding does not match declared dimensions")
        if int(ds.SamplesPerPixel) != 1 or ds.PhotometricInterpretation != "MONOCHROME2":
            _fail("Native MONOCHROME2 scalar pixels required")
        if hasattr(ds, "ModalityLUTSequence") or hasattr(ds, "RealWorldValueMappingSequence"):
            _fail("Nonlinear/alternative intensity mappings are unsupported")
        if {str(x).upper() for x in getattr(ds, "ImageType", [])} & {
            "LOCALIZER",
            "MOSAIC",
            "MIP",
            "PROJECTION",
        }:
            _fail("Projection or tiled images are not volumetric slices")
        datasets.extend([ds] if classic else _expand_enhanced(ds, frame_count))
    if len(set(keys)) != 1:
        _fail("Mixed series, frame, modality or acquisition states")
    return datasets


def _series(datasets):
    import numpy as np

    records = []
    for ds in datasets:
        ipp = np.array(_vector(ds.ImagePositionPatient, 3, "patient position"))
        iop = np.array(_vector(ds.ImageOrientationPatient, 6, "patient orientation"))
        spacing = np.array(_vector(ds.PixelSpacing, 2, "pixel spacing"))
        x, y = iop[:3], iop[3:]
        if np.any(spacing <= 0) or not np.allclose(
            [np.linalg.norm(x), np.linalg.norm(y), x @ y], [1, 1, 0], atol=1e-6, rtol=0
        ):
            _fail("Pixel spacing/orientation must be calibrated and orthonormal")
        slope = float(getattr(ds, "RescaleSlope", 1))
        inter = float(getattr(ds, "RescaleIntercept", 0))
        if not math.isfinite(slope) or slope == 0 or not math.isfinite(inter):
            _fail("Invalid linear intensity rescale")
        records.append(
            {
                "ds": ds,
                "ipp": ipp,
                "x": x,
                "y": y,
                "spacing": spacing,
                "slope": slope,
                "inter": inter,
            }
        )
    first = records[0]
    normal = np.cross(first["x"], first["y"])
    for rec in records:
        if (
            rec["ds"].Rows,
            rec["ds"].Columns,
            rec["ds"].BitsAllocated,
            rec["ds"].BitsStored,
            rec["ds"].HighBit,
            rec["ds"].PixelRepresentation,
        ) != (
            first["ds"].Rows,
            first["ds"].Columns,
            first["ds"].BitsAllocated,
            first["ds"].BitsStored,
            first["ds"].HighBit,
            first["ds"].PixelRepresentation,
        ) or not all(
            np.allclose(rec[k], first[k], atol=1e-6, rtol=0) for k in ("x", "y", "spacing")
        ):
            _fail("Mixed slice geometry or scalar encoding")
    records.sort(key=lambda rec: float(rec["ipp"] @ normal))
    if len(records) < 2 or len(records) > 2048:
        _fail("Volume requires 2..2048 spatial slices")
    positions = np.array([r["ipp"] for r in records])
    delta = np.diff(positions, axis=0)
    step = delta.mean(axis=0)
    if (
        float(step @ normal) <= 1e-8
        or np.any(delta @ normal <= 1e-8)
        or not np.allclose(delta, step, atol=1e-4, rtol=1e-4)
    ):
        _fail("Duplicate or nonuniform slice positions")
    return records, step


def _write_bundle(records, step, blobs, scope, staging):
    import nibabel as nib
    import numpy as np

    first = records[0]
    arrays = []
    for rec in records:
        raw = _pixels(rec["ds"])
        if raw.shape != (int(rec["ds"].Rows), int(rec["ds"].Columns)):
            _fail("Decoded pixel shape mismatch")
        arrays.append(raw.astype(np.float64) * rec["slope"] + rec["inter"])
    values = np.stack(arrays)
    if not np.isfinite(values).all():
        _fail("Nonfinite rescaled pixels")
    if np.all(values == np.rint(values)) and values.min() >= -(2**31) and values.max() <= 2**31 - 1:
        dtype = np.dtype("int32")
        if all(r["slope"] == 1 and r["inter"] == 0 for r in records):
            dtype = _pixels(records[0]["ds"]).dtype
            if dtype == np.dtype("int8"):
                dtype = np.dtype("int16")
    else:
        dtype = np.dtype("float32")
    if values.size * dtype.itemsize + 352 > MAX_IMAGE_BYTES:
        _fail("Output image byte bound exceeded")
    with np.errstate(over="ignore", invalid="ignore"):
        data = values.astype(dtype).transpose(2, 1, 0)
    if not np.isfinite(data).all():
        _fail("Float output exceeds finite range")
    affine = np.eye(4)
    flip = np.diag([-1.0, -1.0, 1.0])
    affine[:3, :3] = flip @ np.column_stack(
        (first["x"] * first["spacing"][1], first["y"] * first["spacing"][0], step)
    )
    affine[:3, 3] = flip @ first["ipp"]
    header = nib.Nifti1Header()
    header.set_data_dtype(dtype)
    header.set_xyzt_units("mm")
    image = nib.Nifti1Image(data, affine, header=header)
    image.set_sform(affine, code=1)
    image.set_qform(None, code=0)
    image.header.set_slope_inter(1.0, 0.0)
    image_path = staging / IMAGE_FILENAME
    nib.save(image, image_path)
    payload = image_path.read_bytes()
    actual = nib.load(image_path)
    if not isinstance(actual, nib.Nifti1Image):
        _fail("Fresh output must be a NIfTI-1 image")
    if len(payload) > MAX_IMAGE_BYTES:
        _fail("Output image byte bound exceeded")
    actual_affine = actual.affine
    if actual_affine is None:
        _fail("Fresh output requires an explicit affine")
    fixed_rescale = all(
        r["slope"] == first["slope"] and r["inter"] == first["inter"] for r in records
    )
    manifest = {
        "version": 1,
        "clinical_validation": False,
        "application_installation": False,
        "scope": scope,
        "method": "converted_dicom_series",
        "image": {
            "filename": IMAGE_FILENAME,
            "dtype": dtype.name,
            "spatial_units": "mm",
            "sha256": hashlib.sha256(payload).hexdigest(),
            "bytes": len(payload),
            "shape_xyz": list(actual.shape),
            "affine_ras": actual_affine.tolist(),
        },
        "crop": {"start_voxels": [0, 0, 0], "size_voxels": list(actual.shape)},
        "source_provenance": {
            "type": "converted_dicom_series",
            "modality": str(first["ds"].Modality),
            "slice_count": len(records),
            "file_count": len(blobs),
            "input_aggregate_sha256": hashlib.sha256(
                b"".join(sorted(hashlib.sha256(b).digest() for b in blobs))
            ).hexdigest(),
            "rescale_mode": "global_linear" if fixed_rescale else "per_frame_linear",
            "rescale_slope": first["slope"] if fixed_rescale else None,
            "rescale_intercept": first["inter"] if fixed_rescale else None,
        },
    }
    (staging / "manifest.json").write_text(json.dumps(manifest, sort_keys=True, allow_nan=False))
    for path in (image_path, staging / "manifest.json"):
        path.chmod(0o600)


def convert_series(input_dir: Path, output_root: Path, source_id: str, *, scope: str) -> Path:
    # Lazy DataElement conversion also warns outside dcmread. Treat every warning
    # as rejection before a parser can print a raw UID or other source value.
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            return _convert_series(input_dir, output_root, source_id, scope=scope)
    except IngestError:
        raise
    except Exception:  # noqa: BLE001 - sanitize the public metadata boundary
        # Parser internals can include source metadata in their exceptions.
        raise IngestError("DICOM conversion rejected") from None


def _convert_series(input_dir: Path, output_root: Path, source_id: str, *, scope: str) -> Path:
    if scope not in {"synthetic", "public", "authorized"}:
        _fail("Invalid declared scope")
    if (
        not isinstance(source_id, str)
        or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{1,63}", source_id)
        or source_id.startswith("zenodo-case006-")
    ):
        _fail("Invalid opaque source_id")
    root = Path(output_root).absolute()
    destination = root / source_id
    # Reject unsafe existing ancestry before creating directories or reading input.
    if destination.exists() or destination.is_symlink():
        _fail("destination already exists")
    if any(p.is_symlink() for p in (root, *root.parents)):
        _fail("Output ancestry must not contain links")
    blobs = _collect_input_files(Path(input_dir))
    datasets = _datasets(blobs)
    records, step = _series(datasets)
    root.mkdir(parents=True, exist_ok=True)
    fd = _open_directory(root)
    os.close(fd)
    staging = Path(tempfile.mkdtemp(prefix=".dicom-staging-", dir=root))
    claimed = False
    try:
        _write_bundle(records, step, blobs, scope, staging)
        from planner.image_source import InstalledNiftiSourceStore

        InstalledNiftiSourceStore(staging, source_id=source_id).load()
        # Exclusive directory claim; manifest rename is the atomic admission point.
        destination.mkdir(mode=0o700)
        claimed = True
        os.rename(staging / IMAGE_FILENAME, destination / IMAGE_FILENAME)
        os.rename(staging / "manifest.json", destination / "manifest.json")
    except BaseException:
        if claimed:
            shutil.rmtree(destination)
        raise
    finally:
        shutil.rmtree(staging)
    return destination


def main(argv=None):
    parser = argparse.ArgumentParser(description="Local calibrated DICOM volume converter")
    parser.add_argument("input_dir")
    parser.add_argument("output_root")
    parser.add_argument("--source-id", required=True)
    parser.add_argument("--scope", required=True, choices=("synthetic", "public", "authorized"))
    args = parser.parse_args(argv)
    try:
        convert_series(
            Path(args.input_dir), Path(args.output_root), args.source_id, scope=args.scope
        )
    except Exception:  # noqa: BLE001 - outer CLI privacy boundary never exposes parser values
        print(
            "DICOM conversion rejected; verify format, geometry, bounds and approved input scope.",
            file=sys.stderr,
        )
        return 1
    print("Calibrated source bundle installed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
