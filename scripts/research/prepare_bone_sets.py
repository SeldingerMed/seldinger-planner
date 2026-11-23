#!/usr/bin/env python3
"""Decode the fetched bone line-up sets into plain arrays for the evaluation.

Two public sets are read, each from the directory the fetch left it in:

  deepfluoro  the xvr-data copy of DeepFluoro (CC BY-NC 4.0, internal
              measurement only): per subject a CT, 14 fiducial points and
              X-ray frames, each with a stored pose and intrinsics.
  lspine      C-ArmLSpine (CC BY 4.0): per case a front and a side C-arm
              frame and the cone-beam scan of the same session.

The step changes formats and sizes and nothing else. It does not interpret a
pose, pick a threshold or choose a view; that lives in the TypeScript the
evaluation runs, where it is tested. The two reductions are stated here
because the evaluation depends on them:

  - a frame is averaged over whole blocks of ``FRAME_BLOCK`` pixels a side;
  - an lspine scan is averaged over whole blocks of ``SCAN_BLOCK`` voxels a
    side. A DeepFluoro CT is kept at its own grid.

For each subject or case it writes, under the destination:
  volume.i16       intensities, little-endian, x fastest, clipped to int16
  fiducials.f32    deepfluoro only: the stored points, x y z triples
  labels.u8        deepfluoro only: the set's bone labels on the scan grid,
                   one byte a voxel, values as stored
  NNN.u16          one reduced frame each, little-endian, rows from the top.
                   A deepfluoro frame is the whole stored frame; its stored
                   intrinsics describe a smaller frame cut from it, and are
                   recorded as stored
  subject.json     shapes, the volume affine, and for every frame what the
                   source stored about its camera

The destination must lie outside the repository and on another storage
device. deepfluoro needs numpy and nibabel (the planner's optional
model runtime); lspine needs numpy and pydicom.
"""

import argparse
import contextlib
import gzip
import hashlib
import io
import itertools
import json
import sys
import zipfile
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_ljubljana import FetchError, created_outside, outside_repository
from prepare_ljubljana import PrepareError, _sha256, frame_pixels, publish

FRAME_BLOCK = 4
SCAN_BLOCK = 2
# Tags of a C-arm frame that are copied into the record as stored.
LSPINE_TAGS = (
    "PositionerPrimaryAngle",
    "PositionerSecondaryAngle",
    "DistanceSourceToDetector",
    "DistanceSourceToPatient",
    "PixelSpacing",
    "ImagerPixelSpacing",
    "PhotometricInterpretation",
    "PatientPosition",
    "AcquisitionTime",
)


def block_mean(array, block: int):
    """Mean over whole blocks of `block` samples along every axis.

    Samples past the last whole block are dropped, so the first sample of the
    result is centered `(block - 1) / 2` samples into the source.
    """
    import numpy

    if block < 1 or any(n < block for n in array.shape):
        raise PrepareError("Block does not fit the array")
    kept = tuple(slice(0, n - n % block) for n in array.shape)
    cut = array[kept].astype(numpy.float64)
    shape = []
    for n in cut.shape:
        shape += [n // block, block]
    return cut.reshape(shape).mean(axis=tuple(range(1, 2 * cut.ndim, 2)))


def block_affine(affine, block: int):
    """The affine of a `block_mean` of a volume with this affine."""
    import numpy

    out = numpy.array(affine, dtype=numpy.float64)
    out[:3, 3] = out[:3, :3] @ numpy.full(3, (block - 1) / 2) + out[:3, 3]
    out[:3, :3] = out[:3, :3] * block
    return out


def _i16(volume, order: str = "F") -> bytes:
    import numpy

    if not numpy.isfinite(volume).all():
        raise PrepareError("Unexpected volume")
    return numpy.clip(numpy.rint(volume), -32768, 32767).astype("<i2").tobytes(order=order)


def _u16(frame) -> bytes:
    import numpy

    return numpy.clip(numpy.rint(frame), 0, 65535).astype("<u2").tobytes()


def stored_size(path: Path) -> tuple[int, int]:
    """Rows and columns a frame states for itself.

    The stored intrinsics of this set describe a frame cut down from the one
    in the file, so the size of the file's own pixels is read from the file.
    """
    data = path.read_bytes()[:4096]
    size = []
    for tag in ("28001000", "28001100"):
        at = data.find(bytes.fromhex(tag) + b"US\x02\x00")
        if at < 0:
            raise PrepareError(f"No stored size: {path.name}")
        size.append(int.from_bytes(data[at + 8 : at + 10], "little"))
    return size[0], size[1]


_STORAGE = {
    "DoubleStorage": "<f8",
    "FloatStorage": "<f4",
    "HalfStorage": "<f2",
    "LongStorage": "<i8",
    "IntStorage": "<i4",
    "ShortStorage": "<i2",
    "CharStorage": "i1",
    "ByteStorage": "u1",
    "BoolStorage": "?",
}


def read_pt(data: bytes):
    """A `torch.save` file of tensors, numbers and dicts, read with numpy.

    The set stores each pose and each landmark list this way. Loading torch to
    read sixteen numbers costs more than a gigabyte of memory, which on a
    machine that is also training gets the step paused. Only tensors, plain
    numbers, strings and dicts are accepted; any other object in the file is
    refused before anything is called.
    """
    import pickle

    import numpy

    def refuse(error=None):
        raise PrepareError("Not a tensor file") from error

    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as error:
        refuse(error)
    pickles = [n for n in archive.namelist() if n == "data.pkl" or n.endswith("/data.pkl")]
    if len(pickles) != 1:
        refuse()
    root = pickles[0][: -len("data.pkl")]
    if root + "byteorder" in archive.namelist() and archive.read(root + "byteorder") != b"little":
        refuse()

    def tensor(storage, offset, size, stride, *_):
        size, stride = tuple(size), tuple(stride)
        if (
            len(size) != len(stride)
            or offset < 0
            or any(n < 0 for n in size)
            or any(step < 0 for step in stride)
        ):
            refuse()
        if 0 in size:
            return numpy.empty(size, dtype=storage.dtype)
        last = offset + sum((n - 1) * step for n, step in zip(size, stride, strict=True))
        if last >= storage.size:
            refuse()
        view = numpy.lib.stride_tricks.as_strided(
            storage[offset:], shape=size, strides=[step * storage.itemsize for step in stride]
        )
        return numpy.array(view)

    class Reader(pickle.Unpickler):
        def find_class(self, module, name):
            if (module, name) == ("torch._utils", "_rebuild_tensor_v2"):
                return tensor
            if module == "torch" and name in _STORAGE:
                return _STORAGE[name]
            if (module, name) == ("collections", "OrderedDict"):
                return dict
            refuse()

        def persistent_load(self, pid):
            if not isinstance(pid, tuple) or len(pid) != 5 or pid[0] != "storage":
                refuse()
            _, dtype, key, _, count = pid
            if dtype not in _STORAGE.values() or not str(key).isdigit():
                refuse()
            storage = numpy.frombuffer(archive.read(f"{root}data/{key}"), dtype=dtype)
            if storage.size != count:
                refuse()
            return storage

    try:
        return Reader(io.BytesIO(archive.read(pickles[0]))).load()
    except PrepareError:
        raise
    except (
        pickle.UnpicklingError,
        zipfile.BadZipFile,
        AttributeError,
        EOFError,
        IndexError,
        KeyError,
        TypeError,
        ValueError,
    ) as error:
        refuse(error)


@contextlib.contextmanager
def _slabs(source: bytes | Path, slab: int):
    """The header of a gzipped NIfTI volume, bytes or a file, then its values
    `slab` slices at a time, scaled as the header says. The volume is never
    held whole."""
    import nibabel
    import numpy

    with contextlib.ExitStack() as stack:
        raw = (
            stack.enter_context(source.open("rb"))
            if isinstance(source, Path)
            else io.BytesIO(source)
        )
        stream = stack.enter_context(gzip.GzipFile(fileobj=raw))

        def take(count: int) -> bytes:
            try:
                data = stream.read(count)
            except (OSError, EOFError, zlib.error) as error:
                raise PrepareError("Unexpected volume") from error
            if len(data) != count:
                raise PrepareError("Unexpected volume")
            return data

        try:
            header = nibabel.Nifti1Header(take(348))
        except (
            ValueError,
            nibabel.spatialimages.HeaderDataError,
            nibabel.wrapstruct.WrapStructError,
        ) as error:
            raise PrepareError("Unexpected volume") from error
        shape = [int(n) for n in header.get_data_shape()]
        if len(shape) != 3 or min(shape) < 1:
            raise PrepareError("Unexpected volume")
        dtype = header.get_data_dtype()
        slope, inter = header.get_slope_inter()
        skip = int(header.get_data_offset()) - 348
        if skip < 0:
            raise PrepareError("Unexpected volume")
        take(skip)

        def values():
            for first in range(0, shape[2], slab):
                count = shape[0] * shape[1] * min(slab, shape[2] - first)
                part = numpy.frombuffer(take(count * dtype.itemsize), dtype=dtype)
                yield part if slope is None else part * slope + (inter or 0.0)

        yield shape, numpy.asarray(header.get_best_affine(), dtype=numpy.float64), values()


def scan_i16(source: bytes | Path, slab: int = 16, sink=None) -> tuple[bytes, list[int], object]:
    """A gzipped NIfTI scan as little-endian 16-bit values, first index
    fastest, with its shape and affine.

    The scan is unpacked and converted `slab` slices at a time, so the step
    never holds the whole scan as floating point. With a `sink` each part is
    handed over as it is made and nothing is returned to hold.
    """
    out = bytearray()
    with _slabs(source, slab) as (shape, affine, values):
        for part in values:
            (sink or out.extend)(_i16(part))
    return bytes(out), shape, affine


def labels_u8(
    source: bytes | Path, shape: list[int], affine, slab: int = 16, sink=None
) -> tuple[bytes, list[int]]:
    """A gzipped NIfTI label volume as bytes, first index fastest, with the
    label values it holds. It must lie on the scan's own grid. A `sink` takes
    the parts as `scan_i16` hands them over."""
    import numpy

    out = bytearray()
    seen: set[int] = set()
    with _slabs(source, slab) as (own_shape, own_affine, values):
        if own_shape != list(shape) or not numpy.allclose(own_affine, affine, rtol=0, atol=1e-4):
            raise PrepareError("Labels are not on the scan grid")
        for part in values:
            whole = numpy.rint(part)
            if (
                not numpy.isfinite(part).all()
                or (whole != part).any()
                or whole.min() < 0
                or whole.max() > 255
            ):
                raise PrepareError("Unexpected labels")
            (sink or out.extend)(whole.astype(numpy.uint8).tobytes())
            seen.update(int(v) for v in numpy.unique(whole))
    return bytes(out), sorted(seen)


def _listed(source: Path) -> dict:
    """Sizes and checksums the fetch recorded, by name."""
    try:
        record = json.loads((source / "SOURCE.json").read_text(encoding="utf-8"))
        if record.get("complete") is not True:
            raise PrepareError("The fetch record does not say the set is complete")
        return {item["name"]: item for item in record["files"]}
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise PrepareError("The source has no readable fetch record") from error


def _fetched(path: Path, name: str, listed: dict) -> bytes:
    """The bytes of a fetched file, refused unless they are the listed ones."""
    item = listed.get(name)
    data = path.read_bytes()
    if item is None or len(data) != item["size"]:
        raise PrepareError(f"Not the fetched file: {name}")
    if item.get("sha256") and _sha256(data) != item["sha256"]:
        raise PrepareError(f"Not the fetched file: {name}")
    return data


def _fetched_path(path: Path, name: str, listed: dict) -> Path:
    """A fetched file too large to hold, refused unless it is the listed one."""
    item = listed.get(name)
    if item is None or not path.is_file() or path.stat().st_size != item["size"]:
        raise PrepareError(f"Not the fetched file: {name}")
    if item.get("sha256"):
        digest = hashlib.sha256()
        with path.open("rb") as file:
            for chunk in iter(lambda: file.read(1 << 20), b""):
                digest.update(chunk)
        if digest.hexdigest() != item["sha256"]:
            raise PrepareError(f"Not the fetched file: {name}")
    return path


class Written:
    """An output file written in parts; `close` gives the digest of the whole."""

    def __init__(self, path: Path):
        self._file = path.open("wb")
        self._digest = hashlib.sha256()

    def write(self, data: bytes) -> None:
        self._file.write(data)
        self._digest.update(data)

    def close(self) -> str:
        self._file.close()
        return self._digest.hexdigest()


def prepare_deepfluoro_subject(source: Path, destination: Path, listed: dict, prefix: str) -> dict:
    import numpy

    def read(name: str) -> bytes:
        return _fetched(source / name, f"{prefix}/{name}", listed)

    def big(name: str) -> Path:
        return _fetched_path(source / name, f"{prefix}/{name}", listed)

    # The scan and its labels go to the destination as they are read. Its
    # record is removed first and written last, so a run that stops part way
    # leaves no record beside half-written files.
    root = created_outside(destination)
    (root / "subject.json").unlink(missing_ok=True)
    digests = {}
    out = Written(root / "volume.i16")
    _, shape, affine = scan_i16(big("volume.nii.gz"), sink=out.write)
    digests["volume.i16"] = out.close()
    files = {}

    points = numpy.asarray(read_pt(read("fiducials.pt")), dtype=numpy.float64).reshape(-1, 3)
    if points.shape[0] < 3 or not numpy.isfinite(points).all():
        raise PrepareError("Unexpected fiducials")
    files["fiducials.f32"] = points.astype("<f4").tobytes()
    digests["fiducials.f32"] = _sha256(files["fiducials.f32"])

    out = Written(root / "labels.u8")
    _, label_values = labels_u8(big("mask.nii.gz"), shape, affine, sink=out.write)
    digests["labels.u8"] = out.close()

    frames = {}
    names = sorted(p.stem for p in (source / "xrays").glob("[0-9]*.pt"))
    if not names:
        raise PrepareError("No frames")
    for name in names:
        stored = read_pt(read(f"xrays/{name}.pt"))
        pose = numpy.asarray(stored["pose"], dtype=numpy.float64).reshape(4, 4)
        intrinsics = {
            key: float(numpy.asarray(value, dtype=numpy.float64).reshape(1)[0])
            for key, value in stored["intrinsics"].items()
        }
        read(f"xrays/{name}.dcm")
        height, width = stored_size(source / "xrays" / f"{name}.dcm")
        pixels = numpy.frombuffer(
            frame_pixels(source / "xrays" / f"{name}.dcm", height, width), dtype="<u2"
        ).reshape(height, width)
        reduced = block_mean(pixels, FRAME_BLOCK)
        out = Written(root / f"{name}.u16")
        out.write(_u16(reduced))
        digests[f"{name}.u16"] = out.close()
        frames[name] = {
            "pose": pose.tolist(),
            "intrinsics": intrinsics,
            "stored_height": height,
            "stored_width": width,
            "height": int(reduced.shape[0]),
            "width": int(reduced.shape[1]),
        }
    record = {
        "set": "deepfluoro",
        "subject": source.name,
        "volume_shape": shape,
        "volume_affine": affine.tolist(),
        "fiducial_count": int(points.shape[0]),
        "frame_block": FRAME_BLOCK,
        "label_values": label_values,
        "frames": frames,
        "sha256": digests,
    }
    publish(root, files, record)
    return record


def prepare_deepfluoro(source: Path, destination: Path) -> list[dict]:
    root = outside_repository(destination)
    listed = _listed(source)
    subjects = sorted(p for p in (source / "deepfluoro").glob("subject*") if p.is_dir())
    if len(subjects) != 6:
        raise PrepareError(f"Expected 6 subjects, found {len(subjects)}")
    return [
        prepare_deepfluoro_subject(s, root / s.name, listed, f"deepfluoro/{s.name}")
        for s in subjects
        if not (root / s.name / "subject.json").is_file()
    ]


def lspine_cases(names: list[str]) -> dict:
    """Member names of the archive by case, split into frames, scan and
    whatever else the case holds, which is listed and not read."""
    cases: dict = {}
    for name in names:
        parts = name.split("/")
        if len(parts) != 4 or not parts[3] or parts[3].startswith("."):
            continue
        folder = parts[2] if parts[2] in ("C-arm", "CBCT") else "other"
        cases.setdefault(parts[1], {"C-arm": [], "CBCT": [], "other": []})[folder].append(name)
    return cases


def prepare_lspine_case(archive: zipfile.ZipFile, case: str, members: dict, destination: Path):
    import numpy
    import pydicom

    # The scan is read one slice at a time, so a case never holds more than
    # one block of slices in memory.
    # A few cases keep the sweep's own projections beside the slices of the
    # scan. Only the slices are read here; the rest is listed in the record.
    heads, aside = [], sorted(members["other"])
    for name in members["CBCT"]:
        ds = pydicom.dcmread(io.BytesIO(archive.read(name)), stop_before_pixels=True)
        if ds.get("Modality") != "CT":
            aside.append(name)
            continue
        heads.append(
            (
                [float(v) for v in ds.ImagePositionPatient],
                [float(v) for v in ds.ImageOrientationPatient],
                [float(v) for v in ds.PixelSpacing],
                (int(ds.Rows), int(ds.Columns)),
                name,
            )
        )
    heads.sort(key=lambda s: s[0][2])
    if not heads:
        raise PrepareError(f"No scan: {case}")
    first = heads[0]
    steps = {round(b[0][2] - a[0][2], 4) for a, b in itertools.pairwise(heads)}
    if (
        len(heads) < 8
        or len(steps) != 1
        or min(steps) <= 0
        or first[1] != [1, 0, 0, 0, 1, 0]
        or any(s[1:4] != first[1:4] or s[0][:2] != first[0][:2] for s in heads)
    ):
        raise PrepareError(f"Unexpected scan geometry: {case}")
    rows, columns = first[3]
    stored_shape = [columns, rows, len(heads)]
    slabs = []
    for at in range(0, len(heads) - len(heads) % SCAN_BLOCK, SCAN_BLOCK):
        block = []
        for head in heads[at : at + SCAN_BLOCK]:
            ds = pydicom.dcmread(io.BytesIO(archive.read(head[4])))
            slope, inter = float(ds.get("RescaleSlope", 1)), float(ds.get("RescaleIntercept", 0))
            block.append(ds.pixel_array.astype(numpy.float64) * slope + inter)
        # A slice is rows (y) by columns (x); written row after row, slab after
        # slab, the bytes run x fastest, then y, then z.
        slabs.append(_i16(block_mean(numpy.stack(block), SCAN_BLOCK)[0], order="C"))
    reduced_shape = [columns // SCAN_BLOCK, rows // SCAN_BLOCK, len(slabs)]
    row_mm, column_mm = first[2]
    # DICOM patient axes are left and posterior positive; the record's affine
    # is in RAS, as a NIfTI affine is.
    lps = numpy.diag([column_mm, row_mm, steps.pop(), 1.0])
    lps[:3, 3] = first[0]
    affine = numpy.diag([-1.0, -1.0, 1.0, 1.0]) @ lps
    files = {"volume.i16": b"".join(slabs)}

    frames = {}
    for name in sorted(members["C-arm"]):
        ds = pydicom.dcmread(io.BytesIO(archive.read(name)))
        pixels = ds.pixel_array
        if pixels.ndim != 2:
            raise PrepareError(f"Unexpected frame: {name}")
        small = block_mean(pixels, FRAME_BLOCK)
        key = f"{len(frames):03d}"
        files[f"{key}.u16"] = _u16(small)
        tags = {}
        for tag in LSPINE_TAGS:
            value = ds.get(tag)
            if value is not None:
                tags[tag] = (
                    [float(v) for v in value]
                    if isinstance(value, pydicom.multival.MultiValue)
                    else str(value)
                )
        frames[key] = {
            "member": name,
            "tags": tags,
            "stored_height": int(pixels.shape[0]),
            "stored_width": int(pixels.shape[1]),
            "height": int(small.shape[0]),
            "width": int(small.shape[1]),
        }
    if len(frames) < 2:
        raise PrepareError(f"Fewer than two frames: {case}")
    record = {
        "set": "lspine",
        "subject": case,
        "stored_volume_shape": stored_shape,
        "stored_volume_affine": affine.tolist(),
        "scan_block": SCAN_BLOCK,
        "volume_shape": reduced_shape,
        "volume_affine": block_affine(affine, SCAN_BLOCK).tolist(),
        "frame_block": FRAME_BLOCK,
        "frames": frames,
        "members_not_read": len(aside),
        "members_not_read_first": aside[:3],
        "sha256": {name: _sha256(data) for name, data in files.items()},
    }
    publish(created_outside(destination), files, record)
    return record


def prepare_lspine(source: Path, destination: Path, only: list[str] | None = None) -> list[dict]:
    root = outside_repository(destination)
    listed = _listed(source)
    path = source / "C-ArmLSpine.zip"
    item = listed.get("C-ArmLSpine.zip")
    if item is None or not path.is_file() or path.stat().st_size != item["size"]:
        raise PrepareError("Not the fetched file: C-ArmLSpine.zip")
    records = []
    with zipfile.ZipFile(path) as archive:
        cases = lspine_cases(archive.namelist())
        chosen = only or sorted(cases, key=lambda c: int(c.removeprefix("case")))
        for case in chosen:
            if case not in cases:
                raise PrepareError(f"No such case: {case}")
            if (root / case / "subject.json").is_file():
                continue
            records.append(prepare_lspine_case(archive, case, cases[case], root / case))
    return records


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    parser.add_argument("set", choices=("deepfluoro", "lspine"))
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--case", action="append", help="lspine only: prepare this case")
    args = parser.parse_args(argv)
    try:
        if args.set == "deepfluoro":
            records = prepare_deepfluoro(args.source, args.destination)
        else:
            records = prepare_lspine(args.source, args.destination, args.case)
    except (PrepareError, FetchError, OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    for record in records:
        print(record["subject"], record["volume_shape"], len(record["frames"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
