"""The studio interchange must not include the source volume, mask, or file path."""

import json

import pytest


def proposal_result(digest, proposal):
    return {
        "source_sha256": digest,
        "method": "aortoiliac_totalsegmentator_total_v1",
        "spatial_units": "mm",
        "operator_confirmation_required": True,
        "segmentation": {"mask_image": object()},
        "proposal": proposal,
    }


PROPOSAL = {
    "method": "aortoiliac_widest_path_model_v1",
    "branches": [],
    "spatial_units": "mm",
    "operator_confirmation_required": True,
}


def test_export_is_source_bound_geometry_only(monkeypatch, capsys):
    from planner import aortoiliac_export

    digest = "d" * 64
    calls = []

    def infer(path, *, expected_sha256, device, runner=None):
        calls.append((str(path), expected_sha256, device, runner))
        return proposal_result(digest, PROPOSAL)

    monkeypatch.setattr(aortoiliac_export, "propose_aortoiliac_model_from_cta", infer)
    assert aortoiliac_export.main(["example.nii.gz", "--sha256", digest, "--device", "gpu"]) == 0
    assert calls == [("example.nii.gz", digest, "gpu", None)]
    assert json.loads(capsys.readouterr().out) == {
        "source_sha256": digest,
        "method": "aortoiliac_totalsegmentator_total_v1",
        "spatial_units": "mm",
        "operator_confirmation_required": True,
        "proposal": PROPOSAL,
    }


def test_installed_weights_run_in_memory_and_are_named_on_stderr(monkeypatch, capsys):
    from planner import aortoiliac_export

    digest = "e" * 64
    built, calls = [], []

    def runner(image, **kwargs):
        raise AssertionError("not called by the stand-in")

    runner.backend = {"backend": "nnunetv2_in_memory_installed_weights_v1", "device": "cpu"}

    def build(folder, *, device, threads):
        built.append((str(folder), device, threads))
        return runner

    def infer(path, *, expected_sha256, device, runner=None):
        calls.append((str(path), expected_sha256, device, runner))
        return proposal_result(digest, PROPOSAL)

    monkeypatch.setattr(aortoiliac_export, "installed_weights_runner", build)
    monkeypatch.setattr(aortoiliac_export, "propose_aortoiliac_model_from_cta", infer)
    argv = ["ct.nii.gz", "--sha256", digest, "--weights", "/w", "--threads", "6"]
    assert aortoiliac_export.main(argv) == 0
    assert built == [("/w", "cpu", 6)]
    assert calls == [("ct.nii.gz", digest, "cpu", runner)]
    out = capsys.readouterr()
    assert json.loads(out.out)["proposal"] == PROPOSAL
    assert "nnunetv2_in_memory_installed_weights_v1" in out.err


def test_threads_are_only_for_installed_weights():
    from planner import aortoiliac_export

    with pytest.raises(SystemExit):
        aortoiliac_export.main(["ct.nii.gz", "--sha256", "e" * 64, "--threads", "6"])
