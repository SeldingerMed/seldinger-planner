"""The device network: its stored file, the browser fixture, masks and drawn devices.

Needs PyTorch, which only the local model runtime has; the hosted checks skip
this module. The fixture it writes is read by web/src/deviceNetwork.test.ts,
which holds the browser's forward pass to the training framework's answer.

Regenerate the fixture after an intentional change to the network or its file:
  SELDINGER_RUN_MODEL_TESTS=1 <model runtime python> \
      tests/ml_runtime/test_device_detector_network.py --write
"""

import base64
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "web" / "src" / "__fixtures__" / "device-network-forward.json"
_WRITE = __name__ == "__main__" and "--write" in sys.argv

if not _WRITE:
    import pytest

    if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
        pytest.skip("Requires isolated imaging runtime", allow_module_level=True)
    torch = pytest.importorskip("torch")
else:
    import torch
import numpy as np

sys.path.insert(0, str(ROOT / "scripts" / "research"))
from device_detector import data, network, train

WIDTHS = (2, 3, 4, 5, 6)
SIDE = 32
SHAPES = ((90, 52), (40, 75), (64, 64), (33, 17))


def small_network(seed=4):
    """A narrow network with every weight and every norm statistic set by hand."""
    rng = np.random.default_rng(seed)
    model = network.DeviceNetwork(WIDTHS)
    with torch.no_grad():
        for name, value in model.state_dict().items():
            if name.endswith("num_batches_tracked"):
                continue
            if name.endswith("running_var"):
                drawn = rng.uniform(0.5, 2.0, size=value.shape)
            elif name.endswith("norm.weight"):
                drawn = rng.uniform(0.6, 1.4, size=value.shape)
            else:
                drawn = rng.normal(0, 0.35, size=value.shape)
            value.copy_(torch.from_numpy(drawn.astype(np.float32)))
    return model.eval()


def small_input(seed=9):
    return np.random.default_rng(seed).normal(size=(1, SIDE, SIDE)).astype(np.float32)


def packed(array, kind="<f4"):
    return base64.b64encode(np.ascontiguousarray(array, dtype=kind).tobytes()).decode()


def unpacked(text, kind="<f4"):
    return np.frombuffer(base64.b64decode(text), dtype=kind)


def inputs():
    """Frames of several shapes and what the network reads for each."""
    rng = np.random.default_rng(31)
    cases = []
    for (width, height), polarity in zip(SHAPES, ("dark", "bright", "dark", "bright"), strict=True):
        gray = rng.integers(0, 256, size=(height, width), dtype=np.uint8)
        cases.append(
            {
                "width": width,
                "height": height,
                "polarity": polarity,
                "gray": packed(gray, "u1"),
                "input": packed(network.network_input(gray, polarity, SIDE)),
            }
        )
    return cases


def masks():
    """Likelihoods on the grid and the frame pixels they mark."""
    rng = np.random.default_rng(32)
    cases = []
    for width, height in SHAPES:
        likely = (rng.random((SIDE, SIDE)) ** 6).astype(np.float32)
        # A cell at the threshold itself, and marked cells on an edge.
        likely[5, 7] = network.THRESHOLD
        likely[0, 3] = likely[SIDE - 1, SIDE - 1] = 0.9
        cases.append(
            {
                "width": width,
                "height": height,
                "likely": packed(likely),
                "mask": packed(network.frame_mask(likely, width, height), "u1"),
            }
        )
    return cases


def fixture():
    model, given = small_network(), small_input()
    with torch.no_grad():
        likely = torch.sigmoid(model(torch.from_numpy(given)[:, None]))[0, 0]
    record = {"purpose": "forward pass fixture, random weights"}
    return {
        "about": "A narrow device network with random weights, one input and the answer "
        "of the training framework for it, with the Python side's inputs for frames "
        "of several shapes and the frame pixels marked for several likelihood grids. "
        "Float32 little-endian or bytes, base64. Written by "
        "tests/ml_runtime/test_device_detector_network.py --write.",
        "file": base64.b64encode(network.export_bytes(model, record, SIDE)).decode(),
        "input": packed(given),
        "likely": packed(likely.numpy()),
        "inputs": inputs(),
        "masks": masks(),
    }


if _WRITE:
    FIXTURE.write_text(json.dumps(fixture(), indent=1) + "\n")
    print(f"wrote {FIXTURE}")
    raise SystemExit(0)


def test_the_committed_fixture_is_what_the_framework_answers_for_its_own_file():
    stored = json.loads(FIXTURE.read_text())
    given = unpacked(stored["input"]).reshape(1, SIDE, SIDE)
    likely = network.run_exported(base64.b64decode(stored["file"]), given)
    assert np.abs(likely.ravel() - unpacked(stored["likely"])).max() < 1e-4
    # The stored answer is that of the network with its norms, not of the file,
    # and it is not flat.
    assert np.ptp(unpacked(stored["likely"])) > 0.3
    assert stored["inputs"] == inputs()
    assert stored["masks"] == masks()


def test_a_stored_file_reads_back_to_the_tensors_it_was_made_from():
    model = small_network()
    header, tensors = network.read_exported(network.export_bytes(model, {"a": 1}, SIDE))
    assert header["format"] == network.FORMAT
    assert header["grid"] == SIDE
    assert header["widths"] == list(WIDTHS)
    assert header["record"] == {"a": 1}
    assert tensors["head.weight"].shape == (1, WIDTHS[0], 1, 1)
    assert tensors["down.0.first.weight"].shape == (WIDTHS[0], 1, 3, 3)
    assert tensors["up.3.first.weight"].shape == (WIDTHS[3], WIDTHS[4] + WIDTHS[3], 3, 3)
    assert np.allclose(tensors["head.bias"], model.head.bias.detach().numpy())


@pytest.mark.parametrize(
    "change",
    [
        lambda data: b"SLDVIEW1" + data[8:],
        lambda data: data[:-4],
        lambda data: data[:8] + b"\xff\xff\xff\x7f" + data[12:],
        lambda data: data[:12] + b"x" + data[13:],
    ],
)
def test_a_damaged_file_is_refused(change):
    data = network.export_bytes(small_network(), {}, SIDE)
    with pytest.raises(ValueError):
        network.read_exported(change(data))


def test_the_input_is_the_frame_on_the_grid_less_its_mean_over_its_spread():
    gray = np.random.default_rng(3).integers(0, 256, size=(40, 64), dtype=np.uint8)
    dark = network.network_input(gray, "dark", SIDE)
    bright = network.network_input(gray, "bright", SIDE)
    assert dark.shape == (SIDE, SIDE) and dark.dtype == np.float32
    assert abs(float(dark.mean())) < 1e-5
    # Reversed polarity reverses the picture, the cells beside the frame too.
    assert np.abs(dark + bright).max() < 1e-4
    with pytest.raises(ValueError):
        network.network_input(gray, "white", SIDE)


def test_marked_frame_pixels_are_the_grown_cells_laid_over_the_frame():
    from scipy import ndimage

    rng = np.random.default_rng(8)
    for width, height in SHAPES:
        likely = rng.random((SIDE, SIDE)) ** 6
        cells = ndimage.binary_dilation(likely >= network.THRESHOLD, iterations=1)
        step = max(width, height) / SIDE
        y = (np.arange(height) + 0.5 - (height - SIDE * step) / 2) / step - 0.5
        x = (np.arange(width) + 0.5 - (width - SIDE * step) / 2) / step - 0.5
        laid = ndimage.map_coordinates(
            cells.astype(np.float64), np.meshgrid(y, x, indexing="ij"), order=0, mode="nearest"
        )
        mask = network.frame_mask(likely, width, height)
        assert mask.dtype == np.uint8 and mask.shape == (height, width)
        assert np.array_equal(mask, (laid > 0.5).astype(np.uint8))
    # One cell at the threshold marks itself and its four edge neighbors.
    one = np.zeros((SIDE, SIDE))
    one[10, 12] = network.THRESHOLD
    assert network.frame_mask(one, SIDE, SIDE).sum() == 5
    assert network.frame_mask(one * 0.99, SIDE, SIDE).sum() == 0


def test_drawn_devices_are_thin_lines_and_the_same_for_the_same_seed():
    bank = data.device_bank(12, 5)
    assert bank.shape == (12, data.SIDE, data.SIDE) and bank.dtype == np.uint8
    assert np.array_equal(bank, data.device_bank(12, 5))
    assert not np.array_equal(bank, data.device_bank(12, 6))
    for drawn in bank:
        on = int((drawn == 255).sum())
        # At least 40 pixels of line, and nowhere an area.
        assert 40 <= on <= 2000
        assert (drawn > 0).mean() < 0.5


def test_a_training_picture_marks_the_drawn_devices_laid_over_it():
    rng = torch.Generator().manual_seed(3)
    count = 16
    frame = torch.full((count, 1, data.SIDE, data.SIDE), 140.0)
    nothing = torch.zeros((count, 1, data.SIDE, data.SIDE))
    drawn = torch.from_numpy(data.device_bank(2 * count, 7)).float() / 255
    x, y = train.compose(
        frame, nothing, nothing, drawn.reshape(count, 2, data.SIDE, data.SIDE), rng
    )
    assert x.shape == y.shape == (count, 1, data.SIDE, data.SIDE)
    assert torch.isfinite(x).all()
    assert set(torch.unique(y).tolist()) <= {0.0, 1.0}
    marked = y.flatten(1).sum(1)
    # Some pictures carry a device and some none.
    assert (marked > 0).any() and (marked == 0).any()
    # Marked pixels are darker than the rest of their picture.
    with_device = marked > 0
    inside = (x * y).flatten(1).sum(1)[with_device] / marked[with_device]
    outside = (x * (1 - y)).flatten(1).sum(1)[with_device] / (1 - y).flatten(1).sum(1)[with_device]
    assert (inside < outside).all()


def test_the_loss_is_lower_for_the_right_answer():
    mask = torch.zeros((2, 1, 32, 32))
    mask[:, :, 10:12, 4:28] = 1
    right = (mask * 2 - 1) * 8
    assert float(network.loss(right, mask)) < 0.05
    assert float(network.loss(-right, mask)) > float(network.loss(right * 0, mask)) > 0.5
