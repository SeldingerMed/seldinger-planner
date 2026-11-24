"""The research wrapper that runs a command with writes confined to a RAM disk."""

import plistlib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "research"))

import ram_only


def hdiutil_plist(*images):
    return plistlib.dumps(
        {
            "images": [
                {
                    "image-path": path,
                    "system-entities": [{"dev-entry": dev, "mount-point": mount}],
                }
                for path, dev, mount in images
            ]
        }
    )


def test_a_ram_backed_mount_is_accepted():
    info = hdiutil_plist(
        ("/System/x.dmg", "/dev/disk7s1", "/Library/Other"),
        ("ram://4194304", "/dev/disk4", "/Volumes/SeldingerRAM"),
    )
    assert ram_only.ram_device_for("/Volumes/SeldingerRAM", info) == "/dev/disk4"


def test_a_file_backed_image_or_unknown_mount_is_refused():
    info = hdiutil_plist(("/Users/x/disk.dmg", "/dev/disk4", "/Volumes/SeldingerRAM"))
    with pytest.raises(ram_only.RamOnlyError):
        ram_only.ram_device_for("/Volumes/SeldingerRAM", info)
    with pytest.raises(ram_only.RamOnlyError):
        ram_only.ram_device_for("/Volumes/Elsewhere", hdiutil_plist())


def test_the_profile_denies_every_write_but_the_ram_disk_and_devices():
    profile = ram_only.sandbox_profile("/Volumes/SeldingerRAM")
    assert "(deny file-write*)" in profile
    assert '(subpath "/Volumes/SeldingerRAM")' in profile
    assert "/Users" not in profile and "/tmp" not in profile and "/var" not in profile


def test_a_path_with_quotes_cannot_escape_the_profile():
    with pytest.raises(ram_only.RamOnlyError):
        ram_only.sandbox_profile('/Volumes/x") (allow file-write*')


def test_the_environment_points_temporary_and_home_paths_into_the_ram_disk():
    env = ram_only.confined_environment(
        "/Volumes/SeldingerRAM", {"PATH": "/usr/bin", "SECRET": "x"}
    )
    assert env["TMPDIR"] == "/Volumes/SeldingerRAM/tmp"
    assert env["HOME"] == "/Volumes/SeldingerRAM/home"
    assert env["PYTHONDONTWRITEBYTECODE"] == "1"
    assert "SECRET" not in env
