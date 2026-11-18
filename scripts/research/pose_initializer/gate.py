"""The synthetic gate: the stored network on frames of held-out vessel models.

  PYTHONPATH=scripts/research <python> -m pose_initializer.gate \
      --network <view-network.bin> --frames <frames dir>/held_out --out <dir>

Reads the stored file, not a checkpoint, so what passes the gate is what the
browser would read. The gate is criterion 5 of the plan: over at least 2,000
held-out frames, the best of the proposals within 15 degrees in at least
80%, and the first proposal in at least 50%.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import torch

from . import measure, network, provenance, storage
from .train import answers, load_split

MIN_FRAMES = 2000
MIN_BEST_WITHIN = 0.80
MIN_FIRST_WITHIN = 0.50


def verdict(result: dict) -> bool:
    overall = result["all"]
    return (
        overall["frames"] >= MIN_FRAMES
        and overall["best_within"] >= MIN_BEST_WITHIN
        and overall["first_within"] >= MIN_FIRST_WITHIN
    )


def gate(network_file: Path, frames_dir: Path, out: Path) -> dict:
    root = storage.external_directory(out)
    data = load_split(frames_dir)
    if data["record"]["settings"]["split"] != "held_out":
        raise ValueError("The gate reads held-out frames only")
    stored = network_file.read_bytes()
    model = network.Exported(stored)
    measured = measure.measure(*answers(model, data["inputs"], torch.device("cpu")), data["views"])
    result = measure.summary(measured, data["modes"])
    report = {
        "network_sha256": provenance.file_sha256(network_file),
        "network_bytes": len(stored),
        "frames_record": data["record"],
        "thresholds": {
            "min_frames": MIN_FRAMES,
            "min_best_within": MIN_BEST_WITHIN,
            "min_first_within": MIN_FIRST_WITHIN,
        },
        "result": result,
        "passed": verdict(result),
        "code": provenance.code_state(),
    }
    provenance.write_json(root / "gate.json", report)
    return report


def main(arguments=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--network", type=Path, required=True)
    parser.add_argument("--frames", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parsed = parser.parse_args(arguments)
    try:
        report = gate(parsed.network, parsed.frames, parsed.out)
    except (storage.StorageError, ValueError, OSError) as error:
        print(f"Refused: {error}", file=sys.stderr)
        return 1
    print(json.dumps({"passed": report["passed"], "result": report["result"]}, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
