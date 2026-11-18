"""The Python copy of the vessel evidence filter against the browser's own output."""

import base64
import json
import os
import sys
from pathlib import Path

import pytest

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Requires isolated imaging runtime", allow_module_level=True)
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "research"))
from pose_initializer import evidence

FIXTURE = json.loads(
    (ROOT / "web" / "src" / "__fixtures__" / "vessel-evidence-levels.json").read_text()
)


def _gray(frame):
    data = np.frombuffer(base64.b64decode(frame["gray"]), dtype=np.uint8)
    return data.reshape(frame["height"], frame["width"]).copy()


def _levels(frame):
    return [
        np.frombuffer(base64.b64decode(text), dtype="<f4").reshape(frame["height"], frame["width"])
        for text in frame["levels"]
    ]


def test_the_constants_are_the_browser_filters():
    assert list(evidence.BLUR_PX) == FIXTURE["blur_px"]


@pytest.mark.parametrize("frame", FIXTURE["frames"], ids=lambda frame: frame["name"])
def test_every_level_agrees_with_the_browser_filter_at_every_pixel(frame):
    ours = evidence.vessel_evidence(_gray(frame), frame["polarity"])
    theirs = _levels(frame)
    assert len(ours) == len(theirs) == len(evidence.BLUR_PX)
    for mine, browser in zip(ours, theirs, strict=True):
        assert mine.dtype == np.float32 and mine.shape == browser.shape
        # The frames hold real lines, so agreement is not agreement on zeros.
        assert browser.max() > 0.9
        assert float(np.abs(mine - browser).max()) <= 1e-4
    strong = int((ours[-1] >= evidence.STRONG).sum())
    assert strong == frame["strong_px"]


def test_chosen_levels_are_the_same_maps_as_in_the_full_set():
    frame = FIXTURE["frames"][0]
    everything = evidence.vessel_evidence(_gray(frame), frame["polarity"])
    chosen = evidence.vessel_evidence(_gray(frame), frame["polarity"], blur_px=(8, 2))
    assert np.array_equal(chosen[0], everything[1])
    assert np.array_equal(chosen[1], everything[3])


def test_the_wrong_polarity_is_a_different_answer():
    frame = FIXTURE["frames"][0]
    other = "bright" if frame["polarity"] == "dark" else "dark"
    try:
        flipped = evidence.vessel_evidence(_gray(frame), other)
    except evidence.NoVessels:
        return
    assert float(np.abs(flipped[-1] - _levels(frame)[-1]).max()) > 0.5


def test_a_frame_with_no_lines_is_refused_as_the_browser_refuses_it():
    rng = np.random.default_rng(3)
    flat = (128 + rng.integers(-2, 3, size=(80, 96))).astype(np.uint8)
    with pytest.raises(evidence.NoVessels):
        evidence.vessel_evidence(flat, "dark")


@pytest.mark.parametrize(
    "gray",
    [
        np.zeros((63, 80), dtype=np.uint8),
        np.zeros((80, 769), dtype=np.uint8),
        np.zeros((80, 80), dtype=np.float32),
        np.zeros((80, 80, 1), dtype=np.uint8),
    ],
)
def test_frames_the_copy_does_not_cover_are_refused(gray):
    with pytest.raises(ValueError, match="outside the supported range"):
        evidence.vessel_evidence(gray, "dark")


def test_an_unknown_polarity_or_blur_width_is_refused():
    gray = np.zeros((80, 80), dtype=np.uint8)
    with pytest.raises(ValueError, match="polarity"):
        evidence.vessel_evidence(gray, "light")
    with pytest.raises(ValueError, match="blur width"):
        evidence.vessel_evidence(gray, "dark", blur_px=(3,))
