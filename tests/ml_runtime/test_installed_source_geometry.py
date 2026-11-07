"""Real geometry worker using a new synthetic, manifest-installed image identity."""

import hashlib
import json
import os

import pytest

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Requires isolated imaging runtime", allow_module_level=True)

import nibabel as nib
import numpy as np


def test_new_installed_source_runs_real_native_mask_geometry(tmp_path, monkeypatch):
    from planner import image_source
    from planner.geometry_contract import CALCULATION_VERSION
    from planner.geometry_worker import compute_job
    from planner.segmentation_worker import _source_bundle

    root = tmp_path / "installed" / "synthetic-new-source"
    root.mkdir(parents=True)
    monkeypatch.setattr(image_source, "INSTALLED_SOURCES_ROOT", root.parent)
    sac = np.zeros((22, 23, 24), dtype=np.uint8)
    sac[5:12, 6:13, 8:16] = 1
    vessel = np.zeros_like(sac)
    vessel[6:11, 7:12, 2:21] = 1

    def save(array, path):
        obj = nib.Nifti1Image(array, np.eye(4))
        obj.header.set_xyzt_units("mm", "sec")
        nib.save(obj, path)
        return hashlib.sha256(path.read_bytes()).hexdigest()

    source = root / "context-cta.nii.gz"
    sha = save(np.zeros_like(sac, dtype=np.int16), source)
    manifest = {
        "version": 1,
        "clinical_validation": False,
        "source_provenance": {"data_scope": "synthetic"},
        "image": {
            "sha256": sha,
            "filename": source.name,
            "dtype": "int16",
            "bytes": source.stat().st_size,
            "shape_xyz": list(sac.shape),
            "spatial_units": "mm",
            "affine_ras": np.eye(4).tolist(),
        },
    }
    (root / "manifest.json").write_text(json.dumps(manifest))
    _, revision, _, units = _source_bundle({"source_id": root.name})
    assert units == "mm" and revision != sha
    blob_dir = tmp_path / "results"
    blobs = blob_dir / "blobs"
    blobs.mkdir(parents=True)
    masks = {}
    for role, array in [("aneurysm", sac), ("vessel", vessel)]:
        path = tmp_path / f"{role}.nii.gz"
        digest = save(array, path)
        path.rename(blobs / f"{digest}.nii.gz")
        masks[role] = {"candidate_id": role, "mask_sha256": digest, "segmentation_revision": 1}
    operator = {
        "neck_origin": [8.0, 9.0, 9.2],
        "neck_normal": [0.0, 0.0, 1.0],
        "aneurysm_seed": [8.0, 9.0, 11.0],
        "parent_path": [[8.0, 9.0, 4.2], [8.0, 9.0, 6.2], [8.0, 9.0, 18.2], [8.0, 9.0, 19.2]],
        "proximal_index": 1,
        "distal_index": 2,
    }
    dependencies = {
        "case_id": "synthetic",
        "image_sha256": sha,
        "source_revision": revision,
        "calculation_version": CALCULATION_VERSION,
        "masks": masks,
        "operator_sha256": hashlib.sha256(
            json.dumps(operator, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest(),
    }
    job = {
        "case_id": "synthetic",
        "image_sha256": sha,
        "source_id": root.name,
        "reference_revision": revision,
        "dependencies": dependencies,
        "operator_inputs": operator,
    }
    result = compute_job(job, blob_dir=blob_dir)
    assert result["image_sha256"] == sha
    assert result["reference_revision"] == revision
    assert result["source_id"] == root.name
    assert result["sac"]["volume"] > 0
    assert result["clinical_validation"] is False
    assert result["morphometric_indices"]["clinical_suitability_established"] is False
