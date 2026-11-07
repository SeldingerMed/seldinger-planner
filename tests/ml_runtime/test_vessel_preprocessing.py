"""Opt-in real-artifact tests for vessel preprocessing and validation.

Run in the isolated ML runtime, not base CI. Parent separately exercises
predict_vessel on actual public CTA; these tests never run image inference.
"""

import os
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1",
    reason="Requires separately installed ML runtime and hash-pinned model artifacts",
)

ROOT = Path(__file__).resolve().parents[2]
MODEL_DIR = ROOT / ".runtime/models/pooled-vessel-v1"
LANDMARKS = MODEL_DIR / "landmarks.npz"


def test_standardize_cta_matches_direct_upstream_torchio_transform():
    import numpy as np
    import torch
    import torchio as tio

    from planner.vessel_inference import standardize_cta

    rng = np.random.default_rng(7)
    # Seeded monotonic synthetic source array (HU-like, not real public data).
    shape = (12, 11, 10)
    base = np.sort(rng.uniform(-100.0, 600.0, size=int(np.prod(shape))))
    image_xyz = base.reshape(shape).astype(np.float32)
    image_xyz += rng.normal(0.0, 2.0, size=shape).astype(np.float32)

    standardized = standardize_cta(image_xyz, LANDMARKS)

    assert standardized.shape == image_xyz.shape
    assert standardized.dtype == np.int16

    # Direct upstream public transform + rounding reference.
    npz = np.load(LANDMARKS, allow_pickle=False)
    reference_landmarks = npz[npz.files[0]].astype(np.float64)
    subject = tio.Subject(
        img=tio.ScalarImage(tensor=torch.as_tensor(image_xyz[None], dtype=torch.float32))
    )
    transform = tio.HistogramStandardization({"img": reference_landmarks})
    transformed = transform(subject)["img"].data
    expected = transformed.round().short().numpy()[0]

    np.testing.assert_array_equal(standardized, expected)
    # No [0, 100] clipped-range assumption: values outside that span are allowed.
    assert standardized.min() < 0 or standardized.max() > 100


def test_standardize_cta_rejects_invalid_input_and_bad_spacing():
    import numpy as np

    pytest.importorskip("planner.vessel_inference")
    from planner.vessel_inference import standardize_cta

    good = np.zeros((4, 4, 4), dtype=np.int16)
    with pytest.raises(ValueError):
        standardize_cta(good[None], LANDMARKS)  # not 3D
    nonfinite = good.astype(np.float32)
    nonfinite[1, 1, 1] = np.nan
    with pytest.raises(ValueError):
        standardize_cta(nonfinite, LANDMARKS)
    big = np.zeros((201, 200, 200), dtype=np.int16)  # > 8,000,000 voxels
    with pytest.raises(ValueError):
        standardize_cta(big, LANDMARKS)


def test_native_mask_restore_preserves_actual_predictor_ndarray_axes():
    import numpy as np

    from planner.vessel_inference import _restore_native_mask

    # Actual upstream predict_single_npy_array returns ZYX ndarray when
    # save_or_return_probabilities=False, NOT a (mask, probabilities) tuple.
    segmentation = np.zeros((3, 5, 7), dtype=np.uint8)
    segmentation[1, 2, 4] = 1
    restored = _restore_native_mask(segmentation, (7, 5, 3))
    assert restored.shape == (7, 5, 3)
    assert restored[4, 2, 1] == 1
    assert restored.sum() == 1
    invalid = segmentation.astype(float)
    invalid[1, 2, 4] = 0.5
    with pytest.raises(ValueError):
        _restore_native_mask(invalid, (7, 5, 3))


def test_predict_vessel_cheap_validation_rejects_before_checkpoint_load():
    import numpy as np

    from planner.vessel_inference import predict_vessel

    good = np.zeros((4, 4, 4), dtype=np.int16)
    bad_paths = ROOT / ".runtime/models/definitely-missing.pth"
    with pytest.raises(ValueError):
        predict_vessel(
            good[None],
            (1.0, 1.0, 1.0),
            checkpoint_path=bad_paths,
            landmarks_path=LANDMARKS,
        )
    with pytest.raises(ValueError):
        predict_vessel(
            good,
            (1.0, 0.0, 1.0),  # zero spacing
            checkpoint_path=MODEL_DIR / "checkpoint_best.pth",
            landmarks_path=LANDMARKS,
        )
    with pytest.raises(ValueError):
        predict_vessel(
            good,
            (1.0, True, 1.0),  # bool spacing not allowed
            checkpoint_path=MODEL_DIR / "checkpoint_best.pth",
            landmarks_path=LANDMARKS,
        )
