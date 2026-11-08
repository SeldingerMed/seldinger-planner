"""Bounded adversarial guards for the native loader; synthetic bytes only."""

import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path

import pytest

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Requires isolated imaging runtime", allow_module_level=True)

import nibabel as nib
import numpy as np

_SPEC = importlib.util.spec_from_file_location(
    "native_input_guards_physics_worker",
    Path(__file__).with_name("test_physics_worker.py"),
)
_installed_job_module = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_installed_job_module)
installed_job = _installed_job_module.installed_job


def _save_nifti(array, path, affine=None):
    affine = np.eye(4) if affine is None else affine
    obj = nib.Nifti1Image(array, affine)
    obj.header.set_xyzt_units("mm", "sec")
    nib.save(obj, path)
    return path.read_bytes()


def _resign_mask(job, blob_dir, role, payload):
    """Rehash a tampered mask and update the job dependency so only the
    loader's byte/hash binding is under test."""
    digest = hashlib.sha256(payload).hexdigest()
    (Path(blob_dir) / "blobs" / f"{digest}.nii.gz").write_bytes(payload)
    job["dependencies"]["masks"][role]["mask_sha256"] = digest
    return digest


def _tamper_mask_payload(job, blob_dir, role, mutate):
    role_dir = Path(blob_dir) / "blobs"
    old_digest = job["dependencies"]["masks"][role]["mask_sha256"]
    payload = (role_dir / f"{old_digest}.nii.gz").read_bytes()
    new_payload = mutate(payload)
    return _resign_mask(job, blob_dir, role, new_payload)


def test_tampered_mask_bytes_rejected_without_resign(tmp_path, monkeypatch):
    from planner.native_inputs import load_native_masks

    job, directory, _root, _vessel, _sac = installed_job(tmp_path, monkeypatch)
    role_dir = Path(directory) / "blobs"
    digest = job["dependencies"]["masks"]["vessel"]["mask_sha256"]
    blob = role_dir / f"{digest}.nii.gz"
    original = blob.read_bytes()
    # Flip one byte inside the stored payload, keep the approved hash.
    blob.write_bytes(original[:-1] + bytes([original[-1] ^ 0x01]))
    with pytest.raises(ValueError):
        load_native_masks(job, blob_dir=directory)
    # Adversary resigns the tampered bytes: hash passes but decode must yield
    # a non-binary or corrupt volume and be rejected.
    job["dependencies"]["masks"]["vessel"]["mask_sha256"] = hashlib.sha256(
        blob.read_bytes()
    ).hexdigest()
    with pytest.raises(ValueError):
        load_native_masks(job, blob_dir=directory)


def test_mask_calibration_mismatch_rejected_despite_approved_metadata(tmp_path, monkeypatch):
    from planner.native_inputs import load_native_masks

    job, directory, _root, vessel, _sac = installed_job(tmp_path, monkeypatch)
    # Scaled affine, same shape/dtype/units: rehashed so the hash layer is a
    # pass-through and only the calibration comparison can block it.
    scaled = _save_nifti(vessel, tmp_path / "scaled.nii.gz", affine=np.diag([2.0, 2.0, 2.0, 1.0]))
    _resign_mask(job, directory, "vessel", scaled)
    with pytest.raises(ValueError, match="calibration"):
        load_native_masks(job, blob_dir=directory)

    # Units mismatch (msec/none instead of mm): same rehash treatment.
    obj = nib.Nifti1Image(vessel, np.eye(4))
    obj.header.set_xyzt_units("unknown", "unknown")
    obj.header.set_sform(np.eye(4), code=1)
    nib.save(obj, tmp_path / "units.nii.gz")
    _resign_mask(job, directory, "vessel", (tmp_path / "units.nii.gz").read_bytes())
    with pytest.raises(ValueError):
        load_native_masks(job, blob_dir=directory)


def test_source_units_mismatch_rejected(tmp_path, monkeypatch):
    from planner.native_inputs import load_native_masks

    job, directory, root, _vessel, _sac = installed_job(tmp_path, monkeypatch)
    # Non-mm source calibration in the manifest-referenced file itself: the
    # manifest is re-signed around it so every hash gate passes. The units
    # guard fires (defense in depth: the installed-store mm check rejects
    # before the loader's own decoded-header mm check is reached).
    volume = np.zeros((22, 23, 24), dtype=np.int16)
    obj = nib.Nifti1Image(volume, np.eye(4))
    obj.header.set_xyzt_units("meter", "sec")
    path = root / "context-cta.nii.gz"
    nib.save(obj, path)
    manifest = json.loads((root / "manifest.json").read_text())
    manifest["image"]["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    manifest["image"]["bytes"] = path.stat().st_size
    (root / "manifest.json").write_text(json.dumps(manifest))
    # Installed-store revision is the sha256 of the manifest bytes.
    revision = hashlib.sha256((root / "manifest.json").read_bytes()).hexdigest()
    job["reference_revision"] = revision
    job["dependencies"]["source_revision"] = revision
    job["image_sha256"] = manifest["image"]["sha256"]
    job["dependencies"]["image_sha256"] = manifest["image"]["sha256"]
    with pytest.raises(ValueError):
        load_native_masks(job, blob_dir=directory)


def test_symlink_mask_and_ancestor_rejected(tmp_path, monkeypatch):
    from planner.native_inputs import load_native_masks

    # Symlinked mask blob.
    job, directory, _root, _vessel, _sac = installed_job(tmp_path, monkeypatch)
    role_dir = Path(directory) / "blobs"
    digest = job["dependencies"]["masks"]["vessel"]["mask_sha256"]
    target = tmp_path / "elsewhere.nii.gz"
    (role_dir / f"{digest}.nii.gz").rename(target)
    (role_dir / f"{digest}.nii.gz").symlink_to(target)
    with pytest.raises(ValueError, match="nonsymlink"):
        load_native_masks(job, blob_dir=directory)

    # Symlinked ancestor directory of the blob store (fresh fixture root).
    job, directory, _root, _vessel, _sac = installed_job(tmp_path / "second", monkeypatch)
    real = tmp_path / "second" / "real-results"
    directory.rename(real)
    Path(directory).symlink_to(real)
    with pytest.raises(ValueError, match="nonsymlink"):
        load_native_masks(job, blob_dir=directory)


def test_decompression_byte_cap(tmp_path, monkeypatch):
    from planner import native_inputs

    # Small stored payload, huge expansion; shrink the cap via monkeypatch so
    # no real bomb memory is allocated.
    monkeypatch.setattr(native_inputs, "MAX_RAW_BYTES", 4096)
    bomb = gzip.compress(b"\x00" * (4096 + 1) + b"\x00" * 351, 9)
    assert len(bomb) < 2048
    with pytest.raises(ValueError, match="bound"):
        native_inputs.decode_bytes(bomb)

    # At-cap decompressed payload is not itself rejected by size alone; a
    # truncated gzip stream is rejected rather than silently truncated.
    truncated = bomb[: len(bomb) // 2]
    with pytest.raises((ValueError, OSError, EOFError, gzip.BadGzipFile)):
        native_inputs.decode_bytes(truncated)


def test_exact_byte_decode_no_reread_between_hash_and_decode(tmp_path, monkeypatch):
    """TOCTOU probe: the bytes hashed are the bytes decoded, even if the file
    on disk is replaced after verification."""
    from planner import native_inputs
    from planner.physics_contract import ALGORITHM_VERSION, encoded

    job, directory, _root, vessel, sac = installed_job(tmp_path, monkeypatch)
    role_dir = Path(directory) / "blobs"
    digest = job["dependencies"]["masks"]["aneurysm"]["mask_sha256"]
    blob = role_dir / f"{digest}.nii.gz"
    calls = []

    real_open = Path.open

    def spying_open(self, *args, **kwargs):
        if args and args[0] == "rb" and self == blob:
            stream = real_open(self, *args, **kwargs)
            who = str(self)

            class SpyingReader:
                def __enter__(self):
                    return self

                def __exit__(self, *exc):
                    stream.close()
                    return False

                def read(self, n):
                    data = stream.read(n)
                    calls.append((who, len(data), hashlib.sha256(data).hexdigest()))
                    # Deterministically replace this exact owned blob after
                    # its read, before the loader hashes/decodes the payload.
                    with real_open(blob, "wb") as replacement:
                        replacement.write(b"replaced-after-read")
                    return data

            return SpyingReader()
        return real_open(self, *args, **kwargs)

    monkeypatch.setattr(Path, "open", spying_open)
    # The spy replaces the file before verification finishes. A later
    # pathname decode would consume corrupt bytes rather than this mask.
    arrays, affine = native_inputs.load_native_masks(job, blob_dir=directory)
    mask_reads = [r for r in calls if r[0] == str(blob)]
    assert len(mask_reads) == 1
    assert mask_reads[0][2] == digest
    with real_open(blob, "rb") as replacement:
        assert replacement.read() == b"replaced-after-read"
    assert np.array_equal(arrays["vessel"], vessel)
    assert np.array_equal(arrays["aneurysm"], sac)
    assert np.array_equal(affine, np.eye(4))
    # The decode used the in-memory payload, not a second disk open: verified
    # by exactly one read of the blob and correct decoded contents.
    assert ALGORITHM_VERSION == job["dependencies"]["algorithm_version"]
    assert (
        hashlib.sha256(encoded(job["operator_inputs"]).encode()).hexdigest()
        == (job["dependencies"]["geometry_dependencies"]["operator_sha256"])
    )
