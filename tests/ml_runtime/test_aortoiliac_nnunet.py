"""Synthetic tests for the in-memory runner of installed TotalSegmentator weights.

No weights and no torch: a stand-in predictor labels voxels by where they are
on the working grid, so the tests check the grid, orientation and pinning
arithmetic the real predictor relies on.
"""

import hashlib
import json
import os

import pytest

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Requires isolated imaging runtime", allow_module_level=True)

import nibabel as nib
import numpy as np

from planner import aortoiliac_nnunet as runner_module
from planner.aortoiliac_inference import AORTOILIAC_LABEL_MAP, infer_aortoiliac_mask


def labels_json():
    labels = {"background": 0}
    labels.update({name: label for label, name in AORTOILIAC_LABEL_MAP.items()})
    labels["iliac_vena_left"] = 67
    return labels


def install_weights(root, *, labels=None, spacing=(3.0, 3.0, 3.0), checkpoint=b"weights"):
    folder = root / runner_module.WEIGHTS_DATASET / runner_module.WEIGHTS_CONFIGURATION
    (folder / "fold_0").mkdir(parents=True)
    (folder / "plans.json").write_text(
        json.dumps(
            {
                "image_reader_writer": "NibabelIOWithReorient",
                "configurations": {"3d_fullres": {"spacing": list(spacing)}},
            }
        )
    )
    (folder / "dataset.json").write_text(json.dumps({"labels": labels or labels_json()}))
    (folder / "fold_0" / "checkpoint_final.pth").write_bytes(checkpoint)
    pins = {
        name: hashlib.sha256((folder / name).read_bytes()).hexdigest()
        for name in runner_module.PINNED_FILES
    }
    return folder, pins


class LeftHalfIsAorta:
    """Labels the patient's left half (low RAS x) of the working grid as aorta
    and records what it was given."""

    def __init__(self):
        self.calls = []

    def predict_single_npy_array(self, image, properties, previous, truncated, probabilities):
        self.calls.append((image.shape, properties, previous, truncated, probabilities))
        assert image.ndim == 4 and image.shape[0] == 1 and image.dtype == np.float32
        _, z, y, x = image.shape
        labels = np.zeros((z, y, x), dtype=np.uint8)
        # Arrays reach nnU-Net as (z, y, x) of the RAS-canonical grid, so the
        # last axis is RAS x, increasing toward the patient's right.
        labels[:, :, : x // 2] = 52
        labels[:, :, x // 2 :] = 7  # some other organ
        return labels


def lps_image(shape=(40, 30, 50), spacing=(0.8, 1.0, 1.5)):
    """A raw CT whose voxel axes run toward the patient's left, back and head
    (LPS, as DICOM-derived volumes often are), stored in RAS world."""
    affine = np.diag([-spacing[0], -spacing[1], spacing[2], 1.0])
    affine[:3, 3] = [20.0, 15.0, -30.0]
    data = np.full(shape, -1000, dtype=np.int16)
    image = nib.Nifti1Image(data, affine)
    image.set_sform(affine, code=1)
    image.header.set_xyzt_units("mm", "sec")
    return image


def make_runner(tmp_path, predictor=None, **change):
    folder, pins = install_weights(tmp_path)
    predictor = predictor or LeftHalfIsAorta()
    run = runner_module.installed_weights_runner(
        folder, pins=change.pop("pins", pins), predictor_factory=lambda *_: predictor, **change
    )
    return run, predictor, folder, pins


def test_the_output_lies_on_the_source_grid_with_each_side_where_it_was_named(tmp_path):
    run, predictor, _, _ = make_runner(tmp_path)
    image = lps_image()
    seg = run(image, fast=True, device="cpu")
    assert seg.shape == image.shape
    assert np.allclose(seg.affine, image.affine)
    world_x = (image.affine @ np.c_[np.arange(40), np.zeros((40, 2)), np.ones(40)].T)[0]
    labels = np.asanyarray(seg.dataobj)
    centre = world_x.mean()
    # Voxels on the patient's left (RAS x below the middle) are aorta.
    left = world_x < centre - 2.0
    right = world_x > centre + 2.0
    assert (labels[left] == 52).all()
    assert (labels[right] == 7).all()
    # The predictor saw the 3 mm working grid with nnU-Net's reversed spacing.
    shape, properties, previous, truncated, probabilities = predictor.calls[0]
    assert shape == (1, 25, 10, 11)  # z: 50*1.5/3, y: 30*1/3, x: 40*0.8/3
    assert properties == {"spacing": [3.0, 3.0, 3.0]}
    assert previous is None and truncated is None and probabilities is False


def test_the_adapter_accepts_the_runner_and_keeps_only_aortoiliac_labels(tmp_path):
    run, _, _, _ = make_runner(tmp_path)
    path = tmp_path / "ct.nii.gz"
    nib.save(lps_image(), path)
    result = infer_aortoiliac_mask(path, runner=run)
    assert result["mask"].shape == (40, 30, 50)
    assert set(np.unique(result["mask"])) == {0, 1}
    assert result["label_voxel_counts"]["aorta"] > 0
    assert result["excluded_nonzero_voxel_count"] > 0


def test_the_body_crop_keeps_each_label_where_it_was_predicted(tmp_path):
    class MarksHighestIndexCorner:
        def predict_single_npy_array(self, image, *rest):
            labels = np.zeros(image.shape[1:], dtype=np.uint8)
            labels[-1, -1, -1] = 52
            labels[0, 0, 0] = 65
            return labels

    run, _, _, _ = make_runner(tmp_path, predictor=MarksHighestIndexCorner())
    image = lps_image(shape=(60, 60, 60), spacing=(1.0, 1.0, 1.0))
    data = np.asanyarray(image.dataobj).copy()
    data[20:40, 15:45, 20:40] = 40  # the body, well inside the scan
    body = nib.Nifti1Image(data, image.affine)
    labels = np.asanyarray(run(body, fast=True).dataobj)
    # The working grid is 20 voxels a side and the body lies in its middle,
    # so the 4-voxel margin leaves the crop's corners inside the scan.
    found = {int(v): np.argwhere(labels == v) for v in (52, 65)}
    assert len(found[52]) and len(found[65])
    world = {
        v: image.affine[:3, :3] @ p.mean(axis=0) + image.affine[:3, 3] for v, p in found.items()
    }
    centre = image.affine[:3, :3] @ np.array([29.5, 29.5, 29.5]) + image.affine[:3, 3]
    # 52 sits at the crop's far corner: right, anterior, head of the centre;
    # 65 at its near corner: left, posterior, foot.
    assert (world[52] - centre > 0).all() and (world[65] - centre < 0).all()
    # Both lie at the crop's corners, not the scan's.
    assert np.abs(world[52] - centre).max() < 29 and np.abs(world[65] - centre).max() < 29


def test_the_body_box_is_the_whole_grid_when_nothing_is_dense():
    working = np.full((5, 6, 7), -1000.0, dtype=np.float32)
    assert runner_module.body_box(working) == ([0, 0, 0], [5, 6, 7])
    working[2, 3, 4] = 0.0
    assert runner_module.body_box(working) == ([0, 0, 0], [5, 6, 7])
    big = np.full((30, 30, 30), -1000.0, dtype=np.float32)
    big[10:12, 14, 20] = 50.0
    assert runner_module.body_box(big) == ([6, 10, 16], [16, 19, 25])


def test_slab_convolution_matches_the_whole_convolution():
    torch = pytest.importorskip("torch")

    torch.manual_seed(0)
    for stride, kernel, padding in ((1, 3, 1), (2, 3, 1), (1, 1, 0), (2, 2, 0)):
        conv = torch.nn.Conv3d(3, 4, kernel, stride=stride, padding=padding)
        x = torch.randn(1, 3, 13, 9, 10)
        with torch.no_grad():
            whole = conv(x)
            runner_module.slab_convolutions(conv, max_unfold_bytes=4 * 3 * 27 * 9 * 10 * 2)
            assert conv.forward is not torch.nn.Conv3d.forward
            sliced = conv(x)
        assert sliced.shape == whole.shape
        assert torch.allclose(sliced, whole, atol=1e-5), (stride, kernel, padding)


def test_slab_convolution_wraps_every_nested_conv3d_once():
    torch = pytest.importorskip("torch")

    net = torch.nn.Sequential(
        torch.nn.Conv3d(1, 2, 3, padding=1),
        torch.nn.Sequential(torch.nn.Conv3d(2, 2, 3, padding=1), torch.nn.ReLU()),
        torch.nn.ConvTranspose3d(2, 1, 2, stride=2),
    )
    assert runner_module.slab_convolutions(net, max_unfold_bytes=1 << 20) == 2
    assert runner_module.slab_convolutions(net, max_unfold_bytes=1 << 20) == 0


def test_a_changed_weight_file_is_refused(tmp_path):
    folder, pins = install_weights(tmp_path)
    (folder / "fold_0" / "checkpoint_final.pth").write_bytes(b"other weights")
    with pytest.raises(ValueError, match="checkpoint_final.pth"):
        runner_module.installed_weights_runner(folder, pins=pins, predictor_factory=None)


def test_a_label_map_that_does_not_name_the_aortoiliac_labels_is_refused(tmp_path):
    labels = labels_json()
    labels["aorta"] = 51
    folder, pins = install_weights(tmp_path, labels=labels)
    with pytest.raises(ValueError, match="label map"):
        runner_module.installed_weights_runner(folder, pins=pins, predictor_factory=None)


def test_weights_planned_for_another_spacing_are_refused(tmp_path):
    folder, pins = install_weights(tmp_path, spacing=(1.5, 1.5, 1.5))
    with pytest.raises(ValueError, match="3 mm"):
        runner_module.installed_weights_runner(folder, pins=pins, predictor_factory=None)


def test_a_symlinked_weight_file_is_refused(tmp_path):
    folder, pins = install_weights(tmp_path)
    real = tmp_path / "elsewhere.json"
    real.write_bytes((folder / "plans.json").read_bytes())
    (folder / "plans.json").unlink()
    (folder / "plans.json").symlink_to(real)
    with pytest.raises(ValueError, match="regular"):
        runner_module.installed_weights_runner(folder, pins=pins, predictor_factory=None)


def test_only_the_3mm_task_and_known_devices_are_run(tmp_path):
    run, _, _, _ = make_runner(tmp_path)
    with pytest.raises(ValueError, match="fast"):
        run(lps_image(), fast=False, device="cpu")
    with pytest.raises(ValueError, match="device"):
        make_runner(tmp_path / "again", device="mps")


def test_a_grid_too_small_for_the_working_spacing_is_refused(tmp_path):
    run, _, _, _ = make_runner(tmp_path)
    with pytest.raises(ValueError, match="small"):
        run(lps_image(shape=(2, 30, 50)), fast=True, device="cpu")


def test_the_pins_shipped_with_the_module_name_every_pinned_file():
    assert set(runner_module.TOTAL_3MM_SHA256) == set(runner_module.PINNED_FILES)
    assert all(len(v) == 64 for v in runner_module.TOTAL_3MM_SHA256.values())
