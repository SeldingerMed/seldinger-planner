#!/usr/bin/env python3
"""Fetch the Hugging Face copy of the Ljubljana 3D-2D cerebral angiogram set.

Research evaluation only. The copy (dataset ``eigenvivek/xvr-data``, folder
``ljubljana/``) is CC BY-NC-ND 4.0 and is redistributed there with the
authors' permission. Nothing fetched here, and nothing made from it, belongs
in this repository: the destination must lie outside the repository and on a
different storage device from it.

The file list is read from the Hub at one pinned revision. Every file is
written through a temporary name, checked against the size the Hub lists and,
for large files, the SHA-256 the Hub lists, and then renamed. A file that is
already present with the right size and digest is kept. ``MANIFEST.json`` in
the destination records the revision and one size and SHA-256 per file.

Stdlib only. Example:
  python3 scripts/research/fetch_ljubljana.py /Volumes/External/ljubljana
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

DATASET = "eigenvivek/xvr-data"
FOLDER = "ljubljana"
# The dataset revision the evaluation protocol was written against.
REVISION = "7a46053ffba5cd3e10779b27cb0d010d0c06178b"
SUBJECTS = 10
MAX_FILES = 200
MAX_FILE_BYTES = 64 * 1024 * 1024
_HOST = "https://huggingface.co"
REPOSITORY = Path(__file__).resolve().parents[2]


class FetchError(Exception):
    pass


def outside_repository(destination: Path, repository: Path = REPOSITORY) -> Path:
    """Resolve ``destination`` and refuse a place that could reach git."""
    resolved = destination.expanduser().resolve()
    root = repository.resolve()
    if resolved == root or root in resolved.parents:
        raise FetchError("The destination must lie outside the repository")
    anchor = resolved
    while not anchor.exists():
        anchor = anchor.parent
    if os.stat(anchor).st_dev == os.stat(root).st_dev:
        raise FetchError(
            "The destination must be on a different storage device from the repository"
        )
    return resolved


def created_outside(directory: Path, repository: Path = REPOSITORY) -> Path:
    """Create ``directory`` and check again where it landed.

    The first check looks at the nearest existing ancestor. A mount can
    change between that check and the directory's creation.
    """
    directory.mkdir(parents=True, exist_ok=True)
    return outside_repository(directory, repository)


def _get(url: str, limit: int) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "seldinger-planner-research"})
    with urllib.request.urlopen(request, timeout=120) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise FetchError(f"Response larger than {limit} bytes: {url}")
    return data


def listing(revision: str) -> list[dict]:
    """Files of the folder at ``revision``: path, size and listed SHA-256."""
    url = (
        f"{_HOST}/api/datasets/{DATASET}/tree/{revision}/{FOLDER}"
        "?recursive=true&expand=false&limit=1000"
    )
    entries = json.loads(_get(url, 4 * 1024 * 1024))
    files = []
    for entry in entries:
        if entry.get("type") != "file":
            continue
        path, size = entry.get("path"), entry.get("size")
        parts = Path(path).parts if isinstance(path, str) else ()
        if (
            # The folder itself is not a file to fetch.
            len(parts) < 2
            or parts[0] != FOLDER
            or ".." in parts
            or Path(path).is_absolute()
            or type(size) is not int
            or not 0 <= size <= MAX_FILE_BYTES
        ):
            raise FetchError(f"Unexpected listing entry: {entry!r}")
        lfs = entry.get("lfs") or {}
        files.append({"path": path, "bytes": size, "listed_sha256": lfs.get("oid")})
    if not files or len(files) > MAX_FILES:
        raise FetchError(f"Unexpected number of files: {len(files)}")
    return sorted(files, key=lambda item: item["path"])


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _matches(path: Path, item: dict) -> str | None:
    if not path.is_file() or path.stat().st_size != item["bytes"]:
        return None
    found = _digest(path)
    listed = item["listed_sha256"]
    return found if listed is None or listed == found else None


def fetch(destination: Path, revision: str = REVISION) -> dict:
    root = outside_repository(destination)
    files = listing(revision)
    root = created_outside(root)
    records = []
    for item in files:
        relative = Path(item["path"]).relative_to(FOLDER)
        target = root / relative
        found = _matches(target, item)
        if found is None:
            target.parent.mkdir(parents=True, exist_ok=True)
            partial = target.with_name(target.name + ".partial")
            url = f"{_HOST}/datasets/{DATASET}/resolve/{revision}/" + urllib.parse.quote(
                item["path"]
            )
            partial.write_bytes(_get(url, item["bytes"]))
            found = _matches(partial, item)
            if found is None:
                partial.unlink()
                raise FetchError(f"Size or digest mismatch: {item['path']}")
            os.replace(partial, target)
        records.append({"path": relative.as_posix(), "bytes": item["bytes"], "sha256": found})
    manifest = {
        "dataset": DATASET,
        "folder": FOLDER,
        "revision": revision,
        "license": "CC BY-NC-ND 4.0",
        "files": records,
        "total_bytes": sum(record["bytes"] for record in records),
    }
    (root / "MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("destination", type=Path)
    parser.add_argument("--revision", default=REVISION)
    args = parser.parse_args(argv)
    try:
        manifest = fetch(args.destination, args.revision)
    except (FetchError, OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(
        f"{len(manifest['files'])} files, {manifest['total_bytes']} bytes, {manifest['revision']}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
