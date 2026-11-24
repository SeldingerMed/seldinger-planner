"""A local cine bundle for the coronary fusion: one X-ray angiography cine
read from its DICOM file into one file the browser opens.

Run by the operator, on the operator's machine, with the ingest runtime:

    .runtime/ingest-runtime/bin/python -m planner.cine_bundle CINE.dcm OUT.cine

The bundle is a first line ``seldinger-cine-bundle-v1``, a line of JSON
(the header), then every frame as rows of 8-bit brightness, contrast dark.
It carries:

- ``source_sha256``: the SHA-256 of the DICOM file it was read from, so a
  pair stated for this cine names exactly this acquisition;
- the frame times in milliseconds from the first frame, and where they came
  from (Frame Time Vector or Frame Time). A cine that only holds a display
  rate gets ``timing`` ``"cine_rate"`` and no times: a display rate is not a
  record of when the frames were taken;
- the C-arm view where the header holds all of it (angles, source to
  detector, source to patient, detector pixel spacing) and it lies within
  the limits the browser admits, and whether the positioner was declared
  static;
- nothing that names the patient, the study or the date. Pairing a cine
  with a CT is the operator's statement, never read from identifiers.

The stored values are taken to 8 bits by one window over the whole cine
(its 0.5th to 99.5th percentile), so a frame's brightness is comparable with
its neighbours'. A file stored with bright contrast (MONOCHROME1) is turned
round. Compressed pixel data is decoded where the runtime's decoders read
it (JPEG Lossless, through GDCM); a file they cannot read is refused.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
import sys
import warnings
from itertools import pairwise
from pathlib import Path

from planner.dicom_ingest import IngestError, _fail
from planner.projection_ingest import XA, _classic_geometry, _read_input

FORMAT = "seldinger-cine-bundle-v1"
MAX_FRAMES = 600
MAX_SIDE = 2048
MAX_BUNDLE_BYTES = 512 * 1024 * 1024
WINDOW = "percentile_0.5_99.5_whole_cine"


def _times(geometry, frames):
    vector = geometry["frame_time_vector_ms"]
    if vector is not None:
        out, total = [], 0.0
        for k, step in enumerate(vector):
            total += step if k else 0.0
            out.append(round(total, 6))
        if all(b > a for a, b in pairwise(out)):
            return out, "frame_time_vector"
    step = geometry["frame_time_ms"]
    if step is not None:
        return [round(k * step, 6) for k in range(frames)], "frame_time"
    return None, None


# The browser's limits (web/src/carmGeometry.ts VIEW_LIMITS, MIN_DEPTH_MM);
# a test holds the two the same.
VIEW_LIMITS = {
    "primary_deg": (-180, 180),
    "secondary_deg": (-90, 90),
    "source_detector_mm": (300, 2000),
    "source_isocenter_mm": (100, 2000),
    "detector_width_mm": (50, 600),
    "detector_height_mm": (50, 600),
}
MIN_VIEW_DEPTH_MM = 1


def _view_admitted(view: dict) -> bool:
    for name, (low, high) in VIEW_LIMITS.items():
        value = view[name]
        if not (isinstance(value, (int, float)) and math.isfinite(value) and low <= value <= high):
            return False
    return view["source_detector_mm"] - view["source_isocenter_mm"] >= MIN_VIEW_DEPTH_MM


def read_cine(data: bytes):
    """The header and the 8-bit frames of one classic XA cine."""
    import numpy as np
    import pydicom

    digest = hashlib.sha256(data).hexdigest()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            ds = pydicom.dcmread(io.BytesIO(data))
        except Exception:  # noqa: BLE001 - any unreadable file gets one plain refusal
            _fail("Not a readable DICOM file")
    if str(getattr(ds, "SOPClassUID", "")) != XA:
        _fail("A classic X-ray angiography cine is required")
    frames = int(getattr(ds, "NumberOfFrames", 1) or 1)
    rows, columns = int(ds.Rows), int(ds.Columns)
    if not 2 <= frames <= MAX_FRAMES:
        _fail("A cine of 2 to 600 frames is required")
    if not (64 <= rows <= MAX_SIDE and 64 <= columns <= MAX_SIDE):
        _fail("Unsupported frame dimensions")
    if int(getattr(ds, "SamplesPerPixel", 1)) != 1 or str(
        getattr(ds, "PhotometricInterpretation", "")
    ) not in ("MONOCHROME1", "MONOCHROME2"):
        _fail("Single-sample monochrome pixel data required")
    geometry = _classic_geometry(ds, frames)
    try:
        pixels = ds.pixel_array
    except Exception:  # noqa: BLE001 - decoder failures vary by plugin
        _fail(f"Pixel data could not be decoded ({ds.file_meta.TransferSyntaxUID.name})")
    pixels = np.asarray(pixels)
    if pixels.shape != (frames, rows, columns):
        _fail("Pixel data contradicts the frame dimensions")
    # Stored values stay integers: the percentiles of the whole cine are
    # taken on them (each order statistic is exact, the interpolation is in
    # float64), and only one frame at a time is turned into floats. The
    # bytes are those of a float64 copy of the whole cine, without its memory.
    if str(ds.PhotometricInterpretation) == "MONOCHROME1":
        pixels = pixels.astype(np.int64 if pixels.dtype.kind == "i" else pixels.dtype)
        pixels = pixels.max() - pixels
    low, high = (float(v) for v in np.percentile(pixels, [0.5, 99.5]))
    span = max(high - low, 1e-9)
    out = np.empty(pixels.shape, dtype=np.uint8)
    for k in range(frames):
        frame = pixels[k].astype(np.float64)
        out[k] = np.round(np.clip((frame - low) / span * 255.0, 0, 255))
    times, timing = _times(geometry, frames)
    if timing is None and (
        getattr(ds, "CineRate", None) or getattr(ds, "RecommendedDisplayFrameRate", None)
    ):
        timing = "cine_rate"
    spacing = geometry["imager_pixel_spacing_mm"]
    view = None
    if (
        geometry["primary_angle_deg"] is not None
        and geometry["secondary_angle_deg"] is not None
        and geometry["source_detector_mm"] is not None
        and geometry["source_isocenter_mm"] is not None
        and spacing is not None
    ):
        view = {
            "primary_deg": geometry["primary_angle_deg"],
            "secondary_deg": geometry["secondary_angle_deg"],
            "source_detector_mm": geometry["source_detector_mm"],
            "source_isocenter_mm": geometry["source_isocenter_mm"],
            "detector_width_mm": round(spacing[1] * columns, 6),
            "detector_height_mm": round(spacing[0] * rows, 6),
        }
        # Only a view the browser's bundle reader admits is written; any
        # other is left out, as a view the header does not hold is.
        if not _view_admitted(view):
            view = None
    motion = geometry["positioner_motion"]
    header = {
        "format": FORMAT,
        "source_sha256": digest,
        "frames": frames,
        "rows": rows,
        "columns": columns,
        "times_ms": times,
        "timing": timing,
        "view": view,
        "geometry": {"static": "fixed", "dynamic": "moving"}.get(motion, "unknown"),
        "transfer_syntax": str(ds.file_meta.TransferSyntaxUID),
        "window": WINDOW,
        "identifiers": "not_carried",
    }
    return header, out


def encode_bundle(header, frames) -> bytes:
    body = frames.tobytes()
    if len(body) != header["frames"] * header["rows"] * header["columns"]:
        _fail("Frames contradict the header")
    text = json.dumps(header, sort_keys=True, separators=(",", ":"), allow_nan=False)
    out = (FORMAT + "\n").encode() + text.encode() + b"\n" + body
    if len(out) > MAX_BUNDLE_BYTES:
        _fail("Bundle byte bound exceeded")
    return out


def _write_new(path: Path, data: bytes):
    path = Path(path).absolute()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("cine", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args(argv)
    try:
        header, frames = read_cine(_read_input(args.cine))
        data = encode_bundle(header, frames)
        _write_new(args.output, data)
    except IngestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except FileExistsError:
        print("error: the output file exists", file=sys.stderr)
        return 2
    except Exception:  # noqa: BLE001 - outer CLI privacy boundary never exposes parser values
        print("error: the cine could not be read", file=sys.stderr)
        return 2
    print(
        json.dumps(
            {
                "bundle_sha256": hashlib.sha256(data).hexdigest(),
                "source_sha256": header["source_sha256"],
                "frames": header["frames"],
                "timing": header["timing"],
                "view": header["view"] is not None,
                "geometry": header["geometry"],
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
