#!/usr/bin/env python3
"""Known-pose virtual X-ray control for the abdominal line-up, end to end.

Three steps around the studio itself:

  prepare  an AVT design CT, read raw from the fetched archive, resampled to
           a 2 mm grid and cut to its lowest part so it fits an installed
           image source (8,000,000 voxels, 16 MiB), installed with its
           manifest under ROOT/installed-sources/SOURCE_ID/ (ml runtime);
  frames   virtual X-rays of that installed image, the scan first moved by a
           known rigid matrix, written as calibrated DICOM XA with a frame
           admission request beside them (ingest runtime; see
           ``virtual_xray.py``);
  score    the line-up the studio saved, against that matrix, at the
           vessels: every point of the saved aorta and iliac model, which
           the bone line-up never looks at, projected through the saved pose
           and through the known pose on each saved frame (any runtime).

Nothing here reads the AVT annotators' masks. Run every step inside
``ram_only.py`` so all writes stay on the RAM disk.
"""

import argparse
import gzip
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

GRID_MM = 2.0
MAX_VOXELS = 8_000_000
MAX_BYTES = 16 * 1024 * 1024
LANDMARK_STEP_MM = 5.0


def resample_lowest(volume, affine, grid_mm=GRID_MM, lowest_mm=360.0):
    """The scan on an axis-aligned ``grid_mm`` grid (linear interpolation),
    cut to its lowest ``lowest_mm`` along RAS z. Returns (int16, affine)."""
    import numpy as np
    from scipy import ndimage

    affine = np.asarray(affine, dtype=float)
    if not np.allclose(affine[:3, :3], np.diag(np.diag(affine[:3, :3]))):
        raise ValueError("Only axis-aligned scans are resampled here")
    zooms = np.abs(np.diag(affine[:3, :3]))
    shape = np.maximum(1, np.round(np.array(volume.shape) * zooms / grid_mm)).astype(int)
    factors = shape / np.array(volume.shape)
    resampled = ndimage.zoom(
        volume.astype(np.float32), factors, order=1, grid_mode=True, mode="nearest"
    )
    out_affine = affine.copy()
    scale = np.array(volume.shape) / shape
    out_affine[:3, :3] = affine[:3, :3] * scale
    # Voxel centres: the new grid spans the same extent.
    out_affine[:3, 3] = affine[:3, :3] @ ((scale - 1) / 2) + affine[:3, 3]
    keep = round(lowest_mm / grid_mm)
    z_up = out_affine[2, 2] > 0
    if keep < resampled.shape[2]:
        if z_up:
            resampled = resampled[:, :, :keep]
        else:
            start = resampled.shape[2] - keep
            resampled = resampled[:, :, start:]
            out_affine[:3, 3] = out_affine[:3, :3] @ [0, 0, start] + out_affine[:3, 3]
    return np.rint(resampled).astype(np.int16), out_affine


def nifti_bytes(volume, affine) -> bytes:
    import nibabel as nib

    image = nib.Nifti1Image(volume, affine)
    image.header.set_xyzt_units("mm", "sec")
    image.set_sform(affine, code=1)
    image.set_qform(None, code=0)
    return gzip.compress(image.to_bytes(), compresslevel=9, mtime=0)


def install_source(root: Path, source_id: str, volume, affine, provenance: dict) -> dict:
    import numpy as np

    data = nifti_bytes(volume, affine)
    if volume.size > MAX_VOXELS or len(data) > MAX_BYTES:
        raise ValueError("The prepared image exceeds the installed-source bounds")
    folder = root / "installed-sources" / source_id
    folder.mkdir(parents=True, exist_ok=False)
    (folder / "context-cta.nii.gz").write_bytes(data)
    manifest = {
        "clinical_validation": False,
        "image": {
            "filename": "context-cta.nii.gz",
            "sha256": hashlib.sha256(data).hexdigest(),
            "bytes": len(data),
            "dtype": "int16",
            "shape_xyz": [int(n) for n in volume.shape],
            "spatial_units": "mm",
            "affine_ras": np.asarray(affine, dtype=float).tolist(),
        },
        "source_provenance": provenance,
    }
    (folder / "manifest.json").write_text(json.dumps(manifest, sort_keys=True))
    return manifest


def resample_path(path, step=LANDMARK_STEP_MM):
    import numpy as np

    path = np.asarray(path, dtype=float)
    seg = np.linalg.norm(np.diff(path, axis=0), axis=1)
    s = np.r_[0.0, np.cumsum(seg)]
    at = np.unique(np.r_[np.arange(0.0, s[-1], step), s[-1]])
    return np.stack([np.interp(at, s, path[:, k]) for k in range(3)], axis=1)


def vessel_points(model) -> dict:
    """Named points of the saved model: every branch every 5 mm, plus its
    ends and the bifurcation."""
    import numpy as np

    points = {}
    for branch in model["branches"]:
        path = np.asarray(branch["path_ras"], dtype=float)
        points[branch["name"]] = resample_path(path)
        points[branch["name"] + "_end"] = path[-1:]
    if model.get("bifurcation_ras") is not None:
        points["bifurcation"] = np.asarray([model["bifurcation_ras"]], dtype=float)
    return points


def pixels(view, isocenter, matrix, points, columns, rows):
    import numpy as np

    from planner.carm_geometry import camera, project

    cam = camera(view, [float(c) for c in isocenter])
    m = np.asarray(matrix, dtype=float)
    moved = points @ m[:3, :3].T + m[:3, 3]
    out = []
    for p in moved:
        x, y, _ = project(cam, [float(c) for c in p])
        out.append(
            [
                (x / view["detector_width_mm"] + 0.5) * columns,
                (0.5 - y / view["detector_height_mm"]) * rows,
            ]
        )
    return np.asarray(out)


def score(saved: dict, model: dict, truth: dict) -> dict:
    """The saved line-up against the known pose, at the vessels.

    ``saved``: the ``inputs`` of the saved line-up record. ``truth``: the
    frame spec (``isocenter``, ``volume_to_carm_ras``, per plane ``view``,
    ``columns`` and ``rows``)."""
    import numpy as np

    points = vessel_points(model)
    every = np.concatenate([v for k, v in points.items() if not k.endswith("_end")])
    planes = {p["plane"]: p for p in truth["planes"]}
    result = {"planes": {}, "three_d": {}}
    iso_saved = np.asarray(saved["isocenter"], dtype=float)
    iso_true = np.asarray(truth["isocenter"], dtype=float)
    m_saved = np.asarray(saved["volume_to_carm_ras"], dtype=float)
    m_true = np.asarray(truth["volume_to_carm_ras"], dtype=float)
    for entry in saved["planes"]:
        plane = planes[entry["plane"]]
        view, columns, rows = plane["view"], plane["columns"], plane["rows"]
        mm_per_px = (
            (view["detector_width_mm"] / columns)
            * view["source_isocenter_mm"]
            / view["source_detector_mm"]
        )
        named = {}
        for name, pts in [("all_vessel_points", every)] + sorted(points.items()):
            a = pixels(entry["view"], iso_saved, m_saved, pts, columns, rows)
            b = pixels(view, iso_true, m_true, pts, columns, rows)
            d = np.linalg.norm(a - b, axis=1)
            named[name] = {
                "n": len(d),
                "mean_px": float(d.mean()),
                "max_px": float(d.max()),
                "mean_mm_at_isocenter": float(d.mean() * mm_per_px),
                "max_mm_at_isocenter": float(d.max() * mm_per_px),
            }
        result["planes"][entry["plane"]] = named
        # The start (the scan as it lies) on the same frame, for scale.
        a = pixels(entry["view"], iso_saved, np.eye(4), every, columns, rows)
        b = pixels(view, iso_true, m_true, every, columns, rows)
        d = np.linalg.norm(a - b, axis=1)
        named["start_all_vessel_points"] = {
            "mean_px": float(d.mean()),
            "mean_mm_at_isocenter": float(d.mean() * mm_per_px),
        }
    # 3D: each point relative to its own isocenter.
    a = every @ m_saved[:3, :3].T + m_saved[:3, 3] - iso_saved
    b = every @ m_true[:3, :3].T + m_true[:3, 3] - iso_true
    first = truth["planes"][0]["view"]
    from planner.carm_geometry import view_frame

    _, _, beam = view_frame(first["primary_deg"], first["secondary_deg"])
    diff = a - b
    along = diff @ np.asarray(beam)
    across = np.linalg.norm(diff - along[:, None] * np.asarray(beam), axis=1)
    result["three_d"] = {
        "mean_mm": float(np.linalg.norm(diff, axis=1).mean()),
        "max_mm": float(np.linalg.norm(diff, axis=1).max()),
        "mean_across_first_beam_mm": float(across.mean()),
        "mean_along_first_beam_mm": float(np.abs(along).mean()),
    }
    return result


def disturbance(rng, isocenter, across_mm=15.0, along_mm=30.0, turn_deg=8.0):
    """A known rigid move of the scan about ``isocenter``: up to
    ``across_mm`` across an AP beam (RAS x and z, uniform in a disc),
    ``along_mm`` along it (RAS y) and ``turn_deg`` about each axis."""
    import numpy as np

    radius = across_mm * np.sqrt(rng.uniform())
    angle = rng.uniform(0, 2 * np.pi)
    shift = np.array(
        [radius * np.cos(angle), rng.uniform(-along_mm, along_mm), radius * np.sin(angle)]
    )
    a, b, c = np.radians(rng.uniform(-turn_deg, turn_deg, size=3))
    rx = np.array([[1, 0, 0], [0, np.cos(a), -np.sin(a)], [0, np.sin(a), np.cos(a)]])
    ry = np.array([[np.cos(b), 0, np.sin(b)], [0, 1, 0], [-np.sin(b), 0, np.cos(b)]])
    rz = np.array([[np.cos(c), -np.sin(c), 0], [np.sin(c), np.cos(c), 0], [0, 0, 1]])
    r = rz @ ry @ rx
    iso = np.asarray(isocenter, dtype=float)
    m = np.eye(4)
    m[:3, :3] = r
    m[:3, 3] = iso - r @ iso + shift
    return m


CONTROL_VIEWS = {
    "a": {"primary_deg": 0.0, "secondary_deg": 0.0},
    "b": {"primary_deg": 90.0, "secondary_deg": 0.0},
}
CONTROL_DETECTOR = {
    "source_detector_mm": 1200.0,
    "source_isocenter_mm": 800.0,
    "detector_width_mm": 360.0,
    "detector_height_mm": 360.0,
}


def control_case(volume, affine, out: Path, poses: int, seed: int, side: int = 512) -> list:
    """Known-pose frames of one prepared scan for the offline evaluation
    ``web/src/research/virtualXrayControl.eval.ts``: the scan, then per pose
    its truth and one admitted-form 8-bit frame per view. Pose 0 is the scan
    as it lies."""
    import numpy as np
    from virtual_xray import admitted_gray8, detector_pixels, render

    out.mkdir(parents=True, exist_ok=False)
    (out / "volume.i16").write_bytes(np.asarray(volume, dtype="<i2").tobytes(order="F"))
    shape = np.array(volume.shape)
    isocenter = (np.asarray(affine) @ np.r_[(shape - 1) / 2.0, 1.0])[:3]
    (out / "volume.json").write_text(
        json.dumps({"shape": [int(n) for n in shape], "affine": np.asarray(affine).tolist()})
    )
    rng = np.random.default_rng(seed)
    records = []
    for pose in range(poses):
        m = np.eye(4) if pose == 0 else disturbance(rng, isocenter)
        name = f"pose{pose}"
        truth = {"isocenter": isocenter.tolist(), "volume_to_carm_ras": m.tolist()}
        folder = out / "frames" / name
        folder.mkdir(parents=True)
        planes = []
        for plane, angles in CONTROL_VIEWS.items():
            view = {**angles, **CONTROL_DETECTOR}
            frame = render(volume, affine, view, isocenter, m, side, side, 1.0)
            (folder / f"{plane}-000000.gray").write_bytes(
                admitted_gray8(detector_pixels(frame)).tobytes()
            )
            planes.append({"plane": plane, "columns": side, "rows": side, "geometry": view})
        (folder / "frames.json").write_text(json.dumps({"planes": planes}))
        (out / f"truth-{name}.json").write_text(json.dumps(truth))
        records.append({"pose": name, **truth})
    return records


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="step", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("--avt", type=Path, required=True)
    p.add_argument("--case", required=True)
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--source-id", required=True)
    p.add_argument("--lowest-mm", type=float, default=360.0)
    f = sub.add_parser("frames")
    f.add_argument("--root", type=Path, required=True)
    f.add_argument("--source-id", required=True)
    f.add_argument("--truth", type=Path, required=True)
    f.add_argument("--out", type=Path, required=True)
    s = sub.add_parser("score")
    s.add_argument("--lineup", type=Path, required=True)
    s.add_argument("--model", type=Path, required=True)
    s.add_argument("--truth", type=Path, required=True)
    c = sub.add_parser("controlset")
    c.add_argument("--avt", type=Path, required=True)
    c.add_argument("--cases", required=True, help="comma-separated design cases")
    c.add_argument("--out", type=Path, required=True)
    c.add_argument("--poses", type=int, default=4)
    c.add_argument("--seed", type=int, required=True)
    c.add_argument("--lowest-mm", type=float, default=360.0)
    args = parser.parse_args(argv)

    if args.step == "controlset":
        import zipfile

        from aortoiliac_raw_cta import ARCHIVES, as_hounsfield, is_design, read_ct_nrrd

        # The set may grow a case at a time; each case folder is new.
        args.out.mkdir(parents=True, exist_ok=True)
        for k, case in enumerate(args.cases.split(",")):
            if not is_design(case):
                parser.error("Only design cases are used")
            archive = zipfile.ZipFile(args.avt / f"{ARCHIVES[case[0]]}.zip")
            members = [
                n
                for n in archive.namelist()
                if n.endswith(f"/{case}.nrrd") and n.split("/")[1].split(" ")[0] == case
            ]
            if len(members) != 1:
                parser.error(f"No single scan for {case}")
            data = archive.read(members[0])
            volume, affine, _ = read_ct_nrrd(data)
            volume, _ = as_hounsfield(volume)
            volume, affine = resample_lowest(volume, affine, lowest_mm=args.lowest_mm)
            records = control_case(volume, affine, args.out / case, args.poses, args.seed + k)
            print(
                json.dumps(
                    {
                        "case": case,
                        "member": members[0],
                        "member_sha256": hashlib.sha256(data).hexdigest(),
                        "shape": list(volume.shape),
                        "poses": records,
                    }
                ),
                flush=True,
            )
        return 0

    if args.step == "prepare":
        import zipfile

        from aortoiliac_raw_cta import ARCHIVES, as_hounsfield, is_design, read_ct_nrrd

        if not is_design(args.case):
            parser.error("Only design cases are used")
        archive = zipfile.ZipFile(args.avt / f"{ARCHIVES[args.case[0]]}.zip")
        member = f"{ARCHIVES[args.case[0]]}/{args.case}/{args.case}.nrrd"
        data = archive.read(member)
        volume, affine, _ = read_ct_nrrd(data)
        volume, offset = as_hounsfield(volume)
        out, out_affine = resample_lowest(volume, affine, lowest_mm=args.lowest_mm)
        manifest = install_source(
            args.root,
            args.source_id,
            out,
            out_affine,
            {
                "origin": "AVT aortic vessel tree, figshare 14806362, CC BY 4.0",
                "member": member,
                "member_sha256": hashlib.sha256(data).hexdigest(),
                "hounsfield_offset": offset,
                "preparation": f"linear to {GRID_MM} mm, lowest {args.lowest_mm} mm",
                "purpose": "engineering control, design case",
            },
        )
        print(json.dumps(manifest))
    elif args.step == "frames":
        import nibabel as nib
        import numpy as np
        from virtual_xray import render, xa_dicom

        folder = args.root / "installed-sources" / args.source_id
        manifest = json.loads((folder / "manifest.json").read_text())
        raw = (folder / manifest["image"]["filename"]).read_bytes()
        if hashlib.sha256(raw).hexdigest() != manifest["image"]["sha256"]:
            raise SystemExit("Installed image changed")
        image = nib.Nifti1Image.from_bytes(gzip.decompress(raw))
        volume = np.asanyarray(image.dataobj)
        truth = json.loads(args.truth.read_text())
        args.out.mkdir(parents=True, exist_ok=False)
        planes = []
        for plane in truth["planes"]:
            frame = render(
                volume,
                image.affine,
                plane["view"],
                truth["isocenter"],
                truth["volume_to_carm_ras"],
                plane["columns"],
                plane["rows"],
                truth.get("step_mm", 1.0),
            )
            seed = manifest["image"]["sha256"] + json.dumps(truth, sort_keys=True)
            data = xa_dicom(frame, plane["view"], seed=seed + plane["plane"])
            name = f"plane-{plane['plane']}.dcm"
            (args.out / name).write_bytes(data)
            planes.append(
                {
                    "plane": plane["plane"],
                    "kind": "dicom",
                    "path": name,
                    "frame_indexes": [0],
                    "crop": None,
                    "redactions": [],
                    "identifiers_removed": False,
                }
            )
        request = {"scope": "public", "planes": planes}
        (args.out / "request.json").write_text(json.dumps(request, indent=1))
        print(json.dumps({"image_sha256": manifest["image"]["sha256"], "request": request}))
    else:
        saved = json.loads(args.lineup.read_text())
        model = json.loads(args.model.read_text())
        truth = json.loads(args.truth.read_text())
        print(json.dumps(score(saved, model["proposal"], truth), indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
