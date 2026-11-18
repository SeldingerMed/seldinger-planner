"""Training the view network and the synthetic gate, on random frames.

Needs PyTorch, which only the local model runtime has; the hosted checks skip
this module. Storage checks are replaced: no volume is touched.
"""

import json
import os
import sys
from pathlib import Path

import pytest

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Requires isolated imaging runtime", allow_module_level=True)
torch = pytest.importorskip("torch")
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "research"))
from pose_initializer import frames, gate, network, provenance, storage, train

CODE = {"commit": "0" * 40, "uncommitted_changes": False}


@pytest.fixture
def anywhere(monkeypatch):
    """Lets outputs go to the test's own temporary directory."""

    def directory(path, **_):
        path.mkdir(parents=True, exist_ok=True)
        return path.resolve()

    monkeypatch.setattr(storage, "external_directory", directory)
    monkeypatch.setattr(storage, "pin_scratch", lambda root: root)
    monkeypatch.setattr(provenance, "code_state", lambda: CODE)


def frames_folder(root, split, count, seed):
    """A complete split of random inputs with random views."""
    rng = np.random.default_rng(seed)
    folder = root / split
    folder.mkdir(parents=True)
    np.savez_compressed(
        folder / "costa__a.npz",
        inputs=rng.integers(0, 255, size=(count, 2, frames.GRID, frames.GRID), dtype=np.uint8),
        views=np.stack(
            [
                rng.uniform(-120, 120, count),
                rng.uniform(-50, 50, count),
                rng.uniform(-25, 25, count),
            ],
            axis=1,
        ).astype(np.float32),
        modes=rng.integers(0, 3, size=count, dtype=np.uint8),
    )
    # A companion file macOS leaves on such volumes; it is not frames.
    (folder / "._costa__a.npz").write_bytes(b"\0\5\x16\7" + bytes(60))
    record = {"settings": {"split": split, "seed": seed}, "code": CODE, "models": 1}
    (folder / "generation.json").write_text(json.dumps({**record, "frames": count}))
    return folder


OPTIONS = {
    "epochs": 2,
    "batch": 8,
    "learning_rate": 1e-3,
    "weight_decay": 0.01,
    "seed": 5,
    "device": "cpu",
}


def test_training_keeps_the_best_checkpoint_and_stores_one_file_with_its_record(tmp_path, anywhere):
    frames_folder(tmp_path / "frames", "training", 16, seed=1)
    frames_folder(tmp_path / "frames", "validation", 6, seed=2)
    result = train.train(tmp_path / "frames", tmp_path / "run", OPTIONS)
    run = tmp_path / "run"
    assert {path.name for path in run.iterdir()} == {
        "best.pt",
        "last.pt",
        "log.jsonl",
        "training.json",
        "view-network.bin",
    }
    rows = [json.loads(line) for line in (run / "log.jsonl").read_text().splitlines()]
    assert [row["epoch"] for row in rows] == [1, 2]
    assert all(row["validation"]["frames"] == 6 for row in rows)
    ranks = [(r["validation"]["best_within"], r["validation"]["first_within"]) for r in rows]
    assert result["chosen_epoch"] == 1 + ranks.index(max(ranks))
    data = (run / "view-network.bin").read_bytes()
    assert result["bytes"] == len(data) and result["sha256"] == provenance.file_sha256(
        run / "view-network.bin"
    )
    assert result == json.loads((run / "training.json").read_text())
    header, _ = network.read_exported(data)
    record = header["record"]
    assert "Not cleared for commercial use" in record["use"] and record["code"] == CODE
    assert record["options"] == OPTIONS and record["chosen_epoch"] == result["chosen_epoch"]
    assert record["training_frames"]["frames"] == 16
    # The stored file is the kept checkpoint, norms folded in.
    kept = network.ViewNetwork()
    kept.load_state_dict(torch.load(run / "best.pt"))
    given = torch.rand(2, 2, frames.GRID, frames.GRID)
    with torch.no_grad():
        for a, b in zip(kept.eval()(given), network.Exported(data)(given), strict=True):
            assert float((a - b).abs().max()) < 1e-4


def test_frames_that_are_not_complete_are_not_trained_on(tmp_path, anywhere):
    folder = frames_folder(tmp_path / "frames", "training", 8, seed=1)
    frames_folder(tmp_path / "frames", "validation", 4, seed=2)
    record = json.loads((folder / "generation.json").read_text())
    (folder / "generation.json").write_text(json.dumps({**record, "frames": 9}))
    with pytest.raises(ValueError, match="do not match their record"):
        train.train(tmp_path / "frames", tmp_path / "run", OPTIONS)
    del record["frames"]
    (folder / "generation.json").write_text(json.dumps(record))
    with pytest.raises(ValueError, match="are not complete"):
        train.train(tmp_path / "frames", tmp_path / "run", OPTIONS)


@pytest.fixture
def stored_network(tmp_path):
    path = tmp_path / "view-network.bin"
    torch.manual_seed(0)
    path.write_bytes(network.export_bytes(network.ViewNetwork().eval(), {"use": "test"}))
    return path


def test_the_gate_reads_the_stored_file_on_held_out_frames(tmp_path, anywhere, stored_network):
    folder = frames_folder(tmp_path / "frames", "held_out", 12, seed=3)
    report = gate.gate(stored_network, folder, tmp_path / "gate")
    assert report == json.loads((tmp_path / "gate" / "gate.json").read_text())
    assert report["network_sha256"] == provenance.file_sha256(stored_network)
    assert report["result"]["all"]["frames"] == 12
    assert report["thresholds"] == {
        "min_frames": 2000,
        "min_best_within": 0.8,
        "min_first_within": 0.5,
    }
    # Twelve frames and an untrained network: not a pass.
    assert report["passed"] is False


def test_the_gate_reads_no_other_split(tmp_path, anywhere, stored_network):
    folder = frames_folder(tmp_path / "frames", "validation", 4, seed=3)
    with pytest.raises(ValueError, match="held-out frames only"):
        gate.gate(stored_network, folder, tmp_path / "gate")


@pytest.mark.parametrize(
    ("frames_count", "best", "first", "passed"),
    [
        (2000, 0.80, 0.50, True),
        (1999, 0.95, 0.90, False),
        (5000, 0.7999, 0.90, False),
        (5000, 0.95, 0.4999, False),
    ],
)
def test_the_gate_passes_only_when_every_threshold_is_met(frames_count, best, first, passed):
    result = {"all": {"frames": frames_count, "best_within": best, "first_within": first}}
    assert gate.verdict(result) is passed
