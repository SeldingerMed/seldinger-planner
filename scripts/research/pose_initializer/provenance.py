"""What a research output records about the code that made it. Stdlib only."""

from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[3]


def code_state() -> dict:
    """Commit of the repository and whether the working tree differs from it."""

    def git(*arguments: str) -> str:
        return subprocess.run(
            ["git", "-C", str(REPOSITORY), *arguments],
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        ).stdout.strip()

    return {
        "commit": git("rev-parse", "HEAD"),
        "uncommitted_changes": bool(git("status", "--porcelain", "--", "scripts/research")),
    }


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def write_json(path: Path, value) -> None:
    """Write through a temporary name in the same directory, then rename."""
    partial = path.with_name(path.name + ".partial")
    partial.write_text(json.dumps(value, indent=1) + "\n")
    partial.replace(path)
