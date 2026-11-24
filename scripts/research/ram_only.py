#!/usr/bin/env python3
"""Run one research command with every file write confined to a RAM disk.

The research drive is below its free-space floor and the internal disk takes
no research data, temporary files, caches or logs. This wrapper:

  1. checks that MOUNT is the mount point of an ``hdiutil`` image whose path
     is ``ram://...`` (memory-backed, not a file on a disk);
  2. points TMPDIR and HOME inside it and drops every other environment
     variable but PATH;
  3. runs the command under ``sandbox-exec`` with a profile that denies every
     file write except under MOUNT and to the standard output devices.

Reads stay allowed, so approved public inputs on the research drive are read
in place. A library that tries to write anywhere else fails instead of
falling back to the internal disk.

  python3 scripts/research/ram_only.py /Volumes/SeldingerRAM -- python3 job.py

Create the RAM disk first, for example 2 GiB:
  diskutil erasevolume HFS+ SeldingerRAM $(hdiutil attach -nomount ram://4194304)
and detach it afterwards with ``hdiutil detach``; its contents are gone then.
"""

import os
import plistlib
import re
import subprocess
import sys
from pathlib import Path

SANDBOX_EXEC = "/usr/bin/sandbox-exec"
_SAFE_PATH = re.compile(r"/[A-Za-z0-9._/ -]+")
_KEPT = ("PATH",)


class RamOnlyError(RuntimeError):
    pass


def ram_device_for(mount: str, hdiutil_info: bytes) -> str:
    """The device of the RAM-backed image mounted at ``mount``, or raise."""
    info = plistlib.loads(hdiutil_info)
    for image in info.get("images", []):
        for entity in image.get("system-entities", []):
            if entity.get("mount-point") == mount:
                if not str(image.get("image-path", "")).startswith("ram://"):
                    raise RamOnlyError(f"{mount} is not a RAM-backed image")
                return str(entity["dev-entry"])
    raise RamOnlyError(f"{mount} is not a mounted disk image")


def sandbox_profile(mount: str) -> str:
    if not _SAFE_PATH.fullmatch(mount) or ".." in mount:
        raise RamOnlyError("Unexpected characters in the RAM disk path")
    return (
        "(version 1)(allow default)(deny file-write*)"
        f'(allow file-write* (subpath "{mount}")'
        ' (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr")'
        ' (literal "/dev/dtracehelper") (regex #"^/dev/fd/") (regex #"^/dev/tty"))'
    )


def confined_environment(mount: str, environ) -> dict:
    env = {key: environ[key] for key in _KEPT if key in environ}
    env.update(
        TMPDIR=f"{mount}/tmp",
        HOME=f"{mount}/home",
        PYTHONDONTWRITEBYTECODE="1",
        MPLBACKEND="Agg",
        MPLCONFIGDIR=f"{mount}/home/mpl",
    )
    return env


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) < 3 or argv[1] != "--":
        print(__doc__, file=sys.stderr)
        return 2
    mount = os.path.realpath(argv[0])
    info = subprocess.run(
        ["/usr/bin/hdiutil", "info", "-plist"], capture_output=True, check=True, timeout=30
    ).stdout
    device = ram_device_for(mount, info)
    for name in ("tmp", "home"):
        Path(mount, name).mkdir(mode=0o700, exist_ok=True)
    print(f"ram_only: writes confined to {mount} ({device})", file=sys.stderr)
    env = confined_environment(mount, os.environ)
    os.execve(SANDBOX_EXEC, [SANDBOX_EXEC, "-p", sandbox_profile(mount), *argv[2:]], env)
    return 1  # not reached


if __name__ == "__main__":
    raise SystemExit(main())
