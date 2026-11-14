#!/usr/bin/env python3
"""Decode the fetched Ljubljana files into plain arrays for the evaluation.

Research evaluation only; see ``fetch_ljubljana.py`` for the license. This
step changes file formats and nothing else. It does not interpret the stored
camera poses, crop or rescale a frame, or choose a threshold: the vessel mask
is every voxel above zero in the volume as distributed, and everything that
turns these numbers into views and a reference pose lives in
``web/src/research/ljubljanaGeometry.ts``, where it is tested.

For each subject it writes, under the destination:
  mask.u8          the vessel mask cut to its bounding box, x fastest
  fiducials.f32    the stored evaluation points, little-endian x y z triples
  frontal.u16      the stored frame, little-endian, rows from the top
  lateral.u16
  subject.json     shapes, the volume affine, the stored poses and intrinsics

Every file read is first checked against the size and SHA-256 the fetch
recorded. The destination must lie outside the repository and on another
storage device. Needs numpy, nibabel and torch, which the planner's optional model
runtime provides:
  .runtime/ml-runtime/bin/python scripts/research/prepare_ljubljana.py SRC DST
"""

import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_ljubljana import SUBJECTS, FetchError, _digest, created_outside, outside_repository

VIEWS = ("frontal", "lateral")
# The files of one subject that are decoded here.
USED = (
    "volume.nii.gz",
    "fiducials.pt",
    *(f"xrays/{view}.{kind}" for view in VIEWS for kind in ("pt", "dcm")),
)
MARGIN = 2
_PIXEL_DATA = bytes.fromhex("e07f1000") + b"OW\x00\x00"
_ROWS, _COLUMNS = bytes.fromhex("28001000"), bytes.fromhex("28001100")


class PrepareError(Exception):
    pass


def frame_pixels(path: Path, height: int, width: int) -> bytes:
    """Little-endian 16-bit pixels of an uncompressed single-frame DICOM.

    The frames in this set are explicit-VR little-endian with the pixel data
    as the last element, so the few elements needed are checked in place
    instead of parsing the whole file.
    """
    data = path.read_bytes()
    size = height * width * 2
    before, header = data[132 : -size - 12], data[-size - 12 : -size]

    def stated(tag: bytes) -> int | None:
        at = before.rfind(tag + b"US\x02\x00")
        return None if at < 0 else struct.unpack("<H", before[at + 8 : at + 10])[0]

    if (
        len(header) != 12
        or data[128:132] != b"DICM"
        or header[:8] != _PIXEL_DATA
        or struct.unpack("<I", header[8:])[0] != size
        or b"1.2.840.10008.1.2.1\x00" not in before[:468]
        or stated(_ROWS) != height
        or stated(_COLUMNS) != width
    ):
        raise PrepareError(f"Not an uncompressed 16-bit frame of {width} by {height}: {path.name}")
    return data[-size:]


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def prepare_subject(source: Path, destination: Path) -> dict:
    import nibabel
    import numpy
    import torch

    image = nibabel.load(source / "volume.nii.gz")
    volume = numpy.asanyarray(image.dataobj)
    affine = numpy.asarray(image.affine, dtype=numpy.float64)
    if volume.ndim != 3 or not numpy.isfinite(volume).all():
        raise PrepareError("Unexpected volume")
    mask = volume > 0
    filled = numpy.nonzero(mask)
    if filled[0].size == 0:
        raise PrepareError("Empty volume")
    low = [max(int(axis.min()) - MARGIN, 0) for axis in filled]
    high = [min(int(axis.max()) + MARGIN + 1, n) for axis, n in zip(filled, mask.shape)]
    box = mask[low[0] : high[0], low[1] : high[1], low[2] : high[2]]
    box_affine = affine.copy()
    box_affine[:3, 3] = affine[:3, :3] @ numpy.array(low, dtype=numpy.float64) + affine[:3, 3]
    files = {"mask.u8": box.astype(numpy.uint8).tobytes(order="F")}

    points = torch.load(source / "fiducials.pt", weights_only=True)
    points = points.reshape(-1, 3).to(torch.float64).numpy()
    if points.shape[0] < 3 or not numpy.isfinite(points).all():
        raise PrepareError("Unexpected fiducials")
    files["fiducials.f32"] = points.astype("<f4").tobytes()

    views = {}
    for view in VIEWS:
        stored = torch.load(source / "xrays" / f"{view}.pt", weights_only=True)
        pose = stored["pose"].reshape(4, 4).to(torch.float64).numpy()
        intrinsics = {key: float(value) for key, value in stored["intrinsics"].items()}
        height, width = int(intrinsics.pop("height")), int(intrinsics.pop("width"))
        files[f"{view}.u16"] = frame_pixels(source / "xrays" / f"{view}.dcm", height, width)
        views[view] = {
            "pose": pose.tolist(),
            "intrinsics": intrinsics,
            "height": height,
            "width": width,
        }

    destination = created_outside(destination)
    for name, data in files.items():
        (destination / name).write_bytes(data)
    record = {
        "subject": source.name,
        "volume_shape": list(volume.shape),
        "volume_affine": affine.tolist(),
        "mask_shape": list(box.shape),
        "mask_affine": box_affine.tolist(),
        "mask_voxels": int(mask.sum()),
        "fiducial_count": int(points.shape[0]),
        "views": views,
        "sha256": {name: _sha256(data) for name, data in files.items()},
    }
    (destination / "subject.json").write_text(json.dumps(record, indent=1) + "\n", encoding="utf-8")
    return record


def verify_source(source: Path, subjects: list[Path]) -> None:
    """Refuse any file that is not the one the fetch recorded."""
    try:
        manifest = json.loads((source / "MANIFEST.json").read_text(encoding="utf-8"))
        listed = {item["path"]: (item["bytes"], item["sha256"]) for item in manifest["files"]}
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise PrepareError("The source has no readable fetch manifest") from error
    for subject in subjects:
        for name in USED:
            path = subject / name
            if not path.is_file() or (path.stat().st_size, _digest(path)) != listed.get(
                f"{subject.name}/{name}"
            ):
                raise PrepareError(f"Not the fetched file: {subject.name}/{name}")


def prepare(source: Path, destination: Path) -> list[dict]:
    root = outside_repository(destination)
    subjects = sorted(path for path in source.glob("subject*") if path.is_dir())
    if len(subjects) != SUBJECTS:
        raise PrepareError(f"Expected {SUBJECTS} subjects, found {len(subjects)}")
    verify_source(source, subjects)
    return [prepare_subject(subject, root / subject.name) for subject in subjects]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args(argv)
    try:
        records = prepare(args.source, args.destination)
    except (PrepareError, FetchError, OSError, ValueError, KeyError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    for record in records:
        print(record["subject"], record["mask_shape"], record["mask_voxels"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
