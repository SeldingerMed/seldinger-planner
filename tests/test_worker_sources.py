"""Source selection is fixed/opaque; product jobs cannot choose filesystem paths."""

from types import SimpleNamespace

import pytest

from planner import segmentation_worker as worker


@pytest.mark.parametrize(
    "source_id", ["zenodo-case006-calibrated", "zenodo-case006-planning-context"]
)
def test_calibrated_worker_metadata_does_not_claim_curated_annotation(source_id):
    metadata = worker._source_context_metadata({"source_id": source_id, "kind": "aneurysm"})
    assert metadata["source_id"] == source_id
    assert metadata["input_context"] == "server_installed_calibrated_reference_informed_context"
    assert metadata["source_annotation_registration_validated"] is False
    assert "curated_reference_case" not in str(metadata)


def test_unknown_source_id_is_rejected_before_filesystem_or_model_work():
    with pytest.raises(ValueError, match="source"):
        worker._source_bundle({"source_id": "../../other-source"})


@pytest.mark.parametrize(
    "source_id", ["zenodo-case006-calibrated", "zenodo-case006-planning-context"]
)
def test_calibrated_worker_source_uses_provider_path_not_job_path(tmp_path, monkeypatch, source_id):
    path = tmp_path / "trusted-provider-image.nii.gz"
    bundle = ({"image": {"sha256": "a" * 64}}, "b" * 64, {"image": path})
    from planner import image_source

    monkeypatch.setattr(
        image_source, "CalibratedSourceStore", lambda: SimpleNamespace(load=lambda: bundle)
    )
    monkeypatch.setattr(
        image_source, "PlanningSourceStore", lambda: SimpleNamespace(load=lambda: bundle)
    )
    data, revision, selected, units = worker._source_bundle(
        {"source_id": source_id, "image_path": "/untrusted/never-read.nii.gz"}
    )
    assert data is bundle[0]
    assert revision == "b" * 64
    assert selected == path
    assert units == "mm"
