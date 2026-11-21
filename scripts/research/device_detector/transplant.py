"""Lay devices of labelled fluoroscopy frames over other 8-bit frames.

  PYTHONPATH=scripts/research:<h5py> <python> -m device_detector.transplant \
      --network <device-network.bin> --weiss <dataset dir> --split validation \
      --count 6 --frames <dir on the external volume>

For every ``<name>.u8`` with its ``<name>.json`` (width, height) in the
directory, writes ``<name>-d<k>.u8``, the frame with the k-th device over it,
and for the frame itself and each of those a ``.mask.u8`` of the pixels the
stored network marks. A device is carried as the share of light it takes
away where it lies: the labelled frame over the same frame with thin dark
lines closed, inside the widened mask.

Used to measure, on frames with a reference pose, what a device in the frame
does to a registration and what taking its pixels out gives back.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from pose_initializer import storage
from scipy import ndimage

from . import data, network

CLOSE_PX = 9
MASK_GROW_PX = 3
MIN_SHARE = 0.3


def taken(gray: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Share of light left at each pixel by the device: 1 away from it."""
    frame = gray.astype(np.float64) + 1
    ground = ndimage.grey_closing(frame, size=(CLOSE_PX, CLOSE_PX))
    near = ndimage.binary_dilation(mask.astype(bool), iterations=MASK_GROW_PX)
    share = np.where(near, np.clip(frame / ground, MIN_SHARE, 1), 1.0)
    return ndimage.gaussian_filter(share, 0.5)


def spread(grid: np.ndarray, width: int, height: int, order: int) -> np.ndarray:
    """A square grid laid over a frame as ``frames.to_grid`` lays the frame on
    the grid: centred, the grid's side on the frame's longer side."""
    step = max(width, height) / grid.shape[0]
    rows = ((height - grid.shape[0] * step) / 2 + step * 0, step)
    columns = ((width - grid.shape[0] * step) / 2, step)
    y = (np.arange(height) + 0.5 - rows[0]) / rows[1] - 0.5
    x = (np.arange(width) + 0.5 - columns[0]) / columns[1] - 0.5
    return ndimage.map_coordinates(
        grid.astype(np.float64), np.meshgrid(y, x, indexing="ij"), order=order, mode="nearest"
    )


def marked(file: bytes, gray: np.ndarray, polarity: str = "dark") -> np.ndarray:
    """Frame pixels the stored network marks as device, uint8 0 or 1."""
    likely = network.run_exported(file, network.network_input(gray, polarity)[None])[0]
    return network.frame_mask(likely, gray.shape[1], gray.shape[0])


def main(arguments=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--network", type=Path, required=True)
    parser.add_argument("--weiss", type=Path, required=True)
    parser.add_argument("--split", choices=("validation", "held_out"), required=True)
    parser.add_argument("--count", type=int, default=6)
    parser.add_argument("--frames", type=Path, required=True)
    parsed = parser.parse_args(arguments)
    try:
        root = storage.external_directory(parsed.frames)
        file = parsed.network.read_bytes()
        grays, masks = data.load(parsed.weiss)[parsed.split]
        chosen = np.linspace(0, len(grays) - 1, parsed.count).round().astype(int)
        shares = [taken(grays[index], masks[index]) for index in chosen]
        report = {"split": parsed.split, "device_frames": chosen.tolist(), "frames": {}}
        names = sorted(
            path.stem
            for path in root.glob("*.json")
            if not path.name.startswith(".") and (root / f"{path.stem}.u8").exists()
        )
        for name in names:
            size = json.loads((root / f"{name}.json").read_text())
            width, height = size["width"], size["height"]
            gray = np.fromfile(root / f"{name}.u8", dtype=np.uint8).reshape(height, width)
            pictures = {"clean": gray}
            for k, share in enumerate(shares):
                over = np.clip(np.rint(gray * spread(share, width, height, 1)), 0, 255)
                pictures[f"d{k}"] = over.astype(np.uint8)
                pictures[f"d{k}"].tofile(root / f"{name}-d{k}.u8")
            row = {}
            for picture, pixels in pictures.items():
                mask = marked(file, pixels)
                mask.tofile(root / f"{name}-{picture}.mask.u8")
                row[picture] = {"marked_share": round(float(mask.mean()), 5)}
                if picture != "clean":
                    device = spread(masks[chosen[int(picture[1:])]], width, height, 0) > 0.5
                    wide = ndimage.binary_dilation(mask.astype(bool), iterations=4)
                    row[picture]["device_found"] = round(
                        float((device & wide).sum() / max(int(device.sum()), 1)), 4
                    )
            report["frames"][name] = row
        (root / "transplant.json").write_text(json.dumps(report, indent=1) + "\n")
    except (storage.StorageError, ValueError, OSError) as error:
        print(f"Refused: {error}", file=sys.stderr)
        return 1
    found = [
        value["device_found"]
        for row in report["frames"].values()
        for value in row.values()
        if "device_found" in value
    ]
    print(
        json.dumps(
            {
                "frames": len(names),
                "devices": len(shares),
                "device_found_mean": float(np.mean(found)),
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
