"""Train the device network. Every output goes to external storage.

  PYTHONPATH=scripts/research:<h5py> <python> -m device_detector.train \
      --weiss <dataset dir> --prepared <vessel models dir> \
      --out <run dir on the external volume> --epochs 60 --seed 1

Each training picture is a labelled frame, turned, scaled and re-lit, most of
them with synthetic contrast-filled vessels laid over; one in five is vessels
alone on a plain ground. Drawn devices are laid over most pictures of either
kind and are marked. Drawn vessel trees are added to the vessels of most
pictures, and nothing of them is marked. Phantom and procedure frames are
drawn equally often.

The network kept is the one after the last epoch. Each epoch is measured on
the validation procedure, on drawn devices over validation vessels and on
device-free vessel pictures, and the log keeps the numbers; none of them
chooses an epoch, because one procedure of 200 like frames does not rank
epochs steadily. The held-out frames are never read here.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
import torch
from pose_initializer import provenance, storage

from . import data, measure, network

USE = (
    "Trained on the WEISS Catheter Segmentation in Fluoroscopy Dataset (UCL, "
    "doi 10.5522/04/24624243, CC BY 4.0), with synthetic vessels from artery "
    "masks released for academic research use (COSTA, Zenodo record 11025761)."
)
VESSELS_ALONE = 0.2
VESSELS_OVER = 0.6
SUBTRACTED = 0.3
BANK = {"training": 3000, "validation": 200}
# The chance of a first and of a second drawn device in a picture.
DEVICES = (0.6, 0.25)
# The chance that a drawn vessel tree is added to a picture's vessels, and
# that it then stands in place of the model's vessels.
TREES = (0.6, 0.3)
# A drawn tree counts as vessel where it is at least this deep.
TREE_FILLED_MM = 0.2
HALF_WIDTH_PX = (0.4, 1.8)
LIGHT_TAKEN = (0.15, 0.6)


def turned(batch: torch.Tensor, rng: torch.Generator, scale=(0.75, 1.35), shift=0.15, pad="border"):
    """The same random turn, scale, shift and flip for every channel of a sample."""
    count, device = batch.shape[0], batch.device

    def draw(low, high):
        return torch.rand(count, generator=rng).to(device) * (high - low) + low

    angle, size = draw(0, 2 * math.pi), draw(*scale)
    flip = torch.where(draw(0, 1) < 0.5, -1.0, 1.0)
    cos, sin = torch.cos(angle) / size, torch.sin(angle) / size
    theta = torch.stack(
        [
            torch.stack([cos * flip, -sin, draw(-shift, shift)], dim=1),
            torch.stack([sin * flip, cos, draw(-shift, shift)], dim=1),
        ],
        dim=1,
    )
    grid = torch.nn.functional.affine_grid(theta, list(batch.shape), align_corners=False)
    return torch.nn.functional.grid_sample(
        batch, grid, mode="bilinear", padding_mode=pad, align_corners=False
    )


def smooth(batch: torch.Tensor, sigma: float) -> torch.Tensor:
    radius = max(1, math.ceil(3 * sigma))
    reach = torch.arange(-radius, radius + 1, device=batch.device, dtype=batch.dtype)
    kernel = torch.exp(-(reach**2) / (2 * sigma * sigma))
    kernel = (kernel / kernel.sum())[None, None]
    pad = torch.nn.functional.pad
    batch = torch.nn.functional.conv2d(
        pad(batch, (radius, radius, 0, 0), mode="replicate"), kernel[:, :, None]
    )
    return torch.nn.functional.conv2d(
        pad(batch, (0, 0, radius, radius), mode="replicate"), kernel[..., None]
    )


def ground(count: int, rng: torch.Generator, device) -> torch.Tensor:
    """Plain grounds with a slow drift, as a subtracted frame has."""
    coarse = torch.randn(count, 1, 6, 6, generator=rng).to(device)
    coarse = coarse * (torch.rand(count, 1, 1, 1, generator=rng).to(device) * 15 + 3)
    level = torch.rand(count, 1, 1, 1, generator=rng).to(device) * 105 + 110
    drift = torch.nn.functional.interpolate(
        coarse, size=data.SIDE, mode="bicubic", align_corners=False
    )
    return level + drift


def compose(frame, mask, vessels, devices, rng: torch.Generator):
    """Training pictures and masks from frames (0 to 255), masks and vessel
    lengths, all (B, 1, SIDE, SIDE), and the closeness of two drawn devices,
    (B, 2, SIDE, SIDE), on one device."""
    count, device = frame.shape[0], frame.device

    def draw(low=0.0, high=1.0):
        return (torch.rand(count, 1, 1, 1, generator=rng) * (high - low) + low).to(device)

    both = turned(torch.cat([frame, mask], dim=1), rng)
    frame, mask = both[:, :1], (both[:, 1:] > 0.35).float()
    alone = draw() < VESSELS_ALONE
    frame = torch.where(alone, ground(count, rng, device), frame)
    mask = torch.where(alone, torch.zeros_like(mask), mask)
    vessels = turned(vessels, rng, scale=(0.8, 1.5), shift=0.3, pad="zeros")
    over = alone | (draw() < VESSELS_OVER)
    frame = frame * torch.exp(-draw(0.1, 0.4) * vessels * over)
    devices = turned(devices, rng, scale=(0.9, 1.15), shift=0.1, pad="zeros")
    for k, chance in enumerate(DEVICES):
        laid = (draw() < chance).float()
        away = data.DEVICE_REACH_PX * (1 - devices[:, k : k + 1])
        half = draw(*HALF_WIDTH_PX)
        soft = (half + 0.5 - away).clamp(0, 1) * laid
        # A tube is darker at its walls than along its middle.
        tube = 0.55 + 0.45 * (away / half).clamp(0, 1) ** 2
        soft = soft * torch.where(draw() < 0.4, tube, torch.ones_like(tube))
        frame = frame * (1 - draw(*LIGHT_TAKEN) * soft)
        mask = torch.maximum(mask, (away <= half.clamp(min=0.75)).float() * laid)
    # The look of a subtracted frame: slow changes taken out.
    subtracted = (draw() < SUBTRACTED) & ~alone
    flat = 128 + draw(1.0, 2.5) * (frame - smooth(frame, 12.0))
    frame = torch.where(subtracted, flat, frame).clamp(0, 255)
    gamma = torch.where(draw() < 0.5, draw(0.6, 1.6), torch.ones_like(draw()))
    frame = 255 * (frame / 255).clamp(1e-4, 1) ** gamma
    frame = frame * draw(0.7, 1.15) + draw(-20, 20)
    frame = torch.where(draw() < 0.3, smooth(frame, 0.8), frame)
    noise = torch.randn(frame.shape, generator=rng).to(device) * draw(0, 6)
    frame = (frame + noise).clamp(0, 255)
    mean = frame.mean(dim=(2, 3), keepdim=True)
    spread = frame.std(dim=(2, 3), keepdim=True)
    return (frame - mean) / (spread + 1), mask


def vessel_pictures(bank: np.ndarray, seed: int) -> np.ndarray:
    """Device-free 8-bit pictures of a vessel bank, the same for a seed."""
    rng = np.random.default_rng(seed)
    out = np.zeros(bank.shape, dtype=np.uint8)
    for index, length in enumerate(bank.astype(np.float64)):
        level = rng.uniform(150, 215) + rng.normal(0, 4, size=length.shape)
        out[index] = np.clip(np.rint(level * np.exp(-rng.uniform(0.1, 0.4) * length)), 0, 255)
    return out


def device_pictures(vessels: np.ndarray, devices: np.ndarray, seed: int):
    """8-bit vessel pictures with one drawn device over each, and its mask."""
    rng = np.random.default_rng(seed + 1)
    pictures = vessel_pictures(vessels, seed).astype(np.float64)
    masks = np.zeros(pictures.shape, dtype=np.uint8)
    for index in range(len(pictures)):
        away = data.DEVICE_REACH_PX * (1 - devices[index % len(devices)] / 255.0)
        half = rng.uniform(*HALF_WIDTH_PX)
        soft = np.clip(half + 0.5 - away, 0, 1)
        pictures[index] *= 1 - rng.uniform(*LIGHT_TAKEN) * soft
        masks[index] = away <= max(half, 0.75)
    return np.clip(np.rint(pictures), 0, 255).astype(np.uint8), masks


def likelihoods(model, gray: np.ndarray, device, batch: int = 64) -> np.ndarray:
    """The model's answer for 8-bit frames of the grid's size, devices dark."""
    model.eval()
    inputs = np.stack([network.normalized(frame.astype(np.float64)) for frame in gray])
    parts = []
    with torch.no_grad():
        for start in range(0, len(inputs), batch):
            x = torch.from_numpy(inputs[start : start + batch]).float()[:, None].to(device)
            parts.append(torch.sigmoid(model(x))[:, 0].float().cpu().numpy())
    return np.concatenate(parts)


def bank_of(root: Path, source: Path | str, split: str, seed: int) -> np.ndarray:
    """The bank of a split: vessel pictures from the models in a directory,
    or drawn ``"device"`` or ``"tree"`` pictures."""
    kind = source if isinstance(source, str) else "vessel"
    path = root / f"{kind}-bank-{split}-seed{seed}.npy"
    if not path.exists():
        if kind == "device":
            made = data.device_bank(BANK[split], seed + (split == "validation"))
        elif kind == "tree":
            made = data.tree_bank(BANK[split], seed + 2 + (split == "validation"))
        else:
            prepared = source
            made = data.vessel_bank(data.load_models(prepared, split), BANK[split], seed)
        partial = path.with_name(path.name + ".partial")
        with partial.open("wb") as handle:
            np.save(handle, made)
        partial.replace(path)
    return np.load(path)


def train(weiss: Path, prepared: Path, out: Path, options: dict) -> dict:
    root = storage.external_directory(out)
    storage.pin_scratch(root)
    torch.manual_seed(options["seed"])
    device = torch.device(options["device"])
    sets = data.load(weiss)
    bank = bank_of(root, prepared, "training", options["seed"])
    validation_bank = bank_of(root, prepared, "validation", options["seed"])
    validation_vessels = vessel_pictures(validation_bank, options["seed"])
    drawn = torch.from_numpy(bank_of(root, "device", "training", options["seed"]))
    validation_devices = device_pictures(
        validation_bank, bank_of(root, "device", "validation", options["seed"]), options["seed"]
    )
    trees = torch.from_numpy(bank_of(root, "tree", "training", options["seed"]).astype(np.float32))
    validation_tree_bank = bank_of(root, "tree", "validation", options["seed"])
    validation_trees = vessel_pictures(validation_tree_bank, options["seed"] + 2)
    frames_, masks = (torch.from_numpy(part) for part in sets["training"])
    lengths = torch.from_numpy(bank.astype(np.float32))
    model = network.DeviceNetwork().to(device)
    steps_per_epoch = len(frames_) // options["batch"]
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=options["learning_rate"], weight_decay=options["weight_decay"]
    )
    schedule = torch.optim.lr_scheduler.OneCycleLR(
        optimizer,
        max_lr=options["learning_rate"],
        total_steps=steps_per_epoch * options["epochs"],
        pct_start=0.05,
    )
    rng = torch.Generator().manual_seed(options["seed"])
    # Half of what is drawn is from the procedures, which are the fewer.
    weights = torch.cat([torch.full((count,), 1 / count) for count in sets["training_groups"]])
    log = root / "log.jsonl"
    started = time.time()
    for epoch in range(1, options["epochs"] + 1):
        model.train()
        shuffled = torch.multinomial(weights, len(frames_), replacement=True, generator=rng)
        running = 0.0
        for step in range(steps_per_epoch):
            chosen = shuffled[step * options["batch"] : (step + 1) * options["batch"]]
            vessels = torch.randint(len(lengths), (len(chosen),), generator=rng)
            devices = torch.randint(len(drawn), (len(chosen), 2), generator=rng)
            grown = torch.randint(len(trees), (len(chosen),), generator=rng)
            chance = torch.rand((2, len(chosen), 1, 1), generator=rng)
            added = (chance[0] < TREES[0]).float()
            in_place = added * (chance[1] < TREES[1]).float()
            x, y = compose(
                frames_[chosen].to(device).float()[:, None],
                masks[chosen].to(device).float()[:, None],
                (lengths[vessels] * (1 - in_place) + trees[grown] * added).to(device)[:, None],
                drawn[devices].to(device).float() / 255,
                rng,
            )
            total = network.loss(model(x), y)
            optimizer.zero_grad(set_to_none=True)
            total.backward()
            optimizer.step()
            schedule.step()
            running += float(total.detach())
        row = {
            "epoch": epoch,
            "loss": round(running / steps_per_epoch, 4),
            "validation": measure.summary(
                likelihoods(model, sets["validation"][0], device), sets["validation"][1]
            ),
            "validation_drawn": measure.summary(
                likelihoods(model, validation_devices[0], device), validation_devices[1]
            ),
            "validation_vessels": measure.on_vessels(
                likelihoods(model, validation_vessels, device), validation_bank.astype(np.float32)
            ),
            "validation_trees": measure.on_vessels(
                likelihoods(model, validation_trees, device),
                validation_tree_bank.astype(np.float32),
                TREE_FILLED_MM,
            ),
            "minutes": round((time.time() - started) / 60, 1),
        }
        with log.open("a") as handle:
            handle.write(json.dumps(row) + "\n")
        print(json.dumps(row), flush=True)
        torch.save(model.state_dict(), root / "last.pt")
    model = model.cpu().eval()
    record = {
        "use": USE,
        "code": provenance.code_state(),
        "options": options,
        "torch": torch.__version__,
        "training_frames": len(frames_),
        "validation_frames": len(sets["validation"][0]),
        "epochs": options["epochs"],
        "validation_at_last_epoch": row["validation"],
        "validation_drawn_at_last_epoch": row["validation_drawn"],
        "validation_vessels_at_last_epoch": row["validation_vessels"],
        "validation_trees_at_last_epoch": row["validation_trees"],
    }
    stored = network.export_bytes(model, record)
    target = root / "device-network.bin"
    partial = target.with_name(target.name + ".partial")
    partial.write_bytes(stored)
    partial.replace(target)
    result = {**record, "file": target.name, "bytes": len(stored)}
    result["sha256"] = provenance.file_sha256(target)
    provenance.write_json(root / "training.json", result)
    return result


def main(arguments=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--weiss", type=Path, required=True)
    parser.add_argument("--prepared", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--epochs", type=int, default=60)
    parser.add_argument("--batch", type=int, default=16)
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
        result = train(parsed.weiss, parsed.prepared, parsed.out, options)
    except (storage.StorageError, ValueError, OSError) as error:
        print(f"Refused: {error}", file=sys.stderr)
        return 1
    print(json.dumps({name: result[name] for name in ("epochs", "bytes", "sha256")}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
