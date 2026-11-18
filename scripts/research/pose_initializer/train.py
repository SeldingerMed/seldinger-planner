"""Train the view network on generated frames. Every output goes to external storage.

  PYTHONPATH=scripts/research <python> -m pose_initializer.train \
      --frames <frames dir> --out <run dir on the external volume> \
      --epochs 30 --seed 1

The checkpoint that is kept is the one with the best validation result
(best of five proposals within 15 degrees, then the first proposal). The
held-out frames are never read here.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch

from . import measure, network, provenance, storage

USE = (
    "Internal research only. Trained on synthetic projections of artery masks "
    "released for academic research use (COSTA, Zenodo record 11025761). Not "
    "cleared for commercial use."
)


def load_split(folder: Path) -> dict:
    """Every frame of one split, in case order, as arrays in memory."""
    record = json.loads((folder / "generation.json").read_text())
    if "frames" not in record:
        raise ValueError(f"The frames in {folder} are not complete")
    inputs, true_views, modes = [], [], []
    # macOS leaves "._name" companions on volumes without extended attributes.
    for path in sorted(p for p in folder.glob("*.npz") if not p.name.startswith(".")):
        with np.load(path) as stored:
            inputs.append(stored["inputs"])
            true_views.append(stored["views"])
            modes.append(stored["modes"])
    data = {
        "inputs": np.concatenate(inputs),
        "views": np.concatenate(true_views),
        "modes": np.concatenate(modes),
        "record": record,
    }
    if len(data["views"]) != record["frames"]:
        raise ValueError(f"The frames in {folder} do not match their record")
    return data


def answers(model, inputs: np.ndarray, device, batch: int = 512):
    """The model's answer for every frame, as arrays."""
    model.eval()
    parts = []
    with torch.no_grad():
        for start in range(0, len(inputs), batch):
            x = torch.from_numpy(inputs[start : start + batch]).to(device).float() / 255
            parts.append([part.float().cpu().numpy() for part in model(x)])
    return tuple(np.concatenate([part[index] for part in parts]) for index in range(3))


def evaluate(model, data: dict, device) -> dict:
    return measure.summary(measure.measure(*answers(model, data["inputs"], device), data["views"]))[
        "all"
    ]


def train(frames_dir: Path, out: Path, options: dict) -> dict:
    root = storage.external_directory(out)
    storage.pin_scratch(root)
    torch.manual_seed(options["seed"])
    device = torch.device(options["device"])
    training = load_split(frames_dir / "training")
    validation = load_split(frames_dir / "validation")
    inputs = torch.from_numpy(training["inputs"])
    true_views = torch.from_numpy(training["views"])
    model = network.ViewNetwork().to(device)
    steps_per_epoch = len(inputs) // options["batch"]
    total_steps = steps_per_epoch * options["epochs"]
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=options["learning_rate"], weight_decay=options["weight_decay"]
    )
    schedule = torch.optim.lr_scheduler.OneCycleLR(
        optimizer, max_lr=options["learning_rate"], total_steps=total_steps, pct_start=0.05
    )
    order = torch.Generator().manual_seed(options["seed"])
    log = root / "log.jsonl"
    best, started = None, time.time()
    for epoch in range(1, options["epochs"] + 1):
        model.train()
        shuffled = torch.randperm(len(inputs), generator=order)
        running = np.zeros(3)
        for step in range(steps_per_epoch):
            chosen = shuffled[step * options["batch"] : (step + 1) * options["batch"]]
            x = inputs[chosen].to(device).float() / 255
            total, which, where = network.loss(model(x), true_views[chosen].to(device))
            optimizer.zero_grad(set_to_none=True)
            total.backward()
            optimizer.step()
            schedule.step()
            running += [float(part.detach()) for part in (total, which, where)]
        row = {
            "epoch": epoch,
            "loss": [round(value / steps_per_epoch, 4) for value in running],
            "validation": evaluate(model, validation, device),
            "minutes": round((time.time() - started) / 60, 1),
        }
        with log.open("a") as handle:
            handle.write(json.dumps(row) + "\n")
        print(json.dumps(row), flush=True)
        rank = (row["validation"]["best_within"], row["validation"]["first_within"])
        torch.save(model.state_dict(), root / "last.pt")
        if best is None or rank > best["rank"]:
            best = {"rank": rank, "epoch": epoch, "validation": row["validation"]}
            torch.save(model.state_dict(), root / "best.pt")
    model.load_state_dict(torch.load(root / "best.pt", map_location=device))
    model = model.cpu().eval()
    record = {
        "use": USE,
        "code": provenance.code_state(),
        "options": options,
        "torch": torch.__version__,
        "training_frames": training["record"],
        "validation_frames": validation["record"],
        "chosen_epoch": best["epoch"],
        "validation_at_chosen_epoch": best["validation"],
    }
    data = network.export_bytes(model, record)
    target = root / "view-network.bin"
    partial = target.with_name(target.name + ".partial")
    partial.write_bytes(data)
    partial.replace(target)
    result = {**record, "file": target.name, "bytes": len(data)}
    result["sha256"] = provenance.file_sha256(target)
    provenance.write_json(root / "training.json", result)
    return result


def main(arguments=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--frames", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--batch", type=int, default=256)
    parser.add_argument("--learning-rate", type=float, default=2e-3)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--device", default="mps" if torch.backends.mps.is_available() else "cpu")
    parsed = parser.parse_args(arguments)
    options = {
        name: getattr(parsed, name)
        for name in ("epochs", "batch", "learning_rate", "weight_decay", "seed", "device")
    }
    try:
        result = train(parsed.frames, parsed.out, options)
    except (storage.StorageError, ValueError, OSError) as error:
        print(f"Refused: {error}", file=sys.stderr)
        return 1
    print(json.dumps({name: result[name] for name in ("chosen_epoch", "bytes", "sha256")}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
