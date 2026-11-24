"""The look at the aorta and iliac model on one mask of the whole aortic
tree, as the AVT set stores it. Phantoms only."""

import gzip
import hashlib
import json
import os
import sys
import zipfile
from pathlib import Path

import pytest

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Requires isolated imaging runtime", allow_module_level=True)

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "research"))
import aortoiliac_single_mask as look
from test_aortoiliac_model import AORTA, LEFT, RENALS, RIGHT, grid, tubes

from planner.aortoiliac_model import propose_aortoiliac_model


def seg_nrrd(mask, affine):
    """A Slicer segmentation file: left-posterior-superior, gzip, one segment."""
    lps = np.diag([-1.0, -1.0, 1.0, 1.0]) @ affine
    header = "NRRD0004\n# a comment\ntype: unsigned char\ndimension: 3\n"
    header += "space: left-posterior-superior\n"
    header += "sizes: " + " ".join(str(n) for n in mask.shape) + "\n"
    header += "space directions: " + " ".join(
        "(" + ",".join(repr(float(v)) for v in lps[:3, axis]) + ")" for axis in range(3)
    )
    header += "\nkinds: domain domain domain\nencoding: gzip\n"
    header += "space origin: (" + ",".join(repr(float(v)) for v in lps[:3, 3]) + ")\n"
    header += "Segment0_LabelValue:=1\nSegment0_Name:=aorta\n\n"
    return header.encode() + gzip.compress(mask.astype(np.uint8).tobytes(order="F"))


def test_a_segmentation_file_is_read_as_its_box_in_patient_axes():
    shape, affine = grid(signs=(-1, -1, 1))
    whole = tubes(shape, affine, [AORTA, RIGHT, LEFT, *RENALS])
    mask, boxed = look.read_seg_nrrd(seg_nrrd(whole, affine))
    assert mask.size < whole.size / 3 and int(mask.sum()) == int(whole.sum())
    held = np.argwhere(mask) @ boxed[:3, :3].T + boxed[:3, 3]
    there = np.argwhere(whole) @ affine[:3, :3].T + affine[:3, 3]
    assert held.min(axis=0) == pytest.approx(there.min(axis=0), abs=1e-6)
    assert held.max(axis=0) == pytest.approx(there.max(axis=0), abs=1e-6)
    with pytest.raises(look.CaseError, match="Not a plain"):
        look.read_seg_nrrd(seg_nrrd(whole, affine).replace(b"encoding: gzip", b"encoding: raw"))
    with pytest.raises(look.CaseError, match="short"):
        look.read_seg_nrrd(seg_nrrd(whole, affine)[:-2000] + gzip.compress(b"00"))


def test_the_mask_alone_says_where_two_points_stop_sharing_a_lumen():
    shape, affine = grid()
    mask = tubes(shape, affine, [AORTA, RIGHT, LEFT, *RENALS])
    model = propose_aortoiliac_model(mask, affine)
    ends = [b["path_ras"][-1] for b in model["branches"][1:]]
    # Below this height the two iliac ends lie in separate pieces of the mask.
    height = look.parts_below(mask, affine, *ends)
    assert height == pytest.approx(model["bifurcation_ras"][2], abs=4)
    # Two points down one artery never part.
    assert look.parts_below(mask, affine, ends[0], model["branches"][1]["path_ras"][-8]) is None


@pytest.mark.parametrize(
    ("spacing_z", "nz", "bridge_z", "slab_slices"),
    [
        # stride_z=2, odd slab=3: slab 9:12 starts inside stride cell 4 and silently shifts z=10
        (0.5, 18, 10, 3),
        # stride_z=2, odd slab=5: final slab 15:19 spans 3 stride cells with 4 slices (shape mismatch)
        (0.5, 19, 10, 5),
        # stride_z=3, odd slab=5: slab 5:10 starts inside stride cell 1 (shape mismatch)
        (0.35, 20, 12, 5),
        # stride_z=3, odd slab=7: slab 7:14 starts inside stride cell 2 and silently shifts z=12
        (0.35, 21, 12, 7),
    ],
)
def test_parts_below_matches_analytic_phantom_across_chunk_sizes(
    monkeypatch, spacing_z, nz, bridge_z, slab_slices
):
    shape = (12, 10, nz)
    affine = np.diag([0.5, 0.5, spacing_z, 1.0])
    affine[:3, 3] = [0.0, 0.0, -5.0]
    mask = np.zeros(shape, dtype=np.uint8)
    # Two separated vertical legs joined only at z=bridge_z.
    mask[2:4, 4:6, : bridge_z + 4] = 1
    mask[8:10, 4:6, : bridge_z + 4] = 1
    mask[2:10, 4:6, bridge_z] = 1
    one = affine[:3, :3] @ np.array([2.5, 4.5, 1.0]) + affine[:3, 3]
    other = affine[:3, :3] @ np.array([8.5, 4.5, 1.0]) + affine[:3, 3]

    stride_z = max(1, int(np.floor(look.PARTING_GRID_MM / spacing_z)))
    assert stride_z > 1 and slab_slices % 2 == 1 and slab_slices % stride_z != 0
    expected_cell = bridge_z // stride_z
    expected_height = float(affine[2, 2] * ((expected_cell + 0.5) * stride_z - 0.5) + affine[2, 3])

    monkeypatch.setattr(look, "SLAB_VOXELS", int(mask.size))
    whole_chunk = look.parts_below(mask, affine, one, other)
    monkeypatch.setattr(look, "SLAB_VOXELS", int(shape[0] * shape[1] * slab_slices))
    odd_chunk = look.parts_below(mask, affine, one, other)

    assert whole_chunk == pytest.approx(expected_height, abs=1e-9)
    assert odd_chunk == pytest.approx(whole_chunk, abs=1e-9)


def test_a_look_records_each_case_and_draws_it(tmp_path, monkeypatch, capsys):
    shape, affine = grid()
    prepared = tmp_path / "prepared"
    prepared.mkdir()
    cases = []
    with zipfile.ZipFile(prepared / "labels.zip", "w") as lifted:
        for subject, capsules in (
            ("K1", [AORTA, RIGHT, LEFT, *RENALS]),
            ("R11", [AORTA, *RENALS]),
            ("D3", [((0.0, 0.0, 3.0), (0.0, 0.0, 0.0), 1.0)]),
            ("K2", [AORTA, RIGHT, LEFT]),
        ):
            data = seg_nrrd(tubes(shape, affine, capsules), affine)
            lifted.writestr(f"{subject}.seg.nrrd", data)
            cases.append(
                {
                    "subject": subject,
                    "meta": {"collection": "phantom"},
                    "sha256": {f"{subject}.seg.nrrd": hashlib.sha256(data).hexdigest()},
                }
            )
    (prepared / "set.json").write_text(json.dumps({"cases": cases}))
    monkeypatch.setattr(look, "outside_repository", lambda path: path)
    monkeypatch.setattr(
        look, "created_outside", lambda path: (path.mkdir(parents=True, exist_ok=True), path)[1]
    )
    # Odd-numbered cases are for design; even-numbered ones are held back
    # and run whole.
    assert (
        look.main([str(prepared), str(tmp_path / "held"), "--set", "held_back", "--case", "K2"])
        == 1
    )
    assert "run whole" in capsys.readouterr().err
    assert look.main([str(prepared), str(tmp_path / "held"), "--set", "held_back"]) == 0
    held = (tmp_path / "held" / "runs.jsonl").read_text().splitlines()
    assert [json.loads(line)["subject"] for line in held] == ["K2"]
    assert look.main([str(prepared), str(tmp_path / "out"), "--set", "design"]) == 0
    runs = [json.loads(line) for line in (tmp_path / "out" / "runs.jsonl").read_text().splitlines()]
    both, alone, refused = runs
    assert both["names"] == ["aorta", "right_iliac", "left_iliac"]
    assert abs(both["bifurcation_above_parting_mm"]) < 4
    assert both["right_is_right"] is True and both["points_in_lumen"] > 0.99
    assert both["iliac_drop_mm"]["left"] > 90 and both["aorta_length_mm"] > 130
    assert alone["names"] == ["aorta"] and alone["bifurcation_above_parting_mm"] is None
    assert "refused" in refused
    # Each case says how much memory its own process came to.
    assert all(0 < run["peak_mb"] < 250 for run in runs)
    summary = json.loads((tmp_path / "out" / "summary.json").read_text())
    assert summary["cases"] == 3 and summary["with_bifurcation"] == 1 and summary["refused"] == 1
    assert len(summary["code"]) == 64 and {run["code"] for run in runs} == {summary["code"]}
    monkeypatch.setattr(look, "code_digest", lambda *files: "0" * 64)
    assert look.main([str(prepared), str(tmp_path / "edited"), "--set", "design"]) == 1
    assert "changed during the run" in capsys.readouterr().err
    assert not (tmp_path / "edited" / "summary.json").exists()
    from PIL import Image

    sheet = Image.open(tmp_path / "out" / "sheet-1.png")
    assert sheet.size[0] >= 2 * look.TILE and np.asarray(sheet).std() > 5
