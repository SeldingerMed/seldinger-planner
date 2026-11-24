"""Synthetic tests for the raw CTA to aortoiliac vessel-mask inference adapter."""

import hashlib
import os
import sys
import types
from pathlib import Path

import pytest

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Requires isolated imaging runtime", allow_module_level=True)

import nibabel as nib
import numpy as np

from planner.aortoiliac_inference import (
    AORTOILIAC_LABEL_MAP,
    AORTOILIAC_ROI_SUBSET,
    METHOD,
    ROI_SUBSET_SUPPORTS_FAST,
    TOTALSEGMENTATOR_LICENSE,
    TOTALSEGMENTATOR_TASK,
    TOTALSEGMENTATOR_VERIFIED_VERSION,
    build_totalsegmentator_kwargs,
    infer_aortoiliac_mask,
    invoke_totalsegmentator,
    propose_aortoiliac_model_from_cta,
)
from planner.aortoiliac_model import METHOD as MODEL_METHOD


def _tube(shape, affine, start, end, radius_mm):
    start = np.asarray(start, dtype=float)
    end = np.asarray(end, dtype=float)
    axis = end - start
    length = float(np.linalg.norm(axis))
    direction = axis / length
    grid = np.indices(shape, dtype=float).reshape(3, -1).T
    ras = grid @ affine[:3, :3].T + affine[:3, 3]
    along = np.clip((ras - start) @ direction, 0.0, length)
    closest = start + along[:, None] * direction
    across = np.linalg.norm(ras - closest, axis=1)
    return (across <= radius_mm).reshape(shape)


def _synthetic_aortoiliac_case(
    *,
    spacing=(2.0, 2.0, 2.0),
    flip_axes=(1, 1, 1),
    permute=(0, 1, 2),
    include_veins_and_organs=False,
):
    spacing = np.asarray(spacing, dtype=float)
    origin = np.array([-60.0, -40.0, -120.0])
    extent = np.array([120.0, 72.0, 270.0])
    shape = tuple(int(np.ceil(extent[p] / spacing[p])) for p in permute)
    affine = np.zeros((4, 4))
    affine[3, 3] = 1
    for i, p in enumerate(permute):
        affine[p, i] = spacing[p] * flip_axes[p]
        affine[p, 3] = origin[p] if flip_axes[p] > 0 else origin[p] + (shape[i] - 1) * spacing[p]

    fork = np.array([0.0, 0.0, 0.0])
    top = np.array([0.0, 0.0, 140.0])
    right_end = np.array([42.0, 8.0, -105.0])  # RAS: +x is patient right
    left_end = np.array([-42.0, 8.0, -105.0])

    aorta = _tube(shape, affine, top, fork, 10.0)
    right_iliac = _tube(shape, affine, fork, right_end, 6.0)
    left_iliac = _tube(shape, affine, fork, left_end, 5.5)

    labels = np.zeros(shape, dtype=np.uint8)
    labels[right_iliac] = 66  # iliac_artery_right
    labels[left_iliac] = 65  # iliac_artery_left
    labels[aorta] = 52  # aorta
    if include_veins_and_organs:
        # Iliac veins (67, 68) and liver (5) must never enter the arterial mask.
        vein_left = _tube(
            shape, affine, np.array([-16.0, -14.0, 0.0]), np.array([-44.0, -14.0, -90.0]), 5.5
        )
        vein_right = _tube(
            shape, affine, np.array([16.0, -14.0, 0.0]), np.array([44.0, -14.0, -90.0]), 5.5
        )
        labels[vein_left & (labels == 0)] = 67
        labels[vein_right & (labels == 0)] = 68
        labels[0:4, 0:4, 0:4] = 5

    cta = np.full(shape, -80.0, dtype=np.int16)
    cta[aorta | right_iliac | left_iliac] = 320
    return cta, labels, affine, {"fork": fork}


def _write_nifti(path: Path, data, affine, *, units="mm", sform_code=2):
    image = nib.Nifti1Image(data, affine)
    image.header.set_xyzt_units(units, "sec")
    image.set_sform(affine, code=sform_code)
    nib.save(image, path)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return path, digest


def test_totalsegmentator_contract_constants_match_primary_source():
    assert TOTALSEGMENTATOR_VERIFIED_VERSION == "2.18.0"
    assert TOTALSEGMENTATOR_LICENSE == "Apache 2.0"
    assert TOTALSEGMENTATOR_TASK == "total"
    assert AORTOILIAC_ROI_SUBSET == ("aorta", "iliac_artery_left", "iliac_artery_right")
    assert AORTOILIAC_LABEL_MAP == {
        52: "aorta",
        65: "iliac_artery_left",
        66: "iliac_artery_right",
    }
    assert ROI_SUBSET_SUPPORTS_FAST is True


def test_build_totalsegmentator_kwargs_defaults_and_fullres_mode():
    default_kwargs = build_totalsegmentator_kwargs()
    assert default_kwargs == {
        "output": None,
        "ml": True,
        "fast": True,
        "fastest": False,
        "task": "total",
        "roi_subset": ["aorta", "iliac_artery_left", "iliac_artery_right"],
        "skip_saving": True,
        "quiet": True,
        "verbose": False,
        "device": "cpu",
        "nr_thr_resamp": 1,
        "nr_thr_saving": 1,
    }
    assert isinstance(default_kwargs["roi_subset"], list)

    fullres_kwargs = build_totalsegmentator_kwargs(
        fast=False, device="gpu:0", nr_thr_resamp=2, nr_thr_saving=2
    )
    assert fullres_kwargs["fast"] is False
    assert fullres_kwargs["roi_subset"] == ["aorta", "iliac_artery_left", "iliac_artery_right"]
    assert fullres_kwargs["task"] == "total"
    assert fullres_kwargs["device"] == "gpu:0"
    assert fullres_kwargs["nr_thr_resamp"] == 2
    assert fullres_kwargs["nr_thr_saving"] == 2


@pytest.mark.parametrize("bad_device", ["", "cuda", "gpu:", "gpu:-1", "tpu", 0])
def test_build_totalsegmentator_kwargs_rejects_invalid_device(bad_device):
    with pytest.raises(ValueError, match="device"):
        build_totalsegmentator_kwargs(device=bad_device)


def test_build_totalsegmentator_kwargs_rejects_invalid_flags():
    with pytest.raises(ValueError, match="fast"):
        build_totalsegmentator_kwargs(fast=1)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="nr_thr_resamp"):
        build_totalsegmentator_kwargs(nr_thr_resamp=0)
    with pytest.raises(ValueError, match="nr_thr_saving"):
        build_totalsegmentator_kwargs(nr_thr_saving=0)
    with pytest.raises(ValueError, match="nr_thr_resamp"):
        build_totalsegmentator_kwargs(nr_thr_resamp=True)


def test_invoke_totalsegmentator_calls_upstream_python_api(monkeypatch):
    captured = {}

    def fake_totalsegmentator(image, **kwargs):
        captured["image"] = image
        captured["kwargs"] = kwargs
        return nib.Nifti1Image(np.zeros(image.shape, dtype=np.uint8), image.affine)

    fake_pkg = types.ModuleType("totalsegmentator")
    fake_api = types.ModuleType("totalsegmentator.python_api")
    monkeypatch.setattr(fake_api, "totalsegmentator", fake_totalsegmentator, raising=False)
    monkeypatch.setitem(sys.modules, "totalsegmentator", fake_pkg)
    monkeypatch.setitem(sys.modules, "totalsegmentator.python_api", fake_api)

    source = nib.Nifti1Image(np.zeros((4, 4, 4), dtype=np.float32), np.eye(4))
    out = invoke_totalsegmentator(source, fast=True, device="cpu")
    assert isinstance(out, nib.Nifti1Image)
    assert captured["image"] is source
    assert captured["kwargs"]["task"] == "total"
    assert captured["kwargs"]["fast"] is True
    assert captured["kwargs"]["roi_subset"] == [
        "aorta",
        "iliac_artery_left",
        "iliac_artery_right",
    ]
    assert captured["kwargs"]["ml"] is True
    assert captured["kwargs"]["output"] is None
    assert captured["kwargs"]["skip_saving"] is True
    assert captured["kwargs"]["quiet"] is True


def test_invoke_totalsegmentator_raises_clear_error_when_runtime_missing(monkeypatch):
    monkeypatch.setitem(sys.modules, "totalsegmentator", None)
    monkeypatch.setitem(sys.modules, "totalsegmentator.python_api", None)
    source = nib.Nifti1Image(np.zeros((4, 4, 4), dtype=np.float32), np.eye(4))
    with pytest.raises(RuntimeError, match="TotalSegmentator"):
        invoke_totalsegmentator(source)


def test_infer_aortoiliac_mask_returns_same_grid_binary_mask_and_metadata(tmp_path):
    affine = np.diag([1.0, 1.0, 2.0, 1.0])
    affine[:3, 3] = [-10.0, -20.0, 5.0]
    cta = np.full((10, 10, 12), -50, dtype=np.int16)
    cta[3:7, 3:7, 2:10] = 300
    path, digest = _write_nifti(tmp_path / "cta.nii.gz", cta, affine)

    labels = np.zeros(cta.shape, dtype=np.uint8)
    labels[4:6, 4:6, 6:10] = 52  # aorta (16)
    labels[3:5, 4:6, 2:6] = 65  # iliac_artery_left (16)
    labels[6:8, 4:6, 2:6] = 66  # iliac_artery_right (16)
    labels[1:3, 1:3, 1:3] = 67  # iliac_vena_left (8, must be excluded)
    labels[8:10, 8:10, 8:10] = 5  # liver (8, must be excluded)

    seen = {}

    def fake_runner(image, **kwargs):
        seen["shape"] = image.shape
        seen["kwargs"] = kwargs
        # Mirrors upstream returning default 'unknown' header units on a fresh Nifti1Image.
        return nib.Nifti1Image(labels, affine)

    result = infer_aortoiliac_mask(path, expected_sha256=digest, runner=fake_runner)
    assert seen["shape"] == (10, 10, 12)
    assert seen["kwargs"]["task"] == "total"
    assert seen["kwargs"]["fast"] is True
    assert seen["kwargs"]["roi_subset"] == [
        "aorta",
        "iliac_artery_left",
        "iliac_artery_right",
    ]
    assert result["method"] == METHOD
    assert result["operator_confirmation_required"] is True
    assert result["clinical_validation"] is False
    assert result["source_sha256"] == digest
    assert result["spatial_units"] == "mm"
    assert result["shape_xyz"] == [10, 10, 12]
    assert np.array_equal(result["affine_ras"], affine)
    assert result["label_voxel_counts"] == {
        "aorta": 16,
        "iliac_artery_left": 16,
        "iliac_artery_right": 16,
    }
    assert result["voxel_count"] == 48
    assert result["excluded_nonzero_voxel_count"] == 16
    assert result["mask"].dtype == np.uint8
    assert result["mask"].shape == (10, 10, 12)
    assert set(np.unique(result["mask"])).issubset({0, 1})
    assert int(result["mask"][1:3, 1:3, 1:3].sum()) == 0
    assert int(result["mask"][8:10, 8:10, 8:10].sum()) == 0
    assert result["backend"]["task"] == "total"
    assert result["backend"]["fast"] is True
    assert result["backend"]["injected_runner"] is True

    mask_img = result["mask_image"]
    assert isinstance(mask_img, nib.Nifti1Image)
    assert mask_img.shape == (10, 10, 12)
    assert np.array_equal(mask_img.affine, affine)
    assert mask_img.header.get_xyzt_units()[0] == "mm"
    assert mask_img.get_data_dtype() == np.uint8
    assert float(mask_img.header["scl_slope"]) == 1.0
    assert float(mask_img.header["scl_inter"]) == 0.0
    assert np.array_equal(np.asanyarray(mask_img.dataobj), result["mask"])


def test_infer_aortoiliac_mask_rejects_runner_grid_and_content_mismatches(tmp_path):
    affine = np.diag([1.0, 1.0, 1.0, 1.0])
    cta = np.zeros((8, 8, 8), dtype=np.int16)
    path, _ = _write_nifti(tmp_path / "cta.nii.gz", cta, affine)
    good = np.zeros((8, 8, 8), dtype=np.uint8)
    good[2:6, 2:6, 2:6] = 52

    # Non-callable runner
    with pytest.raises(TypeError, match="callable"):
        infer_aortoiliac_mask(path, runner="not-callable")  # type: ignore[arg-type]

    # Shape mismatch
    with pytest.raises(ValueError, match="shape"):
        infer_aortoiliac_mask(
            path,
            runner=lambda img, **kw: nib.Nifti1Image(
                np.full((8, 8, 7), 52, dtype=np.uint8), affine
            ),
        )

    # Affine mismatch
    shifted = affine.copy()
    shifted[0, 3] = 2.5
    with pytest.raises(ValueError, match="affine"):
        infer_aortoiliac_mask(path, runner=lambda img, **kw: nib.Nifti1Image(good, shifted))

    # Incompatible units on returned segmentation
    def meter_runner(img, **kw):
        seg = nib.Nifti1Image(good, affine)
        seg.header.set_xyzt_units("meter", "sec")
        return seg

    with pytest.raises(ValueError, match="units"):
        infer_aortoiliac_mask(path, runner=meter_runner)

    # Non-Nifti1Image return
    with pytest.raises(TypeError, match="Nifti1Image"):
        infer_aortoiliac_mask(path, runner=lambda img, **kw: good)

    # Non-integer float labels
    bad_float = good.astype(np.float32)
    bad_float[0, 0, 0] = 52.5
    with pytest.raises(ValueError, match="integer"):
        infer_aortoiliac_mask(path, runner=lambda img, **kw: nib.Nifti1Image(bad_float, affine))

    # Non-finite float labels
    bad_nan = good.astype(np.float32)
    bad_nan[0, 0, 0] = np.nan
    with pytest.raises(ValueError, match="non-finite"):
        infer_aortoiliac_mask(path, runner=lambda img, **kw: nib.Nifti1Image(bad_nan, affine))

    # Negative labels
    bad_neg = good.astype(np.int16)
    bad_neg[0, 0, 0] = -1
    with pytest.raises(ValueError, match="non-negative"):
        infer_aortoiliac_mask(path, runner=lambda img, **kw: nib.Nifti1Image(bad_neg, affine))

    # Empty aortoiliac union (only unrelated organ class present)
    only_liver = np.zeros((8, 8, 8), dtype=np.uint8)
    only_liver[2:5, 2:5, 2:5] = 5
    with pytest.raises(ValueError, match="empty"):
        infer_aortoiliac_mask(path, runner=lambda img, **kw: nib.Nifti1Image(only_liver, affine))


def test_infer_aortoiliac_mask_rejects_bad_input_cta(tmp_path):
    affine = np.diag([1.0, 1.0, 1.0, 1.0])

    def ok_runner(img, **kw):
        return nib.Nifti1Image(np.full(img.shape, 52, dtype=np.uint8), img.affine)

    # Non-NIfTI suffix
    txt_path = tmp_path / "cta.txt"
    txt_path.write_text("not a nifti")
    with pytest.raises(ValueError, match="NIfTI"):
        infer_aortoiliac_mask(txt_path, runner=ok_runner)

    # Uncalibrated units
    unknown_path, _ = _write_nifti(
        tmp_path / "unknown.nii.gz",
        np.zeros((6, 6, 6), dtype=np.int16),
        affine,
        units="unknown",
    )
    with pytest.raises(ValueError, match="millimeter"):
        infer_aortoiliac_mask(unknown_path, runner=ok_runner)

    # Missing sform (sform_code == 0)
    no_sform_path, _ = _write_nifti(
        tmp_path / "nosform.nii.gz",
        np.zeros((6, 6, 6), dtype=np.int16),
        affine,
        sform_code=0,
    )
    with pytest.raises(ValueError, match="sform"):
        infer_aortoiliac_mask(no_sform_path, runner=ok_runner)

    # Non-orthogonal (sheared) affine
    sheared = np.eye(4)
    sheared[0, 1] = 0.25
    sheared_path, _ = _write_nifti(
        tmp_path / "sheared.nii.gz", np.zeros((6, 6, 6), dtype=np.int16), sheared
    )
    with pytest.raises(ValueError, match="right angles"):
        infer_aortoiliac_mask(sheared_path, runner=ok_runner)

    # Non-finite CTA intensities
    nan_data = np.zeros((6, 6, 6), dtype=np.float32)
    nan_data[1, 1, 1] = np.nan
    nan_path, _ = _write_nifti(tmp_path / "nan.nii.gz", nan_data, affine)
    with pytest.raises(ValueError, match="non-finite"):
        infer_aortoiliac_mask(nan_path, runner=ok_runner)

    # Digest mismatch
    good_path, _ = _write_nifti(
        tmp_path / "good.nii.gz", np.zeros((6, 6, 6), dtype=np.int16), affine
    )
    with pytest.raises(ValueError, match="digest"):
        infer_aortoiliac_mask(good_path, expected_sha256="0" * 64, runner=ok_runner)

    # Symlink rejected
    link_path = tmp_path / "link.nii.gz"
    link_path.symlink_to(good_path)
    with pytest.raises(ValueError, match="regular"):
        infer_aortoiliac_mask(link_path, runner=ok_runner)

    # 4D NIfTI rejected
    img4d = nib.Nifti1Image(np.zeros((4, 4, 4, 2), dtype=np.int16), affine)
    img4d.header.set_xyzt_units("mm", "sec")
    img4d.set_sform(affine, code=2)
    path4d = tmp_path / "cta4d.nii.gz"
    nib.save(img4d, path4d)
    with pytest.raises(ValueError, match="3D"):
        infer_aortoiliac_mask(path4d, runner=ok_runner)

    # Voxel bound exceeded
    with pytest.raises(ValueError, match="voxel"):
        infer_aortoiliac_mask(good_path, max_voxels=100, runner=ok_runner)


def test_infer_aortoiliac_mask_default_runner_uses_upstream_and_accepts_uncompressed_nii(
    tmp_path, monkeypatch
):
    affine = np.diag([1.5, 1.5, 1.5, 1.0])
    cta = np.full((6, 6, 6), 120, dtype=np.int16)
    path, digest = _write_nifti(tmp_path / "cta.nii", cta, affine)
    labels = np.zeros((6, 6, 6), dtype=np.uint8)
    labels[2:4, 2:4, 2:5] = 52

    called = {}

    def fake_totalsegmentator(image, **kwargs):
        called["kwargs"] = kwargs
        return nib.Nifti1Image(labels, image.affine)

    fake_pkg = types.ModuleType("totalsegmentator")
    fake_api = types.ModuleType("totalsegmentator.python_api")
    monkeypatch.setattr(fake_api, "totalsegmentator", fake_totalsegmentator, raising=False)
    monkeypatch.setitem(sys.modules, "totalsegmentator", fake_pkg)
    monkeypatch.setitem(sys.modules, "totalsegmentator.python_api", fake_api)

    result = infer_aortoiliac_mask(path)
    assert called["kwargs"]["task"] == "total"
    assert called["kwargs"]["fast"] is True
    assert called["kwargs"]["roi_subset"] == [
        "aorta",
        "iliac_artery_left",
        "iliac_artery_right",
    ]
    assert result["source_sha256"] == digest
    assert result["voxel_count"] == 12
    assert result["backend"]["injected_runner"] is False
    assert result["operator_confirmation_required"] is True


def test_propose_aortoiliac_model_from_cta_end_to_end_with_flipped_permuted_grid(tmp_path):
    cta, labels, affine, truth = _synthetic_aortoiliac_case(
        spacing=(2.0, 2.0, 2.0),
        flip_axes=(-1, 1, -1),
        permute=(1, 2, 0),
        include_veins_and_organs=True,
    )
    path, digest = _write_nifti(tmp_path / "synthetic_cta.nii.gz", cta, affine)

    def fake_runner(image, **kwargs):
        assert image.shape == cta.shape
        assert np.allclose(image.affine, affine)
        assert kwargs["task"] == "total"
        assert kwargs["fast"] is True
        assert kwargs["roi_subset"] == [
            "aorta",
            "iliac_artery_left",
            "iliac_artery_right",
        ]
        return nib.Nifti1Image(labels, affine)

    result = propose_aortoiliac_model_from_cta(path, expected_sha256=digest, runner=fake_runner)
    assert result["method"] == METHOD
    assert result["operator_confirmation_required"] is True
    assert result["clinical_validation"] is False
    assert result["source_sha256"] == digest
    assert result["segmentation"]["operator_confirmation_required"] is True
    assert result["segmentation"]["voxel_count"] > 0
    assert result["segmentation"]["excluded_nonzero_voxel_count"] > 0

    proposal = result["proposal"]
    assert proposal["method"] == MODEL_METHOD
    assert proposal["operator_confirmation_required"] is True
    assert proposal["clinical_validation"] is False
    assert proposal["bifurcation_ras"] is not None
    assert abs(proposal["bifurcation_ras"][0] - truth["fork"][0]) < 4.0
    assert abs(proposal["bifurcation_ras"][1] - truth["fork"][1]) < 4.0
    assert -25.0 < proposal["bifurcation_ras"][2] < 5.0
    branches = {b["name"]: b for b in proposal["branches"]}
    assert set(branches) == {"aorta", "right_iliac", "left_iliac"}
    for branch_name in ("aorta", "right_iliac", "left_iliac"):
        assert branches[branch_name]["length_mm"] > 50.0


def _relabelled_runner(cta, labels, affine, keep):
    """A runner whose segmentation keeps only some of the synthetic labels."""
    kept = np.where(np.isin(labels, keep), labels, 0).astype(np.uint8)

    def runner(image, **kwargs):
        return nib.Nifti1Image(kept, affine)

    return runner


def test_a_lone_iliac_is_not_proposed_as_the_aorta(tmp_path):
    # A pelvic scan cut below the aorta: the segmentation holds one iliac
    # artery and no aorta. The model alone would call the one tube the aorta.
    cta, labels, affine, _ = _synthetic_aortoiliac_case()
    path, digest = _write_nifti(tmp_path / "pelvis.nii.gz", cta, affine)
    runner = _relabelled_runner(cta, labels, affine, keep=(66,))
    with pytest.raises(ValueError, match=r"named aorta .* iliac_artery_right"):
        propose_aortoiliac_model_from_cta(path, expected_sha256=digest, runner=runner)


def test_an_aorta_stub_over_long_iliacs_is_not_proposed_as_the_aorta(tmp_path):
    # Only the last few centimetres of the aorta are in the scan: the widest
    # path is mostly iliac and must not be drawn as the aorta.
    cta, labels, affine, _ = _synthetic_aortoiliac_case()
    grid = np.indices(labels.shape, dtype=float).reshape(3, -1).T
    superior = (grid @ affine[:3, :3].T + affine[:3, 3])[:, 2].reshape(labels.shape)
    labels = np.where((labels == 52) & (superior > 24.0), 0, labels).astype(np.uint8)
    cta = np.where(labels > 0, 320, -80).astype(np.int16)
    path, digest = _write_nifti(tmp_path / "stub.nii.gz", cta, affine)

    def runner(image, **kwargs):
        return nib.Nifti1Image(labels, affine)

    try:
        result = propose_aortoiliac_model_from_cta(path, expected_sha256=digest, runner=runner)
    except ValueError as refusal:
        assert "named aorta" in str(refusal) or "iliac" in str(refusal)
        return
    names = [b["name"] for b in result["proposal"]["branches"]]
    assert names != ["aorta"]


def test_each_name_agrees_with_the_segmentation_on_a_whole_tree(tmp_path):
    cta, labels, affine, _ = _synthetic_aortoiliac_case()
    path, digest = _write_nifti(tmp_path / "tree.nii.gz", cta, affine)

    def runner(image, **kwargs):
        return nib.Nifti1Image(labels, affine)

    result = propose_aortoiliac_model_from_cta(path, expected_sha256=digest, runner=runner)
    agreement = result["label_agreement"]
    assert set(agreement) == {"aorta", "right_iliac", "left_iliac"}
    assert all(share >= 0.5 for share in agreement.values())
    assert "labels" not in result["segmentation"]
