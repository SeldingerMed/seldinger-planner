"""The format step for the aorta and iliac label set: what it lifts and what
it refuses. The set itself is not in the repository."""

import hashlib
import json
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "research"))
import prepare_aortoiliac_sets as sets
from prepare_ljubljana import PrepareError

META = (
    "\ufeffimage_id;age;gender;institute;study_type;split;manufacturer;scanner_model;kvp;"
    "pathology;pathology_location\n"
    "s0001;60;m;A;ct abdomen-pelvis;train;siemens;x;120;vascular;abdomen\n"
    "s0002;51;f;B;ct angiography abdomen-pelvis;test;ge;y;100;no_pathology;\n"
    "s0003;44;f;B;ct thorax;val;ge;y;100;no_pathology;\n"
)


def fetched(tmp_path, monkeypatch, digest="md5", wrong=False):
    """A two-case archive beside its fetch record, and a destination the
    step accepts (the test's own directory shares the repository's device)."""
    source = tmp_path / "source"
    source.mkdir()
    with zipfile.ZipFile(source / sets.ARCHIVE, "w") as archive:
        archive.writestr("meta.csv", META)
        for case in ("s0001", "s0002"):
            archive.writestr(f"{case}/ct.nii.gz", b"scan")
            for label in sets.LABELS:
                archive.writestr(f"{case}/segmentations/{label}.nii.gz", f"{case} {label}".encode())
            archive.writestr(f"{case}/segmentations/liver.nii.gz", b"liver")
        # The third case has the aorta and no iliac labels.
        archive.writestr("s0003/segmentations/aorta.nii.gz", b"aorta")
    data = (source / sets.ARCHIVE).read_bytes()
    taken = hashlib.new(digest.split("_")[0], data).hexdigest()
    item = {"name": sets.ARCHIVE, "size": len(data), digest: "0" * len(taken) if wrong else taken}
    (source / "SOURCE.json").write_text(json.dumps({"complete": True, "files": [item]}))
    monkeypatch.setattr(sets, "outside_repository", lambda path: path)
    monkeypatch.setattr(
        sets, "created_outside", lambda path: (path.mkdir(parents=True, exist_ok=True), path)[1]
    )
    return source


@pytest.mark.parametrize("digest", ["md5", "sha256", "sha256_local"])
def test_the_three_labels_of_each_case_are_lifted_as_stored(tmp_path, monkeypatch, digest):
    source = fetched(tmp_path, monkeypatch, digest)
    out = tmp_path / "out"
    record = sets.prepare_totalsegmentator(source, out)
    assert sorted(p.name for p in out.iterdir()) == ["labels.zip", "set.json"]
    assert record == json.loads((out / "set.json").read_text())
    assert [case["subject"] for case in record["cases"]] == ["s0001", "s0002"]
    assert record["left_out"] == ["s0003"]
    assert record["cases"][1]["meta"]["split"] == "test"
    assert record["cases"][1]["meta"]["study_type"] == "ct angiography abdomen-pelvis"
    assert (
        record["cases"][1]["sha256"]["aorta.nii.gz"] == hashlib.sha256(b"s0002 aorta").hexdigest()
    )
    whole = (out / "labels.zip").read_bytes()
    assert record["labels_zip_sha256"] == hashlib.sha256(whole).hexdigest()
    with zipfile.ZipFile(out / "labels.zip") as lifted:
        assert sorted(lifted.namelist()) == sorted(
            f"{case}/{label}.nii.gz" for case in ("s0001", "s0002") for label in sets.LABELS
        )
        assert lifted.read("s0002/iliac_artery_right.nii.gz") == b"s0002 iliac_artery_right"
    # The same labels give the same file.
    sets.prepare_totalsegmentator(source, out)
    assert (out / "labels.zip").read_bytes() == whole


def test_an_archive_that_is_not_the_fetched_one_is_refused(tmp_path, monkeypatch):
    source = fetched(tmp_path, monkeypatch, wrong=True)
    with pytest.raises(PrepareError, match="Not the fetched file"):
        sets.prepare_totalsegmentator(source, tmp_path / "out")
    assert not (tmp_path / "out").exists()


def test_an_archive_with_no_recorded_digest_is_refused(tmp_path, monkeypatch):
    source = fetched(tmp_path, monkeypatch)
    record = json.loads((source / "SOURCE.json").read_text())
    del record["files"][0]["md5"]
    (source / "SOURCE.json").write_text(json.dumps(record))
    with pytest.raises(PrepareError, match="no digest"):
        sets.prepare_totalsegmentator(source, tmp_path / "out")


def test_a_run_that_stops_part_way_leaves_no_set_record(tmp_path, monkeypatch):
    source = fetched(tmp_path, monkeypatch)
    out = tmp_path / "out"
    sets.prepare_totalsegmentator(source, out)
    monkeypatch.setattr(sets, "MAX_LABEL_BYTES", 4)
    with pytest.raises(PrepareError, match="larger than expected"):
        sets.prepare_totalsegmentator(source, out)
    assert not (out / "set.json").exists()


def test_a_meta_table_that_does_not_name_cases_is_refused():
    with pytest.raises(PrepareError, match="meta.csv"):
        sets.cases_of(b"a;b\n1;2\n")
    with pytest.raises(PrepareError, match="one by one"):
        sets.cases_of(b"image_id;split\ns1;train\ns1;test\n")
    with pytest.raises(PrepareError, match="one by one"):
        sets.cases_of(b"image_id;split\n../x;train\n")


def test_the_label_file_of_each_avt_case_is_found_by_its_folder():
    names = [
        "Rider/",
        "Rider/R1 (AD)/",
        "Rider/R1 (AD)/R1.nrrd",
        "Rider/R1 (AD)/R1.seg.nrrd",
        "Rider/R1 (AD)/._R1.seg.nrrd",
        "Rider/R10/R10.seg.nrrd",
        "__MACOSX/Rider/R10/._R10.seg.nrrd",
    ]
    assert sets.avt_cases(names) == {
        "R1": {"collection": "Rider", "folder": "R1 (AD)", "member": "Rider/R1 (AD)/R1.seg.nrrd"},
        "R10": {"collection": "Rider", "folder": "R10", "member": "Rider/R10/R10.seg.nrrd"},
    }
    for odd in ("Rider/R2/R3.seg.nrrd", "Rider/R2/R 2.seg.nrrd"):
        with pytest.raises(PrepareError, match="Not a case"):
            sets.avt_cases([odd])
    with pytest.raises(PrepareError, match="Not a case"):
        sets.avt_cases(["Rider/R2/R2.seg.nrrd", "Rider/R2 (AD)/R2.seg.nrrd"])


def test_the_avt_label_files_are_lifted_in_case_order(tmp_path, monkeypatch):
    source = tmp_path / "source"
    source.mkdir()
    items = []
    held = {"Dongyang.zip": ["D10", "D2"], "KiTS.zip": ["K1"], "Rider.zip": ["R1 (AD)"]}
    for name, folders in held.items():
        with zipfile.ZipFile(source / name, "w") as archive:
            for folder in folders:
                case = folder.split(" ")[0]
                archive.writestr(f"{name[:-4]}/{folder}/{case}.seg.nrrd", f"label {case}".encode())
                archive.writestr(f"{name[:-4]}/{folder}/{case}.nrrd", b"scan")
        data = (source / name).read_bytes()
        items.append(
            {"name": name, "size": len(data), "sha256_local": hashlib.sha256(data).hexdigest()}
        )
    (source / "SOURCE.json").write_text(json.dumps({"complete": True, "files": items}))
    monkeypatch.setattr(sets, "outside_repository", lambda path: path)
    monkeypatch.setattr(
        sets, "created_outside", lambda path: (path.mkdir(parents=True, exist_ok=True), path)[1]
    )
    out = tmp_path / "out"
    record = sets.prepare_avt(source, out)
    assert [case["subject"] for case in record["cases"]] == ["D2", "D10", "K1", "R1"]
    assert record["cases"][3]["meta"]["folder"] == "R1 (AD)"
    with zipfile.ZipFile(out / "labels.zip") as lifted:
        assert lifted.namelist() == ["D2.seg.nrrd", "D10.seg.nrrd", "K1.seg.nrrd", "R1.seg.nrrd"]
        assert lifted.read("R1.seg.nrrd") == b"label R1"
    assert record["cases"][0]["sha256"] == {"D2.seg.nrrd": hashlib.sha256(b"label D2").hexdigest()}
    # One archive short of the fetched set: nothing is prepared.
    (source / "KiTS.zip").unlink()
    with pytest.raises(PrepareError, match="Not the fetched file"):
        sets.prepare_avt(source, tmp_path / "other")
    assert not (tmp_path / "other").exists()
