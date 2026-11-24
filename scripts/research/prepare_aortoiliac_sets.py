#!/usr/bin/env python3
"""Lift the vessel labels out of the two fetched aorta sets.

  totalsegmentator  Zenodo 10047292, CC BY 4.0: one archive of 1,228 CT
                    scans, each with one label file per structure. Three are
                    lifted: `aorta`, `iliac_artery_left`, `iliac_artery_right`.
  avt               Aortic Vessel Tree, figshare 14806362, CC BY 4.0: 56 CT
                    angiograms from three collections, each with one label of
                    the aorta and its branches. The label file is lifted.

The step copies bytes and nothing else. It writes two files under the
destination, because the drive the sets live on spends a quarter of a
megabyte on every file however small:
  labels.zip   totalsegmentator: for each case `<case>/aorta.nii.gz`,
               `<case>/iliac_artery_left.nii.gz` and
               `<case>/iliac_artery_right.nii.gz`; avt: for each case
               `<case>.seg.nrrd`. Each as its archive stores it
  set.json     for each case the digest of each of its files, and what the
               source says of it (totalsegmentator: its row of `meta.csv`,
               its split, study type and pathology among them; avt: its
               collection and its folder's name); the cases left out for
               lack of a file (`left_out`); and the digest of `labels.zip`

`set.json` appears in one step after `labels.zip` is complete. An archive is
refused unless it is the fetched one: its size, and the digest its fetch
recorded (the source's own MD5 where no SHA-256 was taken).

The destination must lie outside the repository and on another storage
device. Nothing beyond the standard library is needed.
"""

import argparse
import csv
import hashlib
import io
import json
import os
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_ljubljana import FetchError, created_outside, outside_repository
from prepare_bone_sets import _listed, _recorded_digest
from prepare_ljubljana import PrepareError, _sha256

ARCHIVE = "Totalsegmentator_dataset_v201.zip"
LABELS = ("aorta", "iliac_artery_left", "iliac_artery_right")
MAX_LABEL_BYTES = 8 << 20  # a stored label file is tens of kilobytes


def fetched_archive(path: Path, name: str, listed: dict) -> Path:
    """The fetched archive, refused unless its size and recorded digest match."""
    item = listed.get(name)
    if item is None or not path.is_file() or path.stat().st_size != item["size"]:
        raise PrepareError(f"Not the fetched file: {name}")
    wanted = _recorded_digest(item)
    digest = hashlib.sha256() if wanted else hashlib.md5(usedforsecurity=False)
    wanted = wanted or item.get("md5")
    if not wanted:
        raise PrepareError(f"The fetch recorded no digest for {name}")
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1 << 20), b""):
            digest.update(chunk)
    if digest.hexdigest() != wanted:
        raise PrepareError(f"Not the fetched file: {name}")
    return path


def cases_of(meta: bytes) -> list[dict]:
    """The rows of the set's `meta.csv`, in its order."""
    rows = list(csv.DictReader(io.StringIO(meta.decode("utf-8-sig")), delimiter=";"))
    if not rows or "image_id" not in rows[0] or "split" not in rows[0]:
        raise PrepareError("The set's meta.csv is not the expected table")
    names = [row["image_id"] for row in rows]
    if len(set(names)) != len(names) or not all(name.isalnum() for name in names):
        raise PrepareError("The set's meta.csv does not name its cases one by one")
    return rows


def prepare_totalsegmentator(source: Path, destination: Path) -> dict:
    root = outside_repository(destination)
    path = fetched_archive(source / ARCHIVE, ARCHIVE, _listed(source))
    cases = []
    with zipfile.ZipFile(path) as archive:
        held = set(archive.namelist())
        rows = cases_of(archive.read("meta.csv"))
        members = {
            row["image_id"]: [f"{row['image_id']}/segmentations/{label}.nii.gz" for label in LABELS]
            for row in rows
        }
        left_out = sorted(name for name in members if not all(m in held for m in members[name]))
        created_outside(root)
        (root / "set.json").unlink(missing_ok=True)
        with zipfile.ZipFile(root / "labels.zip", "w", zipfile.ZIP_STORED) as lifted:
            for row in rows:
                name = row["image_id"]
                if name in left_out:
                    continue
                digests = {}
                for label, member in zip(LABELS, members[name], strict=True):
                    if archive.getinfo(member).file_size > MAX_LABEL_BYTES:
                        raise PrepareError(f"Label file larger than expected: {member}")
                    data = archive.read(member)
                    lifted.writestr(_fixed(f"{name}/{label}.nii.gz"), data)
                    digests[f"{label}.nii.gz"] = _sha256(data)
                cases.append({"subject": name, "meta": row, "sha256": digests})
    return _record(root, {"archive": ARCHIVE, "labels": list(LABELS)}, left_out, cases)


def _fixed(name: str) -> zipfile.ZipInfo:
    """An entry with a fixed date, so the same labels give the same file."""
    return zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))


def _record(root: Path, source: dict, left_out: list[str], cases: list[dict]) -> dict:
    digest = hashlib.sha256()
    with (root / "labels.zip").open("rb") as file:
        for chunk in iter(lambda: file.read(1 << 20), b""):
            digest.update(chunk)
    record = {
        "source": source,
        "labels_zip_sha256": digest.hexdigest(),
        "left_out": left_out,
        "cases": cases,
    }
    staged = root / "set.json.partial"
    staged.write_text(json.dumps(record, indent=1) + "\n", encoding="utf-8")
    os.replace(staged, root / "set.json")
    return record


AVT_ARCHIVES = ("Dongyang.zip", "KiTS.zip", "Rider.zip")


def avt_cases(names: list[str]) -> dict:
    """The label file of each case in one collection's listing, by case.

    A case is a folder `<collection>/<case><anything>/` holding
    `<case>.seg.nrrd`; a folder's name may carry a note after the case, as in
    `R1 (AD)`. The sidecar files a Mac leaves in an archive are not cases.
    """
    found = {}
    for name in names:
        parts = name.split("/")
        if len(parts) != 3 or not parts[2].endswith(".seg.nrrd") or parts[2].startswith("._"):
            continue
        case = parts[2][: -len(".seg.nrrd")]
        if not case.isalnum() or not parts[1].startswith(case) or case in found:
            raise PrepareError(f"Not a case's label file: {name}")
        found[case] = {"collection": parts[0], "folder": parts[1], "member": name}
    return found


def prepare_avt(source: Path, destination: Path) -> dict:
    root = outside_repository(destination)
    listed = _listed(source)
    paths = [fetched_archive(source / name, name, listed) for name in AVT_ARCHIVES]
    cases = []
    created_outside(root)
    (root / "set.json").unlink(missing_ok=True)
    with zipfile.ZipFile(root / "labels.zip", "w", zipfile.ZIP_STORED) as lifted:
        for path in paths:
            with zipfile.ZipFile(path) as archive:
                found = avt_cases(archive.namelist())
                for case in sorted(found, key=lambda c: (c[0], int(c[1:]))):
                    if archive.getinfo(found[case]["member"]).file_size > MAX_LABEL_BYTES:
                        raise PrepareError(f"Label file larger than expected: {case}")
                    data = archive.read(found[case]["member"])
                    lifted.writestr(_fixed(f"{case}.seg.nrrd"), data)
                    cases.append(
                        {
                            "subject": case,
                            "meta": found[case],
                            "sha256": {f"{case}.seg.nrrd": _sha256(data)},
                        }
                    )
    return _record(root, {"archives": list(AVT_ARCHIVES)}, [], cases)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    parser.add_argument("set", choices=("totalsegmentator", "avt"))
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args(argv)
    try:
        prepare = prepare_avt if args.set == "avt" else prepare_totalsegmentator
        record = prepare(args.source, args.destination)
    except (PrepareError, FetchError, OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(f"prepared {len(record['cases'])} cases, left out {len(record['left_out'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
