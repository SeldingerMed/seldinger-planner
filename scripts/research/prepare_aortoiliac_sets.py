#!/usr/bin/env python3
"""Lift the aorta and iliac labels out of the fetched TotalSegmentator set.

The set (Zenodo 10047292, CC BY 4.0) is one archive of 1,228 CT scans, each
with one label file per structure. The aorta and iliac model is measured
against three of them: `aorta`, `iliac_artery_left` and `iliac_artery_right`.

The step copies bytes and nothing else. For each case it writes, under the
destination:
  aorta.nii.gz, iliac_artery_left.nii.gz, iliac_artery_right.nii.gz
                   the three label files as the archive stores them
  subject.json     the case's row of the set's `meta.csv` (its split, study
                   type and pathology among them) and the digest of each file

and, once, `left-out.json`: the cases of `meta.csv` that lack one of the three
files. The archive is refused unless it is the fetched one: its size, and the
digest its fetch recorded (the source's own MD5 where no SHA-256 was taken).

The destination must lie outside the repository and on another storage
device. Nothing beyond the standard library is needed.
"""

import argparse
import csv
import hashlib
import io
import json
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_ljubljana import FetchError, created_outside, outside_repository
from prepare_bone_sets import _listed, _recorded_digest
from prepare_ljubljana import PrepareError, _sha256, publish

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


def prepare_totalsegmentator(
    source: Path, destination: Path, only: list[str] | None = None
) -> list[dict]:
    root = outside_repository(destination)
    path = fetched_archive(source / ARCHIVE, ARCHIVE, _listed(source))
    records = []
    with zipfile.ZipFile(path) as archive:
        held = set(archive.namelist())
        rows = cases_of(archive.read("meta.csv"))
        by_name = {row["image_id"]: row for row in rows}
        members = {
            name: [f"{name}/segmentations/{label}.nii.gz" for label in LABELS] for name in by_name
        }
        left_out = [name for name in by_name if not all(m in held for m in members[name])]
        if not only:
            # A whole-set run says which cases it could not lift.
            created_outside(root)
            (root / "left-out.json").write_text(json.dumps(sorted(left_out)) + "\n")
        for name in only or [name for name in by_name if name not in left_out]:
            if name not in by_name or name in left_out:
                raise PrepareError(f"No such case with all three labels: {name}")
            if (root / name / "subject.json").is_file():
                continue
            files = {}
            for label, member in zip(LABELS, members[name], strict=True):
                if archive.getinfo(member).file_size > MAX_LABEL_BYTES:
                    raise PrepareError(f"Label file larger than expected: {member}")
                files[f"{label}.nii.gz"] = archive.read(member)
            record = {
                "subject": name,
                "source": {"archive": ARCHIVE, "members": members[name]},
                "meta": by_name[name],
                "sha256": {file: _sha256(data) for file, data in files.items()},
            }
            publish(created_outside(root / name), files, record)
            records.append(record)
    return records


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    parser.add_argument("set", choices=("totalsegmentator",))
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--case", action="append", help="prepare this case only")
    args = parser.parse_args(argv)
    try:
        records = prepare_totalsegmentator(args.source, args.destination, args.case)
    except (PrepareError, FetchError, OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(f"prepared {len(records)} cases")
    return 0


if __name__ == "__main__":
    sys.exit(main())
