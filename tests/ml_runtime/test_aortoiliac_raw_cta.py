"""Synthetic checks of the raw-CT AVT design runner's reading and scoring."""

import gzip
import os
import sys
from pathlib import Path

import pytest

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Requires isolated imaging runtime", allow_module_level=True)

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "research"))

import aortoiliac_raw_cta as raw


def nrrd(volume, *, kind="short", encoding="gzip", spacing=(0.7, 0.7, 2.0)):
    header = (
        "NRRD0004\n# comment\n"
        f"type: {kind}\ndimension: 3\nspace: left-posterior-superior\n"
        f"sizes: {' '.join(str(n) for n in volume.shape)}\n"
        f"space directions: ({spacing[0]},0,0) (0,{spacing[1]},0) (0,0,{spacing[2]})\n"
        f"kinds: domain domain domain\nendian: little\nencoding: {encoding}\n"
        "space origin: (-10,-20,-30)\n\n"
    ).encode()
    body = volume.tobytes(order="F")
    return header + (gzip.compress(body) if encoding == "gzip" else body)


def test_a_ct_file_reads_in_xyz_order_with_an_lps_to_ras_affine():
    volume = np.arange(4 * 3 * 2, dtype=np.int16).reshape((4, 3, 2), order="F") - 1000
    read, affine, header = raw.read_ct_nrrd(nrrd(volume))
    assert np.array_equal(read, volume)
    assert header == {"type": "short", "sizes": [4, 3, 2]}
    assert np.allclose(affine[:3, :3], np.diag([-0.7, -0.7, 2.0]))
    assert np.allclose(affine[:3, 3], [10, 20, -30])


def test_32_bit_ct_reads_and_becomes_16_bit_hounsfield():
    volume = np.array([-1024, 0, 40, 3071, 70000, -40000], dtype=np.int32).reshape(
        (3, 2, 1), order="F"
    )
    read, _, header = raw.read_ct_nrrd(nrrd(volume, kind="int"))
    assert header["type"] == "int" and np.array_equal(read, volume)
    hounsfield, offset = raw.as_hounsfield(read)
    assert offset == 0 and hounsfield.dtype == np.int16
    assert hounsfield.ravel(order="F").tolist() == [-1024, 0, 40, 3071, 32767, -32768]


def test_raw_encoding_and_short_files():
    volume = np.zeros((4, 3, 2), dtype=np.int16)
    read, _, _ = raw.read_ct_nrrd(nrrd(volume, encoding="raw"))
    assert read.shape == (4, 3, 2)
    with pytest.raises(raw.CaseError):
        raw.read_ct_nrrd(nrrd(volume, encoding="raw")[:-4])


def test_unsigned_ct_is_shifted_only_when_air_reads_near_zero():
    air = np.zeros((20, 20, 3), dtype=np.uint16)
    air[8:12, 8:12] = 1064
    shifted, offset = raw.as_hounsfield(air)
    assert offset == -1024 and shifted.dtype == np.int16
    assert shifted[0, 0, 0] == -1024 and shifted[10, 10, 0] == 40
    with pytest.raises(raw.CaseError):
        raw.as_hounsfield(air + 1000)
    signed = np.full((3, 3, 3), -1000, dtype=np.int16)
    assert raw.as_hounsfield(signed)[1] == 0


def test_held_back_cases_are_refused():
    assert raw.is_design("D1") and raw.is_design("K19")
    assert not raw.is_design("R2")
    with pytest.raises(SystemExit):
        raw.main(["--avt", "x", "--weights", "y", "--case", "R2"])


def test_line_distance_over_the_shared_height():
    straight = [[0.0, 0.0, z] for z in range(0, 101, 10)]
    shifted = [[3.0, 0.0, z] for z in range(20, 61, 10)]
    d = raw.line_distance(shifted, straight)
    assert d["mean_mm"] == pytest.approx(3.0, abs=1e-6)
    d = raw.line_distance(straight, shifted)
    assert d["mean_mm"] == pytest.approx(3.0, abs=1e-6) and d["n"] == 21


def test_mask_agreement_counts_voxels_inside_and_near_the_annotation():
    ref = np.zeros((20, 20, 20), dtype=np.uint8)
    ref[5:10, 5:10, 5:10] = 1
    pred = np.zeros_like(ref)
    pred[5:10, 5:10, 5:10] = 1  # inside
    pred[11, 5:10, 5:10] = 1  # 2 voxels away (1 mm voxels): within 2 mm
    pred[15, 5:10, 5:10] = 1  # 6 mm away
    out = raw.mask_agreement(pred, np.eye(4), ref, np.eye(4))
    assert out["inferred_voxels"] == 175
    assert out["inside_annotation"] == pytest.approx(125 / 175)
    assert out["within_2mm_of_annotation"] == pytest.approx(150 / 175)
