"""Offline, hash-checked, narrowly scoped reference source preparer (plan Task 1).

Stdlib only. Converts a little-endian 3D float64 NIfTI-1 context crop and two
curated STL surfaces into deterministic runtime assets plus a fixed manifest.
This is curated-reference preparation, not inference, registration or
morphometry; the STL transform is an explicit candidate, never inferred.
"""

import gzip
import hashlib
import json
import math
import re
import struct
import time
from pathlib import Path

SCHEMA_VERSION = 1
CASE_LABEL = "CMHA AHMU1218001"
SOURCE_URL = "https://doi.org/10.6084/m9.figshare.26965450.v1"
LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/"
CITATION = (
    "Song et al., CMHA (2024). Original case AHMU1218001. Context crop and "
    "coordinate-transformed curated references."
)
IMAGE_FILENAME = "reference-cta.nii.gz"
ANNOTATION_FILES = {"aneurysm": "reference-aneurysm.stl", "artery": "reference-artery.stl"}
# Explicit candidate only: diagonal image flip in x/y, z preserved.
TRANSFORM = [[-1.0, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, 1.0]]
TRANSFORM_STATUS = "candidate_image_consistent"

DATATYPE_FLOAT64 = 64
MAX_GZ_BYTES = 100 * 1024 * 1024
MAX_DECLARED_BYTES = 1100 * 1024 * 1024
MAX_STL_BYTES = 2 * 1024 * 1024
MAX_SECONDS = 30.0
HASH_CHUNK = 1024 * 1024


class ReferencePreparationError(ValueError):
    """Any rejected source, bound violation, or output-contract failure."""


class _HashingWriter:
    def __init__(self, fileobj):
        self._fileobj = fileobj
        self.hasher = hashlib.sha256()

    def write(self, data):
        self.hasher.update(data)
        return self._fileobj.write(data)

    def close(self):
        self._fileobj.close()


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(HASH_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def _verify_inputs(cta_path, aneurysm_path, artery_path, output_dir, expected_sha256):
    inputs = {"cta": cta_path, "aneurysm": aneurysm_path, "artery": artery_path}
    missing = [key for key in ("cta", "aneurysm", "artery") if key not in expected_sha256]
    if missing:
        raise ReferencePreparationError(f"missing expected hash keys: {missing}")
    if output_dir.is_symlink():
        raise ReferencePreparationError("output directory must not be a symlink")
    resolved = {}
    for key, path in inputs.items():
        if not path.is_file():
            raise ReferencePreparationError(f"{key} input not found: {path}")
        if path.is_symlink():
            raise ReferencePreparationError(f"{key} input must not be a symlink: {path}")
        cap = MAX_GZ_BYTES if key == "cta" else MAX_STL_BYTES
        if path.stat().st_size > cap:
            raise ReferencePreparationError(f"{key} input exceeds size cap")
        resolved[key] = path.resolve()
        actual = _file_sha256(path)
        if actual != expected_sha256[key]:
            raise ReferencePreparationError(
                f"{key} hash mismatch: {actual} != {expected_sha256[key]}"
            )
    out_resolved = output_dir.resolve()
    if output_dir.exists():
        if not output_dir.is_dir():
            raise ReferencePreparationError("output path is not a directory")
        if any(output_dir.iterdir()):
            raise ReferencePreparationError("output directory must be absent or empty")
    for key, src in resolved.items():
        if out_resolved == src or out_resolved in src.parents or src in out_resolved.parents:
            raise ReferencePreparationError(f"output directory aliases {key} source")
    if out_resolved.exists() or out_resolved.parent.is_dir():
        for key, src in resolved.items():
            if src == out_resolved or src in out_resolved.parents:
                raise ReferencePreparationError(f"output directory aliases {key} source")
    return resolved


def _parse_nifti_header(raw: bytes, label: str) -> dict:
    if len(raw) < 352:
        raise ReferencePreparationError(f"{label}: header truncated")
    sizeof_hdr = struct.unpack_from("<i", raw, 0)[0]
    if sizeof_hdr != 348:
        raise ReferencePreparationError(
            f"{label}: unsupported endianness or not NIfTI-1 (sizeof_hdr={sizeof_hdr})"
        )
    if raw[344:348] != b"n+1\x00":
        raise ReferencePreparationError(f"{label}: missing n+1 magic")
    dim = struct.unpack_from("<8h", raw, 40)
    if dim[0] != 3:
        raise ReferencePreparationError(f"{label}: unsupported dim[0]={dim[0]}, expected 3D")
    if any(d not in (0, 1) for d in dim[4:]):
        raise ReferencePreparationError(f"{label}: time dimension not supported")
    datatype, bitpix = struct.unpack_from("<2h", raw, 70)
    if datatype != DATATYPE_FLOAT64 or bitpix != 64:
        raise ReferencePreparationError(
            f"{label}: unsupported datatype {datatype} (little-endian float64 only)"
        )
    qform_code, sform_code = struct.unpack_from("<2h", raw, 252)
    if qform_code != 0:
        raise ReferencePreparationError(f"{label}: unsupported qform_code={qform_code}, must be 0")
    if sform_code == 0:
        raise ReferencePreparationError(f"{label}: missing sform")
    srow_x = struct.unpack_from("<4f", raw, 280)
    srow_y = struct.unpack_from("<4f", raw, 296)
    srow_z = struct.unpack_from("<4f", raw, 312)
    srow = [list(srow_x), list(srow_y), list(srow_z)]
    for r in range(3):
        for c in range(3):
            if r != c and srow[r][c] != 0.0:
                raise ReferencePreparationError(
                    f"{label}: unsupported non-diagonal sform (rotation must be axis-aligned)"
                )
        if srow[r][r] == 0.0 or not math.isfinite(srow[r][r]):
            raise ReferencePreparationError(f"{label}: singular sform")
    vox_offset = struct.unpack_from("<f", raw, 108)[0]
    if vox_offset < 352:
        raise ReferencePreparationError(f"{label}: invalid vox_offset {vox_offset}")
    if raw[348:352] != b"\x00\x00\x00\x00":
        raise ReferencePreparationError(f"{label}: extensions not supported")
    slope, inter = struct.unpack_from("<2f", raw, 112)
    if not all(math.isfinite(v) for v in (slope, inter)):
        raise ReferencePreparationError(f"{label}: non-finite intensity scaling unsupported")
    xyzt_units = raw[123]
    dims = (dim[1], dim[2], dim[3])
    if min(dims) <= 0:
        raise ReferencePreparationError(f"{label}: invalid dimensions {dims}")
    declared = dims[0] * dims[1] * dims[2] * 8
    if declared > MAX_DECLARED_BYTES:
        raise ReferencePreparationError(f"{label}: declared volume {declared} bytes exceeds cap")
    spacing = [struct.unpack_from("<f", raw, 76 + 4 * (axis + 1))[0] for axis in range(3)]
    if any(not math.isfinite(s) or s <= 0 for s in spacing):
        raise ReferencePreparationError(f"{label}: invalid pixel spacing {spacing}")
    return {
        "dims": dims,
        "srow": srow,
        "vox_offset": int(vox_offset),
        "slope": slope,
        "inter": inter,
        "xyzt_units": xyzt_units,
        "spacing": spacing,
        "srow_bytes": raw[280:324],
    }


def _open_source(path: Path, label: str):
    size = path.stat().st_size
    if size > MAX_GZ_BYTES:
        raise ReferencePreparationError(f"{label}: source file {size} bytes exceeds cap")
    with path.open("rb") as probe:
        magic = probe.read(2)
    opener = gzip.open if magic == b"\x1f\x8b" else open
    return opener(path, "rb")


def _discard(source, count, deadline, label):
    while count > 0:
        if time.monotonic() > deadline:
            raise ReferencePreparationError(f"{label}: processing time bound exceeded")
        chunk = source.read(min(count, HASH_CHUNK))
        if not chunk:
            raise ReferencePreparationError(f"{label}: unexpected EOF in payload")
        count -= len(chunk)


def _crop_payload(header, source, sink, deadline, label, origin, size):
    d0, d1, _d2 = header["dims"]
    i0, j0, k0 = origin
    i1, j1, k1 = (o + n for o, n in zip(origin, size))
    base = header["vox_offset"]
    row_bytes = (i1 - i0) * 8
    position = 0  # fresh stream, before the NIfTI header
    for k in range(k0, k1):
        for j in range(j0, j1):
            target = base + ((k * d1 + j) * d0 + i0) * 8
            if target > position:
                _discard(source, target - position, deadline, label)
                position = target
            row = source.read(row_bytes)
            if len(row) != row_bytes:
                raise ReferencePreparationError(f"{label}: unexpected EOF in payload")
            sink.write(row)
            position = target + row_bytes
            if time.monotonic() > deadline:
                raise ReferencePreparationError(f"{label}: processing time bound exceeded")
    # Validate the entire declared source, including an uncropped tail and gzip CRC.
    end = base + d0 * d1 * _d2 * 8
    _discard(source, end - position, deadline, label)
    if source.read(1):
        raise ReferencePreparationError(f"{label}: payload exceeds declared dimensions")


def _write_cropped_image(header, source_path, output_path, origin, size, deadline):
    new_header = None
    with _open_source(source_path, "reference image") as source:
        raw = source.read(352)
        if len(raw) != 352:
            raise ReferencePreparationError("reference image: unexpected EOF in header")
        buf = bytearray(raw[:352])
        struct.pack_into("<8h", buf, 40, 3, size[0], size[1], size[2], 0, 0, 0, 0)
        struct.pack_into("<f", buf, 108, 352.0)
        srow = [list(row) for row in header["srow"]]
        for r in range(3):
            srow[r][3] += sum(header["srow"][r][c] * origin[c] for c in range(3))
            struct.pack_into("<4f", buf, 280 + 16 * r, *srow[r])
        new_header = bytes(buf)

    writer = None
    try:
        writer = _HashingWriter(output_path.open("wb"))
        with gzip.GzipFile(filename="", mode="wb", fileobj=writer, mtime=0) as gz:
            gz.write(new_header)
            with _open_source(source_path, "reference image") as source:
                try:
                    _crop_payload(header, source, gz, deadline, "reference image", origin, size)
                except (EOFError, gzip.BadGzipFile) as exc:
                    raise ReferencePreparationError(
                        "reference image: truncated or corrupt source"
                    ) from exc
    finally:
        if writer is not None:
            writer.close()
    return writer.hasher.hexdigest(), srow


def _stl_triangles_from_binary(data: bytes, label: str):
    if len(data) < 84:
        raise ReferencePreparationError(f"{label}: truncated STL")
    count = struct.unpack_from("<I", data, 80)[0]
    if len(data) != 84 + 50 * count:
        raise ReferencePreparationError(f"{label}: truncated STL")
    triangles = []
    for idx in range(count):
        offset = 84 + 50 * idx
        values = struct.unpack_from("<12f", data, offset)
        if not all(math.isfinite(v) for v in values):
            raise ReferencePreparationError(f"{label}: non-finite STL geometry")
        triangles.append((values[0:3], (values[3:6], values[6:9], values[9:12])))
    return triangles


_FACET = re.compile(r"facet normal\s+(\S+)\s+(\S+)\s+(\S+)")
_VERTEX = re.compile(r"vertex\s+(\S+)\s+(\S+)\s+(\S+)")


def _stl_triangles_from_ascii(text: str, label: str):
    if not text.startswith("solid"):
        raise ReferencePreparationError(f"{label}: not a recognized STL")
    triangles = []
    facets = _FACET.findall(text)
    vertices = _VERTEX.findall(text)
    if len(vertices) != 3 * len(facets) or "endsolid" not in text:
        raise ReferencePreparationError(f"{label}: malformed or truncated ASCII STL")
    for f_idx, facet in enumerate(facets):
        coords = []
        for v_idx in range(3):
            parts = vertices[3 * f_idx + v_idx]
            coords.append(tuple(float(p) for p in parts))
        normal = tuple(float(p) for p in facet)
        if not all(math.isfinite(v) for v in (*normal, *[c for tri in coords for c in tri])):
            raise ReferencePreparationError(f"{label}: non-finite STL geometry")
        triangles.append((normal, tuple(coords)))
    return triangles


def _read_stl(path: Path, label: str):
    size = path.stat().st_size
    if size > MAX_STL_BYTES:
        raise ReferencePreparationError(f"{label}: mesh input {size} bytes exceeds cap")
    data = path.read_bytes()
    if data[:5].lower() == b"solid" and b"facet" in data[:4096]:
        try:
            return _stl_triangles_from_ascii(data.decode("ascii"), label)
        except UnicodeDecodeError as exc:
            raise ReferencePreparationError(f"{label}: invalid ASCII STL") from exc
    return _stl_triangles_from_binary(data, label)


def _transformed_stl(triangles):
    out = []
    for _, (a, b, c) in triangles:
        va = (-a[0], -a[1], a[2])
        vb = (-b[0], -b[1], b[2])
        vc = (-c[0], -c[1], c[2])
        u = (vb[0] - va[0], vb[1] - va[1], vb[2] - va[2])
        v = (vc[0] - va[0], vc[1] - va[1], vc[2] - va[2])
        nx = u[1] * v[2] - u[2] * v[1]
        ny = u[2] * v[0] - u[0] * v[2]
        nz = u[0] * v[1] - u[1] * v[0]
        norm = math.sqrt(nx * nx + ny * ny + nz * nz)
        if norm > 0:
            normal = (nx / norm, ny / norm, nz / norm)
        else:
            normal = (0.0, 0.0, 0.0)
        out.append((normal, (va, vb, vc)))
    return out


def _write_binary_stl(path: Path, triangles) -> str:
    writer = _HashingWriter(path.open("wb"))
    try:
        writer.write(b"\x00" * 80)
        writer.write(struct.pack("<I", len(triangles)))
        for normal, (a, b, c) in triangles:
            writer.write(struct.pack("<3f", *normal))
            writer.write(struct.pack("<3f", *a))
            writer.write(struct.pack("<3f", *b))
            writer.write(struct.pack("<3f", *c))
            writer.write(struct.pack("<H", 0))
    finally:
        writer.close()
    return writer.hasher.hexdigest()


def _bbox_center(triangles):
    points = [v for _, tri in triangles for v in tri]
    return [(min(p[axis] for p in points) + max(p[axis] for p in points)) / 2 for axis in range(3)]


def prepare_reference(
    cta_path: Path,
    aneurysm_path: Path,
    artery_path: Path,
    output_dir: Path,
    *,
    expected_sha256: dict[str, str],
    ijk_start: tuple[int, int, int],
    ijk_stop: tuple[int, int, int],
) -> dict:
    """Prepare the deterministic reference crop and transformed curated STLs."""
    deadline = time.monotonic() + MAX_SECONDS
    resolved = _verify_inputs(cta_path, aneurysm_path, artery_path, output_dir, expected_sha256)
    if any(type(v) is not int or v < 0 for v in (*ijk_start, *ijk_stop)):
        raise ReferencePreparationError("crop indices must be nonnegative integers")
    origin = tuple(ijk_start)
    stop = tuple(ijk_stop)
    if len(origin) != 3 or len(stop) != 3:
        raise ReferencePreparationError("ijk_start and ijk_stop must be 3-vectors")
    if any(s <= o for o, s in zip(origin, stop)):
        raise ReferencePreparationError("ijk_stop must be strictly greater than ijk_start")
    with _open_source(resolved["cta"], "reference image") as source:
        raw = source.read(352)
        header = _parse_nifti_header(raw, "reference image")
    if any(s > d for s, d in zip(stop, header["dims"])):
        raise ReferencePreparationError(
            f"ijk_stop {stop} exceeds source dimensions {header['dims']}"
        )
    size = tuple(s - o for s, o in zip(stop, origin))
    if size[0] * size[1] * size[2] * 8 > MAX_DECLARED_BYTES:
        raise ReferencePreparationError("crop exceeds declared uncompressed cap")

    output_dir.mkdir(parents=True, exist_ok=True)
    image_sha = None
    annotations = []
    try:
        image_sha, cropped_srow = _write_cropped_image(
            header, resolved["cta"], output_dir / IMAGE_FILENAME, origin, size, deadline
        )
        focus_ras = None
        for ann_id, filename in ANNOTATION_FILES.items():
            triangles = _read_stl(resolved[ann_id], f"{ann_id} surface")
            transformed = _transformed_stl(triangles)
            sha = _write_binary_stl(output_dir / filename, transformed)
            annotations.append(
                {
                    "id": ann_id,
                    "filename": filename,
                    "sha256": sha,
                    "triangle_count": len(transformed),
                }
            )
            if ann_id == "aneurysm":
                focus_ras = _bbox_center(transformed)
    except Exception:
        image_sha = None
        raise

    srow = header["srow"]

    manifest = {
        "schema_version": SCHEMA_VERSION,
        "case_label": CASE_LABEL,
        "source_url": SOURCE_URL,
        "license_url": LICENSE_URL,
        "citation": CITATION,
        "image": {"filename": IMAGE_FILENAME, "sha256": image_sha},
        "annotations": annotations,
        "focus_ras": focus_ras,
        "source_sha256": dict(expected_sha256),
        "transform": {"matrix": TRANSFORM, "status": TRANSFORM_STATUS},
        "source_header": {
            "xyzt_units": header["xyzt_units"],
            "scl_slope": header["slope"],
            "scl_inter": header["inter"],
            "spacing": list(header["spacing"]),
        },
        "crop": {
            "origin_ijk": list(origin),
            "size_voxels": list(size),
            "source_affine": [list(row) for row in srow],
            "cropped_affine": cropped_srow,
        },
    }
    if not all(math.isfinite(v) for v in focus_ras):
        raise ReferencePreparationError("focus_ras is not finite")
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return manifest
