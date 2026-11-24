"""Decode one X-ray angiography cine to standard output, for the research
evaluations in ``web/src/research``. Nothing is written to disk.

Run with the ingest runtime (pydicom, numpy, GDCM for JPEG Lossless):
  .runtime/ingest-runtime/bin/python scripts/research/decode_cine.py FILE

Output: one line of JSON, then every frame as rows of 8-bit brightness,
contrast dark. The frames, times, view and window are exactly those of the
product's cine bundle (``planner.cine_bundle.read_cine``): one window over
the whole cine, bright contrast turned round, and no times where the file
holds only a display rate. The line adds the maker's name and the keys the
earlier evaluations read (``sha256``, ``primary_deg``, ``secondary_deg``).
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from planner.cine_bundle import read_cine


def main(path):
    import pydicom

    with open(path, "rb") as handle:
        data = handle.read()
    header, frames = read_cine(data)
    maker = str(getattr(pydicom.dcmread(path, stop_before_pixels=True), "Manufacturer", ""))
    view = header["view"] or {}
    line = {
        **header,
        "manufacturer": maker,
        "sha256": header["source_sha256"],
        "primary_deg": view.get("primary_deg"),
        "secondary_deg": view.get("secondary_deg"),
    }
    sys.stdout.write(json.dumps(line) + "\n")
    sys.stdout.flush()
    sys.stdout.buffer.write(frames.tobytes())


if __name__ == "__main__":
    main(sys.argv[1])
