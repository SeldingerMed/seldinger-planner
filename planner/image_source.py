"""Calibrated image-only source store.

Implements docs/plans/calibrated-image-source-contract.md: pure-stdlib,
integrity-pinned access to the prepared Zenodo case 006 calibrated context
crop. No NumPy/NiBabel/FastAPI; no pixels are decoded here. Identity is
established by pinning exact source/image/manifest bytes via constructor
trusted configuration, never by caller assertions.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import math
import re
import struct
from pathlib import Path
from typing import Any, NoReturn

CALIBRATED_SOURCE_ID = "zenodo-case006-calibrated"
CALIBRATED_ROOT = (
    Path(__file__).resolve().parent.parent
    / ".runtime"
    / "original-public-source"
    / "zenodo-15697196"
    / "prepared-case-006"
    / "context-v3"
)
CALIBRATED_IMAGE_SHA256 = "88f6e5a67dee23439c864d9e32d771fdd24abee55b904b8260fe30e3ddcd40a3"
CALIBRATED_MANIFEST_SHA256 = "cb4f1ced10ae6b3b2e6d7cc9273c5f3f4fbc0478dba6a74588f083b3626c478f"
SOURCE_IMAGE_SHA256 = "98ecbcedc625ff1eecdf3a90366a05ec0bc38fd6c4172facbc8bb5bb7d86e9b4"

PLANNING_SOURCE_ID = "zenodo-case006-planning-context"
PLANNING_ROOT = (
    Path(__file__).resolve().parent.parent
    / ".runtime"
    / "original-public-source"
    / "zenodo-15697196"
    / "prepared-case-006"
    / "context-planning-v1"
)
PLANNING_IMAGE_SHA256 = "26b8a3e766cf1306796286c8d10dfef41192930919df9029f9be0779b8080473"
PLANNING_MANIFEST_SHA256 = "92834342c650ecae3733cac33aec096f01ff699c4f25c234fdb0b8738ae6f18e"

MAX_MANIFEST_BYTES = 16384
MAX_IMAGE_BYTES = 16 * 1024 * 1024
MAX_DIM = 2048
MAX_TOTAL_VOXELS = 8_000_000
IMAGE_FILENAME = "context-cta.nii.gz"

_CASE_LABEL = "Zenodo case 006 calibrated context"
_SOURCE_URL = "https://doi.org/10.5281/zenodo.15697196"
_LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/"
_CITATION = (
    "Zenodo record 15697196, public deidentified case 006 (CC BY 4.0), "
    "calibrated context crop prepared from DICOM-derived mm calibration."
)


def _fail(message: str) -> NoReturn:
    raise ValueError(f"calibrated source store: {message}")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _regular_file(path: Path, label: str) -> Path:
    if path.is_symlink() or not path.exists():
        _fail(f"{label} missing or is a symlink: {path}")
    if not path.is_file():
        _fail(f"{label} is not a regular file: {path}")
    return path


def _is_native_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _validate_affine(affine: Any) -> list[list[float]]:
    if not isinstance(affine, list) or len(affine) != 4:
        _fail("image affine_ras must be a 4x4 matrix")
    matrix: list[list[float]] = []
    for row in affine:
        if not isinstance(row, list) or len(row) != 4:
            _fail("image affine_ras must be a 4x4 matrix")
            return []
        for value in row:
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
            ):
                _fail("image affine_ras values must be finite numbers")
        matrix.append([float(value) for value in row])
    if matrix[3] != [0.0, 0.0, 0.0, 1.0]:
        _fail("image affine_ras last row must be homogeneous [0, 0, 0, 1]")
    a, b, c = matrix[0][:3], matrix[1][:3], matrix[2][:3]
    det = (
        a[0] * (b[1] * c[2] - b[2] * c[1])
        - a[1] * (b[0] * c[2] - b[2] * c[0])
        + a[2] * (b[0] * c[1] - b[1] * c[0])
    )
    if det == 0.0 or not math.isfinite(det):
        _fail("image affine_ras is singular")
    spacing = [math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2) for v in zip(a, b, c)]
    if any(s <= 0.0 or not math.isfinite(s) for s in spacing):
        _fail("image affine_ras yields non-positive spacing")
    return matrix


def _validate_manifest(manifest: Any) -> dict[str, Any]:
    if not isinstance(manifest, dict):
        _fail("manifest must be a JSON object")
    if manifest.get("version") != 1:
        _fail("manifest version must be 1")
    if manifest.get("clinical_validation") is not False:
        _fail("clinical_validation must remain false")
    if manifest.get("application_installation") is not False:
        _fail("application_installation must remain false")
    if manifest.get("source_image_sha256") != SOURCE_IMAGE_SHA256:
        _fail("source_image_sha256 does not match pinned full source hash")
    if "source_header" in manifest:
        _fail("manifest must not carry source_header")

    image = manifest.get("image")
    if not isinstance(image, dict):
        _fail("manifest image must be an object")
    if image.get("filename") != IMAGE_FILENAME:
        _fail("image filename does not match prepared context image")
    if image.get("dtype") != "int32":
        _fail("image dtype must be int32")
    if image.get("spatial_units") != "mm":
        _fail("image spatial_units must be mm")
    if not isinstance(image.get("sha256"), str) or len(image["sha256"]) != 64:
        _fail("image sha256 missing")
    recorded_bytes = image.get("bytes")
    if (
        not isinstance(recorded_bytes, int)
        or isinstance(recorded_bytes, bool)
        or recorded_bytes <= 0
        or recorded_bytes > MAX_IMAGE_BYTES
    ):
        _fail("image bytes out of range")
    shape = image.get("shape_xyz")
    if (
        not isinstance(shape, list)
        or len(shape) != 3
        or any(not _is_native_int(v) or v <= 0 or v > MAX_DIM for v in shape)
    ):
        _fail("image shape_xyz must be three positive integers <= 2048")
    if shape[0] * shape[1] * shape[2] > MAX_TOTAL_VOXELS:
        _fail("image voxel count exceeds limit")
    _validate_affine(image.get("affine_ras"))

    crop = manifest.get("crop")
    if not isinstance(crop, dict):
        _fail("manifest crop must be an object")
    start = crop.get("start_voxels")
    size = crop.get("size_voxels")
    if (
        not isinstance(start, list)
        or len(start) != 3
        or any(not _is_native_int(v) or v < 0 for v in start)
    ):
        _fail("crop start_voxels must be three non-negative integers")
    if size != shape:
        _fail("crop size_voxels must equal image shape_xyz")

    provenance = manifest.get("source_provenance")
    if not isinstance(provenance, dict):
        _fail("manifest source_provenance must be an object")

    limits = manifest.get("selection_and_evidence_limits")
    if not isinstance(limits, dict):
        _fail("manifest selection_and_evidence_limits must be an object")
    for flag in (
        "independent_localization",
        "stl_frame_units_validated",
        "stl_registration_validated",
        "annotation_validated_anatomy",
    ):
        if limits.get(flag) is not False:
            _fail(f"selection_and_evidence_limits.{flag} must remain false")
    return manifest


class CalibratedSourceStore:
    """Integrity-pinned store for the calibrated image-only source."""

    _source_id = CALIBRATED_SOURCE_ID
    _case_label = _CASE_LABEL

    def __init__(
        self,
        root: Path | str | None = None,
        *,
        expected_manifest_sha256: str = CALIBRATED_MANIFEST_SHA256,
        expected_image_sha256: str = CALIBRATED_IMAGE_SHA256,
    ) -> None:
        self.root = Path(root) if root is not None else CALIBRATED_ROOT
        self.expected_manifest_sha256 = expected_manifest_sha256
        self.expected_image_sha256 = expected_image_sha256
        self.source_id = self._source_id

    def load(self) -> tuple[dict[str, Any], str, dict[str, Path]]:
        root = self.root
        if root.is_symlink():
            _fail("root must not be a symlink")
        if not root.is_dir():
            _fail(f"root is not a directory: {root}")
        manifest_path = root / "manifest.json"
        if manifest_path.is_symlink() or not manifest_path.exists():
            raise FileNotFoundError(f"calibrated source store: manifest not found: {manifest_path}")
        manifest_path = _regular_file(manifest_path, "manifest")
        manifest_size = manifest_path.stat().st_size
        if manifest_size > MAX_MANIFEST_BYTES:
            _fail(f"manifest exceeds {MAX_MANIFEST_BYTES} bytes")
        manifest_bytes = manifest_path.read_bytes()
        manifest_sha = hashlib.sha256(manifest_bytes).hexdigest()
        if manifest_sha != self.expected_manifest_sha256:
            _fail("manifest sha256 does not match expected manifest hash")
        try:
            manifest = json.loads(manifest_bytes)
        except json.JSONDecodeError as exc:
            raise ValueError(f"calibrated source store: malformed manifest JSON: {exc}") from exc
        manifest = _validate_manifest(manifest)

        image_path = _regular_file(root / manifest["image"]["filename"], "image")
        image_size = image_path.stat().st_size
        if image_size != manifest["image"]["bytes"]:
            _fail("image byte size does not match manifest record")
        if image_size > MAX_IMAGE_BYTES:
            _fail("image exceeds 16MiB")
        image_sha = _sha256_file(image_path)
        if image_sha != manifest["image"]["sha256"]:
            _fail("image sha256 does not match manifest record")
        if image_sha != self.expected_image_sha256:
            _fail("image sha256 does not match expected image hash")

        return manifest, manifest_sha, {"image": image_path}

    def metadata(
        self,
        bundle: tuple[dict[str, Any], str, dict[str, Path]],
        case_id: str | None = None,
    ) -> dict[str, Any]:
        data, revision, _paths = bundle
        image = data["image"]
        shape = image["shape_xyz"]
        affine = image["affine_ras"]
        cols = list(zip(affine[0][:3], affine[1][:3], affine[2][:3]))
        spacing = [math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2) for v in cols]
        meta: dict[str, Any] = {
            "source_id": self.source_id,
            "case_label": self._case_label,
            "source_url": _SOURCE_URL,
            "license_url": _LICENSE_URL,
            "citation": _CITATION,
            "image_sha256": image["sha256"],
            "image_url": f"/api/image-sources/{self.source_id}/volume",
            "reference_revision": revision,
            "spatial_units": "mm",
            "dimensions": list(shape),
            "spacing_mm": spacing,
            "image_affine_ras": affine,
            "method": "calibrated_context_crop",
            "selection_basis": "reference-informed candidate context",
            "clinical_validation": False,
            "stl_registration_validated": False,
        }
        if case_id is not None:
            meta["case_id"] = case_id
        return meta


class PlanningSourceStore(CalibratedSourceStore):
    """Integrity-pinned store for the broader planning-context source.

    Same manifest shape, validation and caps as the calibrated source; only
    identity and trusted hash pins differ. Not an accuracy/performance
    validation — reference-informed context only.
    """

    _source_id = PLANNING_SOURCE_ID
    _case_label = "Zenodo case 006 planning context"

    def __init__(
        self,
        root: Path | str | None = None,
        *,
        expected_manifest_sha256: str = PLANNING_MANIFEST_SHA256,
        expected_image_sha256: str = PLANNING_IMAGE_SHA256,
    ) -> None:
        super().__init__(
            root if root is not None else PLANNING_ROOT,
            expected_manifest_sha256=expected_manifest_sha256,
            expected_image_sha256=expected_image_sha256,
        )


INSTALLED_SOURCES_ROOT = Path(__file__).resolve().parent.parent / ".runtime" / "installed-sources"
_ALLOWED_CUSTOM_DTYPES = {
    "int16": (4, 16),
    "int32": (8, 32),
    "uint8": (2, 8),
    "uint16": (512, 16),
    "float32": (16, 32),
}


def _validate_installed_nifti(payload: bytes, image: dict[str, Any]) -> None:
    """Validate the exact hashed bytes, without importing an imaging stack.

    Phase 1 accepts single-file NIfTI-1 with explicit sform calibration. It
    deliberately rejects qform-only/NIfTI-2 sources rather than guessing a frame.
    """
    limit = 352 + MAX_TOTAL_VOXELS * 4 + 65536
    try:
        if payload[:2] == b"\x1f\x8b":
            with gzip.GzipFile(fileobj=io.BytesIO(payload)) as stream:
                raw = stream.read(limit + 1)
        else:
            raw = payload
    except (OSError, EOFError) as exc:
        raise ValueError("Invalid compressed NIfTI") from exc
    if len(raw) > limit or len(raw) < 352:
        _fail("NIfTI decompressed size out of bounds")
    endian = "<" if struct.unpack_from("<i", raw)[0] == 348 else ">"
    if struct.unpack_from(endian + "i", raw)[0] != 348 or raw[344:348] != b"n+1\x00":
        _fail("installed image must be single-file NIfTI-1")
    dims = struct.unpack_from(endian + "8h", raw, 40)
    if dims[0] != 3 or list(dims[1:4]) != image["shape_xyz"]:
        _fail("NIfTI grid does not match manifest")
    datatype, bits = struct.unpack_from(endian + "2h", raw, 70)
    if (datatype, bits) != _ALLOWED_CUSTOM_DTYPES[image["dtype"]]:
        _fail("NIfTI dtype does not match manifest")
    if raw[123] & 7 != 2:
        _fail("NIfTI header units must be mm")
    offset = struct.unpack_from(endian + "f", raw, 108)[0]
    if not math.isfinite(offset) or offset < 352 or offset != int(offset):
        _fail("Invalid NIfTI voxel offset")
    count = math.prod(image["shape_xyz"])
    if int(offset) + count * bits // 8 != len(raw):
        _fail("NIfTI payload length does not match native grid")
    if struct.unpack_from(endian + "h", raw, 254)[0] <= 0:
        _fail("Phase 1 installed NIfTI requires an explicit sform")
    affine = [list(struct.unpack_from(endian + "4f", raw, 280 + i * 16)) for i in range(3)]
    affine.append([0.0, 0.0, 0.0, 1.0])
    _validate_affine(affine)
    if any(
        not math.isclose(affine[i][j], image["affine_ras"][i][j], rel_tol=1e-6, abs_tol=1e-6)
        for i in range(4)
        for j in range(4)
    ):
        _fail("NIfTI affine does not match manifest")


class InstalledNiftiSourceStore:
    """Manifest-verified store for any server-installed NIfTI volume source."""

    def __init__(self, root: Path | str, *, source_id: str) -> None:
        self.root = Path(root)
        self.source_id = source_id

    def load(self) -> tuple[dict[str, Any], str, dict[str, Path]]:
        root = self.root
        if root.is_symlink() or any(parent.is_symlink() for parent in root.parents):
            _fail("installed source root or ancestor is a symlink")
        if not root.is_dir():
            raise FileNotFoundError(f"installed source store: directory not found: {root}")
        manifest_path = root / "manifest.json"
        if manifest_path.is_symlink() or not manifest_path.exists():
            raise FileNotFoundError(f"installed source store: manifest not found: {manifest_path}")
        manifest_path = _regular_file(manifest_path, "manifest")
        if manifest_path.stat().st_size > MAX_MANIFEST_BYTES:
            _fail(f"manifest exceeds {MAX_MANIFEST_BYTES} bytes")
        with manifest_path.open("rb") as stream:
            manifest_bytes = stream.read(MAX_MANIFEST_BYTES + 1)
        if len(manifest_bytes) > MAX_MANIFEST_BYTES:
            _fail(f"manifest exceeds {MAX_MANIFEST_BYTES} bytes")
        manifest_sha = hashlib.sha256(manifest_bytes).hexdigest()
        manifest = json.loads(manifest_bytes)
        if not isinstance(manifest, dict) or manifest.get("clinical_validation") is not False:
            _fail("installed manifest must be an object with clinical_validation == false")
        image = manifest.get("image")
        if not isinstance(image, dict):
            _fail("installed manifest image must be an object")
        filename = image.get("filename", IMAGE_FILENAME)
        if (
            not isinstance(filename, str)
            or not filename
            or filename in {".", ".."}
            or "/" in filename
            or "\\" in filename
        ):
            _fail("invalid image filename")
        if image.get("dtype") not in _ALLOWED_CUSTOM_DTYPES:
            _fail("unsupported image dtype")
        if image.get("spatial_units") != "mm":
            _fail("installed image spatial_units must be mm")
        sha = image.get("sha256")
        if not isinstance(sha, str) or re.fullmatch(r"[a-f0-9]{64}", sha) is None:
            _fail("installed image sha256 missing")
        shape = image.get("shape_xyz")
        if (
            not isinstance(shape, list)
            or len(shape) != 3
            or any(not _is_native_int(v) or v <= 0 or v > MAX_DIM for v in shape)
        ):
            _fail("invalid shape_xyz")
        if shape[0] * shape[1] * shape[2] > MAX_TOTAL_VOXELS:
            _fail("image voxel count exceeds limit")
        _validate_affine(image.get("affine_ras"))
        crop = manifest.get("crop", {"start_voxels": [0, 0, 0], "size_voxels": list(shape)})
        if not isinstance(crop, dict):
            _fail("invalid crop")
        start = crop.get("start_voxels")
        if (
            not isinstance(start, list)
            or len(start) != 3
            or any(not _is_native_int(v) or v < 0 for v in start)
            or crop.get("size_voxels") != shape
        ):
            _fail("invalid crop dimensions or start")
        manifest["crop"] = crop
        image_path = _regular_file(root / filename, "image")
        image_size = image_path.stat().st_size
        if image_size <= 0 or image_size > MAX_IMAGE_BYTES:
            _fail("image byte size out of bounds")
        if "bytes" in image and image["bytes"] != image_size:
            _fail("image byte size does not match manifest")
        with image_path.open("rb") as stream:
            payload = stream.read(MAX_IMAGE_BYTES + 1)
        if not 0 < len(payload) <= MAX_IMAGE_BYTES or len(payload) != image_size:
            _fail("image changed or exceeds byte cap")
        if hashlib.sha256(payload).hexdigest() != sha:
            _fail("image sha256 does not match manifest record")
        _validate_installed_nifti(payload, image)
        return manifest, manifest_sha, {"image": image_path}

    def metadata(
        self,
        bundle: tuple[dict[str, Any], str, dict[str, Path]],
        case_id: str | None = None,
    ) -> dict[str, Any]:
        data, revision, _paths = bundle
        image = data["image"]
        shape = image["shape_xyz"]
        affine = image["affine_ras"]
        cols = list(zip(affine[0][:3], affine[1][:3], affine[2][:3]))
        spacing = [math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2) for v in cols]
        meta: dict[str, Any] = {
            "source_id": self.source_id,
            "case_label": data.get("case_label", f"Installed NIfTI source ({self.source_id})"),
            "source_url": data.get("source_url", "local://installed-source"),
            "license_url": data.get("license_url"),
            "citation": data.get("citation", "Server-installed NIfTI source"),
            "image_sha256": image["sha256"],
            "image_url": f"/api/image-sources/{self.source_id}/volume",
            "reference_revision": revision,
            "spatial_units": "mm",
            "dimensions": list(shape),
            "spacing_mm": spacing,
            "image_affine_ras": affine,
            "method": "installed_nifti_source",
            "selection_basis": "server-installed calibrated volume",
            "clinical_validation": False,
            "stl_registration_validated": False,
        }
        if case_id is not None:
            meta["case_id"] = case_id
        return meta
