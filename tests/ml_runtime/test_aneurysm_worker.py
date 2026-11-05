"""Opt-in real new-runtime worker contract on the authorized public context."""

import os
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("SELDINGER_RUN_ANEURYSM_TESTS") != "1",
    reason="Requires original installed public reference and aneurysm runtime",
)
ROOT = Path(__file__).resolve().parents[2]


def test_actual_aneurysm_worker_preserves_source_and_real_model_provenance(tmp_path):
    import hashlib
    import json

    import nibabel as nib
    import numpy as np

    from planner.segmentation_worker import run_local_model

    raw = (ROOT / ".runtime/public-reference/manifest.json").read_bytes()
    manifest = json.loads(raw)
    job = {
        "kind": "aneurysm",
        "role": "aneurysm",
        "case_id": "public-worker-check",
        "image_sha256": manifest["image"]["sha256"],
        "reference_revision": hashlib.sha256(raw).hexdigest(),
        "artifact_version": "1",
    }
    result = run_local_model(job, tmp_path)
    metadata = result["metadata"]
    assert metadata["producer"] == "aneurysm_model"
    assert metadata["role"] == "aneurysm" and metadata["slice_index"] is None
    assert metadata["segmentation_extent"] == "full_context_roi"
    assert metadata["automatic_aneurysm_segmentation_within_selected_context"] is True
    assert metadata["automatic_aneurysm_detection"] is False
    assert metadata["volumetric_morphometry_eligible"] is False
    assert metadata["clinical_validation"] == "none"
    assert metadata["provenance"]["selected_head"] == "merged_aneurysm_vessel_head_1"
    assert metadata["provenance"]["device"] == "mps"
    assert metadata["provenance"]["accepted"] is False
    assert "mask" not in metadata["provenance"]
    candidate = nib.load(result["mask_path"])
    source = nib.load(ROOT / ".runtime/public-reference/reference-cta.nii.gz")
    np.testing.assert_array_equal(candidate.affine, source.affine)
    assert (
        candidate.shape == source.shape
        and candidate.header.get_xyzt_units() == source.header.get_xyzt_units()
    )
    assert candidate.get_data_dtype() == np.uint8
    assert int(np.asarray(candidate.dataobj).sum()) == metadata["foreground_count"]
    assert (
        hashlib.sha256(result["mask_path"].read_bytes()).hexdigest()
        == "68666d83675e9d2be4f2e13f1efe6fc4140269b48dee2f5940a85ccadf474dc0"
    )
