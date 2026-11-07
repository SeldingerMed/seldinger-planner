"""Synthetic worker geometry contracts, never reported as real model results."""

import hashlib
import json
import os

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1", reason="Separate ML runtime only"
)


def correction_fixture(tmp_path, monkeypatch):
    import nibabel as nib
    import numpy as np

    import planner.segmentation_worker as worker

    ref = tmp_path / "reference"
    ref.mkdir()
    affine = np.diag([-0.5, -0.75, 1.25, 1.0])
    source = nib.Nifti1Image(np.arange(168, dtype=np.float32).reshape(6, 7, 4), affine)
    source.header.set_xyzt_units("mm")
    source_path = ref / "reference-cta.nii.gz"
    nib.save(source, source_path)
    image_hash = hashlib.sha256(source_path.read_bytes()).hexdigest()
    manifest = json.dumps({"image": {"sha256": image_hash}}).encode()
    (ref / "manifest.json").write_bytes(manifest)
    reference_revision = hashlib.sha256(manifest).hexdigest()
    base = np.zeros(source.shape, dtype=np.uint8)
    base[1, 1, 0] = base[4, 5, 3] = base[2, 3, 2] = 1
    blobs = tmp_path / "blobs"
    blobs.mkdir()
    initial_path = blobs / "initial.nii.gz"
    mask = nib.Nifti1Image(base, source.affine, header=source.header.copy())
    mask.set_data_dtype(np.uint8)
    nib.save(mask, initial_path)
    mask_hash = hashlib.sha256(initial_path.read_bytes()).hexdigest()
    initial_path.rename(blobs / (mask_hash + ".nii.gz"))
    monkeypatch.setattr(worker, "REFERENCE_DIR", ref)
    monkeypatch.setattr(worker, "REFERENCE_IMAGE", source_path)
    monkeypatch.setattr(worker, "MASK_BLOB_DIR", blobs, raising=False)
    job = {
        "case_id": "synthetic-case",
        "image_sha256": image_hash,
        "reference_revision": reference_revision,
        "kind": "sam2",
        "role": "aneurysm",
        "artifact_version": "2",
        "point_ras": [-1.0, -2.25, 2.5],
        "point_label": 0,
        "display_window": [0, 600],
        "base_mask": {
            "candidate_id": "synthetic-base",
            "mask_sha256": mask_hash,
            "image_sha256": image_hash,
            "reference_revision": reference_revision,
            "segmentation_revision": 1,
            "producer": "aneurysm_model",
        },
    }
    out = tmp_path / "out"
    out.mkdir()
    return worker, job, out, base


def test_sam_prior_splices_only_selected_native_slice_preserving_all_other_voxels(
    tmp_path, monkeypatch
):
    import nibabel as nib
    import numpy as np

    import planner.sam_refinement as sam

    worker, job, out, base = correction_fixture(tmp_path, monkeypatch)
    corrected_plane = np.zeros((7, 6), dtype=np.uint8)
    corrected_plane[3, 1] = 1

    def fake_refine(image, **kwargs):
        assert "initial_mask" in kwargs, "Existing mask must initialize the actual predictor"
        np.testing.assert_array_equal(kwargs["initial_mask"], base[:, :, 2].T)
        assert kwargs["labels"] == [0]
        return {
            "mask": corrected_plane,
            "initial_mask_used": True,
            "method": "synthetic_stub",
            "score": 0.5,
        }

    monkeypatch.setattr(sam, "refine_slice", fake_refine)
    metadata = worker._run_job(job, out)
    result = np.asarray(nib.load(out / "mask.nii.gz").dataobj)
    expected = base.copy()
    expected[:, :, 2] = corrected_plane.T
    np.testing.assert_array_equal(result, expected)
    assert result[1, 1, 0] == result[4, 5, 3] == 1
    assert result[2, 3, 2] == 0
    assert metadata["segmentation_extent"] == "single_slice_edit_of_existing_mask"
    assert metadata["correction_base"] == job["base_mask"]
    assert metadata["point_label"] == 0
    assert metadata["point_ras"] == job["point_ras"]
    assert metadata["prompt_native_ijk"] == [2.0, 3.0, 2]
    assert metadata["prompt_box_native_xyxy"] == [0.0, 0.0, 5.0, 6.0]
    assert metadata["clinical_validation"] == "none"
    assert metadata["three_dimensional_propagation"] is False
    assert metadata["volumetric_morphometry_eligible"] is False
