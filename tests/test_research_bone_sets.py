"""The format step for the bone line-up sets: what it refuses and how it
reads the archive listing. The sets themselves are not in the repository. The
two reductions need numpy and are tested in `tests/ml_runtime`."""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "research"))
import prepare_bone_sets as bone
from prepare_ljubljana import PrepareError


def test_lspine_cases_split_frames_from_scan_and_set_other_folders_aside():
    names = [
        "C-ArmLSpine/",
        "C-ArmLSpine/case2/",
        "C-ArmLSpine/case2/C-arm/0001.dcm",
        "C-ArmLSpine/case2/C-arm/0002.dcm",
        "C-ArmLSpine/case2/CBCT/0000.dcm",
        "C-ArmLSpine/case2/CBCT/._0000.dcm",
        "C-ArmLSpine/case10/CBCT/0000.dcm",
    ]
    cases = bone.lspine_cases(names)
    assert sorted(cases) == ["case10", "case2"]
    assert len(cases["case2"]["C-arm"]) == 2 and len(cases["case2"]["CBCT"]) == 1
    assert cases["case2"]["other"] == []
    # One case of the set carries a further folder; it is listed, not read.
    extra = bone.lspine_cases(["C-ArmLSpine/case134/ori/XA.1", "C-ArmLSpine/case134/CBCT/0.dcm"])
    assert extra["case134"]["other"] == ["C-ArmLSpine/case134/ori/XA.1"]
    assert extra["case134"]["C-arm"] == [] and len(extra["case134"]["CBCT"]) == 1


def test_a_file_that_is_not_the_fetched_one_is_refused(tmp_path):
    (tmp_path / "a.bin").write_bytes(b"abcd")
    digest = bone._sha256(b"abcd")
    listed = {"a.bin": {"size": 4, "sha256": digest}}
    assert bone._fetched(tmp_path / "a.bin", "a.bin", listed) == b"abcd"
    for wrong in (
        {"a.bin": {"size": 5, "sha256": digest}},
        {"a.bin": {"size": 4, "sha256": "0" * 64}},
        {},
    ):
        with pytest.raises(PrepareError, match="Not the fetched file: a.bin"):
            bone._fetched(tmp_path / "a.bin", "a.bin", wrong)


def test_a_large_fetched_file_is_checked_without_being_held(tmp_path):
    data = bytes(range(256)) * 9000
    (tmp_path / "big.bin").write_bytes(data)
    listed = {"big.bin": {"size": len(data), "sha256": bone._sha256(data)}}
    assert bone._fetched_path(tmp_path / "big.bin", "big.bin", listed) == tmp_path / "big.bin"
    for wrong in (
        {"big.bin": {"size": len(data) + 1, "sha256": bone._sha256(data)}},
        {"big.bin": {"size": len(data), "sha256": "0" * 64}},
        {},
    ):
        with pytest.raises(PrepareError, match="Not the fetched file: big.bin"):
            bone._fetched_path(tmp_path / "big.bin", "big.bin", wrong)


def test_an_output_written_in_parts_reports_the_digest_of_the_whole(tmp_path):
    out = bone.Written(tmp_path / "volume.i16")
    out.write(b"abc")
    out.write(b"defg")
    assert out.close() == bone._sha256(b"abcdefg")
    assert (tmp_path / "volume.i16").read_bytes() == b"abcdefg"


def test_a_fetch_record_that_is_not_complete_is_refused(tmp_path):
    (tmp_path / "SOURCE.json").write_text(json.dumps({"complete": False, "files": []}))
    with pytest.raises(PrepareError, match="does not say the set is complete"):
        bone._listed(tmp_path)
    (tmp_path / "SOURCE.json").write_text(
        json.dumps({"complete": True, "files": [{"name": "x", "size": 1}]})
    )
    assert bone._listed(tmp_path) == {"x": {"name": "x", "size": 1}}


def test_the_stored_size_of_a_frame_is_read_from_the_frame_itself(tmp_path):
    def element(tag: str, value: int) -> bytes:
        return bytes.fromhex(tag) + b"US\x02\x00" + value.to_bytes(2, "little")

    path = tmp_path / "frame.dcm"
    path.write_bytes(b"\x00" * 128 + b"DICM" + element("28001000", 6) + element("28001100", 4))
    assert bone.stored_size(path) == (6, 4)
    path.write_bytes(b"\x00" * 128 + b"DICM" + element("28001000", 6))
    with pytest.raises(PrepareError, match="No stored size: frame.dcm"):
        bone.stored_size(path)
