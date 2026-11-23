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


def test_a_case_without_two_frames_and_a_scan_is_left_out_of_a_whole_set_run():
    cases = {
        "case10": {"C-arm": ["a", "b"], "CBCT": ["s"], "other": []},
        "case2": {"C-arm": ["a", "b"], "CBCT": ["s"], "other": []},
        "case134": {"C-arm": [], "CBCT": ["s"], "other": ["x"]},
        "case7": {"C-arm": ["a", "b"], "CBCT": [], "other": []},
    }
    assert bone.lspine_complete(cases) == (["case2", "case10"], ["case7", "case134"])


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


def test_the_lumbar_archive_is_checked_against_the_digest_its_fetch_recorded(tmp_path, monkeypatch):
    import zipfile

    def made(path):
        path.mkdir(parents=True, exist_ok=True)
        return path

    monkeypatch.setattr(bone, "outside_repository", lambda destination: destination)
    monkeypatch.setattr(bone, "created_outside", made)

    source = tmp_path / "source"
    source.mkdir()
    with zipfile.ZipFile(source / "C-ArmLSpine.zip", "w"):
        pass
    size = (source / "C-ArmLSpine.zip").stat().st_size
    # The record of a fetch checked by another digest carries its own under `sha256_local`.
    for key in ("sha256", "sha256_local"):
        item = {"name": "C-ArmLSpine.zip", "size": size, key: "0" * 64}
        (source / "SOURCE.json").write_text(json.dumps({"complete": True, "files": [item]}))
        with pytest.raises(PrepareError, match="Not the fetched file: C-ArmLSpine.zip"):
            bone.prepare_lspine(source, tmp_path / f"out-{key}")
        assert not (tmp_path / f"out-{key}").exists()
    item = {"name": "C-ArmLSpine.zip", "size": size}
    item["sha256_local"] = bone._sha256((source / "C-ArmLSpine.zip").read_bytes())
    (source / "SOURCE.json").write_text(json.dumps({"complete": True, "files": [item]}))
    assert bone.prepare_lspine(source, tmp_path / "out") == []


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
