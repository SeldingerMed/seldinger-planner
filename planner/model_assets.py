"""Verified local checkpoint access, without importing an ML runtime or unpickling.

Only trusted installation code chooses an expected identity. Product requests
must never supply model paths, expected hashes, or arbitrary checkpoint specs.
"""

import hashlib
import hmac
import os
import stat
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path


class ModelArtifactError(ValueError):
    """Registered model bytes could not be verified."""


@dataclass(frozen=True)
class CheckpointSpec:
    size_bytes: int
    sha256: str


OWNED_VESSEL_CHECKPOINT = CheckpointSpec(
    816174770,
    "120873508cec02b85e883dcdf2410c89fcdc53782d2d6fd3a001df739ee45db0",
)
OWNED_VESSEL_REVISION = "4f8253e0537770a7751916d274d3b83133bca8ff"

# Official pinned Kaggle version, exact fold acquired independently. Hash is
# acquisition provenance, not a pre-published upstream checksum manifest.
RSNA_ANEURYSM_CHECKPOINT = CheckpointSpec(
    875399410,
    "e60b539d025a8ecccf77d3ff1a45ef6888b5e059671cc8e24fff572d520fa521",
)
RSNA_ANEURYSM_REVISION = "pengchengshi/dataset660_26classes_resize224_4661/pytorch/default/2"
RSNA_ANEURYSM_SOURCE_REVISION = "1ead0ba4dc00bcd84591269995dde6a8446ca3ad"


@contextmanager
def verified_checkpoint(path: Path, *, expected: CheckpointSpec = OWNED_VESSEL_CHECKPOINT):
    """Yield the same verified read-only file handle, positioned at byte zero.

    Consumers should load from this handle rather than reopening a path after
    verification. This prevents path-replacement races, not hostile in-place
    writes by a local owner; installed runtime artifacts must remain immutable.
    Successful verification does not establish inference or model performance.
    """
    if path.is_symlink():
        raise ModelArtifactError("Checkpoint symlink is not permitted")
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        raise ModelArtifactError("Cannot open registered checkpoint") from None
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size != expected.size_bytes:
            raise ModelArtifactError("Checkpoint size or file type mismatch")
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
        if not hmac.compare_digest(actual, expected.sha256):
            raise ModelArtifactError("Checkpoint hash mismatch")
        stream.seek(0)
        yield stream
