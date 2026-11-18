"""Generate synthetic frames from prepared vessel models, onto external storage.

  PYTHONPATH=scripts/research <python> -m pose_initializer.generate \
      --prepared <prepared dir> --out <dir on the external volume> \
      --split training --frames-per-model 600 --seed 1 --workers 8

One file of frames is written per vessel model, so an interrupted run picks
up where it stopped. Every frame is drawn from a random stream that depends
only on the seed, the split and the case, so a run can be repeated exactly.
"""

from __future__ import annotations

import argparse
import json
import multiprocessing
import sys
import zlib
from pathlib import Path

import numpy as np

from . import frames, provenance, storage

SPLITS = ("training", "validation", "held_out")


def stream(seed: int, split: str, case_id: str) -> np.random.Generator:
    """The random stream of one case: the same on every run and machine."""
    return np.random.default_rng([seed, SPLITS.index(split), zlib.crc32(case_id.encode())])


def frames_of(model: dict, count: int, rng) -> dict:
    """``count`` samples of one model as arrays (fewer if some gave no frame)."""
    inputs, labels, modes = [], [], []
    for _ in range(count):
        made = frames.sample(model, rng)
        if made is None:
            continue
        view = made["view"]
        inputs.append(made["input"])
        labels.append((view["primary_deg"], view["secondary_deg"], view["turn_deg"]))
        modes.append(frames.MODES.index(made["mode"]))
    return {
        "inputs": np.stack(inputs) if inputs else np.zeros((0, 2, frames.GRID, frames.GRID), "u1"),
        "views": np.asarray(labels, dtype=np.float32).reshape(-1, 3),
        "modes": np.asarray(modes, dtype=np.uint8),
    }


def _work(task) -> tuple[str, int]:
    prepared, target, case_id, model_file, count, seed, split = task
    with np.load(Path(prepared) / model_file) as stored:
        model = {name: stored[name] for name in stored.files}
    made = frames_of(model, count, stream(seed, split, case_id))
    target = Path(target)
    partial = target.with_name(target.name + ".partial")
    with partial.open("wb") as handle:
        np.savez_compressed(handle, **made)
    partial.replace(target)
    return case_id, len(made["views"])


def generate(prepared: Path, out: Path, split: str, count: int, seed: int, workers: int) -> dict:
    root = storage.external_directory(out)
    storage.pin_scratch(root)
    folder = root / split
    folder.mkdir(exist_ok=True)
    manifest = json.loads((prepared / "manifest.json").read_text())
    cases = [case for case in manifest["cases"] if case["split"] == split and "model_file" in case]
    settings = {
        "split": split,
        "frames_per_model": count,
        "seed": seed,
        "prepared_manifest_sha256": provenance.file_sha256(prepared / "manifest.json"),
        "grid": frames.GRID,
        "input_blur_px": list(frames.INPUT_BLUR_PX),
        "primary_range_deg": frames.PRIMARY_RANGE_DEG,
        "secondary_range_deg": frames.SECONDARY_RANGE_DEG,
        "turn_range_deg": frames.TURN_RANGE_DEG,
        "side_px": list(frames.SIDE_PX),
        "modes": dict(zip(frames.MODES, frames.MODE_SHARE, strict=True)),
    }
    record = folder / "generation.json"
    if record.exists():
        before = json.loads(record.read_text())
        if before["settings"] != settings:
            raise ValueError("This folder holds frames made with other settings")
    tasks = [
        (str(prepared), str(folder / f"{case['case_id']}.npz"), case["case_id"], case["model_file"])
        + (count, seed, split)
        for case in cases
        if not (folder / f"{case['case_id']}.npz").exists()
    ]
    provenance.write_json(record, {"settings": settings, "code": provenance.code_state()})
    done = len(cases) - len(tasks)
    with multiprocessing.get_context("spawn").Pool(workers) as pool:
        for case_id, made in pool.imap_unordered(_work, tasks):
            done += 1
            print(f"{done}/{len(cases)} {case_id} {made}", flush=True)
    total = 0
    for case in cases:
        with np.load(folder / f"{case['case_id']}.npz") as stored:
            total += len(stored["views"])
    summary = {"settings": settings, "code": provenance.code_state(), "models": len(cases)}
    summary["frames"] = total
    provenance.write_json(record, summary)
    return summary


def main(arguments=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--prepared", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--split", choices=SPLITS, required=True)
    parser.add_argument("--frames-per-model", type=int, required=True)
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--workers", type=int, default=4)
    options = parser.parse_args(arguments)
    if not 1 <= options.frames_per_model <= 5000 or not 1 <= options.workers <= 12:
        parser.error("frames per model must be 1 to 5000 and workers 1 to 12")
    try:
        summary = generate(
            options.prepared,
            options.out,
            options.split,
            options.frames_per_model,
            options.seed,
            options.workers,
        )
    except (storage.StorageError, ValueError, OSError) as error:
        print(f"Refused: {error}", file=sys.stderr)
        return 1
    print(json.dumps({"models": summary["models"], "frames": summary["frames"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
