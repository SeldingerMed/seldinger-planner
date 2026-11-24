#!/usr/bin/env python3
"""Measure the aorta and iliac model against labelled CT.

For each case of the prepared set (see `prepare_aortoiliac_sets.py`) the three labels
are joined into one vessel mask, as the planner would receive it, and
`planner.aortoiliac_model.propose_aortoiliac_model` is run on that mask. The
labels then say, without reference to the model, what it should have found:

  reference   read from the labels alone: whether each iliac label touches
              the aorta label and how far it runs from there, the point
              midway between the two places of contact (the bifurcation),
              how far the aorta label runs from that point, and the lumen's
              equal-area radius in one axial slice of the aorta 30 mm above
              it;
  expected    `both` when each iliac label touches the aorta and all three
              vessels run at least `BOTH_SPAN_MM` from the bifurcation,
              `none` when no iliac voxel is labelled, `partial` otherwise. A
              `partial` case is counted and described, not scored for naming.

Results (one record a case, and the summary) go to a directory outside the
repository. Needs numpy, scipy and nibabel (the planner's physics runtime).
"""

import argparse
import json
import multiprocessing
import resource
import statistics
import sys
import time
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from fetch_ljubljana import FetchError, created_outside, outside_repository
from prepare_aortoiliac_sets import LABELS
from prepare_ljubljana import PrepareError, _sha256

BOTH_SPAN_MM = 60.0
STATION_ABOVE_MM = 30.0
SKIP_NEAR_FORK_MM = 10.0
TUBE_MARGIN_MM = 3.0
SETS = {"design": ("train",), "held_back": ("val", "test")}


def reference(labels: dict, affine) -> dict:
    """What the labels alone say the model should find."""
    import numpy as np
    from scipy import ndimage

    aorta = labels["aorta"] > 0
    grown = ndimage.binary_dilation(aorta, structure=np.ones((3, 3, 3), dtype=bool))
    voxel_mm3 = float(abs(np.linalg.det(affine[:3, :3])))
    out: dict = {"aorta_mm3": float(aorta.sum()) * voxel_mm3, "sides": {}}
    for side in ("left", "right"):
        label = labels[f"iliac_artery_{side}"] > 0
        held = np.argwhere(label)
        record: dict = {"mm3": float(len(held)) * voxel_mm3, "contact_ras": None, "span_mm": 0.0}
        touching = np.argwhere(label & grown)
        if len(touching):
            contact = affine[:3, :3] @ touching.mean(axis=0) + affine[:3, 3]
            points = held @ affine[:3, :3].T + affine[:3, 3]
            record["contact_ras"] = [float(v) for v in contact]
            record["span_mm"] = float(np.linalg.norm(points - contact, axis=1).max())
        out["sides"][side] = record
    left, right = out["sides"]["left"], out["sides"]["right"]
    out["bifurcation_ras"] = out["station"] = None
    out["aorta_span_mm"] = 0.0
    if left["contact_ras"] and right["contact_ras"]:
        fork = (np.asarray(left["contact_ras"]) + np.asarray(right["contact_ras"])) / 2
        out["bifurcation_ras"] = [float(v) for v in fork]
        held = np.argwhere(aorta) @ affine[:3, :3].T + affine[:3, 3]
        out["aorta_span_mm"] = float(np.linalg.norm(held - fork, axis=1).max())
    spans = [left["span_mm"], right["span_mm"], out["aorta_span_mm"]]
    if all(span >= BOTH_SPAN_MM for span in spans):
        out["expected"] = "both"
    elif left["mm3"] == 0 and right["mm3"] == 0:
        out["expected"] = "none"
    else:
        out["expected"] = "partial"
    if out["bifurcation_ras"] is not None:
        # One axial slice of the aorta label, a fixed height above the fork.
        # Axial is the index axis that runs most nearly head to foot.
        axis = int(np.argmax(np.abs(affine[2, :3])))
        step = float(affine[2, axis])
        at = np.linalg.solve(affine[:3, :3], fork - affine[:3, 3])[axis] + STATION_ABOVE_MM / step
        at = round(float(at))
        if 0 <= at < aorta.shape[axis]:
            area = float(np.take(aorta, at, axis=axis).sum()) * voxel_mm3 / abs(step)
            if area > 0:
                out["station"] = {
                    "height_ras": float(fork[2] + STATION_ABOVE_MM),
                    "equal_area_radius_mm": float(np.sqrt(area / np.pi)),
                }
    return out


def score(model: dict, ref: dict, labels: dict, affine) -> dict:
    """The model against the labels."""
    import numpy as np
    from scipy.spatial import cKDTree

    inverse = np.linalg.inv(affine)
    shape = np.asarray(labels["aorta"].shape)

    def held_by(points, label):
        index = np.rint(points @ inverse[:3, :3].T + inverse[:3, 3]).astype(int)
        inside = ((index >= 0) & (index < shape)).all(axis=1)
        found = np.zeros(len(points), dtype=bool)
        found[inside] = label[tuple(index[inside].T)] > 0
        return found

    lines = {b["name"]: np.asarray(b["path_ras"]) for b in model["branches"]}
    radii = {b["name"]: np.asarray(b["radius_mm"]) for b in model["branches"]}
    every = np.concatenate(list(lines.values()))
    every_radius = np.concatenate(list(radii.values()))
    union = np.zeros(labels["aorta"].shape, dtype=bool)
    for label in labels.values():
        union |= label > 0
    out: dict = {
        "names": list(lines),
        "points_in_lumen": float(held_by(every, union).mean()),
        "aorta_points_in_aorta_label": float(held_by(lines["aorta"], labels["aorta"]).mean()),
        "aorta_length_mm": float(model["branches"][0]["length_mm"]),
        "bifurcation_off_mm": None,
        "sides": {},
        "station": None,
    }
    # The share of each label inside the model's tubes: within a line's
    # radius, and a margin, of that line.
    tree = cKDTree(every)
    out["label_in_tubes"] = {}
    for name, label in labels.items():
        held = np.argwhere(label > 0)
        if len(held):
            away, nearest = tree.query(held @ affine[:3, :3].T + affine[:3, 3])
            out["label_in_tubes"][name] = float(
                (away <= every_radius[nearest] + TUBE_MARGIN_MM).mean()
            )
    if model["bifurcation_ras"] is not None and ref["bifurcation_ras"] is not None:
        out["bifurcation_off_mm"] = float(
            np.linalg.norm(np.asarray(model["bifurcation_ras"]) - ref["bifurcation_ras"])
        )
    for side in ("left", "right"):
        line = lines.get(f"{side}_iliac")
        if line is None:
            continue
        along = np.r_[0.0, np.cumsum(np.linalg.norm(np.diff(line, axis=0), axis=1))]
        beyond = line[along >= SKIP_NEAR_FORK_MM]
        other = "right" if side == "left" else "left"
        record = {
            "length_mm": float(along[-1]),
            "in_own_label": float(held_by(beyond, labels[f"iliac_artery_{side}"]).mean()),
            "in_other_label": float(held_by(beyond, labels[f"iliac_artery_{other}"]).mean()),
            "short_of_label_end_mm": None,
        }
        contact = ref["sides"][side]["contact_ras"]
        if contact:
            reach = float(np.linalg.norm(line - np.asarray(contact), axis=1).max())
            record["short_of_label_end_mm"] = ref["sides"][side]["span_mm"] - reach
        out["sides"][side] = record
    if ref["station"]:
        aorta = lines["aorta"]
        nearest = int(np.argmin(np.abs(aorta[:, 2] - ref["station"]["height_ras"])))
        if abs(aorta[nearest, 2] - ref["station"]["height_ras"]) <= 3.0:
            out["station"] = {
                "model_radius_mm": float(radii["aorta"][nearest]),
                "equal_area_radius_mm": ref["station"]["equal_area_radius_mm"],
            }
    return out


def as_expected(expected: str, scored: dict | None) -> bool | None:
    """Whether the model named what the labels say is there. A `partial`
    case has no expected answer."""
    if expected == "partial":
        return None
    if scored is None:
        return False
    if expected == "none":
        return scored["names"] == ["aorta"]
    return scored["names"] == ["aorta", "right_iliac", "left_iliac"] and all(
        scored["sides"][side]["in_own_label"] > scored["sides"][side]["in_other_label"]
        for side in ("left", "right")
    )


class CaseError(PrepareError):
    """One case cannot be read; the run sets it aside and goes on."""


MODEL_FILE = Path(__file__).resolve().parents[2] / "planner" / "aortoiliac_model.py"


def code_digest(*files: Path) -> str:
    """One digest of the files a run is made of, as they are on disk now."""
    return _sha256(b"".join(Path(file).read_bytes() for file in files))


def peak_mb(who: int) -> float:
    peak = resource.getrusage(who).ru_maxrss
    return peak / (1 << 20 if sys.platform == "darwin" else 1 << 10)


GRID_AGREES_VOXELS = 0.25
BOX_MARGIN = 2
SLAB_VOXELS = 4_000_000


def load_case(lifted, case: dict) -> tuple[dict, object]:
    """One case's three labels, and their grid, from the prepared set.

    The labels come back as the box of the scan that holds them, with a
    margin, and the affine of that box: a scan is tens of millions of voxels
    and the arteries a few thousandths of it. Each label is read a few
    slices at a time. The three files must lie on one grid; their
    stored headers may differ by a rounding or a small turn, so the grids
    agree when no corner of the scan moves by more than `GRID_AGREES_VOXELS`
    of a voxel. A case whose grids differ raises `CaseError`.
    """
    import gzip
    import io

    import nibabel
    import numpy as np

    kept, shape, affine = {}, None, None
    for name in LABELS:
        data = lifted.read(f"{case['subject']}/{name}.nii.gz")
        if _sha256(data) != case["sha256"][f"{name}.nii.gz"]:
            raise PrepareError(f"Not the prepared file: {case['subject']}/{name}.nii.gz")
        stream = gzip.GzipFile(fileobj=io.BytesIO(data))
        header = nibabel.Nifti1Header.from_fileobj(stream)
        grid, dtype = header.get_data_shape(), header.get_data_dtype()
        if len(grid) != 3 or header.get_slope_inter() not in ((None, None), (1.0, 0.0)):
            raise PrepareError(f"Not a plain three-dimensional label: {case['subject']}/{name}")
        if shape is None:
            shape, affine = grid, np.asarray(header.get_best_affine(), dtype=float)
            corners = np.asarray(
                [
                    [i, j, k, 1.0]
                    for i in (0, shape[0])
                    for j in (0, shape[1])
                    for k in (0, shape[2])
                ]
            )
        elif grid != shape or np.abs(
            corners @ (np.asarray(header.get_best_affine(), dtype=float) - affine).T
        ).max() > GRID_AGREES_VOXELS * min(header.get_zooms()[:3]):
            raise CaseError(f"Labels on different grids: {case['subject']}")
        # A few slices at a time, in the order the file stores them: only
        # the labelled voxels are kept.
        stream.seek(header.get_data_offset())
        slab = max(1, SLAB_VOXELS // (shape[0] * shape[1]))
        found = [np.zeros((0, 3), dtype=np.int32)]
        for first in range(0, shape[2], slab):
            slices = min(slab, shape[2] - first)
            raw = stream.read(shape[0] * shape[1] * slices * dtype.itemsize)
            part = np.frombuffer(raw, dtype=dtype)
            if part.size != shape[0] * shape[1] * slices:
                raise PrepareError(f"Label file is short: {case['subject']}/{name}")
            part = np.argwhere(part.reshape((shape[0], shape[1], slices), order="F"))
            part[:, 2] += first
            found.append(part.astype(np.int32))
        found = np.concatenate(found)
        if len(found):
            kept[name] = found
    low, high = np.zeros(3, dtype=int), np.zeros(3, dtype=int)
    if kept:
        every = np.concatenate(list(kept.values()))
        low = np.maximum(0, every.min(axis=0) - BOX_MARGIN)
        high = np.minimum(shape, every.max(axis=0) + 1 + BOX_MARGIN)
    labels = {}
    for name in LABELS:
        labels[name] = np.zeros(tuple(high - low), dtype=np.uint8)
        if name in kept:
            labels[name][tuple((kept[name] - low).T)] = 1
    boxed_affine = affine.copy()
    boxed_affine[:3, 3] = affine[:3, :3] @ np.asarray(low, dtype=float) + affine[:3, 3]
    return labels, boxed_affine


def run_case(lifted, case: dict) -> dict:
    import numpy as np

    from planner.aortoiliac_model import propose_aortoiliac_model

    out = {"subject": case["subject"], "meta": case["meta"]}
    try:
        labels, affine = load_case(lifted, case)
    except CaseError as fault:
        return {**out, "left_out": str(fault)}
    union = np.zeros(labels["aorta"].shape, dtype=np.uint8)
    for label in labels.values():
        union |= (label > 0).astype(np.uint8)
    if not labels["aorta"].any():
        return {**out, "expected": "no_aorta"}
    ref = reference(labels, affine)
    out.update(expected=ref["expected"], reference=ref)
    started = time.perf_counter()
    try:
        model = propose_aortoiliac_model(union, affine)
    except ValueError as refusal:
        return {**out, "refused": str(refusal), "as_expected": as_expected(ref["expected"], None)}
    out["seconds"] = time.perf_counter() - started
    out["scored"] = score(model, ref, labels, affine)
    out["method"] = model["method"]
    out["as_expected"] = as_expected(ref["expected"], out["scored"])
    return out


_OPEN: dict = {}


def _worker(job: tuple[str, dict]) -> dict:
    prepared, case = job
    if prepared not in _OPEN:
        _OPEN[prepared] = zipfile.ZipFile(Path(prepared) / "labels.zip")
    run = run_case(_OPEN[prepared], case)
    # Every case is scored by a process of its own, which reads the code as
    # it is on disk at that moment: the run records which code that was.
    run["code"] = code_digest(MODEL_FILE, Path(__file__))
    run["peak_mb"] = peak_mb(resource.RUSAGE_SELF)
    return run


def summarize(runs: list[dict]) -> dict:
    def median(values):
        values = [v for v in values if v is not None]
        return statistics.median(values) if values else None

    def worst(values):
        values = [v for v in values if v is not None]
        return max(values) if values else None

    summary: dict = {
        "cases": len(runs),
        "left_out": sum("left_out" in r for r in runs),
        "no_aorta_label": 0,
    }
    for expected in ("both", "none", "partial"):
        rows = [r for r in runs if r.get("expected") == expected]
        scored = [r["scored"] for r in rows if "scored" in r]
        block: dict = {
            "cases": len(rows),
            "refused": sum("refused" in r for r in rows),
            "median_seconds": median(r.get("seconds") for r in rows),
            "median_points_in_lumen": median(s["points_in_lumen"] for s in scored),
            "least_points_in_lumen": min((s["points_in_lumen"] for s in scored), default=None),
            "median_aorta_label_in_tubes": median(s["label_in_tubes"].get("aorta") for s in scored),
        }
        if expected == "partial":
            block["with_bifurcation"] = sum(len(s["names"]) == 3 for s in scored)
        else:
            block["as_expected"] = sum(r["as_expected"] is True for r in rows)
        if expected == "both":
            named = [s for s in scored if len(s["names"]) == 3]
            off = [s["bifurcation_off_mm"] for s in named]
            sides = [s["sides"][side] for s in named for side in ("left", "right")]
            station = [s["station"] for s in named if s["station"]]
            block.update(
                median_bifurcation_off_mm=median(off),
                worst_bifurcation_off_mm=worst(off),
                bifurcation_within_10mm=sum(v is not None and v <= 10 for v in off),
                median_iliac_points_in_own_label=median(s["in_own_label"] for s in sides),
                median_iliac_short_of_label_end_mm=median(
                    s["short_of_label_end_mm"] for s in sides
                ),
                iliac_within_20mm_of_label_end=sum(
                    s["short_of_label_end_mm"] is not None and s["short_of_label_end_mm"] <= 20
                    for s in sides
                ),
                iliac_lines=len(sides),
                median_iliac_label_in_tubes=median(
                    s["label_in_tubes"].get(f"iliac_artery_{side}")
                    for s in named
                    for side in ("left", "right")
                ),
                station_cases=len(station),
                median_station_model_minus_equal_area_mm=median(
                    s["model_radius_mm"] - s["equal_area_radius_mm"] for s in station
                ),
            )
        summary[expected] = block
    summary["no_aorta_label"] = sum(r.get("expected") == "no_aorta" for r in runs)
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    parser.add_argument("prepared", type=Path)
    parser.add_argument("results", type=Path)
    parser.add_argument("--set", choices=sorted(SETS), required=True)
    parser.add_argument("--case", action="append", help="design only: run this case")
    parser.add_argument("--first", type=int, help="design only: run the first N cases")
    args = parser.parse_args(argv)
    try:
        if args.set != "design" and (args.case or args.first):
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
            if case["meta"]["split"] in SETS[args.set]
            and (not args.case or case["subject"] in args.case)
        ]
        cases = cases[: args.first] if args.first else cases
        created_outside(root)
        code = code_digest(MODEL_FILE, Path(__file__))
        runs = []
        # Each case runs in a worker of its own: the memory a large case
        # leaves behind is not handed back while its process lives.
        jobs = ((str(args.prepared), case) for case in cases)
        with (
            multiprocessing.get_context("spawn").Pool(1, maxtasksperchild=1) as pool,
            (root / "runs.jsonl").open("w", encoding="utf-8") as lines,
        ):
            for run in pool.imap(_worker, jobs):
                if run["code"] != code:
                    raise PrepareError("The code changed during the run")
                runs.append(run)
                lines.write(json.dumps(run) + "\n")
                lines.flush()
            pool.close()
            pool.join()
        summary = {
            "set": args.set,
            "code": code,
            "peak_worker_mb": peak_mb(resource.RUSAGE_CHILDREN),
            "summary": summarize(runs),
        }
        (root / "summary.json").write_text(json.dumps(summary, indent=1) + "\n", encoding="utf-8")
    except (PrepareError, FetchError, OSError, KeyError, zipfile.BadZipFile) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(json.dumps(summary["summary"], indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
