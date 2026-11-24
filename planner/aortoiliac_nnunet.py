"""Installed TotalSegmentator ``total`` 3 mm weights, run in memory by nnU-Net v2.

A runner for ``planner.aortoiliac_inference.infer_aortoiliac_mask``. It uses
the weights already installed on the machine, pinned to the upstream release
``v2.0.0-weights`` asset ``Dataset297_TotalSegmentator_total_3mm_1559subj.zip``
(SHA-256 ``0baa2c8d...4c073394``). The three pinned files below were read
byte for byte from that asset.

The TotalSegmentator wrapper is not called. It writes temporary files and a
usage counter, and can report usage over the network. This runner does what
it does for the ``fast`` (3 mm) total task, with no file writes:

  1. reorient the scan to the closest RAS axes, as nnU-Net's
     ``NibabelIOWithReorient`` reader does for these weights;
  2. resample to 3 mm with cubic interpolation, as the wrapper does;
  3. predict with nnU-Net's in-memory predictor on the box of that grid that
     holds the body (above -500 HU, with a 12 mm margin); voxels outside it
     are background;
  4. resample the labels back to the source grid with nearest neighbours and
     undo the reorientation.

The wrapper's first stage for ``roi_subset`` (a 6 mm model that crops the
scan around the requested structures) is not run: the 3 mm model sees the
whole scan. The labels carry the upstream ``total`` label map.

All imaging and ML imports stay lazy.
"""

import hashlib
import json
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

from planner.aortoiliac_inference import AORTOILIAC_LABEL_MAP

WEIGHTS_DATASET = "Dataset297_TotalSegmentator_total_3mm_1559subj"
WEIGHTS_CONFIGURATION = "nnUNetTrainer_4000epochs_NoMirroring__nnUNetPlans__3d_fullres"
WEIGHTS_RELEASE = (
    "https://github.com/wasserth/TotalSegmentator/releases/download/"
    "v2.0.0-weights/Dataset297_TotalSegmentator_total_3mm_1559subj.zip"
)
WEIGHTS_RELEASE_SHA256 = "0baa2c8de2975600eb31801dd5c1825cd2b356f794498659cf3348714c073394"
PINNED_FILES = ("plans.json", "dataset.json", "fold_0/checkpoint_final.pth")
TOTAL_3MM_SHA256 = {
    "plans.json": "d1cb3c15f53dc36fdb618e0f9082573d1f50b74a9b5fa73094ac8680845839f1",
    "dataset.json": "e804e08ad8912e3a6f541741c8c78799d75acbd3f4f3f18ff5f211bbd3da961a",
    "fold_0/checkpoint_final.pth": (
        "1e38e40356adc2706a662e365405a97f862d62a7da65f6bf81d025aee1b979ac"
    ),
}
WORKING_SPACING_MM = 3.0
BODY_HU = -500.0
BODY_MARGIN_VOXELS = 4
SLAB_UNFOLD_BYTES = 512 * 2**20
BACKEND = "nnunetv2_in_memory_installed_weights_v1"

_DEVICE = re.compile(r"cpu|cuda(:[0-9]+)?")
_CHUNK = 1 << 20


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def verify_installed_weights(model_dir, pins=None) -> dict[str, str]:
    """Check the pinned files of the weight folder and return their digests."""
    pins = TOTAL_3MM_SHA256 if pins is None else pins
    folder = Path(model_dir)
    if set(pins) != set(PINNED_FILES):
        raise ValueError("Pins must name every pinned weight file")
    found = {}
    for name in PINNED_FILES:
        path = folder / name
        if path.is_symlink() or any(p.is_symlink() for p in path.parents) or not path.is_file():
            raise ValueError(f"{name} must be a regular non-symlink file")
        digest = _sha256(path)
        if digest != pins[name]:
            raise ValueError(f"{name} is not the pinned file")
        found[name] = digest
    labels = json.loads((folder / "dataset.json").read_text())["labels"]
    if any(labels.get(name) != label for label, name in AORTOILIAC_LABEL_MAP.items()):
        raise ValueError("The weights' label map does not name the aorta and iliac labels")
    plans = json.loads((folder / "plans.json").read_text())
    spacing = plans["configurations"]["3d_fullres"]["spacing"]
    if [float(s) for s in spacing] != [WORKING_SPACING_MM] * 3:
        raise ValueError("The weights are not planned for a 3 mm grid")
    if plans.get("image_reader_writer") != "NibabelIOWithReorient":
        raise ValueError("The weights expect another image reader")
    return found


def _slab_forward(conv, max_unfold_bytes):
    """The convolution computed over slabs of output depth. CPU Conv3d copies
    each input patch into a buffer of channels x kernel volume x output
    voxels; one 112 x 112 x 128 tile at 32 channels needs 5.5 GB at once.
    Over slabs the same sums are taken, a slab at a time."""
    import torch
    import torch.nn.functional as F

    whole = conv.forward
    kd, kh, kw = conv.kernel_size
    sd = conv.stride[0]
    pd, ph, pw = conv.padding
    if conv.dilation != (1, 1, 1) or conv.groups != 1 or conv.padding_mode != "zeros":
        return whole

    def forward(x):
        if x.dim() != 5:
            return whole(x)
        n, c, d, h, w = x.shape
        out_d = (d + 2 * pd - kd) // sd + 1
        out_h = (h + 2 * ph - kh) // conv.stride[1] + 1
        out_w = (w + 2 * pw - kw) // conv.stride[2] + 1
        per_row = n * c * kd * kh * kw * out_h * out_w * x.element_size()
        rows = max(1, int(max_unfold_bytes // max(per_row, 1)))
        if rows >= out_d:
            return whole(x)
        padded = F.pad(x, (0, 0, 0, 0, pd, pd)) if pd else x
        parts = []
        for start in range(0, out_d, rows):
            stop = min(out_d, start + rows)
            piece = padded[:, :, start * sd : (stop - 1) * sd + kd]
            parts.append(
                F.conv3d(piece, conv.weight, conv.bias, conv.stride, (0, ph, pw), conv.dilation, 1)
            )
        return torch.cat(parts, dim=2)

    return forward


def slab_convolutions(network, max_unfold_bytes=SLAB_UNFOLD_BYTES) -> int:
    """Computes every Conv3d of ``network`` over output-depth slabs. Returns
    how many were changed; a convolution already changed is left alone."""
    import torch

    changed = 0
    for module in network.modules():
        if type(module) is torch.nn.Conv3d and not getattr(module, "_slab", False):
            module.forward = _slab_forward(module, max_unfold_bytes)
            module._slab = True
            changed += 1
    return changed


def default_predictor_factory(model_dir: Path, device: str, threads: int):
    import contextlib
    import sys

    with contextlib.redirect_stdout(sys.stderr):
        return _predictor(model_dir, device, threads)


def _predictor(model_dir: Path, device: str, threads: int):
    import torch
    from nnunetv2.inference.predict_from_raw_data import nnUNetPredictor

    torch.set_num_threads(threads)
    predictor = nnUNetPredictor(
        tile_step_size=0.5,
        use_gaussian=True,
        use_mirroring=False,
        perform_everything_on_device=False,
        device=torch.device(device),
        verbose=False,
        verbose_preprocessing=False,
        allow_tqdm=False,
    )
    predictor.initialize_from_trained_model_folder(
        str(model_dir), use_folds=(0,), checkpoint_name="checkpoint_final.pth"
    )
    slab_convolutions(predictor.network)
    return predictor


def _working_shape(shape, zooms):
    new = [max(1, round(n * z / WORKING_SPACING_MM)) for n, z in zip(shape, zooms, strict=True)]
    if min(new) < 2:
        raise ValueError("Scan is too small for the 3 mm working grid")
    return new


def body_box(working):
    """The box of the working grid that holds the body (above -500 HU), with
    a 4-voxel (12 mm) margin; the whole grid when nothing is that dense.
    Labels outside it are background. Prediction memory grows with the
    voxels predicted, and air beside the body holds no vessel."""
    import numpy as np

    dense = np.argwhere(working > BODY_HU)
    if not len(dense):
        return [0, 0, 0], list(working.shape)
    low = np.maximum(dense.min(axis=0) - BODY_MARGIN_VOXELS, 0)
    high = np.minimum(dense.max(axis=0) + 1 + BODY_MARGIN_VOXELS, working.shape)
    return [int(v) for v in low], [int(v) for v in high]


def installed_weights_runner(
    model_dir,
    *,
    pins=None,
    device: str = "cpu",
    threads: int = 4,
    predictor_factory: Callable[..., Any] | None = default_predictor_factory,
):
    """A ``runner(cta_image, **kwargs) -> Nifti1Image`` on the source grid.

    ``predictor_factory=None`` only verifies the weights (for tests and checks)
    and returns None."""
    if not isinstance(device, str) or _DEVICE.fullmatch(device) is None:
        raise ValueError("device must be 'cpu' or 'cuda[:n]'")
    if type(threads) is not int or threads < 1:
        raise ValueError("threads must be a positive integer")
    folder = Path(model_dir)
    digests = verify_installed_weights(folder, pins)
    if predictor_factory is None:
        return None
    predictor = predictor_factory(folder, device, threads)

    def run(cta_image, *, fast=True, **_ignored):
        import nibabel as nib
        import numpy as np
        from nibabel.orientations import apply_orientation, io_orientation, ornt_transform
        from scipy import ndimage

        if fast is not True:
            raise ValueError("Only the fast (3 mm) total task is installed")
        source_ornt = io_orientation(cta_image.affine)
        canonical = cta_image.as_reoriented(source_ornt)
        zooms = [float(z) for z in canonical.header.get_zooms()[:3]]
        data = np.asanyarray(canonical.dataobj).astype(np.float32)
        shape = _working_shape(data.shape, zooms)
        working = ndimage.zoom(
            data, [n / m for n, m in zip(shape, data.shape, strict=True)], order=3
        ).astype(np.float32)
        del data
        low, high = body_box(working)
        crop = working[low[0] : high[0], low[1] : high[1], low[2] : high[2]]
        predicted = predictor.predict_single_npy_array(
            crop.transpose(2, 1, 0)[None].copy(),
            {"spacing": [WORKING_SPACING_MM] * 3},
            None,
            None,
            False,
        )
        del working, crop
        predicted = np.asarray(predicted).transpose(2, 1, 0)
        if predicted.shape != tuple(int(h - lo) for lo, h in zip(low, high, strict=True)):
            raise ValueError("Predictor returned another grid")
        labels = np.zeros(shape, dtype=np.uint8)
        labels[low[0] : high[0], low[1] : high[1], low[2] : high[2]] = predicted
        del predicted
        back = ndimage.zoom(
            labels.astype(np.uint8),
            [m / n for m, n in zip(canonical.shape, shape, strict=True)],
            order=0,
        )
        if back.shape != canonical.shape:
            raise ValueError("Labels did not return to the source grid")
        canonical_ornt = np.array([[0, 1], [1, 1], [2, 1]])
        out = apply_orientation(back, ornt_transform(canonical_ornt, source_ornt))
        result = nib.Nifti1Image(np.ascontiguousarray(out, dtype=np.uint8), cta_image.affine)
        result.header.set_xyzt_units("mm", "sec")
        result.set_sform(cta_image.affine, code=2)
        return result

    run.backend = {
        "backend": BACKEND,
        "weights_dataset": WEIGHTS_DATASET,
        "weights_configuration": WEIGHTS_CONFIGURATION,
        "weights_release": WEIGHTS_RELEASE,
        "weights_release_sha256": WEIGHTS_RELEASE_SHA256,
        "weights_sha256": digests,
        "working_spacing_mm": WORKING_SPACING_MM,
        "device": device,
    }
    return run
