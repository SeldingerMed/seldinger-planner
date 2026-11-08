"""Trusted native-grid calibration parsed from verified source bytes.

These tests exercise the actual generated NIfTI-1 header bytes (gzip, sha256)
with stdlib only: no NumPy and no NiBabel in this module.
"""

import gzip
import hashlib
import math
import struct


def header_bytes(shape, srow, *, units=2, sform_code=1, qform_code=0):
    hdr = bytearray(348)
    struct.pack_into("<i", hdr, 0, 348)
    struct.pack_into("<8h", hdr, 40, 3, *shape, 1, 1, 1, 1)
    struct.pack_into("<8f", hdr, 76, 1.0, 0.5, 0.5, 0.625, 1.0, 1.0, 1.0, 1.0)
    struct.pack_into("<f", hdr, 108, 352.0)
    hdr[123] = units
    struct.pack_into("<2h", hdr, 252, qform_code, sform_code)
    struct.pack_into("<3f", hdr, 256, 0.0, 0.0, 0.0)
    struct.pack_into("<3f", hdr, 268, srow[0][3], srow[1][3], srow[2][3])
    for index, row in enumerate(srow):
        struct.pack_into("<4f", hdr, 280 + 16 * index, *row)
    hdr[344:348] = b"n+1\x00"
    return bytes(hdr) + b"\x00" * 4


def write_source(tmp_path, payload):
    compressed = gzip.compress(payload)
    digest = hashlib.sha256(compressed).hexdigest()
    path = tmp_path / "source.nii.gz"
    path.write_bytes(compressed)
    return path, digest


def affine_apply(affine, voxel):
    return [
        affine[r][0] * voxel[0] + affine[r][1] * voxel[1] + affine[r][2] * voxel[2] + affine[r][3]
        for r in range(3)
    ]


def test_trusted_grid_binds_actual_header_shape_and_affine(tmp_path):
    from planner.native_grid import trusted_grid

    srow = [[0.5, 0, 0, 8.0], [0, 0.5, 0, 9.0], [0, 0, 0.625, 1.7]]
    path, digest = write_source(tmp_path, header_bytes([56, 77, 50], srow))
    bundle = (
        {"image": {"sha256": digest, "affine_ras": [[-1, 0, 0, 0]] * 3}},
        "b" * 64,
        {"image": path},
    )
    grid = trusted_grid(bundle)
    # The manifest affine above is deliberately wrong: the actual stored
    # header, not the provider manifest, is the trusted calibration.
    assert grid["shape"] == [56, 77, 50]
    assert grid["affine"][:3] == [
        list(struct.unpack_from("<4f", header_bytes([56, 77, 50], srow), 280 + 16 * i))
        for i in range(3)
    ]
    assert grid["affine"][3] == [0, 0, 0, 1]
    assert grid["units"] == "mm"


def test_off_center_anchor_snaps_to_rotated_anisotropic_voxel_center(tmp_path):
    from planner.native_grid import validate_centerline_binding

    angle = math.pi / 6
    cos, sin = math.cos(angle), math.sin(angle)
    affine = [
        [0.5 * cos, -0.5 * sin, 0.0, 8.0],
        [0.5 * sin, 0.5 * cos, 0.0, 9.0],
        [0.0, 0.0, 0.625, 1.7],
        [0.0, 0.0, 0.0, 1.0],
    ]
    grid = {"shape": [56, 77, 50], "affine": affine, "units": "mm"}
    start_center = affine_apply(affine, [8, 9, 4])
    end_center = affine_apply(affine, [8, 9, 19])
    # Operator anchors are physically consistent but off-center: their native
    # voxel coordinates are (8.3, 8.6, 4.0) and (8.4, 9.5, 19.0).
    start_anchor = affine_apply(affine, [8.3, 8.6, 4.0])
    end_anchor = affine_apply(affine, [8.4, 9.5, 19.0])
    result = {
        "grid_shape": [56, 77, 50],
        "path_ras": [list(start_center), [0.0, 0.0, 9.0], list(end_center)],
        "length_mm": 1.0,
    }
    validate_centerline_binding(grid, {"start_ras": start_anchor, "end_ras": end_anchor}, result)


def test_misanchored_grid_shape_or_endpoint_is_rejected(tmp_path):
    import pytest

    from planner.native_grid import validate_centerline_binding

    affine = [[0.5, 0, 0, 8.0], [0, 0.5, 0, 9.0], [0, 0, 0.625, 1.7], [0, 0, 0, 1.0]]
    grid = {"shape": [56, 77, 50], "affine": affine, "units": "mm"}
    start_anchor = affine_apply(affine, [8.3, 8.6, 4.0])
    end_center = affine_apply(affine, [8, 9, 19])
    result = {
        "grid_shape": [56, 77, 50],
        "path_ras": [list(affine_apply(affine, [8, 9, 4])), [0.0, 0.0, 9.0], list(end_center)],
        "length_mm": 1.0,
    }
    with pytest.raises(ValueError):
        validate_centerline_binding(
            grid,
            {"start_ras": start_anchor, "end_ras": end_center},
            result | {"grid_shape": [4, 4, 4]},
        )
    # Anchor beyond half a voxel of the proposed endpoint voxel.
    far_anchor = affine_apply(affine, [9.0, 8.6, 4.0])
    with pytest.raises(ValueError):
        validate_centerline_binding(grid, {"start_ras": far_anchor, "end_ras": end_center}, result)
    # Path endpoint is not a native voxel center.
    off_center = affine_apply(affine, [8, 9, 4.37])
    with pytest.raises(ValueError):
        validate_centerline_binding(
            grid,
            {"start_ras": start_anchor, "end_ras": end_center},
            result | {"path_ras": [list(off_center), [0.0, 0.0, 9.0], list(end_center)]},
        )


def test_tampered_source_bytes_or_invalid_headers_are_rejected(tmp_path):
    import pytest

    from planner.native_grid import trusted_grid

    srow = [[0.5, 0, 0, 8.0], [0, 0.5, 0, 9.0], [0, 0, 0.625, 1.7]]
    path, _digest = write_source(tmp_path, header_bytes([56, 77, 50], srow))
    bundle = ({"image": {"sha256": "f" * 64}}, "b" * 64, {"image": path})
    with pytest.raises(ValueError):
        trusted_grid(bundle)

    def bound(payload):
        compressed = gzip.compress(payload)
        return (
            {"image": {"sha256": hashlib.sha256(compressed).hexdigest()}},
            "b" * 64,
            {"image": _write(tmp_path, compressed)},
        )

    # Non-millimeter xyzt units must not silently calibrate a grid.
    with pytest.raises(ValueError):
        trusted_grid(bound(header_bytes([56, 77, 50], srow, units=0)))
    # Shape over the per-dimension bound.
    with pytest.raises(ValueError):
        trusted_grid(bound(header_bytes([56, 77, 2049], srow)))
    # Grid over the voxel budget.
    with pytest.raises(ValueError):
        trusted_grid(bound(header_bytes([2048, 2048, 3], srow)))
    from planner.native_grid import parse_grid_header

    with pytest.raises(ValueError):
        parse_grid_header(b"\x1f\x8b")
    # Truncated header.
    with pytest.raises(ValueError):
        trusted_grid(bound(b"\x00" * 100))
    # Wrong magic / sizeof_hdr.
    broken = bytearray(header_bytes([56, 77, 50], srow))
    struct.pack_into("<i", broken, 0, 347)
    with pytest.raises(ValueError):
        trusted_grid(bound(bytes(broken)))
    # No sform or qform calibration present.
    with pytest.raises(ValueError):
        trusted_grid(bound(header_bytes([56, 77, 50], srow, sform_code=0, qform_code=0)))
    # Singular affine.
    with pytest.raises(ValueError):
        trusted_grid(bound(header_bytes([56, 77, 50], [[1, 0, 0, 0], [1, 0, 0, 0], [0, 0, 1, 0]])))


def _write(tmp_path, compressed):
    path = tmp_path / "broken.nii.gz"
    path.write_bytes(compressed)
    return path


def test_qform_only_is_rejected_even_with_valid_quaternion(tmp_path):
    import pytest

    from planner.native_grid import trusted_grid

    payload = header_bytes(
        [8, 9, 32],
        [[0.5, 0, 0, 8.0], [0, 0.5, 0, 9.0], [0, 0, 0.625, 1.7]],
        sform_code=0,
        qform_code=1,
    )
    path, digest = write_source(tmp_path, payload)
    with pytest.raises(ValueError, match="sform"):
        trusted_grid(({"image": {"sha256": digest}}, "b" * 64, {"image": path}))


def test_no_heavy_imports_in_fresh_interpreter():
    import os
    import subprocess
    import sys

    env = {k: v for k, v in os.environ.items() if not k.startswith("PYTHON")}
    child = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import sys;import planner.native_grid as m;assert m.MAX_VOXELS==8_000_000;"
                "assert not {'numpy','nibabel'} & set(sys.modules)"
            ),
        ],
        capture_output=True,
        text=True,
        env=env,
        timeout=20,
        check=False,
    )
    assert child.returncode == 0, child.stderr


def test_big_endian_sform_and_bounded_header_read(tmp_path, monkeypatch):
    from planner import native_grid

    header = bytearray(352)
    struct.pack_into(">i", header, 0, 348)
    struct.pack_into(">8h", header, 40, 3, 8, 9, 32, 1, 1, 1, 1)
    header[123] = 2
    header[344:348] = b"n+1\x00"
    struct.pack_into(">h", header, 254, 1)
    for row, values in enumerate(
        [[0.0, -0.5, 0.0, 8.0], [0.75, 0.0, 0.0, 9.0], [0.0, 0.0, 0.625, 1.7]]
    ):
        struct.pack_into(">4f", header, 280 + 16 * row, *values)
    real = gzip.GzipFile
    reads = []

    class Reader:
        def __init__(self, **kwargs):
            self.reader = real(**kwargs)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            self.reader.close()

        def read(self, n):
            reads.append(n)
            return self.reader.read(n)

    compressed = gzip.compress(bytes(header) + b"x" * 100000)
    monkeypatch.setattr(native_grid.gzip, "GzipFile", Reader)
    grid = native_grid.parse_grid_header(compressed)
    assert reads == [native_grid.HEADER_BYTES + 1]
    assert grid["shape"] == [8, 9, 32]
    assert grid["affine"][1] == [0.75, 0.0, 0.0, 9.0]
