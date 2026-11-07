import hashlib

import pytest

from planner.model_assets import CheckpointSpec, ModelArtifactError, verified_checkpoint


def fixture(tmp_path):
    data = b"explicitly synthetic checkpoint bytes, not a torch model"
    path = tmp_path / "checkpoint.pth"
    path.write_bytes(data)
    return path, data, CheckpointSpec(len(data), hashlib.sha256(data).hexdigest())


def test_verified_checkpoint_returns_same_open_stream_at_byte_zero(tmp_path):
    path, data, spec = fixture(tmp_path)
    with verified_checkpoint(path, expected=spec) as stream:
        assert stream.tell() == 0
        assert stream.read() == data
    assert stream.closed


def test_wrong_hash_is_refused_before_consumer_can_load(tmp_path):
    path, data, _ = fixture(tmp_path)
    entered = False
    with (
        pytest.raises(ModelArtifactError, match="hash"),
        verified_checkpoint(path, expected=CheckpointSpec(len(data), "0" * 64)),
    ):
        entered = True
    assert not entered


def test_wrong_size_and_symlink_are_refused(tmp_path):
    path, data, spec = fixture(tmp_path)
    with (
        pytest.raises(ModelArtifactError, match="size"),
        verified_checkpoint(path, expected=CheckpointSpec(len(data) + 1, spec.sha256)),
    ):
        pytest.fail("Consumer must not run")
    link = tmp_path / "link.pth"
    link.symlink_to(path)
    with (
        pytest.raises(ModelArtifactError, match="symlink|open"),
        verified_checkpoint(link, expected=spec),
    ):
        pytest.fail("Consumer must not run")


def test_replacing_path_after_verification_does_not_replace_open_stream(tmp_path):
    path, data, spec = fixture(tmp_path)
    with verified_checkpoint(path, expected=spec) as stream:
        replacement = tmp_path / "replacement"
        replacement.write_bytes(b"different synthetic bytes")
        replacement.replace(path)
        assert stream.read() == data
