"""Synthetic native masks; no learned predictions or clinical validation."""

import math
import os

import pytest

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Requires isolated imaging runtime", allow_module_level=True)
import numpy as np


def fixture_inputs():
    return {
        "neck_origin": [8.0, 9.0, 9.2],
        "neck_normal": [0.0, 0.0, 1.0],
        "aneurysm_seed": [8.0, 9.0, 11.0],
        "parent_path": [[8.0, 9.0, 4.2], [8.0, 9.0, 6.2], [8.0, 9.0, 18.2], [8.0, 9.0, 19.2]],
        "proximal_index": 1,
        "distal_index": 2,
    }


def fixture_masks():
    sac = np.zeros((22, 23, 24), dtype=np.uint8)
    sac[5:12, 6:13, 8:16] = 1
    vessel = np.zeros_like(sac)
    vessel[6:11, 7:12, 2:21] = 1
    return sac, vessel


def test_compute_job_validates_actual_source_and_mask_blobs(tmp_path, monkeypatch):
    import hashlib
    import json

    import nibabel as nib

    from planner import geometry_worker as worker
    from planner import segmentation_worker
    from planner.geometry_contract import CALCULATION_VERSION

    def install(data, path):
        image = nib.Nifti1Image(data, np.eye(4))
        image.header.set_xyzt_units("mm", "sec")
        nib.save(image, path)
        return hashlib.sha256(path.read_bytes()).hexdigest()

    sac, vessel = fixture_masks()
    source = tmp_path / "source.nii.gz"
    digest = install(np.zeros_like(sac, dtype=np.int16), source)
    blobs = tmp_path / "blobs"
    blobs.mkdir()
    masks = {}
    for role, data in [("aneurysm", sac), ("vessel", vessel)]:
        path = tmp_path / f"{role}.nii.gz"
        sha = install(data, path)
        path.rename(blobs / f"{sha}.nii.gz")
        masks[role] = {"candidate_id": role, "mask_sha256": sha, "segmentation_revision": 1}
    inputs = fixture_inputs()
    input_hash = hashlib.sha256(
        json.dumps(inputs, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    ).hexdigest()
    deps = {
        "case_id": "synthetic",
        "image_sha256": digest,
        "source_revision": "b" * 64,
        "operator_sha256": input_hash,
        "masks": masks,
        "calculation_version": CALCULATION_VERSION,
        "artifact_version": "4",
    }
    job = {
        "case_id": "synthetic",
        "image_sha256": digest,
        "reference_revision": "b" * 64,
        "source_id": "zenodo-case006-calibrated",
        "dependencies": deps,
        "operator_inputs": inputs,
    }
    monkeypatch.setattr(
        segmentation_worker,
        "_source_bundle",
        lambda _job: ({"image": {"sha256": digest}}, "b" * 64, source, "mm"),
    )
    result = worker.compute_job(job, blob_dir=blobs.parent)
    assert result["sac"]["height"] == pytest.approx(6.3)
    assert result["reference_revision"] == "b" * 64
    job["dependencies"]["masks"]["aneurysm"]["mask_sha256"] = "../../bad"
    with pytest.raises(ValueError, match="identity"):
        worker.compute_job(job, blob_dir=blobs.parent)


def test_duplicate_station_positions_are_not_two_parent_sections():
    from planner.geometry_worker import compute_native_geometry

    sac, vessel = fixture_masks()
    inputs = fixture_inputs()
    inputs["parent_path"][2] = inputs["parent_path"][1][:]
    with pytest.raises(ValueError, match="distinct"):
        compute_native_geometry(sac, vessel, np.eye(4), inputs)


def test_zero_local_tangent_is_rejected_by_geometry_core():
    from planner.geometry_worker import compute_native_geometry

    sac, vessel = fixture_masks()
    inputs = fixture_inputs()
    inputs["parent_path"][0] = inputs["parent_path"][2][:]
    with pytest.raises(ValueError, match="normal"):
        compute_native_geometry(sac, vessel, np.eye(4), inputs)


def test_all_operator_path_samples_require_segmented_vessel_support():
    from planner.geometry_worker import compute_native_geometry

    sac, vessel = fixture_masks()
    inputs = fixture_inputs()
    inputs["parent_path"][0] = [0.0, 0.0, 0.0]
    with pytest.raises(ValueError, match="foreground"):
        compute_native_geometry(sac, vessel, np.eye(4), inputs)


def test_parent_station_inside_sac_is_refused_not_presented_as_parent_caliber():
    from planner.geometry_worker import compute_native_geometry

    sac, vessel = fixture_masks()
    inputs = fixture_inputs()
    inputs["parent_path"][2] = [8.0, 9.0, 12.2]
    with pytest.raises(ValueError, match="overlap"):
        compute_native_geometry(sac, vessel, np.eye(4), inputs)


def test_native_mask_geometry_has_independent_half_voxel_expectations():
    from planner.geometry_worker import compute_native_geometry

    sac, vessel = fixture_masks()
    result = compute_native_geometry(sac, vessel, np.eye(4), fixture_inputs())
    assert result["sac"]["height"] == pytest.approx(6.3)
    assert result["sac"]["width"] == pytest.approx(math.sqrt(85))
    assert result["neck"]["area"] == pytest.approx(48.5)
    for role in ("proximal_parent", "distal_parent"):
        assert result[role]["area"] == pytest.approx(24.5)
        assert result[role]["max_diameter"] == pytest.approx(math.sqrt(41))
        assert result[role]["min_diameter"] == pytest.approx(5.0)
        assert result[role]["plane_normal"] == pytest.approx([0, 0, 1])
    assert result["spatial_units"] == "mm"
    assert result["validated_morphometry"] is False
    assert result["clinical_validation"] is False
    assert "web_targets" not in result and "pipeline_eval" not in result
