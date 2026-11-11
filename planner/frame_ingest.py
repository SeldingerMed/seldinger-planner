"""Local admission of a few angiographic pixel frames. Ingest runtime only.

Reads a JSON request naming PNG frames (8-bit grayscale, for example from the
documented ffmpeg extraction) or frames of one uncompressed DICOM XA object
per plane, applies the declared redaction rectangles and crop, and installs a
bundle that ``planner.frame_source`` admits. Source files are read once,
hashed, and never copied; only the processed pixels are stored.

Run with the isolated ingest runtime:
  env -u PYTHONPATH -u PYTHONHOME .runtime/ingest-runtime/bin/python \
      -m planner.frame_ingest .runtime/installed-frames REQUEST.json --source-id ID
"""

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import struct
import sys
import tempfile
import warnings
import zlib
from pathlib import Path

from planner.carm_geometry import validate_view
from planner.dicom_ingest import IngestError, _fail, _open_directory
from planner.frame_source import (
    MANIFEST_FILENAME,
    MANIFEST_VERSION,
    MAX_FRAME_INDEX,
    MAX_FRAMES_PER_PLANE,
    MAX_MANIFEST_BYTES,
    MAX_PLANES,
    MAX_REDACTIONS,
    MAX_SIDE,
    MAX_SOURCE_SIDE,
    MIN_SIDE,
    PIXEL_FORMAT,
    InstalledFrameStore,
    frame_filename,
    validate_manifest,
    validate_rectangle,
)
from planner.projection_ingest import _plane, _read_input

MAX_REQUEST_BYTES = 65536
MAX_PNG_BYTES = 32 * 1024 * 1024
UNCOMPRESSED = {"1.2.840.10008.1.2", "1.2.840.10008.1.2.1"}
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_REQUEST_KEYS = {"scope", "planes"}
_PLANE_KEYS = {"plane", "kind", "crop", "redactions", "identifiers_removed"}


def decode_png(data: bytes):
    """Rows, columns and row-major bytes of an 8-bit grayscale PNG.

    Only non-interlaced 8-bit grayscale is admitted, which is what
    ``ffmpeg -pix_fmt gray`` writes. Ancillary chunks, including text, are
    skipped and never stored.
    """
    if not 0 < len(data) <= MAX_PNG_BYTES or data[:8] != _PNG_SIGNATURE:
        _fail("Select an 8-bit grayscale PNG frame")
    offset, header, compressed, ended = 8, None, [], False
    while offset + 12 <= len(data) and not ended:
        (length,) = struct.unpack(">I", data[offset : offset + 4])
        kind = data[offset + 4 : offset + 8]
        body = data[offset + 8 : offset + 8 + length]
        if len(body) != length or offset + 12 + length > len(data):
            _fail("Truncated PNG frame")
        (crc,) = struct.unpack(">I", data[offset + 8 + length : offset + 12 + length])
        if zlib.crc32(kind + body) != crc:
            _fail("Corrupt PNG frame")
        if header is None and kind != b"IHDR":
            _fail("Corrupt PNG frame")
        if kind == b"IHDR":
            if header is not None or length != 13:
                _fail("Corrupt PNG frame")
            header = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT":
            compressed.append(body)
        elif kind == b"IEND":
            ended = True
        offset += 12 + length
    if header is None or not ended:
        _fail("Truncated PNG frame")
    columns, rows, depth, color, compression, filtering, interlace = header
    if (depth, color, compression, filtering, interlace) != (8, 0, 0, 0, 0):
        _fail("Select an 8-bit grayscale, non-interlaced PNG frame")
    if not (1 <= rows <= MAX_SOURCE_SIDE and 1 <= columns <= MAX_SOURCE_SIDE):
        _fail("Unsupported frame dimensions")
    expected = rows * (columns + 1)
    inflater = zlib.decompressobj()
    try:
        raw = inflater.decompress(b"".join(compressed), expected + 1)
    except zlib.error:
        _fail("Corrupt PNG frame")
    if len(raw) != expected or not inflater.eof:
        _fail("PNG frame size contradicts its header")
    out, previous = bytearray(rows * columns), bytes(columns)
    for r in range(rows):
        start = r * (columns + 1)
        kind, line = raw[start], bytearray(raw[start + 1 : start + 1 + columns])
        if kind == 1:
            for i in range(1, columns):
                line[i] = (line[i] + line[i - 1]) & 255
        elif kind == 2:
            for i in range(columns):
                line[i] = (line[i] + previous[i]) & 255
        elif kind == 3:
            for i in range(columns):
                left = line[i - 1] if i else 0
                line[i] = (line[i] + ((left + previous[i]) >> 1)) & 255
        elif kind == 4:
            for i in range(columns):
                a = line[i - 1] if i else 0
                b = previous[i]
                c = previous[i - 1] if i else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                predictor = a if pa <= pb and pa <= pc else b if pb <= pc else c
                line[i] = (line[i] + predictor) & 255
        elif kind != 0:
            _fail("Corrupt PNG frame")
        out[r * columns : (r + 1) * columns] = line
        previous = bytes(line)
    return rows, columns, bytes(out)


def _dicom_frames(data: bytes, indexes):
    """Selected frames of an uncompressed monochrome XA object as 8-bit rows."""
    import numpy as np
    import pydicom

    ds = pydicom.dcmread(
        io.BytesIO(data),
        specific_tags=[
            "Rows",
            "Columns",
            "NumberOfFrames",
            "SamplesPerPixel",
            "PhotometricInterpretation",
            "BitsAllocated",
            "BitsStored",
            "PixelRepresentation",
            "PixelData",
        ],
    )
    if str(ds.file_meta.TransferSyntaxUID) not in UNCOMPRESSED:
        _fail("Uncompressed little-endian pixel data required")
    rows, columns = int(ds.Rows), int(ds.Columns)
    count = int(getattr(ds, "NumberOfFrames", 1))
    allocated, stored = int(ds.BitsAllocated), int(ds.BitsStored)
    photometric = str(ds.PhotometricInterpretation)
    if (
        int(ds.SamplesPerPixel) != 1
        or photometric not in ("MONOCHROME1", "MONOCHROME2")
        or allocated not in (8, 16)
        or not 1 <= stored <= allocated
        or int(ds.PixelRepresentation) != 0
    ):
        _fail("Unsigned single-sample monochrome pixel data required")
    step = allocated // 8
    size = rows * columns * step
    pixels = ds.get_item("PixelData").value
    if not isinstance(pixels, bytes) or not count * size <= len(pixels) <= count * size + 1:
        _fail("Pixel data length contradicts the frame dimensions")
    frames = []
    for index in indexes:
        if not 0 <= index < count:
            _fail("Frame index is outside the instance")
        frame = np.frombuffer(
            pixels, dtype="<u2" if step == 2 else "u1", count=rows * columns, offset=index * size
        ).astype(np.float64)
        frames.append(frame)
    # One linear display scale for the plane, from its own selected frames.
    low = min(float(frame.min()) for frame in frames)
    high = max(float(frame.max()) for frame in frames)
    span = high - low or 1.0
    out = []
    for frame in frames:
        scaled = np.rint((frame - low) * (255.0 / span))
        if photometric == "MONOCHROME1":
            scaled = 255.0 - scaled  # Stored bytes are display brightness.
        out.append(scaled.astype(np.uint8).tobytes())
    return rows, columns, out


def _process(pixels: bytes, rows, columns, crop, redactions):
    """Blank the redaction rectangles, then crop. Coordinates are source pixels."""
    data = bytearray(pixels)
    for x, y, width, height in redactions:
        for r in range(y, y + height):
            data[r * columns + x : r * columns + x + width] = bytes(width)
    if crop is None:
        return rows, columns, bytes(data)
    x, y, width, height = crop
    return (
        height,
        width,
        b"".join(data[r * columns + x : r * columns + x + width] for r in range(y, y + height)),
    )


def _relative(base: Path, name):
    if not isinstance(name, str) or not name or len(name) > 512 or Path(name).is_absolute():
        _fail("Input paths are relative to the request file")
    if ".." in Path(name).parts:
        _fail("Input paths are relative to the request file")
    return base / name


def _admit_plane(spec, base: Path):
    if not isinstance(spec, dict) or spec.get("kind") not in ("png", "dicom"):
        _fail("Invalid plane request")
    extra = {"frames", "container"} if spec["kind"] == "png" else {"path", "frame_indexes"}
    if not _PLANE_KEYS <= set(spec) <= _PLANE_KEYS | extra:
        _fail("Invalid plane request")
    if spec["kind"] == "dicom" and not extra <= set(spec):
        _fail("Invalid plane request")
    if spec["plane"] not in ("single", "a", "b"):
        _fail("Invalid plane label")
    crop, redactions = spec["crop"], spec["redactions"]
    if not isinstance(redactions, list) or len(redactions) > MAX_REDACTIONS:
        _fail("Invalid redactions")
    if type(spec["identifiers_removed"]) is not bool:
        _fail("Invalid identifier attestation")
    geometry, container, burned = None, None, "not_declared"
    if spec["kind"] == "png":
        requested = spec.get("frames")
        if not isinstance(requested, list) or not 1 <= len(requested) <= MAX_FRAMES_PER_PLANE:
            _fail("One to eight frames per plane required")
        decoded = []
        for item in requested:
            if not isinstance(item, dict) or set(item) != {"path", "index"}:
                _fail("Invalid frame request")
            if type(item["index"]) is not int or not 0 <= item["index"] <= MAX_FRAME_INDEX:
                _fail("Invalid frame index")
            data = _read_input(_relative(base, item["path"]))
            rows, columns, pixels = decode_png(data)
            decoded.append((item["index"], hashlib.sha256(data).hexdigest(), rows, columns, pixels))
        if spec.get("container") is not None:
            # The video is hashed in pieces and never loaded or decoded here.
            container = _hash_file(_relative(base, spec["container"]))
    else:
        indexes = spec["frame_indexes"]
        if (
            not isinstance(indexes, list)
            or not 1 <= len(indexes) <= MAX_FRAMES_PER_PLANE
            or any(type(index) is not int for index in indexes)
        ):
            _fail("One to eight frames per plane required")
        data = _read_input(_relative(base, spec["path"]))
        record, _ = _plane(data)
        burned = record["burned_in_annotation"]
        rows, columns, frames = _dicom_frames(data, indexes)
        if (rows, columns) != (record["rows"], record["columns"]):
            _fail("Conflicting frame dimensions")
        digest = hashlib.sha256(data).hexdigest()
        container = (digest, len(data))
        decoded = [
            (index, digest, rows, columns, pixels)
            for index, pixels in zip(indexes, frames, strict=True)
        ]
        spacing = record["imager_pixel_spacing_mm"]
        if record["calibration"]["status"] == "calibrated" and crop is None:
            geometry = {
                "primary_deg": record["primary_angle_deg"],
                "secondary_deg": record["secondary_angle_deg"],
                "source_detector_mm": record["source_detector_mm"],
                "source_isocenter_mm": record["source_isocenter_mm"],
                "detector_width_mm": spacing[1] * columns,
                "detector_height_mm": spacing[0] * rows,
            }
            try:
                validate_view(geometry)
            except ValueError:
                # Outside the supported camera bounds: admitted as uncalibrated.
                geometry = None
    rows, columns = source_rows, source_columns = decoded[0][2], decoded[0][3]
    if any((rows, columns) != (source_rows, source_columns) for _, _, rows, columns, _ in decoded):
        _fail("Frames of one plane must share their dimensions")
    declared_clean = spec["kind"] == "dicom" and burned == "no"
    if not declared_clean and spec["identifiers_removed"] is not True:
        _fail("Operator attestation that identifiers were removed is required")
    # An attestation with nothing recorded says nothing about what was removed.
    if spec["kind"] == "png" and crop is None:
        _fail("A PNG plane needs a recorded crop")
    if not declared_clean and crop is None and not redactions:
        _fail("An attested plane needs a recorded crop or redaction")
    try:
        if crop is not None:
            validate_rectangle(crop, source_columns, source_rows, "crop")
        for rectangle in redactions:
            validate_rectangle(rectangle, source_columns, source_rows, "redaction")
    except ValueError:
        _fail("Crop or redaction is outside the frame")
    frames, files = [], {}
    for index, input_sha, _, _, pixels in sorted(decoded, key=lambda item: item[0]):
        rows, columns, processed = _process(pixels, source_rows, source_columns, crop, redactions)
        frames.append(
            {
                "index": index,
                "sha256": hashlib.sha256(processed).hexdigest(),
                "input_sha256": input_sha,
            }
        )
        files[frame_filename(spec["plane"], index)] = processed
    if len(files) != len(decoded):
        _fail("Frame indexes must be distinct")
    if not (MIN_SIDE <= rows <= MAX_SIDE and MIN_SIDE <= columns <= MAX_SIDE):
        _fail("Stored frames must be 64 to 1024 pixels per side; crop larger frames")
    plane = {
        "plane": spec["plane"],
        "rows": rows,
        "columns": columns,
        "container_sha256": container[0] if container else None,
        "container_bytes": container[1] if container else None,
        "deidentification": {
            "basis": "dicom_declared_no_burned_in_annotation"
            if declared_clean
            else "operator_attested_crop_and_redaction",
            "burned_in_annotation": burned,
            "source_rows": source_rows,
            "source_columns": source_columns,
            "crop": crop,
            "redactions": redactions,
        },
        "geometry": geometry,
        "frames": frames,
    }
    return plane, files


def _hash_file(path: Path):
    path = Path(path).absolute()
    fd = _open_directory(path.parent)
    try:
        file_fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
    except OSError:
        _fail("Select a regular container file, without links")
    finally:
        os.close(fd)
    digest, size = hashlib.sha256(), 0
    with os.fdopen(file_fd, "rb") as stream:
        while chunk := stream.read(1 << 20):
            digest.update(chunk)
            size += len(chunk)
            if size > 2**40:
                _fail("Container byte bound exceeded")
    if size < 1:
        _fail("Container is empty")
    return digest.hexdigest(), size


def admit_frames(request_path, output_root: Path, source_id: str) -> Path:
    # Parser warnings and exceptions can carry source metadata. Reject on any
    # warning and replace every unexpected failure with a fixed message.
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            return _admit_frames(Path(request_path), output_root, source_id)
    except IngestError:
        raise
    except Exception:  # noqa: BLE001 - sanitize the public metadata boundary
        raise IngestError("Frame admission rejected") from None


def _admit_frames(request_path: Path, output_root: Path, source_id: str) -> Path:
    if not isinstance(source_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{1,63}", source_id):
        _fail("Invalid opaque source_id")
    root = Path(output_root).absolute()
    destination = root / source_id
    if destination.exists() or destination.is_symlink():
        _fail("destination already exists")
    if any(p.is_symlink() for p in (root, *root.parents)):
        _fail("Output ancestry must not contain links")
    raw = _read_input(request_path)
    if len(raw) > MAX_REQUEST_BYTES:
        _fail("Request byte bound exceeded")
    request = json.loads(raw)
    if not isinstance(request, dict) or set(request) != _REQUEST_KEYS:
        _fail("Invalid request fields")
    if request["scope"] not in ("synthetic", "public", "authorized"):
        _fail("Invalid declared scope")
    specs = request["planes"]
    if not isinstance(specs, list) or not 1 <= len(specs) <= MAX_PLANES:
        _fail("One or two planes required")
    kinds = {spec.get("kind") if isinstance(spec, dict) else None for spec in specs}
    if len(kinds) != 1:
        _fail("Planes of one bundle must share their kind")
    base = request_path.absolute().parent
    planes, files = [], {}
    for spec in specs:
        plane, plane_files = _admit_plane(spec, base)
        planes.append(plane)
        files.update(plane_files)
    manifest = {
        "version": MANIFEST_VERSION,
        "kind": "projection_frames",
        "clinical_validation": False,
        "scope": request["scope"],
        "method": "admitted_png_frames" if kinds == {"png"} else "admitted_dicom_xa_frames",
        "pixel_format": PIXEL_FORMAT,
        "biplane_linkage": "operator_declared" if len(planes) == 2 else "not_applicable",
        "planes": planes,
    }
    encoded = json.dumps(manifest, sort_keys=True, allow_nan=False).encode()
    if len(encoded) > MAX_MANIFEST_BYTES:
        _fail("Frame manifest byte bound exceeded")
    validate_manifest(json.loads(encoded))
    root.mkdir(parents=True, exist_ok=True)
    os.close(_open_directory(root))
    staging = Path(tempfile.mkdtemp(prefix=".frames-staging-", dir=root))
    claimed = False
    try:
        for name, data in {**files, MANIFEST_FILENAME: encoded}.items():
            (staging / name).write_bytes(data)
            (staging / name).chmod(0o600)
        # Exclusive directory claim. Frames move in first; the manifest rename
        # is the atomic admission point, since nothing is readable without it.
        destination.mkdir(mode=0o700)
        claimed = True
        for name in files:
            os.rename(staging / name, destination / name)
        os.rename(staging / MANIFEST_FILENAME, destination / MANIFEST_FILENAME)
        # The published bundle must pass the installed reader, frame by frame.
        store = InstalledFrameStore(root)
        for plane in planes:
            for frame in plane["frames"]:
                store.frame(source_id, plane["plane"], frame["index"])
    except BaseException:
        if claimed:
            shutil.rmtree(destination)
        raise
    finally:
        shutil.rmtree(staging)
    return destination


def main(argv=None):
    parser = argparse.ArgumentParser(description="Local angiographic frame admission")
    parser.add_argument("output_root")
    parser.add_argument("request")
    parser.add_argument("--source-id", required=True)
    args = parser.parse_args(argv)
    try:
        admit_frames(Path(args.request), Path(args.output_root), args.source_id)
    except Exception:  # noqa: BLE001 - outer CLI privacy boundary never exposes parser values
        print(
            "Frame admission rejected; verify format, bounds, crop, attestation and input scope.",
            file=sys.stderr,
        )
        return 1
    print("Projection frame bundle installed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
