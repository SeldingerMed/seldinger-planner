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
    source.header.set_xyzt_units("unknown")  # This fixture uses the legacy unknown-unit registry.
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


def test_correction_uses_server_configured_blobs_not_global_default(tmp_path, monkeypatch):
    import planner.sam_refinement as sam

    worker, job, out, _ = correction_fixture(tmp_path, monkeypatch)
    configured = worker.MASK_BLOB_DIR
    monkeypatch.setattr(worker, "MASK_BLOB_DIR", tmp_path / "missing-default")
    monkeypatch.setattr(
        sam,
        "refine_slice",
        lambda image, **kwargs: {
            "mask": kwargs["initial_mask"],
            "initial_mask_used": True,
        },
    )
    metadata = worker._run_job(job, out, blob_dir=configured)
    assert metadata["correction_base"] == job["base_mask"]


def test_correction_decodes_the_hashed_bytes_without_reopening_path(tmp_path, monkeypatch):
    import nibabel as nib
    import numpy as np

    worker, job, _, base = correction_fixture(tmp_path, monkeypatch)
    source = nib.load(worker.REFERENCE_IMAGE)
    load = nib.load
    blob = worker.MASK_BLOB_DIR / (job["base_mask"]["mask_sha256"] + ".nii.gz")

    def replace_before_reopen(path, *args, **kwargs):
        if str(path) == str(blob):
            changed = base.copy()
            changed[0, 0, 0] = 1
            image = nib.Nifti1Image(changed, source.affine, header=source.header.copy())
            image.set_data_dtype(np.uint8)
            nib.save(image, blob)
            assert hashlib.sha256(blob.read_bytes()).hexdigest() != job["base_mask"]["mask_sha256"]
        return load(path, *args, **kwargs)

    monkeypatch.setattr(nib, "load", replace_before_reopen)
    observed = worker._load_correction_base(job, source)
    np.testing.assert_array_equal(observed, base)


def test_base_blob_change_during_model_execution_cannot_publish(tmp_path, monkeypatch):
    import planner.sam_refinement as sam

    worker, job, out, _ = correction_fixture(tmp_path, monkeypatch)
    blob = worker.MASK_BLOB_DIR / (job["base_mask"]["mask_sha256"] + ".nii.gz")

    def replace_during_inference(image, **kwargs):
        old = blob.read_bytes()
        changed = bytearray(old)
        changed[-1] ^= 1
        assert hashlib.sha256(changed).hexdigest() != job["base_mask"]["mask_sha256"]
        blob.write_bytes(changed)
        return {"mask": kwargs["initial_mask"], "initial_mask_used": True}

    monkeypatch.setattr(sam, "refine_slice", replace_during_inference)
    with pytest.raises(ValueError, match="hash"):
        worker._run_job(job, out)
    assert not (out / "mask.nii.gz").exists()
