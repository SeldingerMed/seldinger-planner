"""Decode one X-ray angiography cine to standard output, for the cine
evaluation in ``web/src/research/coronaryCine.eval.ts``. Nothing is written
to disk.

Run with the ingest runtime (pydicom, numpy):
  .runtime/ingest-runtime/bin/python scripts/research/decode_cine.py FILE

Output: one line of JSON (frames, rows, columns, frame times in
milliseconds from the first frame, C-arm angles and distances where the
file holds them, the file's SHA-256), a newline, then every frame as rows
of 8-bit brightness, contrast dark. A cine's stored values are taken to
8 bits by one window over the whole cine (its 0.5th to 99.5th percentile),
so a frame's brightness is comparable with its neighbours'. A file stored
with bright contrast (MONOCHROME1) is turned round.
"""

import hashlib
import json
import sys

import numpy as np
import pydicom


def times_ms(ds, frames):
    vector = getattr(ds, "FrameTimeVector", None)
    if vector is not None and len(vector) == frames:
        steps = [float(v) for v in vector]
        out, total = [], 0.0
        for k, step in enumerate(steps):
            total += step if k else 0.0
            out.append(total)
        return out, "frame_time_vector"
    frame_time = getattr(ds, "FrameTime", None)
    if frame_time:
        return [k * float(frame_time) for k in range(frames)], "frame_time"
    rate = getattr(ds, "CineRate", None) or getattr(ds, "RecommendedDisplayFrameRate", None)
    if rate:
        return [k * 1000.0 / float(rate) for k in range(frames)], "cine_rate"
    return None, None


def main(path):
    with open(path, "rb") as handle:
        data = handle.read()
    ds = pydicom.dcmread(path)
    frames = int(getattr(ds, "NumberOfFrames", 1) or 1)
    pixels = ds.pixel_array.astype(np.float64)
    if frames == 1:
        pixels = pixels[None]
    if getattr(ds, "PhotometricInterpretation", "") == "MONOCHROME1":
        pixels = pixels.max() - pixels
    low, high = np.percentile(pixels, [0.5, 99.5])
    scaled = np.clip((pixels - low) / max(high - low, 1e-9) * 255.0, 0, 255)
    out = np.round(scaled).astype(np.uint8)
    times, timing = times_ms(ds, frames)

    def number(name):
        value = getattr(ds, name, None)
        try:
            return float(value) if value is not None else None
        except (TypeError, ValueError):
            return None

    header = {
        "frames": frames,
        "rows": int(ds.Rows),
        "columns": int(ds.Columns),
        "times_ms": times,
        "timing": timing,
        "primary_deg": number("PositionerPrimaryAngle"),
        "secondary_deg": number("PositionerSecondaryAngle"),
        "manufacturer": str(getattr(ds, "Manufacturer", "")),
        "sha256": hashlib.sha256(data).hexdigest(),
    }
    sys.stdout.write(json.dumps(header) + "\n")
    sys.stdout.flush()
    sys.stdout.buffer.write(out.tobytes())


if __name__ == "__main__":
    main(sys.argv[1])
