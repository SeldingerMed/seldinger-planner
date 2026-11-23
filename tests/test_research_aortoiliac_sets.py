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
    records = sets.prepare_totalsegmentator(source, out)
    assert [r["subject"] for r in records] == ["s0001", "s0002"]
    assert json.loads((out / "left-out.json").read_text()) == ["s0003"]
    assert not (out / "s0003").exists()
    assert sorted(p.name for p in (out / "s0002").iterdir()) == [
        "aorta.nii.gz",
        "iliac_artery_left.nii.gz",
        "iliac_artery_right.nii.gz",
        "subject.json",
    ]
    assert (out / "s0002" / "iliac_artery_right.nii.gz").read_bytes() == b"s0002 iliac_artery_right"
    record = json.loads((out / "s0002" / "subject.json").read_text())
    assert record["meta"]["split"] == "test"
    assert record["meta"]["study_type"] == "ct angiography abdomen-pelvis"
    assert record["sha256"]["aorta.nii.gz"] == hashlib.sha256(b"s0002 aorta").hexdigest()
    # A second run finds every case done.
    assert sets.prepare_totalsegmentator(source, out) == []


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


def test_a_named_case_without_all_three_labels_is_refused(tmp_path, monkeypatch):
    source = fetched(tmp_path, monkeypatch)
    with pytest.raises(PrepareError, match="No such case"):
        sets.prepare_totalsegmentator(source, tmp_path / "out", ["s0003"])
    assert [
        r["subject"] for r in sets.prepare_totalsegmentator(source, tmp_path / "out", ["s0002"])
    ] == ["s0002"]
    # A run of named cases does not speak for the whole set.
    assert not (tmp_path / "out" / "left-out.json").exists()


def test_a_meta_table_that_does_not_name_cases_is_refused():
    with pytest.raises(PrepareError, match="meta.csv"):
        sets.cases_of(b"a;b\n1;2\n")
    with pytest.raises(PrepareError, match="one by one"):
        sets.cases_of(b"image_id;split\ns1;train\ns1;test\n")
    with pytest.raises(PrepareError, match="one by one"):
        sets.cases_of(b"image_id;split\n../x;train\n")
