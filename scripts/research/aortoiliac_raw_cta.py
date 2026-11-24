#!/usr/bin/env python3
"""Raw CT angiograms of the AVT design cases through the aorta and iliac model.

For each odd-numbered (design) AVT case this reads the raw CT from the
fetched archive into memory, runs the installed TotalSegmentator ``total``
3 mm weights on it (``planner.aortoiliac_nnunet``), names the aorta and both
iliac arteries with ``planner.aortoiliac_model``, and compares the result with
the AVT annotators' own mask of the same scan. The annotators' mask is never
an input to the model; it is read only to score.

  mask      share of inferred aorta and iliac voxels inside the annotated
            lumen, and within 2 mm of it;
  lines     the same model built from the annotated mask, as the reference:
            share of the inferred lines inside the annotated lumen, share of
            the reference lines inside the inferred mask, the distance from
            each inferred line to the reference line of the same name, and
            the distance between the two bifurcations;
  parting   the height below which the two inferred iliac ends lie in
            separate pieces of the annotated mask, against the inferred
            bifurcation;
  sides     whether the right iliac line ends on the patient's right.

Even-numbered (held-back) cases are refused: that set has been read once
already. Output is one JSON line per case to stdout. Nothing is written to
disk; run it inside ``ram_only.py`` so a library cannot do so either.

  python3 scripts/research/ram_only.py /Volumes/SeldingerRAM -- \\
      .runtime/ml-runtime/bin/python scripts/research/aortoiliac_raw_cta.py \\
      --avt "/Volumes/Training HD/Seldinger Data/raw/figshare-14806362-avt-aortic-vessel-tree" \\
      --weights ~/.totalsegmentator/nnunet/results/<dataset>/<configuration>
"""

import argparse
import gzip
import hashlib
import json
import re
import resource
import sys
import time
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

ARCHIVES = {"D": "Dongyang", "K": "KiTS", "R": "Rider"}
_SUBJECT = re.compile(r"([DKR])([0-9]+)")
_TYPES = {
    "short": "<i2",
    "int16": "<i2",
    "signed short": "<i2",
    "int": "<i4",
    "int32": "<i4",
    "signed int": "<i4",
    "unsigned short": "<u2",
    "uint16": "<u2",
    "ushort": "<u2",
}
LINE_STEP_MM = 2.0


class CaseError(RuntimeError):
    pass


def is_design(subject: str) -> bool:
    match = _SUBJECT.fullmatch(subject)
    if match is None:
        raise CaseError(f"Not an AVT subject: {subject}")
    return int(match.group(2)) % 2 == 1


def read_ct_nrrd(data: bytes):
    """A CT NRRD as (int16-or-uint16 array in x, y, z order, RAS affine, header)."""
    import numpy as np

    end = data.find(b"\n\n")
    fields = {}
    for line in data[: max(end, 0)].decode("latin-1").splitlines()[1:]:
        key, mark, value = line.partition(":")
        if mark and not line.startswith("#"):
            fields[key.strip()] = value.lstrip("=").strip()
    try:
        dtype = np.dtype(_TYPES[fields["type"]])
        shape = tuple(int(n) for n in fields["sizes"].split())
        columns = [
            [float(v) for v in vector.strip("()").split(",")]
            for vector in fields["space directions"].split()
        ]
        origin = [float(v) for v in fields["space origin"].strip("()").split(",")]
        if (
            not data.startswith(b"NRRD")
            or fields["dimension"] != "3"
            or fields["space"] not in ("left-posterior-superior", "LPS")
            or fields.get("endian", "little") != "little"
            or fields["encoding"] not in ("gzip", "gz", "raw")
            or len(shape) != 3
            or np.shape(columns) != (3, 3)
            or len(origin) != 3
        ):
            raise ValueError
    except (KeyError, ValueError):
        raise CaseError("Not a plain CT file") from None
    body = data[end + 2 :]
    if fields["encoding"] != "raw":
        body = gzip.decompress(body)
    count = shape[0] * shape[1] * shape[2]
    if len(body) != count * dtype.itemsize:
        raise CaseError("CT file is short")
    volume = np.frombuffer(body, dtype=dtype).reshape(shape, order="F")
    affine = np.eye(4)
    affine[:3, :3] = np.asarray(columns, dtype=float).T
    affine[:3, 3] = origin
    affine = np.diag([-1.0, -1.0, 1.0, 1.0]) @ affine
    return volume, affine, {"type": fields["type"], "sizes": list(shape)}


def as_hounsfield(volume):
    """Signed volumes are taken as Hounsfield units. An unsigned volume is
    shifted by -1024 when the air around the body reads near 0, and refused
    otherwise. Returns (int16 array, offset applied)."""
    import numpy as np

    if volume.dtype.kind == "i":
        if volume.dtype.itemsize > 2:
            volume = np.clip(volume, -32768, 32767)
        return volume.astype(np.int16, copy=False), 0
    corners = np.concatenate(
        [volume[:8, :8, :].ravel(), volume[-8:, :8, :].ravel(), volume[:8, -8:, :].ravel()]
    )
    if float(np.median(corners)) > 200:
        raise CaseError("Unsigned CT without air near 0; offset unknown")
    return (volume.astype(np.int32) - 1024).astype(np.int16), -1024


def resample_line(path, step=LINE_STEP_MM):
    import numpy as np

    path = np.asarray(path, dtype=float)
    if len(path) < 2:
        return path
    seg = np.linalg.norm(np.diff(path, axis=0), axis=1)
    s = np.r_[0.0, np.cumsum(seg)]
    if s[-1] <= 0:
        return path[:1]
    at = np.arange(0.0, s[-1] + 1e-9, step)
    return np.stack([np.interp(at, s, path[:, k]) for k in range(3)], axis=1)


def line_distance(one, other):
    """Mean and 95th percentile distance (mm) from points of ``one`` to the
    polyline ``other`` (both resampled every 2 mm), over the part of ``one``
    that lies within the height range of ``other``."""
    import numpy as np
    from scipy.spatial import cKDTree

    a, b = resample_line(one), resample_line(other)
    low, high = b[:, 2].min(), b[:, 2].max()
    keep = (a[:, 2] >= low - 1.0) & (a[:, 2] <= high + 1.0)
    if keep.sum() < 3 or len(b) < 2:
        return None
    dense = resample_line(b, 0.5)
    d, _ = cKDTree(dense).query(a[keep])
    return {"mean_mm": float(d.mean()), "p95_mm": float(np.percentile(d, 95)), "n": int(keep.sum())}


def points_inside(points, mask, affine):
    import numpy as np

    points = np.asarray(points, dtype=float)
    inverse = np.linalg.inv(affine)
    index = np.rint(points @ inverse[:3, :3].T + inverse[:3, 3]).astype(int)
    inside = ((index >= 0) & (index < mask.shape)).all(axis=1)
    inside[inside] = mask[tuple(index[inside].T)] > 0
    return float(inside.mean()) if len(points) else None


def mask_agreement(pred, pred_affine, ref, ref_affine):
    """Share of predicted voxels inside the annotated lumen and within 2 mm."""
    import numpy as np
    from scipy import ndimage

    spacing = np.linalg.norm(ref_affine[:3, :3], axis=0)
    # Distances only matter up to 2 mm: the annotation's own box with a
    # margin past that holds every voxel that can count.
    found = np.argwhere(ref)
    margin = np.ceil(2.0 / spacing).astype(int) + 2
    low = np.maximum(found.min(axis=0) - margin, 0) if len(found) else np.zeros(3, int)
    high = np.minimum(found.max(axis=0) + 1 + margin, ref.shape) if len(found) else np.zeros(3, int)
    box = ref[low[0] : high[0], low[1] : high[1], low[2] : high[2]]
    outside = ndimage.distance_transform_edt(box == 0, sampling=spacing)
    voxels = np.argwhere(pred)
    world = voxels @ pred_affine[:3, :3].T + pred_affine[:3, 3]
    inverse = np.linalg.inv(ref_affine)
    index = np.rint(world @ inverse[:3, :3].T + inverse[:3, 3]).astype(int) - low
    held = ((index >= 0) & (index < box.shape)).all(axis=1)
    distance = np.full(len(index), np.inf)
    distance[held] = outside[tuple(index[held].T)]
    return {
        "inferred_voxels": len(voxels),
        "inside_annotation": float((distance == 0).mean()),
        "within_2mm_of_annotation": float((distance <= 2.0).mean()),
    }


def compare(model, ref_model, pred, pred_affine, ref, ref_affine):
    """Scores of the inferred model against the annotated mask and the model
    built from it. Neither reference is an input to the inferred model."""
    import numpy as np
    from aortoiliac_single_mask import parts_below

    lines = {b["name"]: np.asarray(b["path_ras"]) for b in model["branches"]}
    ref_lines = {b["name"]: np.asarray(b["path_ras"]) for b in ref_model["branches"]}
    every = np.concatenate([resample_line(v) for v in lines.values()])
    ref_every = np.concatenate([resample_line(v) for v in ref_lines.values()])
    out = {
        "names": sorted(lines),
        "reference_names": sorted(ref_lines),
        "lines_inside_annotation": points_inside(every, ref, ref_affine),
        "reference_lines_inside_inference": points_inside(ref_every, pred, pred_affine),
        "line_distance": {
            name: line_distance(lines[name], ref_lines[name]) for name in lines if name in ref_lines
        },
        "bifurcation_distance_mm": None,
        "bifurcation_above_parting_mm": None,
        "right_is_right": None,
    }
    if model["bifurcation_ras"] is not None and ref_model["bifurcation_ras"] is not None:
        out["bifurcation_distance_mm"] = float(
            np.linalg.norm(np.subtract(model["bifurcation_ras"], ref_model["bifurcation_ras"]))
        )
    if model["bifurcation_ras"] is not None:
        ends = {side: lines[f"{side}_iliac"][-1] for side in ("right", "left")}
        parting = parts_below(ref, ref_affine, ends["right"], ends["left"])
        if parting is not None:
            out["bifurcation_above_parting_mm"] = float(model["bifurcation_ras"][2] - parting)
        out["right_is_right"] = bool(ends["right"][0] > ends["left"][0])
    return out


def peak_mb() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 2**20


def run_case(archive: zipfile.ZipFile, member: str, run) -> dict:
    import nibabel as nib
    import numpy as np
    from aortoiliac_single_mask import read_seg_nrrd

    from planner.aortoiliac_inference import AORTOILIAC_LABEL_MAP
    from planner.aortoiliac_model import propose_aortoiliac_model

    out = {"member": member}
    data = archive.read(member)
    out["ct_sha256"] = hashlib.sha256(data).hexdigest()
    volume, affine, header = read_ct_nrrd(data)
    del data
    volume, offset = as_hounsfield(volume)
    out.update(ct=header, hounsfield_offset=offset)
    image = nib.Nifti1Image(volume, affine)
    image.header.set_xyzt_units("mm", "sec")
    started = time.perf_counter()
    seg = run(image, fast=True)
    out["inference_seconds"] = time.perf_counter() - started
    labels = np.asanyarray(seg.dataobj)
    del image, volume
    out["label_voxels"] = {
        name: int((labels == label).sum()) for label, name in AORTOILIAC_LABEL_MAP.items()
    }
    pred = np.isin(labels, tuple(AORTOILIAC_LABEL_MAP)).astype(np.uint8)
    del labels, seg
    seg_member = member[: -len(".nrrd")] + ".seg.nrrd"
    seg_data = archive.read(seg_member)
    out["annotation_sha256"] = hashlib.sha256(seg_data).hexdigest()
    ref, ref_affine = read_seg_nrrd(seg_data)
    del seg_data
    # Crop the inferred mask to its own box before the model, as the
    # annotated mask is; the model sees only the inferred voxels.
    found = np.argwhere(pred)
    if not len(found):
        return {**out, "refused": "No aorta or iliac voxel inferred"}
    low = np.maximum(0, found.min(axis=0) - 2)
    high = np.minimum(pred.shape, found.max(axis=0) + 3)
    pred = np.ascontiguousarray(pred[low[0] : high[0], low[1] : high[1], low[2] : high[2]])
    pred_affine = affine.copy()
    pred_affine[:3, 3] = affine[:3, :3] @ low + affine[:3, 3]
    del found
    out["mask"] = mask_agreement(pred, pred_affine, ref, ref_affine)
    try:
        model = propose_aortoiliac_model(pred, pred_affine)
    except ValueError as refusal:
        return {**out, "refused": str(refusal)}
    try:
        ref_model = propose_aortoiliac_model(ref, ref_affine)
    except ValueError as refusal:
        return {**out, "model": summary(model), "reference_refused": str(refusal)}
    out["model"] = summary(model)
    out["reference_model"] = summary(ref_model)
    out["scores"] = compare(model, ref_model, pred, pred_affine, ref, ref_affine)
    return out


def summary(model) -> dict:
    return {
        "method": model["method"],
        "names": [b["name"] for b in model["branches"]],
        "lengths_mm": {b["name"]: round(float(b["length_mm"]), 1) for b in model["branches"]},
        "bifurcation_ras": model["bifurcation_ras"],
    }


def design_members(avt: Path, wanted=None):
    for letter, name in ARCHIVES.items():
        path = avt / f"{name}.zip"
        archive = zipfile.ZipFile(path)
        for member in sorted(archive.namelist()):
            leaf = member.rsplit("/", 1)[-1]
            if not leaf.endswith(".nrrd") or leaf.endswith(".seg.nrrd"):
                continue
            subject = leaf[: -len(".nrrd")]
            if not subject.startswith(letter) or not is_design(subject):
                continue
            if wanted and subject not in wanted:
                continue
            yield subject, archive, member


def main(argv=None) -> int:
    from planner.aortoiliac_nnunet import installed_weights_runner

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--avt", type=Path, required=True)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--case", action="append", help="run only this design case")
    parser.add_argument("--threads", type=int, default=8)
    args = parser.parse_args(argv)
    for subject in args.case or []:
        if not is_design(subject):
            parser.error(f"{subject} is held back; only design cases are run")
    run = installed_weights_runner(args.weights, threads=args.threads)
    print(json.dumps({"backend": run.backend}), flush=True)
    for subject, archive, member in design_members(args.avt, set(args.case or [])):
        started = time.perf_counter()
        try:
            record = run_case(archive, member, run)
        except (CaseError, ValueError, MemoryError) as fault:
            record = {"member": member, "failed": f"{type(fault).__name__}: {fault}"}
        record.update(
            subject=subject,
            seconds=round(time.perf_counter() - started, 1),
            peak_mb=round(peak_mb()),
        )
        print(json.dumps(record, allow_nan=False, default=float), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
