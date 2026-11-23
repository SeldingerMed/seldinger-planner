#!/usr/bin/env python3
"""Look at the aorta and iliac model on one mask of the whole aortic tree.

The AVT set stores, for each CT angiogram, one mask of the aorta and every
branch its annotators followed: the arch vessels, the visceral and renal
arteries, the iliac arteries and their branches. That is the mask a planner
receives when nothing has named its parts. The set has no label of the
bifurcation or of either iliac artery, so a case is recorded and drawn, not
scored:

  record   the branches the model named, their lengths, how far each iliac
           line runs toward the feet, the share of line points inside the
           mask, and whether the right iliac line ends on the patient's
           right of the left one;
  parting  read from the mask and the two iliac line ends alone: the height
           below which the two ends lie in separate pieces of the mask. The
           model's bifurcation is where the lumen divides, so the two heights
           agree when the lines named as iliac arteries are the two limbs of
           one fork;
  sheet    each case from the front and from the side, mask in grey, the
           aorta line in red, the right iliac in green, the left in blue.

Odd-numbered cases of each collection are for design; even-numbered ones are
held back and run whole. Results go to a directory outside the repository. Needs numpy, scipy and
Pillow (the planner's physics runtime).
"""

import argparse
import json
import multiprocessing
import resource
import sys
import time
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from aortoiliac_eval import (
    BOX_MARGIN,
    MODEL_FILE,
    SLAB_VOXELS,
    CaseError,
    code_digest,
    peak_mb,
)
from fetch_ljubljana import FetchError, created_outside, outside_repository
from prepare_ljubljana import PrepareError, _sha256

TILE = 220
TILES_ACROSS, TILES_DOWN = 4, 3
PARTING_GRID_MM = 1.2
COLOURS = {"aorta": (235, 60, 60), "right_iliac": (70, 210, 90), "left_iliac": (80, 140, 255)}


def read_seg_nrrd(data: bytes):
    """A Slicer segmentation file as the box that holds its mask, with the
    box's voxel-to-RAS affine. Read a few slices at a time."""
    import gzip
    import io

    import numpy as np

    end = data.find(b"\n\n")
    fields = {}
    for line in data[: max(end, 0)].decode("latin-1").splitlines()[1:]:
        key, mark, value = line.partition(":")
        if mark and not line.startswith("#"):
            fields[key.strip()] = value.lstrip("=").strip()
    try:
        plain = (
            data.startswith(b"NRRD")
            and fields["type"] in ("unsigned char", "uchar", "uint8")
            and fields["dimension"] == "3"
            and fields["encoding"] in ("gzip", "gz")
            and fields["space"] in ("left-posterior-superior", "LPS")
        )
        shape = tuple(int(n) for n in fields["sizes"].split())
        columns = [
            [float(v) for v in vector.strip("()").split(",")]
            for vector in fields["space directions"].split()
        ]
        origin = [float(v) for v in fields["space origin"].strip("()").split(",")]
        if not plain or len(shape) != 3 or np.shape(columns) != (3, 3) or len(origin) != 3:
            raise ValueError
    except (KeyError, ValueError):
        raise CaseError("Not a plain segmentation file") from None
    affine = np.eye(4)
    affine[:3, :3] = np.asarray(columns, dtype=float).T
    affine[:3, 3] = origin
    affine = np.diag([-1.0, -1.0, 1.0, 1.0]) @ affine
    stream = gzip.GzipFile(fileobj=io.BytesIO(data[end + 2 :]))
    slab = max(1, SLAB_VOXELS // (shape[0] * shape[1]))
    found = [np.zeros((0, 3), dtype=np.int32)]
    try:
        for first in range(0, shape[2], slab):
            slices = min(slab, shape[2] - first)
            part = np.frombuffer(stream.read(shape[0] * shape[1] * slices), dtype=np.uint8)
            if part.size != shape[0] * shape[1] * slices:
                raise CaseError("Segmentation file is short")
            part = np.argwhere(part.reshape((shape[0], shape[1], slices), order="F"))
            part[:, 2] += first
            found.append(part.astype(np.int32))
    except (OSError, EOFError) as error:
        raise CaseError("Segmentation file is short") from error
    found = np.concatenate(found)
    if not len(found):
        return np.zeros((0, 0, 0), dtype=np.uint8), affine
    low = np.maximum(0, found.min(axis=0) - BOX_MARGIN)
    high = np.minimum(shape, found.max(axis=0) + 1 + BOX_MARGIN)
    mask = np.zeros(tuple(high - low), dtype=np.uint8)
    mask[tuple((found - low).T)] = 1
    boxed = affine.copy()
    boxed[:3, 3] = affine[:3, :3] @ low + affine[:3, 3]
    return mask, boxed


def parts_below(mask, affine, one, other) -> float | None:
    """The height (RAS, mm) below which two points of the lumen lie in
    separate pieces of the mask, or None when they never part.

    Read from the mask alone, on a grid of about `PARTING_GRID_MM`: the mask
    is cut level by level across the axis that runs head to foot, and what
    lies below the cut is checked for a way from one point to the other.
    """
    import numpy as np
    from scipy import ndimage
    from scipy.spatial import cKDTree

    affine = np.asarray(affine, dtype=float)
    spacing = np.linalg.norm(affine[:3, :3], axis=0)
    stride = np.maximum(1, np.floor(PARTING_GRID_MM / spacing)).astype(int)
    # A few slices at a time: a whole aortic tree at scan resolution is a
    # few hundred megabytes, and the mask is not needed again.
    small = np.zeros(tuple(-(-n // s) for n, s in zip(mask.shape, stride)), dtype=bool)
    slab = max(1, SLAB_VOXELS // (mask.shape[0] * mask.shape[1]))
    for first in range(0, mask.shape[2], slab):
        part = mask[:, :, first : first + slab] > 0
        last = first + part.shape[2]
        small[:, :, first // stride[2] : -(-last // stride[2])] |= (
            np.pad(
                part,
                [
                    (0, -part.shape[0] % stride[0]),
                    (0, -part.shape[1] % stride[1]),
                    (first % stride[2], -last % stride[2]),
                ],
            )
            .reshape(
                small.shape[0],
                stride[0],
                small.shape[1],
                stride[1],
                -1,
                stride[2],
            )
            .any(axis=(1, 3, 5))
        )
    axis = int(np.argmax(np.abs(affine[2, :3])))
    if affine[2, axis] < 0:
        small = np.flip(small, axis=axis)
    small = np.moveaxis(small, axis, 2)
    held = np.argwhere(small)
    inverse = np.linalg.inv(affine)
    at = []
    for point in (one, other):
        index = (inverse[:3, :3] @ np.asarray(point, dtype=float) + inverse[:3, 3]) / stride
        if affine[2, axis] < 0:
            index[axis] = small.shape[2] - 1 - index[axis]
        index = np.r_[np.delete(index, axis), index[axis]]
        at.append(held[cKDTree(held).query(index)[1]])
    everything = np.ones((3, 3, 3), dtype=bool)

    def joined(level: int) -> bool:
        labels, _ = ndimage.label(small[:, :, :level], structure=everything)
        return labels[tuple(at[0])] == labels[tuple(at[1])]

    low, high = int(max(at[0][2], at[1][2])) + 1, small.shape[2]
    if joined(low) or not joined(high):
        return None
    # `low` levels are not enough for a way between the points, `high` are.
    while high - low > 1:
        middle = (low + high) // 2
        low, high = (low, middle) if joined(middle) else (middle, high)
    index = np.asarray(mask.shape, dtype=float) / 2
    level = (low + 0.5) * stride[axis] - 0.5
    index[axis] = level if affine[2, axis] > 0 else mask.shape[axis] - 1 - level
    return float(affine[2, :3] @ index + affine[2, 3])


def tile(mask, affine, model, title: str):
    """The case from the front (the patient's right on the left) and from
    the side (the patient's front on the left)."""
    import numpy as np
    from PIL import Image, ImageDraw

    picture = Image.new("RGB", (2 * TILE, TILE), (12, 12, 16))
    held = np.argwhere(mask)
    if len(held):
        held = held[:: max(1, len(held) // 300_000)]
        ras = held @ affine[:3, :3].T + affine[:3, 3]
        low, high = ras.min(axis=0), ras.max(axis=0)
        scale = (TILE - 24) / max(float((high - low).max()), 1.0)
        centre = (low + high) / 2

        def placed(points, view):
            points = np.asarray(points, dtype=float).reshape(-1, 3)
            across = -(points[:, 0] - centre[0]) if view == 0 else -(points[:, 1] - centre[1])
            down = -(points[:, 2] - centre[2])
            return np.c_[across * scale + TILE / 2 + view * TILE, down * scale + TILE / 2 + 8]

        pixels = np.asarray(picture).copy()
        for view in (0, 1):
            spots = np.rint(placed(ras, view)).astype(int)
            inside = (
                (spots[:, 0] >= view * TILE)
                & (spots[:, 0] < (view + 1) * TILE)
                & (spots[:, 1] >= 0)
                & (spots[:, 1] < TILE)
            )
            pixels[spots[inside, 1], spots[inside, 0]] = (120, 120, 128)
        picture = Image.fromarray(pixels)
        draw = ImageDraw.Draw(picture)
        if model:
            for view in (0, 1):
                for branch in model["branches"]:
                    line = [tuple(p) for p in placed(branch["path_ras"], view)]
                    draw.line(line, fill=COLOURS[branch["name"]], width=2)
                if model["bifurcation_ras"]:
                    x, y = placed(model["bifurcation_ras"], view)[0]
                    draw.ellipse((x - 3, y - 3, x + 3, y + 3), outline=(255, 230, 60))
    ImageDraw.Draw(picture).text((4, 2), title, fill=(255, 255, 255))
    return np.asarray(picture)


def run_case(lifted, case: dict) -> tuple[dict, object]:
    import numpy as np

    from planner.aortoiliac_model import propose_aortoiliac_model

    out = {"subject": case["subject"], "meta": case["meta"]}
    name = f"{case['subject']}.seg.nrrd"
    data = lifted.read(name)
    if _sha256(data) != case["sha256"][name]:
        raise PrepareError(f"Not the prepared file: {name}")
    try:
        mask, affine = read_seg_nrrd(data)
    except CaseError as fault:
        return {**out, "left_out": str(fault)}, tile(np.zeros((0, 3)), np.eye(4), None, name)
    del data
    if mask.any():
        held = np.argwhere(mask) @ affine[:3, :3].T + affine[:3, 3]
        out["mask_height_mm"] = float(np.ptp(held[:, 2]))
        del held
    started = time.perf_counter()
    try:
        model = propose_aortoiliac_model(mask, affine)
    except ValueError as refusal:
        out["refused"] = str(refusal)
        return out, tile(mask, affine, None, f"{case['subject']} refused")
    out["seconds"] = time.perf_counter() - started
    lines = {b["name"]: np.asarray(b["path_ras"]) for b in model["branches"]}
    every = np.concatenate(list(lines.values()))
    inverse = np.linalg.inv(affine)
    index = np.rint(every @ inverse[:3, :3].T + inverse[:3, 3]).astype(int)
    inside = ((index >= 0) & (index < mask.shape)).all(axis=1)
    inside[inside] = mask[tuple(index[inside].T)] > 0
    out.update(
        method=model["method"],
        names=list(lines),
        points_in_lumen=float(inside.mean()),
        aorta_length_mm=float(model["branches"][0]["length_mm"]),
        aorta_median_radius_mm=float(np.median(model["branches"][0]["radius_mm"])),
        bifurcation_ras=model["bifurcation_ras"],
        bifurcation_above_parting_mm=None,
        right_is_right=None,
        iliac_drop_mm={},
        iliac_length_mm={},
    )
    if model["bifurcation_ras"] is not None:
        ends = {side: lines[f"{side}_iliac"][-1] for side in ("right", "left")}
        parting = parts_below(mask, affine, ends["right"], ends["left"])
        if parting is not None:
            out["bifurcation_above_parting_mm"] = model["bifurcation_ras"][2] - parting
        out["right_is_right"] = bool(ends["right"][0] > ends["left"][0])
        for side, end in ends.items():
            out["iliac_drop_mm"][side] = float(model["bifurcation_ras"][2] - end[2])
        for branch in model["branches"][1:]:
            out["iliac_length_mm"][branch["name"].split("_")[0]] = float(branch["length_mm"])
    return out, tile(mask, affine, model, f"{case['subject']} {len(lines)}")


def set_of(subject: str) -> str:
    """Odd-numbered cases of each collection are for design, even-numbered
    ones are held back."""
    digits = "".join(c for c in subject if c.isdigit())
    if not digits:
        raise PrepareError(f"Case without a number: {subject}")
    return "design" if int(digits) % 2 else "held_back"


_OPEN: dict = {}


def _worker(job: tuple[str, dict]):
    prepared, case = job
    if prepared not in _OPEN:
        _OPEN[prepared] = zipfile.ZipFile(Path(prepared) / "labels.zip")
    run, drawn = run_case(_OPEN[prepared], case)
    # Every case runs in a process of its own, which reads the code as it is
    # on disk at that moment: the run records which code that was.
    run["code"] = code_digest(MODEL_FILE, Path(__file__))
    run["peak_mb"] = peak_mb(resource.RUSAGE_SELF)
    return run, drawn


def summarize(runs: list[dict]) -> dict:
    forked = [r for r in runs if len(r.get("names", ())) == 3]
    apart = [r["bifurcation_above_parting_mm"] for r in forked]
    return {
        "cases": len(runs),
        "left_out": sum("left_out" in r for r in runs),
        "refused": sum("refused" in r for r in runs),
        "aorta_alone": sum(r.get("names") == ["aorta"] for r in runs),
        "with_bifurcation": len(forked),
        "right_is_right": sum(r["right_is_right"] is True for r in forked),
        "parting_found": sum(v is not None for v in apart),
        "bifurcation_within_10mm_of_parting": sum(v is not None and abs(v) <= 10 for v in apart),
        "least_points_in_lumen": min(
            (r["points_in_lumen"] for r in runs if "names" in r), default=None
        ),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    parser.add_argument("prepared", type=Path)
    parser.add_argument("results", type=Path)
    parser.add_argument("--set", choices=("design", "held_back"), required=True)
    parser.add_argument("--case", action="append", help="design only: run this case")
    args = parser.parse_args(argv)
    try:
        import numpy as np
        from PIL import Image

        if args.set != "design" and args.case:
            raise PrepareError("The held-back set is run whole")
        root = outside_repository(args.results)
        if (root / "summary.json").exists():
            raise PrepareError("The results directory already holds a finished run")
        try:
            record = json.loads((args.prepared / "set.json").read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise PrepareError("Not a prepared set") from error
        cases = [
            case
            for case in record["cases"]
            if set_of(case["subject"]) == args.set
            and (not args.case or case["subject"] in args.case)
        ]
        created_outside(root)
        code = code_digest(MODEL_FILE, Path(__file__))
        runs, tiles, sheets = [], [], 0

        def sheet():
            nonlocal sheets
            rows = [
                np.concatenate(
                    tiles[first : first + TILES_ACROSS]
                    + [np.zeros_like(tiles[0])]
                    * (TILES_ACROSS - len(tiles[first:][:TILES_ACROSS])),
                    axis=1,
                )
                for first in range(0, len(tiles), TILES_ACROSS)
            ]
            sheets += 1
            Image.fromarray(np.concatenate(rows, axis=0)).save(root / f"sheet-{sheets}.png")
            tiles.clear()

        jobs = ((str(args.prepared), case) for case in cases)
        with (
            multiprocessing.get_context("spawn").Pool(1, maxtasksperchild=1) as pool,
            (root / "runs.jsonl").open("w", encoding="utf-8") as lines,
        ):
            for run, drawn in pool.imap(_worker, jobs):
                if run["code"] != code:
                    raise PrepareError("The code changed during the run")
                runs.append(run)
                tiles.append(drawn)
                lines.write(json.dumps(run) + "\n")
                lines.flush()
                if len(tiles) == TILES_ACROSS * TILES_DOWN:
                    sheet()
            pool.close()
            pool.join()
        if tiles:
            sheet()
        summary = {
            "code": code,
            "peak_worker_mb": peak_mb(resource.RUSAGE_CHILDREN),
            **summarize(runs),
        }
        (root / "summary.json").write_text(json.dumps(summary, indent=1) + "\n", encoding="utf-8")
    except (PrepareError, FetchError, OSError, KeyError, zipfile.BadZipFile) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(json.dumps(summary, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
