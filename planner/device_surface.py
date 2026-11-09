"""Bounded read-only native-mask display surfaces. No anatomy repair or smoothing."""

from __future__ import annotations

import hashlib
import math
import struct
import subprocess
from pathlib import Path

MAX_TRIANGLES = 60_000
ROOT = Path(__file__).resolve().parents[1]


def triangles_to_stl(triangles):
    if not isinstance(triangles, list) or not 0 < len(triangles) <= MAX_TRIANGLES:
        raise ValueError("Surface triangle cap exceeded")
    result = bytearray(84 + 50 * len(triangles))
    struct.pack_into("<I", result, 80, len(triangles))
    for i, tri in enumerate(triangles):
        if len(tri) != 3 or any(len(p) != 3 for p in tri):
            raise ValueError("Invalid surface triangle")
        values = [float(v) for p in tri for v in p]
        if not all(math.isfinite(v) and abs(v) <= 100_000 for v in values):
            raise ValueError("Invalid surface coordinates")
        struct.pack_into("<12fH", result, 84 + i * 50, 0, 0, 0, *values, 0)
    return bytes(result)


def build_surface(mask_path: Path, sha256: str) -> bytes:
    completed = subprocess.run(
        [
            str(ROOT / ".runtime/ml-runtime/bin/python"),
            "-m",
            "planner.device_surface",
            str(mask_path),
            sha256,
        ],
        cwd=ROOT,
        capture_output=True,
        timeout=30,
        check=True,
    )
    data = completed.stdout
    if not 134 <= len(data) <= 84 + 50 * MAX_TRIANGLES:
        raise ValueError("Surface output exceeds cap")
    count = struct.unpack_from("<I", data, 80)[0]
    if count > MAX_TRIANGLES or len(data) != 84 + 50 * count:
        raise ValueError("Invalid surface output")
    return data


def native_surface(path: Path, expected_sha: str):
    import gzip
    import io
    import re

    import nibabel as nib
    import numpy as np

    from planner.mask_geometry import surface_from_mask

    if re.fullmatch(r"[a-f0-9]{64}", expected_sha) is None:
        raise ValueError("Invalid mask identity")
    if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= 16 * 1024**2:
        raise ValueError("Invalid mask source")
    with path.open("rb") as stream:
        encoded = stream.read(16 * 1024**2 + 1)
    if len(encoded) > 16 * 1024**2 or hashlib.sha256(encoded).hexdigest() != expected_sha:
        raise ValueError("Mask integrity mismatch")
    # Decode the exact immutable bytes just verified, never reopen a mutable path.
    with gzip.GzipFile(fileobj=io.BytesIO(encoded)) as stream:
        decoded = stream.read(16 * 1024**2 + 1)
    if len(decoded) > 16 * 1024**2:
        raise ValueError("Decoded mask exceeds cap")
    image = nib.Nifti1Image.from_bytes(decoded)
    if (
        len(image.shape) != 3
        or math.prod(image.shape) > 8_000_000
        or image.header.get_xyzt_units()[0] != "mm"
    ):
        raise ValueError("Unsupported native mask geometry")
    if (
        image.get_data_dtype() != np.uint8
        or getattr(image.dataobj, "slope", None) != 1
        or getattr(image.dataobj, "inter", None) != 0
    ):
        raise ValueError("Unsupported mask encoding")
    mesh = surface_from_mask(
        np.asarray(image.dataobj),
        image.affine,
        reject_boundary=False,
        triangle_budget=MAX_TRIANGLES,
    )
    return triangles_to_stl(mesh["triangles_world"])


if __name__ == "__main__":
    import sys

    sys.stdout.buffer.write(native_surface(Path(sys.argv[1]), sys.argv[2]))
