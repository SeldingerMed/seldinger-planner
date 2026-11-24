"""The studio interchange must not include the source volume, mask, or file path."""

import json


def test_export_is_source_bound_geometry_only(monkeypatch, capsys):
    from planner import aortoiliac_export

    digest = "d" * 64
    proposal = {
        "method": "aortoiliac_widest_path_model_v1",
        "branches": [],
        "spatial_units": "mm",
        "operator_confirmation_required": True,
    }
    calls = []

    def infer(path, *, expected_sha256, device):
        calls.append((str(path), expected_sha256, device))
        return {
            "source_sha256": digest,
            "method": "aortoiliac_totalsegmentator_total_v1",
            "spatial_units": "mm",
            "operator_confirmation_required": True,
            "segmentation": {"mask_image": object()},
            "proposal": proposal,
        }

    monkeypatch.setattr(aortoiliac_export, "propose_aortoiliac_model_from_cta", infer)
    assert aortoiliac_export.main(["example.nii.gz", "--sha256", digest, "--device", "gpu"]) == 0
    assert calls == [("example.nii.gz", digest, "gpu")]
    assert json.loads(capsys.readouterr().out) == {
        "source_sha256": digest,
        "method": "aortoiliac_totalsegmentator_total_v1",
        "spatial_units": "mm",
        "operator_confirmation_required": True,
        "proposal": proposal,
    }
