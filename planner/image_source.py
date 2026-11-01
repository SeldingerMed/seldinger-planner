"""Calibrated image-only source store.

Implements docs/plans/calibrated-image-source-contract.md: pure-stdlib,
integrity-pinned access to the prepared Zenodo case 006 calibrated context
crop. No NumPy/NiBabel/FastAPI; no pixels are decoded here. Identity is
established by pinning exact source/image/manifest bytes via constructor
trusted configuration, never by caller assertions.
"""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from typing import Any

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


def _fail(message: str) -> None:
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
        not _is_native_int(recorded_bytes)
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
