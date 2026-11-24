"""The held-out virtual X-ray control's reading of its cohort, on synthetic data.

No weights and no archive: an in-memory tar stands in for the fetched one, and
a stand-in runner and model stand in for the installed weights and the model
builder, so the tests check the cohort rule, the case folder and the refusals.
"""

import gzip
import io
import json
import os
import sys
import tarfile
from pathlib import Path

import pytest

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Requires isolated imaging runtime", allow_module_level=True)

import nibabel as nib
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "research"))

import heldout_control as hc

MODEL = {
    "method": "aortoiliac_widest_path_model_v1",
    "branches": [
        {"name": "aorta", "path_ras": [[0, 0, 30], [0, 0, 0]], "length_mm": 30.0},
        {"name": "right_iliac", "path_ras": [[0, 0, 0], [-10, 0, -20]], "length_mm": 22.4},
        {"name": "left_iliac", "path_ras": [[0, 0, 0], [10, 0, -20]], "length_mm": 22.4},
    ],
    "bifurcation_ras": [0, 0, 0],
}


def scan_bytes(shape=(24, 20, 30), hu=-1000):
    volume = np.full(shape, hu, dtype=np.int16)
    volume[8:16, 6:14, 5:25] = 400
    affine = np.diag([-2.0, -2.0, 2.0, 1.0])
    affine[:3, 3] = [20, 20, -30]
    return gzip.compress(nib.Nifti1Image(volume, affine).to_bytes())


def archive(names):
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w:gz") as tar:
        for name in names:
            data = b"not a scan" if not name.endswith(".nii.gz") else scan_bytes()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    raw.seek(0)
    return raw


def stand_in_runner(image, *, fast=True):
    assert fast is True
    labels = np.zeros(image.shape, dtype=np.uint8)
    labels[10:14, 8:12, 12:25] = 52
    labels[10:12, 8:12, 5:12] = 66
    labels[12:14, 8:12, 5:12] = 65
    return nib.Nifti1Image(labels, image.affine)


def test_the_cohort_is_the_first_dataset6_scans_in_archive_order():
    names = [
        "CTPelvic1K_dataset6_data/README.txt",
        "CTPelvic1K_dataset6_data/dataset6_CLINIC_0060_data.nii.gz",
        "CTPelvic1K_dataset7_data/dataset7_CLINIC_metal_0001_data.nii.gz",
        "CTPelvic1K_dataset6_data/dataset6_CLINIC_0012_data.nii.gz",
        "CTPelvic1K_dataset6_data/dataset6_CLINIC_0023_data.nii.gz",
    ]
    got = [name for name, _ in hc.cohort_members(archive(names), read_limit=2)]
    assert got == [names[1], names[3]]


def test_a_case_folder_holds_the_control_and_the_points_the_line_up_never_reads(tmp_path):
    member = "CTPelvic1K_dataset6_data/dataset6_CLINIC_0012_data.nii.gz"
    data = scan_bytes()
    record = hc.case_from_scan(
        member, data, stand_in_runner, tmp_path, 3, propose=lambda mask, affine: MODEL, side=32
    )
    assert record["case"] == "C0012"
    assert record["label_voxels"] == {
        "aorta": 4 * 4 * 13,
        "iliac_artery_left": 2 * 4 * 7,
        "iliac_artery_right": 2 * 4 * 7,
    }
    assert record["model"]["names"] == ["aorta", "right_iliac", "left_iliac"]
    assert [p["pose"] for p in record["poses"]] == ["pose0", "pose1", "pose2", "pose3"]
    folder = tmp_path / "C0012"
    for name in ("volume.json", "volume.i16", "truth-pose3.json", "vessels.json"):
        assert (folder / name).is_file()
    vessels = json.loads((folder / "vessels.json").read_text())
    assert set(vessels["groups"]) == {
        "aorta",
        "right_iliac",
        "left_iliac",
        "aorta_end",
        "right_iliac_end",
        "left_iliac_end",
        "bifurcation",
    }
    assert vessels["groups"]["bifurcation"] == [[0.0, 0.0, 0.0]]
    assert len(vessels["groups"]["aorta"]) == 7  # every 5 mm over 30 mm


def test_the_seed_of_each_case_follows_its_place_in_the_cohort(tmp_path):
    data = scan_bytes()
    member = "x/dataset6_CLINIC_0001_data.nii.gz"
    one = hc.case_from_scan(
        member, data, stand_in_runner, tmp_path / "a", 0, propose=lambda m, a: MODEL, side=16
    )
    two = hc.case_from_scan(
        member, data, stand_in_runner, tmp_path / "b", 1, propose=lambda m, a: MODEL, side=16
    )
    assert one["poses"][1]["volume_to_carm_ras"] != two["poses"][1]["volume_to_carm_ras"]
    again = hc.case_from_scan(
        member, data, stand_in_runner, tmp_path / "c", 0, propose=lambda m, a: MODEL, side=16
    )
    assert again["poses"] == one["poses"]


def test_a_refused_model_writes_no_case(tmp_path):
    def refuse(mask, affine):
        raise ValueError("No iliac arteries")

    record = hc.case_from_scan(
        "x/dataset6_CLINIC_0005_data.nii.gz",
        scan_bytes(),
        stand_in_runner,
        tmp_path,
        0,
        propose=refuse,
    )
    assert record["refused"] == "No iliac arteries"
    assert not (tmp_path / "C0005").exists()


def test_no_inferred_vessel_writes_no_case(tmp_path):
    def empty(image, *, fast=True):
        return nib.Nifti1Image(np.zeros(image.shape, dtype=np.uint8), image.affine)

    record = hc.case_from_scan(
        "x/dataset6_CLINIC_0007_data.nii.gz",
        scan_bytes(),
        empty,
        tmp_path,
        0,
        propose=lambda m, a: MODEL,
    )
    assert record["refused"] == "No aorta or iliac voxel inferred"
    assert not (tmp_path / "C0007").exists()


def test_only_the_protocol_archive_is_read(tmp_path):
    other = tmp_path / "CTPelvic1K_dataset7_data.tar.gz"
    other.write_bytes(b"")
    with pytest.raises(SystemExit):
        hc.main(["--archive", str(other), "--weights", str(tmp_path), "--out", str(tmp_path / "o")])
