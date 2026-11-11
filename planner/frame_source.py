"""Projection pixel-frame contract and installed store.

Stdlib only. A frame bundle is a small, bounded set of single 8-bit grayscale
angiographic frames admitted for retrospective display and 2D-to-3D
registration proposals. It is separate from the geometry-only projection
manifest in ``planner.projection_source``, which still retains no pixels.

Admission bounds: at most two planes, eight frames per plane, and 64 to 1024
pixels per side. Every frame is stored as raw row-major bytes and bound to
this manifest by SHA-256. No source metadata is retained, only the hashes of
the files the frames came from.

Deidentification is recorded per plane. Pixels are admitted either because
the DICOM object declares no burned-in annotation, or because the operator
attested that the recorded crop and redaction rectangles removed every
identifier. Nothing here is live video, and nothing is registered or
clinically validated by being admitted.
"""

import hashlib
import json
import os
import re
import stat
from pathlib import Path
from typing import NoReturn

from planner.carm_geometry import VIEW_NUMBERS, validate_view

MANIFEST_VERSION = 1
MANIFEST_FILENAME = "frames.json"
MAX_MANIFEST_BYTES = 65536
MAX_PLANES = 2
MAX_FRAMES_PER_PLANE = 8
MIN_SIDE = 64
MAX_SIDE = 1024
MAX_SOURCE_SIDE = 4096
MAX_REDACTIONS = 16
MAX_FRAME_INDEX = 1_000_000
PIXEL_FORMAT = "gray8"
INSTALLED_FRAMES_ROOT = Path(__file__).resolve().parent.parent / ".runtime" / "installed-frames"
METHODS = ("admitted_png_frames", "admitted_dicom_xa_frames")
BASES = ("dicom_declared_no_burned_in_annotation", "operator_attested_crop_and_redaction")
_SOURCE_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{1,63}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_TOP_KEYS = {
    "version",
    "kind",
    "clinical_validation",
    "scope",
    "method",
    "pixel_format",
    "biplane_linkage",
    "planes",
}
_PLANE_KEYS = {
    "plane",
    "rows",
    "columns",
    "container_sha256",
    "container_bytes",
    "deidentification",
    "geometry",
    "frames",
}
_DEID_KEYS = {
    "basis",
    "burned_in_annotation",
    "source_rows",
    "source_columns",
    "crop",
    "redactions",
}
_FRAME_KEYS = {"index", "sha256", "input_sha256"}


def _fail(message) -> NoReturn:
    raise ValueError("projection frames: " + message)


def _integer(value, low, high, label):
    if type(value) is not int or not low <= value <= high:
        _fail("invalid " + label)
    return value


def _sha(value, label):
    if not isinstance(value, str) or not _SHA256.fullmatch(value):
        _fail("invalid " + label)
    return value


def validate_rectangle(value, columns, rows, label):
    """``[x, y, width, height]`` in pixels, inside a ``columns`` by ``rows`` image."""
    if not isinstance(value, list) or len(value) != 4:
        _fail("invalid " + label)
    x, y, width, height = (_integer(item, 0, MAX_SOURCE_SIDE, label) for item in value)
    if width < 1 or height < 1 or x + width > columns or y + height > rows:
        _fail("invalid " + label)
    return value


def frame_filename(plane, index):
    return f"{plane}-{index:06d}.gray"


def _validate_deidentification(deid, method, rows, columns):
    if not isinstance(deid, dict) or set(deid) != _DEID_KEYS:
        _fail("invalid deidentification fields")
    source_rows = _integer(deid["source_rows"], 1, MAX_SOURCE_SIDE, "source rows")
    source_columns = _integer(deid["source_columns"], 1, MAX_SOURCE_SIDE, "source columns")
    crop = deid["crop"]
    if crop is None:
        if (rows, columns) != (source_rows, source_columns):
            _fail("frame size contradicts the uncropped source")
    else:
        validate_rectangle(crop, source_columns, source_rows, "crop")
        if (rows, columns) != (crop[3], crop[2]):
            _fail("frame size contradicts the crop")
    redactions = deid["redactions"]
    if not isinstance(redactions, list) or len(redactions) > MAX_REDACTIONS:
        _fail("invalid redactions")
    for rectangle in redactions:
        validate_rectangle(rectangle, source_columns, source_rows, "redaction")
    burned = deid["burned_in_annotation"]
    if method == "admitted_png_frames":
        # A PNG carries no declaration, and screen captures usually carry text.
        if (
            burned != "not_declared"
            or crop is None
            or deid["basis"] != "operator_attested_crop_and_redaction"
        ):
            _fail("a PNG plane requires an operator-attested crop")
    elif burned == "no":
        if deid["basis"] != "dicom_declared_no_burned_in_annotation":
            _fail("invalid deidentification basis")
    elif burned in ("yes", "unknown"):
        if deid["basis"] != "operator_attested_crop_and_redaction" or (
            crop is None and not redactions
        ):
            _fail("burned-in annotation requires an operator-attested crop or redaction")
    else:
        _fail("invalid burned-in annotation state")
    return crop


def _validate_plane(plane, method):
    if not isinstance(plane, dict) or set(plane) != _PLANE_KEYS:
        _fail("invalid plane fields")
    if plane["plane"] not in ("single", "a", "b"):
        _fail("invalid plane label")
    rows = _integer(plane["rows"], MIN_SIDE, MAX_SIDE, "rows")
    columns = _integer(plane["columns"], MIN_SIDE, MAX_SIDE, "columns")
    if plane["container_sha256"] is None:
        if plane["container_bytes"] is not None or method != "admitted_png_frames":
            _fail("invalid container identity")
    else:
        _sha(plane["container_sha256"], "container hash")
        _integer(plane["container_bytes"], 1, 2**40, "container byte count")
    crop = _validate_deidentification(plane["deidentification"], method, rows, columns)
    geometry = plane["geometry"]
    if geometry is not None:
        # Acquisition geometry assumes the central ray meets the middle of the
        # stored frame, which a crop moves. Only uncropped DICOM planes keep it.
        if method != "admitted_dicom_xa_frames" or crop is not None:
            _fail("geometry requires an uncropped DICOM plane")
        if not isinstance(geometry, dict) or set(geometry) != set(VIEW_NUMBERS):
            _fail("invalid geometry fields")
        try:
            validate_view(geometry)
        except (ValueError, TypeError):
            _fail("invalid geometry")
    frames = plane["frames"]
    if not isinstance(frames, list) or not 1 <= len(frames) <= MAX_FRAMES_PER_PLANE:
        _fail("one to eight frames per plane required")
    for frame in frames:
        if not isinstance(frame, dict) or set(frame) != _FRAME_KEYS:
            _fail("invalid frame fields")
        _integer(frame["index"], 0, MAX_FRAME_INDEX, "frame index")
        _sha(frame["sha256"], "frame hash")
        _sha(frame["input_sha256"], "frame input hash")
        if method == "admitted_dicom_xa_frames" and (
            frame["input_sha256"] != plane["container_sha256"]
        ):
            _fail("a DICOM frame comes from its plane's own file")
    indexes = [frame["index"] for frame in frames]
    if indexes != sorted(set(indexes)):
        _fail("frame indexes must be distinct and ascending")
    return plane


def validate_manifest(manifest):
    """Strict closed-schema admission of one pixel-frame manifest."""
    if not isinstance(manifest, dict) or set(manifest) != _TOP_KEYS:
        _fail("invalid manifest fields")
    if (
        type(manifest["version"]) is not int
        or manifest["version"] != MANIFEST_VERSION
        or manifest["kind"] != "projection_frames"
        or manifest["clinical_validation"] is not False
        or manifest["scope"] not in ("synthetic", "public", "authorized")
        or manifest["method"] not in METHODS
        or manifest["pixel_format"] != PIXEL_FORMAT
    ):
        _fail("unsupported manifest declaration")
    planes = manifest["planes"]
    if not isinstance(planes, list) or not 1 <= len(planes) <= MAX_PLANES:
        _fail("one or two planes required")
    for plane in planes:
        _validate_plane(plane, manifest["method"])
    labels = [plane["plane"] for plane in planes]
    if len(planes) == 2:
        # Nothing here verifies that two planes show the same run.
        if labels != ["a", "b"] or manifest["biplane_linkage"] != "operator_declared":
            _fail("a two-plane bundle requires planes A and B")
    elif labels != ["single"] or manifest["biplane_linkage"] != "not_applicable":
        _fail("a one-plane bundle carries no biplane linkage")
    return manifest


def find_frame(manifest, plane, index):
    """The plane and frame records for a plane label and source frame index."""
    for candidate in manifest["planes"]:
        if candidate["plane"] == plane:
            for frame in candidate["frames"]:
                if type(index) is int and frame["index"] == index:
                    return candidate, frame
    raise FileNotFoundError("projection frames: unknown frame")


class InstalledFrameStore:
    """Reads ``ROOT/SOURCE_ID/frames.json`` and its frames without following links."""

    def __init__(self, root=None):
        self._root = root

    def root(self):
        return Path(self._root) if self._root is not None else INSTALLED_FRAMES_ROOT

    def _directory(self, source_id):
        if not isinstance(source_id, str) or not _SOURCE_ID.fullmatch(source_id):
            raise FileNotFoundError("projection frames: unknown source")
        root = self.root()
        if root.is_symlink() or any(parent.is_symlink() for parent in root.parents):
            _fail("installed root or ancestor is a symlink")
        directory = root / source_id
        if directory.is_symlink():
            _fail("installed source is a symlink")
        if not directory.is_dir():
            raise FileNotFoundError("projection frames: unknown source")
        return directory

    @staticmethod
    def _read(path, bound):
        directory_fd = None
        try:
            path = Path(path).absolute()
            # O_NOFOLLOW on the file alone does not protect its ancestry.
            # Walk using held directory descriptors, so a checked ancestor
            # cannot be replaced with a symlink before the file is opened.
            directory_fd = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY)
            for part in path.parent.parts[1:]:
                next_fd = os.open(
                    part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd
                )
                os.close(directory_fd)
                directory_fd = next_fd
            fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
        except FileNotFoundError:
            raise
        except OSError:
            _fail("installed file is not a regular file")
        finally:
            if directory_fd is not None:
                os.close(directory_fd)
        with os.fdopen(fd, "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                _fail("installed file is not a regular file")
            raw = stream.read(bound + 1)
        if not 0 < len(raw) <= bound:
            _fail("installed file byte bound exceeded")
        return raw

    def load(self, source_id):
        raw = self._read(self._directory(source_id) / MANIFEST_FILENAME, MAX_MANIFEST_BYTES)
        manifest = validate_manifest(json.loads(raw))
        return manifest, hashlib.sha256(raw).hexdigest()

    def frame(self, source_id, plane, index):
        """Verified pixel bytes of one frame, with the manifest revision."""
        manifest, revision = self.load(source_id)
        record, frame = find_frame(manifest, plane, index)
        size = record["rows"] * record["columns"]
        try:
            raw = self._read(self._directory(source_id) / frame_filename(plane, index), size)
        except FileNotFoundError:
            _fail("frame file is missing")
        if len(raw) != size or hashlib.sha256(raw).hexdigest() != frame["sha256"]:
            _fail("frame failed its integrity check")
        return raw, revision
