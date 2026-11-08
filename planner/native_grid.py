"""Trusted native-grid calibration parsed from the verified source bytes.

Stdlib-only: the exact bytes pinned by the verified source hash are bounded
gzip-decompressed and the actual NIfTI-1 header (first 352 bytes) is decoded
with struct. The actual stored header supplies the calibration that binds
grid shape and RAS anchors. Provider manifests and caller affines do not
override it. No NumPy, no NiBabel, no data-array decode.
"""

import gzip
import io
import math
import struct

from planner.native_inputs import MAX_VOXELS, verified_bytes

HEADER_BYTES = 352
MAX_DIMENSION = 2048
# Python's round() banker's-tie policy matches the fixed worker; half-voxel
# cell membership admits exact ties with a floating-point epsilon.
HALF_VOXEL = 0.5 + 1e-6
CENTER_TOLERANCE = 1e-4


def _decompress(payload):
    if payload[:2] == b"\x1f\x8b":
        try:
            with gzip.GzipFile(fileobj=io.BytesIO(payload)) as stream:
                return stream.read(HEADER_BYTES + 1)
        except (EOFError, OSError):
            raise ValueError("Native source compressed header is invalid") from None
    return payload[: HEADER_BYTES + 1]


def parse_grid_header(payload):
    """Decode the trusted NIfTI-1 calibration from verified source bytes."""
    raw = _decompress(payload)
    if len(raw) < HEADER_BYTES:
        raise ValueError("Native source header is truncated")
    header = raw[:HEADER_BYTES]
    endian = next(
        (order for order in ("<", ">") if struct.unpack_from(order + "i", header, 0)[0] == 348),
        None,
    )
    if endian is None or header[344:348] != b"n+1\x00":
        raise ValueError("Native source is not a NIfTI-1 image")
    dims = struct.unpack_from(endian + "8h", header, 40)
    if dims[0] != 3:
        raise ValueError("Native source grid must be three-dimensional")
    shape = list(dims[1:4])
    if (
        any(type(n) is not int or n < 1 or n > MAX_DIMENSION for n in shape)
        or math.prod(shape) > MAX_VOXELS
    ):
        raise ValueError("Native source grid exceeds its bound")
    if header[123] & 0x07 != 2:
        raise ValueError("Native source spatial units must be millimeters")
    sform_code = struct.unpack_from(endian + "h", header, 254)[0]
    if sform_code <= 0:
        raise ValueError("Native source requires explicit sform calibration")
    affine = [list(struct.unpack_from(endian + "4f", header, 280 + 16 * i)) for i in range(3)]
    affine.append([0.0, 0.0, 0.0, 1.0])
    if (
        affine[3] != [0, 0, 0, 1]
        or any(not math.isfinite(v) for row in affine for v in row)
        or not math.isfinite(_determinant3(affine))
        or abs(_determinant3(affine)) < 1e-12
    ):
        raise ValueError("Invalid native source calibration")
    return {"shape": shape, "affine": affine, "units": "mm"}


def trusted_grid(bundle):
    """Load the verified source bytes and return its trusted native grid."""
    return parse_grid_header(verified_bytes(bundle[2]["image"], bundle[0]["image"]["sha256"]))


def _determinant3(affine):
    m = affine
    return (
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    )


def _inverse3(m):
    det = _determinant3(m)
    if not math.isfinite(det) or abs(det) < 1e-12:
        raise ValueError("Native source calibration is singular")
    a, b, c = m[0][:3]
    d, e, f = m[1][:3]
    g, h, i = m[2][:3]
    return [
        [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
        [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
        [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
    ]


def native_voxel(affine, point):
    """Pure Cramer-inverse transform of a RAS point to native coordinates."""
    inverse = _inverse3(affine)
    delta = [point[r] - affine[r][3] for r in range(3)]
    return tuple(
        inverse[r][0] * delta[0] + inverse[r][1] * delta[1] + inverse[r][2] * delta[2]
        for r in range(3)
    )


def _is_voxel_center(grid, point):
    native = native_voxel(grid["affine"], point)
    return all(
        abs(v - round(v)) <= CENTER_TOLERANCE and 0 <= round(v) <= n - 1
        for v, n in zip(native, grid["shape"], strict=True)
    )


def validate_centerline_binding(grid, parameters, result):
    """Bind proposal endpoints and grid diagnostics to the trusted calibration.

    Each endpoint must be a native voxel center. Its operator anchor must
    lie within half a voxel componentwise of that center. Floating ties
    are admitted on either adjacent cell by this validation; the fixed
    worker chooses nearest-index representatives with ties to even.
    """
    if result.get("grid_shape") != list(grid["shape"]):
        raise ValueError("Centerline grid shape does not match the trusted source header")
    points = result["path_ras"]
    for anchor, point, label in (
        (parameters["start_ras"], points[0], "start"),
        (parameters["end_ras"], points[-1], "end"),
    ):
        if not _is_voxel_center(grid, point):
            raise ValueError(f"Proposed {label} endpoint is not a native voxel center")
        anchor_voxel = native_voxel(grid["affine"], anchor)
        endpoint_voxel = native_voxel(grid["affine"], point)
        if any(
            not math.isfinite(a) or not 0 <= a <= n - 1
            for a, n in zip(anchor_voxel, grid["shape"], strict=True)
        ):
            raise ValueError("Operator anchor is outside the native center grid")
        if any(abs(a - e) > HALF_VOXEL for a, e in zip(anchor_voxel, endpoint_voxel, strict=True)):
            raise ValueError(f"Operator {label} anchor is misanchored to the proposed endpoint")
