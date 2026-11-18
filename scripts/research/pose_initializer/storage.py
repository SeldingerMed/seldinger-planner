"""Where research outputs may be written: one named external volume.

Every prepared vessel model, generated frame, checkpoint, log, cache and
temporary file of this part goes to an attached external volume and never to
the internal disk. A path that merely starts with ``/Volumes`` proves
nothing, so the volume is identified by its UUID, read from the system, every
time a run starts. There is no fallback: a missing, renamed or read-only
volume stops the run. Stdlib only.
"""

from __future__ import annotations

import os
import plistlib
import shutil
import subprocess
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[3]
# Colin's "Training HD", the volume the storage policy names for this work.
TRAINING_VOLUME_UUID = "7CD85429-DA1B-3D84-89F5-3C2DA7AB14D4"
MIN_FREE_BYTES = 20 * 2**30


class StorageError(Exception):
    pass


def mount_point(path: Path) -> Path:
    """Mount point of the nearest existing ancestor of the resolved path."""
    anchor = path
    while not anchor.exists():
        anchor = anchor.parent
    while not os.path.ismount(anchor):
        anchor = anchor.parent
    return anchor


def volume_facts(mount: Path) -> dict:
    """What the system says about the volume mounted at ``mount`` (macOS)."""
    try:
        listing = subprocess.run(
            ["/usr/sbin/diskutil", "info", "-plist", str(mount)],
            check=True,
            capture_output=True,
            timeout=60,
        )
        found = plistlib.loads(listing.stdout)
        if not isinstance(found, dict):
            raise TypeError("not a property list of volume facts")
        return found
    except (
        OSError,
        TypeError,
        ValueError,
        subprocess.SubprocessError,
        plistlib.InvalidFileException,
    ) as error:
        raise StorageError(f"Could not identify the volume at {mount}") from error


def external_directory(
    directory: Path,
    *,
    volume_uuid: str = TRAINING_VOLUME_UUID,
    repository: Path = REPOSITORY,
    facts=volume_facts,
    min_free_bytes: int = MIN_FREE_BYTES,
) -> Path:
    """Resolve ``directory``, create it and return it, or refuse.

    Refused: a place inside the repository, a volume other than the named
    one, an internal or read-only volume, the repository's own device, and
    a volume with less than ``min_free_bytes`` free. The check runs again
    after the directory is created, since a mount can change in between.
    """
    resolved = directory.expanduser().resolve()
    root = repository.resolve()
    if resolved == root or root in resolved.parents:
        raise StorageError("Research outputs must lie outside the repository")

    def check() -> None:
        mount = mount_point(resolved)
        found = facts(mount)
        if found.get("VolumeUUID") != volume_uuid:
            raise StorageError(f"{mount} is not the named external volume")
        if found.get("Internal") is not False:
            raise StorageError(f"{mount} is not an external volume")
        if found.get("WritableVolume") is not True:
            raise StorageError(f"{mount} is not writable")
        if os.stat(mount).st_dev == os.stat(root).st_dev:
            raise StorageError("Research outputs must be off the repository's device")
        if shutil.disk_usage(mount).free < min_free_bytes:
            raise StorageError(f"{mount} has too little free space")

    check()
    resolved.mkdir(parents=True, exist_ok=True)
    if directory.expanduser().resolve() != resolved:
        raise StorageError("The output directory moved while it was being created")
    check()
    return resolved


def pin_scratch(root: Path) -> Path:
    """Send temporary files and library caches of this process under ``root``."""
    scratch = root / "scratch"
    scratch.mkdir(parents=True, exist_ok=True)
    for name in ("TMPDIR", "TORCH_HOME", "XDG_CACHE_HOME", "MPLCONFIGDIR"):
        os.environ[name] = str(scratch)
    return scratch
