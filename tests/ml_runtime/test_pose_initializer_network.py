"""The view network: targets, loss, the stored file and the browser fixture.

Needs PyTorch, which only the local model runtime has; the hosted checks skip
this module. The fixture it writes is read by web/src/poseInitializer.test.ts,
which holds the browser's forward pass to the training framework's answer.

Regenerate the fixture after an intentional change to the network or its file:
  SELDINGER_RUN_MODEL_TESTS=1 <model runtime python> \
      tests/ml_runtime/test_pose_initializer_network.py --write
"""

import base64
import json
import os
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "web" / "src" / "__fixtures__" / "view-network-forward.json"
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
from pose_initializer import frames, network, views

SMALL = {"widths": (3, 4, 5, 6), "blocks": (1, 2, 2, 2), "grid": 32}


def small_network(seed=4):
    """A narrow network with every weight and every norm statistic set by hand."""
    rng = np.random.default_rng(seed)
    model = network.ViewNetwork(**SMALL)
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
    rng = np.random.default_rng(seed)
    return rng.random((1, 2, SMALL["grid"], SMALL["grid"])).astype(np.float32)


def packed(array):
    return base64.b64encode(np.ascontiguousarray(array, dtype="<f4").tobytes()).decode()


def unpacked(text):
    return np.frombuffer(base64.b64decode(text), dtype="<f4")


def fixture():
    model, given = small_network(), small_input()
    with torch.no_grad():
        scores, offsets, turns = model(torch.from_numpy(given))
    data = network.export_bytes(model, {"purpose": "forward pass fixture, random weights"})
    return {
        "about": "A narrow view network with random weights, one input and the answer of "
        "the training framework for it, with the Python side's reading of that answer, "
        "its grid averages and its turned view frames. Float32, little-endian, base64. "
        "Written by tests/ml_runtime/test_pose_initializer_network.py --write.",
        "file": base64.b64encode(data).decode(),
        "input": packed(given),
        "scores": packed(scores.numpy()),
        "offsets": packed(offsets.numpy()),
        "turns": packed(turns.numpy()),
        "proposals": views.proposals(scores[0].numpy(), offsets[0].numpy(), turns[0].numpy()),
        "grids": grids(),
        "frames": turned_frames(),
    }


def grids():
    """Levels of several shapes and their averages on a 16 by 16 grid."""
    rng = np.random.default_rng(31)
    cases = []
    for width, height in ((90, 52), (40, 75), (64, 64), (10, 12)):
        level = rng.random((height, width)).astype(np.float32)
        cases.append(
            {
                "width": width,
                "height": height,
                "size": 16,
                "level": packed(level),
                "grid": packed(frames.to_grid(level, 16)),
            }
        )
    return cases


def turned_frames():
    cases = []
    for view in ((0, 0, 0), (35, -20, 10), (-117.5, 41.25, -25), (90, 0, 170), (120, 50, -3)):
        u, v, d = views.turned_frame(*(float(x) for x in view))
        cases.append(
            {
                "view": dict(zip(("primary_deg", "secondary_deg", "turn_deg"), view, strict=True)),
                "u": u.tolist(),
                "v": v.tolist(),
                "d": d.tolist(),
            }
        )
    return cases


if _WRITE:
    FIXTURE.write_text(json.dumps(fixture(), indent=1) + "\n")
    print(f"wrote {FIXTURE}")
    raise SystemExit(0)


def test_the_committed_fixture_is_what_the_framework_answers_for_its_own_file():
    stored = json.loads(FIXTURE.read_text())
    data = base64.b64decode(stored["file"])
    given = unpacked(stored["input"]).reshape(1, 2, SMALL["grid"], SMALL["grid"])
    with torch.no_grad():
        scores, offsets, turns = network.Exported(data)(torch.from_numpy(given.copy()))
    assert np.abs(scores.numpy().ravel() - unpacked(stored["scores"])).max() < 1e-4
    assert np.abs(offsets.numpy().ravel() - unpacked(stored["offsets"])).max() < 1e-4
    assert np.abs(turns.numpy().ravel() - unpacked(stored["turns"])).max() < 1e-4
    # The stored answer is that of the network with its norms, not of the file.
    assert np.abs(unpacked(stored["scores"])).max() > 0.5


def test_the_committed_fixture_holds_this_codes_reading_of_the_answer():
    stored = json.loads(FIXTURE.read_text())
    found = views.proposals(
        unpacked(stored["scores"]),
        unpacked(stored["offsets"]).reshape(views.BINS, 2),
        unpacked(stored["turns"]),
    )
    assert len(found) == len(stored["proposals"]) == views.MAX_PROPOSALS
    for mine, kept in zip(found, stored["proposals"], strict=True):
        assert mine.keys() == kept.keys()
        assert all(np.isclose(mine[name], kept[name], atol=1e-9) for name in mine)
    assert stored["grids"] == grids()
    assert len(stored["frames"]) == len(turned_frames())
    for mine, kept in zip(turned_frames(), stored["frames"], strict=True):
        assert mine["view"] == kept["view"]
        assert all(np.allclose(mine[axis], kept[axis], atol=1e-12) for axis in "uvd")


def test_the_stored_file_answers_as_the_network_with_its_norms_does():
    model, given = small_network(seed=21), torch.from_numpy(small_input(seed=22))
    with torch.no_grad():
        before = model(given)
        after = network.Exported(network.export_bytes(model, {}))(given)
    for a, b in zip(before, after, strict=True):
        assert a.shape == b.shape
        assert float((a - b).abs().max()) < 1e-4
    assert before[0].shape == (1, views.BINS)
    assert before[1].shape == (1, views.BINS, 2) and before[2].shape == (1, views.BINS)


def test_the_network_has_about_two_million_weights_and_reads_the_grid():
    model = network.ViewNetwork()
    count = sum(parameter.numel() for parameter in model.parameters())
    assert 1_500_000 < count < 2_500_000
    with torch.no_grad():
        scores, _, _ = model.eval()(torch.zeros(2, 2, 128, 128))
    assert scores.shape == (2, views.BINS)


@pytest.mark.parametrize("view", [(32.0, 18.0, 12.0), (-120.0, 50.0, -25.0), (150.0, 0.0, 0.0)])
def test_batch_targets_are_the_single_frame_targets(view):
    weight, offsets, turn = network.targets(torch.tensor([view, (0.0, 0.0, 0.0)]))
    expected = views.targets(*view)
    assert np.allclose(weight[0].numpy(), expected[0], atol=1e-5)
    assert np.allclose(offsets[0].numpy(), expected[1], atol=1e-5)
    assert np.allclose(turn[0].numpy(), expected[2], atol=1e-6)


def answer_for(view, turn_error=0.0):
    weight, offsets, turn = network.targets(torch.tensor([view]))
    return (torch.log(weight + 1e-9), offsets, turn + turn_error)


def test_the_loss_is_lowest_for_the_right_answer():
    view = torch.tensor([(40.0, -10.0, 5.0)])
    right = network.loss(answer_for((40.0, -10.0, 5.0)), view)
    wrong_bin = network.loss(answer_for((-60.0, 30.0, 5.0)), view)
    wrong_turn = network.loss(answer_for((40.0, -10.0, 5.0), turn_error=1.0), view)
    assert float(right[0]) < float(wrong_turn[0]) < float(wrong_bin[0])
    assert float(right[2]) < 1e-6 and float(wrong_turn[2]) > 0.4
    assert float(wrong_bin[1]) > float(right[1]) + 5


def test_the_loss_reaches_every_weight():
    model = network.ViewNetwork(**SMALL)
    total, _, _ = network.loss(
        model(torch.rand(4, 2, 32, 32)), torch.tensor([(10.0, 5.0, 0.0)] * 4)
    )
    total.backward()
    assert all(
        parameter.grad is not None and bool(torch.isfinite(parameter.grad).all())
        for parameter in model.parameters()
    )
    assert float(model.head.weight.grad.abs().sum()) > 0
    assert float(model.stem.weight.grad.abs().sum()) > 0


def test_the_file_says_what_it_holds():
    model = small_network()
    data = network.export_bytes(model, {"seed": 4})
    header, tensors = network.read_exported(data)
    assert data[:8] == b"SLDVIEW1" and header["format"] == network.FORMAT
    assert header["record"] == {"seed": 4} and header["grid"] == 32
    assert header["bins"] == views.BINS and header["widths"] == [3, 4, 5, 6]
    assert tensors["stem.weight"].shape == (3, 2, 3, 3) and tensors["head.bias"].shape == (1100,)
    assert sum(array.size for array in tensors.values()) == header["floats"]
    (length,) = struct.unpack("<I", data[8:12])
    assert length % 4 == 0 and len(data) == 12 + length + 4 * header["floats"]


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda data: b"NOTVIEW1" + data[8:], "Not a view network file"),
        (lambda data: data[:6], "Not a view network file"),
        (
            lambda data: data[:8] + struct.pack("<I", 2**24) + data[12:],
            "Invalid view network header",
        ),
        (lambda data: data[:12] + b"{{{{" + data[16:], "Invalid view network header"),
        (lambda data: data[:-4], "wrong length"),
        (lambda data: data + b"\0\0\0\0", "wrong length"),
        (
            lambda data: data.replace(b"seldinger-view-network-v1", b"seldinger-view-network-v9"),
            "Unknown view network format",
        ),
    ],
)
def test_a_file_that_is_not_a_view_network_is_refused(change, message):
    data = network.export_bytes(small_network(), {})
    with pytest.raises(ValueError, match=message):
        network.read_exported(change(data))
