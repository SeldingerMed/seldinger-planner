#!/usr/bin/env python3
"""Held-out known-pose virtual X-ray control on scans no Step D choice has read.

The protocol is frozen in docs/verification/step-d-heldout-virtual-xray-protocol.md
before any scan of the cohort is opened. The cohort is the first COHORT_LIMIT
scans of CTPelvic1K clinical set 6 (Zenodo 4588403, CC BY 4.0) in archive
order. For each scan this

  1. reads the scan from the archive into memory;
  2. runs the installed TotalSegmentator ``total`` 3 mm weights on it and names
     the aorta and both iliac arteries (``planner.aortoiliac_model``), which
     gives the vessel points the score reads;
  3. writes a known-pose control case (``lineup_control.control_case``): the
     resampled scan, one truth per pose and the virtual X-ray frames;
  4. writes ``vessels.json``: the named vessel points of step 2. The line-up
     reads bone in the scan and the frames only, never these points.

``web/src/research/virtualXrayControl.eval.ts`` then lines each pose up and
scores the vessel points. Run inside ``ram_only.py`` so nothing reaches any
disk but the RAM volume:

  python3 scripts/research/ram_only.py /Volumes/SeldingerRAM -- \\
      .runtime/ml-runtime/bin/python scripts/research/heldout_control.py \\
      --archive ".../zenodo-4588403-ctpelvic1k/CTPelvic1K_dataset6_data.tar.gz" \\
      --weights ~/.totalsegmentator/nnunet/results/<dataset>/<configuration> \\
      --out /Volumes/SeldingerRAM/control/heldout
"""

import argparse
import gzip
import hashlib
import json
import re
import sys
import tarfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

ARCHIVE_NAME = "CTPelvic1K_dataset6_data.tar.gz"
ARCHIVE_BYTES = 8811634327
COHORT_LIMIT = 10
POSES = 4
SEED = 20261124
LOWEST_MM = 360.0
_MEMBER = re.compile(r"(?:^|/)dataset6_CLINIC_([0-9]{4})_data\.nii\.gz$")


def cohort_members(fileobj, read_limit=COHORT_LIMIT):
    """(member name, bytes) of the first ``read_limit`` set-6 scans in archive
    order, streamed: nothing past the last of them is read."""
    if read_limit < 1:
        return
    with tarfile.open(fileobj=fileobj, mode="r|gz") as tar:
        taken = 0
        for member in tar:
            if not member.isfile() or not _MEMBER.search(member.name):
                continue
            yield member.name, tar.extractfile(member).read()
            taken += 1
            if taken >= read_limit:
                return


def case_from_scan(
    member, data, run, out_root, index, *, propose=None, poses=POSES, side=512
) -> dict:
    """One control case from one scan; returns its record. A scan whose
    vessels cannot be named writes nothing and is recorded as refused."""
    import nibabel as nib
    import numpy as np
    from aortoiliac_raw_cta import as_hounsfield
    from lineup_control import control_case, resample_lowest, vessel_points

    from planner.aortoiliac_inference import AORTOILIAC_LABEL_MAP

    if propose is None:
        from planner.aortoiliac_model import propose_aortoiliac_model as propose
    found_name = _MEMBER.search(member)
    if not found_name:
        raise ValueError(f"Not a cohort scan: {member}")
    case = "C" + found_name.group(1)
    out = {"case": case, "member": member, "member_sha256": hashlib.sha256(data).hexdigest()}
    image = nib.Nifti1Image.from_bytes(gzip.decompress(data) if data[:2] == b"\x1f\x8b" else data)
    volume, offset = as_hounsfield(np.asanyarray(image.dataobj))
    affine = image.affine.copy()
    out["ct"] = {
        "shape": [int(n) for n in volume.shape],
        "spacing_mm": [round(float(s), 4) for s in np.linalg.norm(affine[:3, :3], axis=0)],
        "hounsfield_offset": offset,
    }
    scan = nib.Nifti1Image(volume, affine)
    scan.header.set_xyzt_units("mm", "sec")
    started = time.perf_counter()
    labels = np.asanyarray(run(scan, fast=True).dataobj)
    out["inference_seconds"] = round(time.perf_counter() - started, 1)
    out["label_voxels"] = {
        name: int((labels == label).sum()) for label, name in AORTOILIAC_LABEL_MAP.items()
    }
    pred = np.isin(labels, tuple(AORTOILIAC_LABEL_MAP)).astype(np.uint8)
    del labels, scan
    where = np.argwhere(pred)
    if not len(where):
        return {**out, "refused": "No aorta or iliac voxel inferred"}
    low = np.maximum(0, where.min(axis=0) - 2)
    high = np.minimum(pred.shape, where.max(axis=0) + 3)
    pred = np.ascontiguousarray(pred[low[0] : high[0], low[1] : high[1], low[2] : high[2]])
    pred_affine = affine.copy()
    pred_affine[:3, 3] = affine[:3, :3] @ low + affine[:3, 3]
    try:
        model = propose(pred, pred_affine)
    except ValueError as refusal:
        return {**out, "refused": str(refusal)}
    out["model"] = {
        "method": model.get("method"),
        "names": [b["name"] for b in model["branches"]],
        "bifurcation_ras": model.get("bifurcation_ras"),
    }
    grid, grid_affine = resample_lowest(volume, affine, lowest_mm=LOWEST_MM)
    folder = Path(out_root) / case
    out["poses"] = control_case(grid, grid_affine, folder, poses, SEED + index, side)
    groups = {name: np.asarray(p, dtype=float).tolist() for name, p in vessel_points(model).items()}
    (folder / "vessels.json").write_text(json.dumps({"case": case, "groups": groups}))
    return out


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--threads", type=int, default=8)
    args = parser.parse_args(argv)
    if args.archive.name != ARCHIVE_NAME:
        parser.error(f"The protocol reads {ARCHIVE_NAME} only")
    if args.archive.stat().st_size != ARCHIVE_BYTES:
        parser.error("The archive is not the recorded download")
    from planner.aortoiliac_nnunet import installed_weights_runner

    run = installed_weights_runner(args.weights, threads=args.threads)
    print(
        json.dumps(
            {
                "backend": run.backend,
                "protocol": {"limit": COHORT_LIMIT, "poses": POSES, "seed": SEED},
            }
        ),
        flush=True,
    )
    args.out.mkdir(parents=True, exist_ok=True)
    with args.archive.open("rb") as raw:
        for index, (member, data) in enumerate(cohort_members(raw)):
            started = time.perf_counter()
            try:
                record = case_from_scan(member, data, run, args.out, index)
            except (ValueError, MemoryError, RuntimeError) as fault:
                record = {"member": member, "failed": f"{type(fault).__name__}: {fault}"}
            record["seconds"] = round(time.perf_counter() - started, 1)
            print(json.dumps(record, allow_nan=False, default=float), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
