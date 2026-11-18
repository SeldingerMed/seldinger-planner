"""Where the view initializer's research outputs may go. No volume is touched."""

import os
import plistlib
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "research"))
from pose_initializer import storage

UUID = "11111111-2222-3333-4444-555555555555"
GOOD = {"VolumeUUID": UUID, "Internal": False, "WritableVolume": True}


class OtherDevice:
    """Makes the fake repository look like it sits on another device."""

    def __init__(self, monkeypatch, repository):
        real = os.stat
        self.repository = str(repository)

        def stat(path, *args, **kwargs):
            found = real(path, *args, **kwargs)
            if str(path) == self.repository:
                return os.stat_result((*found[:2], found.st_dev + 1, *found[3:]))
            return found

        monkeypatch.setattr(storage.os, "stat", stat)


@pytest.fixture
def places(tmp_path, monkeypatch):
    repository = tmp_path / "repo"
    repository.mkdir()
    volume = tmp_path / "volume"
    volume.mkdir()
    monkeypatch.setattr(storage, "mount_point", lambda path: volume)
    OtherDevice(monkeypatch, repository)
    return repository, volume


def directory(target, repository, facts=GOOD, **more):
    return storage.external_directory(
        target,
        volume_uuid=UUID,
        repository=repository,
        facts=lambda mount: facts,
        min_free_bytes=more.pop("min_free_bytes", 1),
        **more,
    )


def test_a_directory_on_the_named_external_volume_is_created(places):
    repository, volume = places
    made = directory(volume / "runs" / "a", repository)
    assert made == (volume / "runs" / "a").resolve() and made.is_dir()


def test_the_repository_is_refused_before_anything_is_created(places):
    repository, _ = places
    for inside in (repository, repository / "data" / "frames"):
        with pytest.raises(storage.StorageError, match="outside the repository"):
            directory(inside, repository)
    assert not (repository / "data").exists()


@pytest.mark.parametrize(
    ("facts", "message"),
    [
        ({**GOOD, "VolumeUUID": "another"}, "not the named external volume"),
        ({"Internal": False, "WritableVolume": True}, "not the named external volume"),
        ({**GOOD, "Internal": True}, "not an external volume"),
        ({"VolumeUUID": UUID, "WritableVolume": True}, "not an external volume"),
        ({**GOOD, "WritableVolume": False}, "not writable"),
    ],
)
def test_any_other_volume_is_refused_and_nothing_is_created(places, facts, message):
    repository, volume = places
    with pytest.raises(storage.StorageError, match=message):
        directory(volume / "runs", repository, facts)
    assert not (volume / "runs").exists()


def test_a_full_volume_is_refused(places):
    repository, volume = places
    with pytest.raises(storage.StorageError, match="too little free space"):
        directory(volume / "runs", repository, min_free_bytes=2**62)


def test_the_repositorys_own_device_is_refused(tmp_path, monkeypatch):
    repository = tmp_path / "repo"
    repository.mkdir()
    volume = tmp_path / "volume"
    volume.mkdir()
    monkeypatch.setattr(storage, "mount_point", lambda path: volume)
    with pytest.raises(storage.StorageError, match="off the repository's device"):
        directory(volume / "runs", repository)


def test_a_symlink_into_the_repository_is_refused(places, tmp_path):
    repository, volume = places
    link = volume / "link"
    link.symlink_to(repository)
    with pytest.raises(storage.StorageError, match="outside the repository"):
        directory(link / "frames", repository)


def test_a_volume_that_changes_while_the_directory_is_made_is_refused(places):
    repository, volume = places
    answers = iter([GOOD, {**GOOD, "VolumeUUID": "swapped"}])
    with pytest.raises(storage.StorageError, match="not the named external volume"):
        storage.external_directory(
            volume / "runs",
            volume_uuid=UUID,
            repository=repository,
            facts=lambda mount: next(answers),
            min_free_bytes=1,
        )


class Listing:
    def __init__(self, stdout):
        self.stdout = stdout


@pytest.mark.parametrize(
    "outcome",
    [
        FileNotFoundError("no diskutil"),
        subprocess.CalledProcessError(1, "diskutil"),
        subprocess.TimeoutExpired("diskutil", 60),
        Listing(b"not a property list"),
        Listing(plistlib.dumps(["a", "list"])),
    ],
)
def test_a_volume_the_system_cannot_describe_is_refused(tmp_path, monkeypatch, outcome):
    def run(*args, **kwargs):
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr(storage.subprocess, "run", run)
    with pytest.raises(storage.StorageError, match="Could not identify"):
        storage.volume_facts(tmp_path)


def test_volume_facts_are_what_the_system_lists(tmp_path, monkeypatch):
    asked = []

    def run(command, **kwargs):
        asked.append((command, kwargs))
        return Listing(plistlib.dumps(GOOD))

    monkeypatch.setattr(storage.subprocess, "run", run)
    assert storage.volume_facts(tmp_path) == GOOD
    assert asked[0][0] == ["/usr/sbin/diskutil", "info", "-plist", str(tmp_path)]
    assert asked[0][1]["check"] is True


def test_the_mount_point_of_a_missing_path_is_that_of_its_nearest_ancestor(tmp_path):
    assert storage.mount_point(tmp_path / "not" / "there") == storage.mount_point(tmp_path)


def test_scratch_and_library_caches_follow_the_output_root(tmp_path, monkeypatch):
    for name in ("TMPDIR", "TORCH_HOME", "XDG_CACHE_HOME", "MPLCONFIGDIR"):
        monkeypatch.setenv(name, "/somewhere/else")
    scratch = storage.pin_scratch(tmp_path)
    assert scratch == tmp_path / "scratch" and scratch.is_dir()
    for name in ("TMPDIR", "TORCH_HOME", "XDG_CACHE_HOME", "MPLCONFIGDIR"):
        assert os.environ[name] == str(scratch)
