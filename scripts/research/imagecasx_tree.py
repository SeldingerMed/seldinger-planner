"""Read one ImageCAS-X case's named coronary centerlines to standard output,
for the Step E research evaluation in ``web/src/research``. Nothing is
written to disk: the release zip is read in place and every member is
decoded in memory.

ImageCAS-X (Zenodo 10.5281/zenodo.23562647, CC BY 4.0) gives each CT case a
left and a right centerline tree as VTK 5.1 binary polydata, with a
``segment_name`` per point (LM, LAD, LCX, D1, OM1, ...). The release does
not state the points' axes, so they are checked against the case's own
coronary mask: the convention (RAS, or LPS) that puts more points inside
the mask is taken, and a tree that falls mostly outside it under both is
refused.

Run with the ingest runtime (numpy, nibabel):
  .runtime/ingest-runtime/bin/python scripts/research/imagecasx_tree.py ZIP CASE

Output: one line of JSON with, per side, the convention, the share of
points on the mask, and each named branch as its longest same-name run
along any one centerline, in RAS millimetres.
"""

import gzip
import json
import re
import sys
import zipfile

ROOT = "ImageCAS-X_dataset_v2"
MIN_ON_MASK = 0.8


def _after(blob, tag):
    match = re.search(rb"(?:^|\n)" + tag + rb"[^\n]*\n", blob)
    if not match:
        raise ValueError(f"No {tag.decode()} section")
    return match.end(), match.group(0).strip().split()


def _strings(blob, start, count):
    """VTK 5.1 binary strings: a length byte (110xxxxx) then the text."""
    out, at = [], start
    for _ in range(count):
        head = blob[at]
        if head & 0xE0 != 0xC0:
            raise ValueError("Unexpected string encoding")
        size = head & 0x1F
        out.append(blob[at + 1 : at + 1 + size].decode("ascii"))
        at += 1 + size
    return out


def read_vtk(blob):
    import numpy as np

    start, head = _after(blob, rb"POINTS")
    n = int(head[1])
    if head[2] != b"float":
        raise ValueError("Points are not float")
    points = np.frombuffer(blob[start : start + 12 * n], ">f4").reshape(n, 3).astype(float)
    _, head = _after(blob, rb"LINES")
    n_offsets, n_connectivity = int(head[1]), int(head[2])
    start, _ = _after(blob, rb"OFFSETS vtktypeint64")
    offsets = np.frombuffer(blob[start : start + 8 * n_offsets], ">i8")
    start, _ = _after(blob, rb"CONNECTIVITY vtktypeint64")
    connectivity = np.frombuffer(blob[start : start + 8 * n_connectivity], ">i8")
    lines = [
        connectivity[offsets[i] : offsets[i + 1]].tolist() for i in range(n_offsets - 1)
    ]
    start, head = _after(blob, rb"segment_name 1")
    names = _strings(blob, start, int(head[2]))
    if len(names) != n:
        raise ValueError("One name per point is expected")
    return points, lines, names


def _longest_runs(lines, names):
    best = {}
    for line in lines:
        run, current = [], None
        for i in line + [None]:
            name = names[i] if i is not None else None
            if name != current:
                if current and len(run) > len(best.get(current, [])):
                    best[current] = run
                run, current = [], name
            if i is not None:
                run.append(i)
    return best


def read_case(archive, case):
    import nibabel as nib
    import numpy as np

    raw = gzip.decompress(archive.read(f"{ROOT}/segmentations/{case}.coronary.nii.gz"))
    image = nib.Nifti1Image.from_bytes(raw)
    mask = np.asarray(image.dataobj) > 0
    to_voxel = np.linalg.inv(image.affine)
    out = {}
    for side in ("left", "right"):
        blob = archive.read(f"{ROOT}/centerlines/{case}.coronary_{side}_centerline.vtk")
        points, lines, names = read_vtk(blob)
        on_mask = {}
        for convention, p in (("ras", points), ("lps", points * [-1, -1, 1])):
            v = np.rint((to_voxel @ np.c_[p, np.ones(len(p))].T).T[:, :3]).astype(int)
            inside = np.all((v >= 0) & (v < mask.shape), axis=1)
            # A point outside the volume counts as off the mask.
            on_mask[convention] = float(sum(mask[tuple(x)] for x in v[inside]) / len(v))
        convention = max(on_mask, key=lambda name: on_mask[name])
        if on_mask[convention] < MIN_ON_MASK:
            raise ValueError(f"The {side} tree lies off its own mask")
        ras = points if convention == "ras" else points * [-1, -1, 1]
        out[side] = {
            "convention": convention,
            "on_mask": on_mask,
            "points": len(points),
            "branches": {
                name: ras[run].round(2).tolist()
                for name, run in _longest_runs(lines, names).items()
            },
        }
    return out


def main(argv):
    path, case = argv
    with zipfile.ZipFile(path) as archive:
        line = {"case": case, **read_case(archive, case)}
    sys.stdout.write(json.dumps(line) + "\n")


if __name__ == "__main__":
    main(sys.argv[1:])
