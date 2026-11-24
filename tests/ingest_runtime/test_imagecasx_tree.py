"""The ImageCAS-X centerline reader used by the Step E research evaluation."""

import gzip
import importlib.util
import io
import json
import os
import zipfile
from pathlib import Path

import pytest

if os.environ.get("SELDINGER_RUN_INGEST_TESTS") != "1":
    pytest.skip("Requires isolated ingest runtime", allow_module_level=True)

import nibabel as nib
import numpy as np

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "research" / "imagecasx_tree.py"
spec = importlib.util.spec_from_file_location("imagecasx_tree", SCRIPT)
assert spec is not None and spec.loader is not None
tree = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tree)


def vtk(points, lines, names):
    """A VTK 5.1 binary polydata file as the ImageCAS-X release writes it."""
    head = b"# vtk DataFile Version 5.1\nvtk output\nBINARY\nDATASET POLYDATA\n"
    body = b"POINTS %d float\n" % len(points)
    body += np.asarray(points, ">f4").tobytes() + b"\n"
    offsets = np.cumsum([0] + [len(line) for line in lines])
    body += b"LINES %d %d\nOFFSETS vtktypeint64\n" % (len(offsets), offsets[-1])
    body += np.asarray(offsets, ">i8").tobytes() + b"\n"
    body += b"CONNECTIVITY vtktypeint64\n"
    body += np.asarray([i for line in lines for i in line], ">i8").tobytes() + b"\n"
    body += b"POINT_DATA %d\nFIELD FieldData 1\nsegment_name 1 %d string\n" % (
        len(points),
        len(points),
    )
    body += b"".join(bytes([0xC0 | len(n)]) + n.encode() for n in names) + b"\n"
    return head + body


def case_zip(points_lps, lines, names, mask_points_lps):
    """A zip holding one case: a left and a right centerline and the mask."""
    affine = np.diag([-1.0, -1.0, 1.0, 1.0])  # voxel -> RAS; LPS = voxel index
    lab = np.zeros((40, 40, 40), np.uint8)
    for p in mask_points_lps:
        lab[tuple(int(v) for v in p)] = 1
    img = nib.Nifti1Image(lab, affine)
    raw = io.BytesIO()
    raw.write(gzip.compress(img.to_bytes()))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        root = "ImageCAS-X_dataset_v2"
        z.writestr(f"{root}/segmentations/7.coronary.nii.gz", raw.getvalue())
        for side in ("left", "right"):
            z.writestr(
                f"{root}/centerlines/7.coronary_{side}_centerline.vtk",
                vtk(points_lps, lines, names),
            )
    return out.getvalue()


def test_reads_named_branches_in_ras_by_the_mask():
    # LM 0-2, then LAD 3-5 on one line and LCX 6-7 on the other.
    pts = [
        [10, 10, 10],
        [11, 10, 10],
        [12, 10, 10],
        [13, 11, 10],
        [14, 12, 10],
        [15, 13, 10],
        [13, 9, 10],
        [14, 8, 10],
    ]
    lines = [[0, 1, 2, 3, 4, 5], [0, 1, 2, 6, 7]]
    names = ["LM", "LM", "LM", "LAD", "LAD", "LAD", "LCX", "LCX"]
    data = case_zip(pts, lines, names, pts)
    out = tree.read_case(zipfile.ZipFile(io.BytesIO(data)), "7")
    left = out["left"]
    assert left["convention"] == "lps"
    assert left["on_mask"]["lps"] == 1.0
    assert set(left["branches"]) == {"LM", "LAD", "LCX"}
    # LPS to RAS: x and y turned round.
    assert left["branches"]["LM"][0] == [-10.0, -10.0, 10.0]
    assert len(left["branches"]["LAD"]) == 3
    assert len(left["branches"]["LCX"]) == 2


def test_a_tree_off_its_own_mask_is_refused():
    pts = [[10, 10, 10], [11, 10, 10], [12, 10, 10]]
    data = case_zip(pts, [[0, 1, 2]], ["LM"] * 3, [[30, 30, 30]])
    with pytest.raises(ValueError, match="mask"):
        tree.read_case(zipfile.ZipFile(io.BytesIO(data)), "7")


def test_names_are_read_by_their_length_prefix():
    blob = vtk([[0, 0, 0], [1, 0, 0]], [[0, 1]], ["OM12", "D1"])
    _, _, names = tree.read_vtk(blob)
    assert names == ["OM12", "D1"]


def test_main_prints_and_writes_nothing(tmp_path, capsys, monkeypatch):
    pts = [[10, 10, 10], [11, 10, 10], [12, 10, 10]]
    path = tmp_path / "set.zip"
    path.write_bytes(case_zip(pts, [[0, 1, 2]], ["LM"] * 3, pts))
    before = sorted(p.name for p in tmp_path.iterdir())
    tree.main([str(path), "7"])
    line = json.loads(capsys.readouterr().out)
    assert line["case"] == "7" and "LM" in line["left"]["branches"]
    assert sorted(p.name for p in tmp_path.iterdir()) == before
