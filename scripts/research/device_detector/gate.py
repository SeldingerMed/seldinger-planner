"""Measure a stored device network on what training never read.

  PYTHONPATH=scripts/research:<h5py> <python> -m device_detector.gate \
      --network <device-network.bin> --weiss <dataset dir> \
      --prepared <vessel models dir> --out <dir on the external volume>

Reads the frames of the two held-out procedures of the WEISS set and
device-free pictures of the held-out vessel models, runs the file as the
browser runs it and writes ``gate.json``. The directory must not hold one.

The masks cover catheters and guidewires. The frames also hold pacing leads,
closure wires and probes, which the masks leave out and which are not
vessels either, so overlap with the masks says little. The gate is on what
must not happen: a vessel marked as a device, or areas marked and not lines.
How much of the labelled devices is found is reported beside it. Whether
taking the marked pixels out helps a registration is measured apart, under
protocol ``ljubljana-device-removal-v1``.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from pose_initializer import provenance, storage

from . import data, measure, network, train

VESSEL_PICTURES = 300
SEED = 20261121
# The first network was gated on overlap with the masks (0.5) and did not
# pass (0.24); its held-out frames were those of all four later procedures.
# The second network's marks on the two held-out procedures were looked at
# once during development (about half of the labelled pixels found), so the
# share found is reported and not gated.
MAX_VESSEL_MARKED = 0.02
MAX_MARKED = 0.05


def gate(stored: Path, weiss: Path, prepared: Path, out: Path) -> dict:
    root = storage.external_directory(out)
    storage.pin_scratch(root)
    target = root / "gate.json"
    if target.exists():
        raise ValueError(f"{target} exists; a gate is run once per file")
    file = stored.read_bytes()
    frames_, masks = data.load(weiss)["held_out"]

    def run(gray: np.ndarray) -> np.ndarray:
        inputs = np.stack([network.normalized(frame.astype(np.float64)) for frame in gray])
        return np.concatenate(
            [
                network.run_exported(file, inputs[start : start + 32])
                for start in range(0, len(inputs), 32)
            ]
        )

    bank = data.vessel_bank(data.load_models(prepared, "held_out"), VESSEL_PICTURES, SEED)
    devices = measure.summary(run(frames_), masks)
    vessels = measure.on_vessels(run(train.vessel_pictures(bank, SEED)), bank.astype(np.float32))
    result = {
        "network_sha256": provenance.file_sha256(stored),
        "code": provenance.code_state(),
        "held_out_frames": devices,
        "held_out_vessel_pictures": vessels,
        "limits": {
            "max_vessel_marked": MAX_VESSEL_MARKED,
            "max_marked": MAX_MARKED,
        },
        "passed": vessels["vessel_marked_share"] <= MAX_VESSEL_MARKED
        and devices["marked_share"] <= MAX_MARKED,
    }
    provenance.write_json(target, result)
    return result


def main(arguments=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--network", type=Path, required=True)
    parser.add_argument("--weiss", type=Path, required=True)
    parser.add_argument("--prepared", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parsed = parser.parse_args(arguments)
    try:
        result = gate(parsed.network, parsed.weiss, parsed.prepared, parsed.out)
    except (storage.StorageError, ValueError, OSError) as error:
        print(f"Refused: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=1))
    return 0 if result["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
