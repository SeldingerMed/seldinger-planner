"""Worker protocol using declared synthetic images and injected inference only."""

import os

import pytest

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Requires optional imaging runtime", allow_module_level=True)


def _source(tmp_path, monkeypatch):
    import hashlib

    import nibabel as nib
    import numpy as np

    from planner import segmentation_worker as worker

    path = tmp_path / "synthetic.nii.gz"
    image = nib.Nifti1Image(np.arange(60, dtype=np.int16).reshape(3, 4, 5), np.eye(4))
    image.header.set_xyzt_units("mm")
    nib.save(image, path)
    sha = hashlib.sha256(path.read_bytes()).hexdigest()
    data = {
        "image": {
            "sha256": sha,
            "shape_xyz": [3, 4, 5],
            "dtype": "int16",
            "affine_ras": np.eye(4).tolist(),
        },
        "crop": {"size_voxels": [3, 4, 5]},
    }
    monkeypatch.setattr(worker, "_source_bundle", lambda _: (data, "b" * 64, path, "mm"))
    job = {
        "kind": "rsna-vessel",
        "role": "vessel",
        "case_id": "synthetic-source-case",
        "image_sha256": sha,
        "reference_revision": "b" * 64,
        "source_id": "synthetic-installed",
        "display_window": [0, 600],
    }
    return worker, path, job


def test_rsna_worker_uses_fixed_runtime_and_vessel_role_without_owned_checkpoint(
    tmp_path, monkeypatch
):
    import nibabel as nib
    import numpy as np

    from planner import aneurysm_inference as adapter

    worker, _, job = _source(tmp_path, monkeypatch)
    calls = []

    def infer(data, affine, *, checkpoint_path, role):
        calls.append((checkpoint_path, role))
        return {"mask": (data > 30).astype(np.uint8), "synthetic_fixture": True}

    monkeypatch.setattr(adapter, "predict_aneurysm", infer)
    output = tmp_path / "output"
    output.mkdir()
    metadata = worker._run_job(job, output)
    assert worker._KIND_PYTHON["rsna-vessel"] == worker.ANEURYSM_PYTHON
    assert calls == [(worker.ANEURYSM_CHECKPOINT, "vessel")]
    assert metadata["producer"] == "rsna_vessel_model" and metadata["role"] == "vessel"
    assert metadata["foreground_count"] == 29
    mask = nib.load(output / "mask.nii.gz")
    assert mask.shape == (3, 4, 5) and mask.header.get_xyzt_units()[0] == "mm"
    np.testing.assert_array_equal(np.asarray(mask.dataobj), np.arange(60).reshape(3, 4, 5) > 30)


def test_worker_decodes_the_same_verified_source_bytes_not_a_path_reopen(tmp_path, monkeypatch):
    import nibabel as nib
    import numpy as np

    from planner import aneurysm_inference as adapter

    worker, path, job = _source(tmp_path, monkeypatch)
    original_load = nib.load

    def forbid_source_reopen(selected, *args, **kwargs):
        if str(selected) == str(path):
            raise AssertionError("Reopened source path after hash verification")
        return original_load(selected, *args, **kwargs)

    def infer(data, affine, **kwargs):
        np.testing.assert_array_equal(data, np.arange(60).reshape(3, 4, 5))
        return {"mask": data > 30, "synthetic_fixture": True}

    monkeypatch.setattr(nib, "load", forbid_source_reopen)
    monkeypatch.setattr(adapter, "predict_aneurysm", infer)
    output = tmp_path / "output"
    output.mkdir()
    assert worker._run_job(job, output)["foreground_count"] == 29


@pytest.mark.parametrize("invalid", [0.5, 256.0, -256.0, float("nan")])
def test_nonbinary_model_values_are_rejected_before_uint8_cast(tmp_path, monkeypatch, invalid):
    import numpy as np

    from planner import aneurysm_inference as adapter

    worker, _, job = _source(tmp_path, monkeypatch)
    monkeypatch.setattr(
        adapter,
        "predict_aneurysm",
        lambda data, affine, **kwargs: {"mask": np.full(data.shape, invalid)},
    )
    output = tmp_path / "output"
    output.mkdir()
    with pytest.raises(ValueError, match="binary"):
        worker._run_job(job, output)
    assert not (output / "mask.nii.gz").exists()


def test_changed_source_after_model_execution_cannot_publish_a_candidate(tmp_path, monkeypatch):
    import numpy as np

    from planner import aneurysm_inference as adapter

    worker, path, job = _source(tmp_path, monkeypatch)

    def infer(data, affine, **kwargs):
        path.write_bytes(b"changed during inference")
        return {"mask": np.ones(data.shape, dtype=np.uint8)}

    monkeypatch.setattr(adapter, "predict_aneurysm", infer)
    output = tmp_path / "output"
    output.mkdir()
    with pytest.raises(ValueError, match="hash|source"):
        worker._run_job(job, output)
    assert not (output / "mask.nii.gz").exists()


def test_every_installed_source_requires_actual_declared_mm_units(tmp_path, monkeypatch):
    import hashlib

    import nibabel as nib
    import numpy as np

    from planner import aneurysm_inference as adapter

    worker, path, job = _source(tmp_path, monkeypatch)
    image = nib.Nifti1Image(np.arange(60, dtype=np.int16).reshape(3, 4, 5), np.eye(4))
    nib.save(image, path)
    sha = hashlib.sha256(path.read_bytes()).hexdigest()
    worker._source_bundle(job)[0]["image"]["sha256"] = sha
    job["image_sha256"] = sha

    def infer(*args, **kwargs):
        raise AssertionError("Model ran before source calibration validation")

    monkeypatch.setattr(adapter, "predict_aneurysm", infer)
    output = tmp_path / "output"
    output.mkdir()
    with pytest.raises(ValueError, match="units|calibrat"):
        worker._run_job(job, output)
