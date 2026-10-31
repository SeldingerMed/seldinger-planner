"""Opt-in real-ML tests for the local segmentation worker contract.

Analytic coordinate tests and cheap subprocess-shape tests run in the isolated
ML runtime only (same gate as the other model tests). These tests never launch
the expensive owned-vessel forward pass and never touch the network.
"""

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1",
    reason="Requires separately installed ML runtime and hash-pinned model weights",
)

ROOT = Path(__file__).resolve().parents[2]
REFERENCE_IMAGE = ROOT / ".runtime/public-reference/reference-cta.nii.gz"


def _matrix(rows):
    import numpy as np

    return np.asarray(rows, dtype=np.float64)


# ---------------------------------------------------------------------------
# Analytic RAS -> native prompt coordinate tests
# ---------------------------------------------------------------------------


def test_identity_affine_returns_matching_in_plane_prompt_and_rounded_k():
    from planner.segmentation_worker import ras_to_native_prompt

    affine = _matrix([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]])
    assert ras_to_native_prompt((5.0, 7.0, 3.0), affine, (10, 11, 6)) == (5.0, 7.0, 3)


def test_reflected_affine_roundtrips_voxel_to_ras_and_back():
    import numpy as np

    from planner.segmentation_worker import ras_to_native_prompt

    # LPS-style negative diagonals with translation, like the installed reference.
    affine = _matrix([[-1, 0, 0, 100.0], [0, -1, 0, 50.0], [0, 0, 1, -10.0], [0, 0, 0, 1]])
    voxel = np.asarray([2, 3, 4], dtype=np.float64)
    ras = (affine @ np.asarray([*voxel, 1.0]))[:3]
    assert ras_to_native_prompt(tuple(ras), affine, (10, 10, 10)) == (2.0, 3.0, 4)


def test_translated_anisotropic_affine_roundtrip():
    import numpy as np

    from planner.segmentation_worker import ras_to_native_prompt

    affine = _matrix(
        [
            [0.5, 0, 0, 10.0],
            [0, 0.75, 0, 20.0],
            [0, 0, 1.25, 30.0],
            [0, 0, 0, 1],
        ]
    )
    voxel = np.asarray([8, 12, 5], dtype=np.float64)
    ras = (affine @ np.asarray([*voxel, 1.0]))[:3]
    assert ras_to_native_prompt(tuple(ras), affine, (20, 20, 10)) == (8.0, 12.0, 5)


def test_slice_index_is_rounded_to_nearest_native_axial_plane():
    from planner.segmentation_worker import ras_to_native_prompt

    affine = _matrix([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]])
    assert ras_to_native_prompt((1.0, 1.0, 3.4), affine, (5, 5, 6))[2] == 3
    assert ras_to_native_prompt((1.0, 1.0, 3.6), affine, (5, 5, 6))[2] == 4


def test_out_of_bounds_and_nonfinite_prompts_are_rejected():
    from planner.segmentation_worker import ras_to_native_prompt

    affine = _matrix([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]])
    with pytest.raises(ValueError):
        ras_to_native_prompt((-0.1, 1.0, 1.0), affine, (5, 5, 6))
    with pytest.raises(ValueError):
        ras_to_native_prompt((1.0, 5.0, 1.0), affine, (5, 5, 6))
    with pytest.raises(ValueError):
        ras_to_native_prompt((1.0, 1.0, 6.0), affine, (5, 5, 6))
    with pytest.raises(ValueError):
        ras_to_native_prompt((1.0, 1.0, float("nan")), affine, (5, 5, 6))


def test_prompt_box_is_clipped_strictly_inside_the_frame():
    from planner.segmentation_worker import clip_prompt_box

    assert clip_prompt_box(10, 10, 3, 32, 24) == [7.0, 7.0, 13.0, 13.0]
    assert clip_prompt_box(0, 23, 3, 32, 24) == [0.0, 20.0, 3.0, 23.0]
    assert clip_prompt_box(31, 0, 3, 32, 24) == [28.0, 0.0, 31.0, 3.0]
    with pytest.raises(ValueError):
        clip_prompt_box(10, 10, 1, 32, 24)  # radius below the API minimum of 2
    with pytest.raises(ValueError):
        clip_prompt_box(10, 10, 41, 32, 24)  # radius above the API maximum of 40


def test_xyz_plane_insertion_keeps_row_column_orientation():
    import numpy as np

    # Displayed plane is volume[:, :, k].T (rows J, cols I); the candidate mask
    # must be transposed back into XYZ so plane[j_row, i_col] lands at [i, j, k].
    plane_rows_j_cols_i = np.zeros((5, 4), dtype=np.uint8)
    plane_rows_j_cols_i[1, 2] = 1  # j=1, i=2
    k = 3
    mask_xyz = np.zeros((4, 5, 6), dtype=np.uint8)
    mask_xyz[:, :, k] = plane_rows_j_cols_i.T
    assert mask_xyz[2, 1, k] == 1
    assert mask_xyz[1, 2, k] == 0
    assert mask_xyz.sum() == 1


# ---------------------------------------------------------------------------
# Subprocess shape tests (no model weights loaded)
# ---------------------------------------------------------------------------


def test_module_import_pulls_in_no_heavy_libraries():
    probe = (
        "import sys, planner.segmentation_worker;"
        "print(sorted(m.split('.')[0] for m in sys.modules"
        " if m.split('.')[0] in {'numpy','nibabel','torch','torchio','sam2','nnunetv2'}))"
    )
    completed = subprocess.run(
        [sys.executable, "-c", probe],
        check=False,
        cwd=str(ROOT),
        capture_output=True,
        timeout=60,
    )
    assert completed.returncode == 0, completed.stderr.decode()
    assert json.loads(completed.stdout.decode()) == []


def test_subprocess_timeout_is_contract_fixed():
    from planner.segmentation_worker import SUBPROCESS_TIMEOUT_SECONDS

    assert SUBPROCESS_TIMEOUT_SECONDS == 180


def test_run_local_model_uses_ml_python_without_shell_and_reads_outputs(tmp_path, monkeypatch):
    import planner.segmentation_worker as worker

    recorded = {}

    class FakeCompleted:
        returncode = 0
        stdout = b""
        stderr = b""

    def fake_run(cmd, **kwargs):
        recorded["cmd"] = cmd
        recorded["kwargs"] = kwargs
        (tmp_path / "mask.nii.gz").write_bytes(b"nifti-bytes")
        (tmp_path / "metadata.json").write_text(json.dumps({"foreground_count": 3}))
        return FakeCompleted()

    monkeypatch.setattr(worker.subprocess, "run", fake_run)
    job = {"kind": "sam2", "case_id": "case-1"}
    result = worker.run_local_model(job, tmp_path)
    cmd = recorded["cmd"]
    assert cmd[:3] == [
        str(ROOT / ".runtime/ml-runtime/bin/python"),
        "-m",
        "planner.segmentation_worker",
    ]
    assert recorded["kwargs"]["timeout"] == 180
    assert recorded["kwargs"]["shell"] is False
    assert "input" in recorded["kwargs"] and json.loads(recorded["kwargs"]["input"]) == job
    assert result["mask_path"] == tmp_path / "mask.nii.gz"
    assert result["metadata"] == {"foreground_count": 3}


@pytest.mark.parametrize("mode", ["oversize", "symlink"])
def test_worker_metadata_is_bounded_before_reading(tmp_path, monkeypatch, mode):
    import planner.segmentation_worker as worker

    def fake_run(command, **kwargs):
        (tmp_path / "mask.nii.gz").write_bytes(b"explicit synthetic subprocess fixture")
        path = tmp_path / "metadata.json"
        if mode == "oversize":
            path.write_text(json.dumps({"padding": "x" * 32768}))
        else:
            target = tmp_path / "other.json"
            target.write_text("{}")
            path.symlink_to(target)
        return subprocess.CompletedProcess(command, 0, b"", b"")

    monkeypatch.setattr(worker.subprocess, "run", fake_run)
    with pytest.raises(RuntimeError, match="metadata"):
        worker.run_local_model({"kind": "vessel"}, tmp_path)


def test_failed_worker_raises_sanitized_runtime_error(tmp_path, monkeypatch):
    import planner.segmentation_worker as worker

    class FakeFailed:
        returncode = 1
        stdout = b""
        stderr = b"internal failure"

    def fake_run(cmd, **kwargs):
        return FakeFailed()

    monkeypatch.setattr(worker.subprocess, "run", fake_run)
    with pytest.raises(RuntimeError) as excinfo:
        worker.run_local_model({"kind": "vessel"}, tmp_path)
    message = str(excinfo.value)
    assert str(ROOT) not in message
    assert "Traceback" not in message


# ---------------------------------------------------------------------------
# End-to-end worker against the installed original public reference (real SAM)
# ---------------------------------------------------------------------------


def test_run_local_model_sam2_prompted_slice_end_to_end(tmp_path):
    import nibabel as nib
    import numpy as np

    from planner.segmentation_worker import ras_to_native_prompt, run_local_model

    manifest = json.loads((ROOT / ".runtime/public-reference/manifest.json").read_text())
    reference_revision = hashlib.sha256(
        (ROOT / ".runtime/public-reference/manifest.json").read_bytes()
    ).hexdigest()
    assert reference_revision != manifest["image"]["sha256"]
    source = nib.load(str(REFERENCE_IMAGE))
    voxel = np.asarray([87, 90, 70], dtype=np.float64)
    point_ras = (source.affine @ np.asarray([*voxel, 1.0]))[:3]
    _i, _j, k = ras_to_native_prompt(tuple(point_ras), source.affine, source.shape)

    job = {
        "case_id": "public-reference-case",
        "image_sha256": manifest["image"]["sha256"],
        "reference_revision": reference_revision,
        "artifact_version": "v1",
        "kind": "sam2",
        "role": "aneurysm",
        "point_ras": [float(v) for v in point_ras],
        "radius_voxels": 6,
        "display_window": [0, 600],
    }
    result = run_local_model(job, tmp_path)
    assert result["mask_path"] == tmp_path / "mask.nii.gz"
    metadata = result["metadata"]

    mask_image = nib.load(str(tmp_path / "mask.nii.gz"))
    mask = np.asanyarray(mask_image.dataobj)
    assert mask.shape == source.shape
    assert mask_image.get_data_dtype() == np.uint8
    assert mask_image.header.get_xyzt_units() == source.header.get_xyzt_units()
    assert np.allclose(mask_image.affine, source.affine)
    assert set(np.unique(mask)).issubset({0, 1})

    assert metadata["image_sha256"] == manifest["image"]["sha256"]
    assert metadata["reference_revision"] == reference_revision
    assert metadata["native_shape"] == [175, 180, 140]
    assert metadata["source_units"] == "unknown"
    assert metadata["source_dtype"] == "float64"
    assert metadata["display_window"] == [0, 600]
    assert np.allclose(metadata["source_affine"], source.affine)
    assert metadata["slice_index"] == k
    assert metadata["segmentation_extent"] == "single_native_axial_slice"
    assert metadata["volumetric_morphometry_eligible"] is False
    assert metadata["prompt_provenance"] == "operator_entered"
    assert metadata["automatic_aneurysm_detection"] is False
    assert metadata["foreground_count"] == int((mask == 1).sum())
    # A fresh SAM candidate only ever touches the prompted native axial slice.
    other = np.concatenate([mask[:, :, :k].ravel(), mask[:, :, k + 1 :].ravel()])
    assert other.sum() == 0
    # Metadata is JSON-safe scalars only (no arrays or tensors).
    round_tripped = json.loads(json.dumps(metadata))
    assert round_tripped == metadata


def test_worker_rejects_jobs_that_do_not_match_the_installed_reference(tmp_path):
    from planner.segmentation_worker import run_local_model

    job = {
        "case_id": "some-other-case",
        "image_sha256": "0" * 64,
        "reference_revision": "0" * 64,
        "kind": "sam2",
        "role": "aneurysm",
        "point_ras": [0.0, 0.0, 0.0],
        "radius_voxels": 6,
        "display_window": [0, 600],
    }
    with pytest.raises(RuntimeError) as excinfo:
        run_local_model(job, tmp_path)
    assert str(ROOT) not in str(excinfo.value)
    assert not (tmp_path / "mask.nii.gz").exists()
