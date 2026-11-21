"""The device network and the one file it is stored in.

A small U-shaped network reads one 256 by 256 picture and answers, for every
pixel, how much it looks like part of a catheter or a guidewire.

The stored file is what the browser reads (web/src/deviceNetwork.ts):

  bytes 0 to 7   ASCII ``SLDDEVC1``
  bytes 8 to 11  length of the header in bytes, unsigned, little-endian
  then           the header, JSON in UTF-8, padded with spaces to a multiple
                 of four bytes
  then           every tensor as float32, little-endian, in header order

Batch normalization is folded into the convolution before it, so the file
holds only convolutions, each with a bias.
"""

from __future__ import annotations

import json
import struct

import numpy as np
import torch
from pose_initializer import frames
from torch import nn

MAGIC = b"SLDDEVC1"
FORMAT = "seldinger-device-network-v1"
GRID = 256
WIDTHS = (8, 16, 32, 64, 96)
MAX_HEADER_BYTES = 1 << 20


def network_input(gray: np.ndarray, polarity: str) -> np.ndarray:
    """What the network reads for an 8-bit frame: devices dark, on the square
    grid, less its mean and over its spread. Mirrored by deviceNetwork.ts."""
    grid = frames.to_grid(gray.astype(np.float32), GRID).astype(np.float64)
    if polarity == "bright":
        grid = 255 - grid
    elif polarity != "dark":
        raise ValueError("Polarity is dark or bright")
    return normalized(grid).astype(np.float32)


def normalized(grid: np.ndarray) -> np.ndarray:
    return (grid - grid.mean()) / (grid.std() + 1.0)


class Pair(nn.Module):
    """Two 3 by 3 convolutions, each with a norm and a ReLU."""

    def __init__(self, inputs: int, outputs: int):
        super().__init__()
        self.first = nn.Conv2d(inputs, outputs, 3, 1, 1, bias=False)
        self.first_norm = nn.BatchNorm2d(outputs)
        self.second = nn.Conv2d(outputs, outputs, 3, 1, 1, bias=False)
        self.second_norm = nn.BatchNorm2d(outputs)

    def forward(self, x):
        x = torch.relu(self.first_norm(self.first(x)))
        return torch.relu(self.second_norm(self.second(x)))


class DeviceNetwork(nn.Module):
    def __init__(self, widths=WIDTHS):
        super().__init__()
        self.widths = tuple(widths)
        self.down = nn.ModuleList(
            Pair(1 if level == 0 else widths[level - 1], width)
            for level, width in enumerate(widths)
        )
        self.up = nn.ModuleList(
            Pair(widths[level + 1] + widths[level], widths[level])
            for level in range(len(widths) - 1)
        )
        self.head = nn.Conv2d(widths[0], 1, 1)

    def forward(self, x):
        """Logits, (B, 1, GRID, GRID), for inputs of the same size."""
        kept = []
        for level, pair in enumerate(self.down):
            if level:
                x = torch.nn.functional.max_pool2d(x, 2)
            x = pair(x)
            kept.append(x)
        for level in reversed(range(len(self.up))):
            x = torch.nn.functional.interpolate(x, scale_factor=2, mode="nearest")
            x = self.up[level](torch.cat([x, kept[level]], dim=1))
        return self.head(x)


def loss(logits, mask):
    """Cross-entropy on every pixel plus one less the overlap of the batch."""
    truth = mask.float()
    entropy = torch.nn.functional.binary_cross_entropy_with_logits(logits, truth)
    likely = torch.sigmoid(logits)
    overlap = (2 * (likely * truth).sum() + 1) / (likely.sum() + truth.sum() + 1)
    return entropy + 1 - overlap


def _folded(convolution: nn.Conv2d, norm: nn.BatchNorm2d):
    scale = norm.weight / torch.sqrt(norm.running_var + norm.eps)
    return convolution.weight * scale[:, None, None, None], norm.bias - norm.running_mean * scale


def export_bytes(model: DeviceNetwork, record: dict) -> bytes:
    """The stored file for ``model`` in evaluation mode, with its record."""
    tensors: list[tuple[str, torch.Tensor]] = []

    def add(name, pair):
        tensors.extend([(f"{name}.weight", pair[0]), (f"{name}.bias", pair[1])])

    with torch.no_grad():
        for kind, pairs in (("down", model.down), ("up", model.up)):
            for level, pair in enumerate(pairs):
                add(f"{kind}.{level}.first", _folded(pair.first, pair.first_norm))
                add(f"{kind}.{level}.second", _folded(pair.second, pair.second_norm))
        add("head", (model.head.weight, model.head.bias))
    arrays = [(name, tensor.detach().cpu().numpy().astype("<f4")) for name, tensor in tensors]
    listed, offset = [], 0
    for name, array in arrays:
        listed.append({"name": name, "shape": list(array.shape), "offset": offset})
        offset += array.size
    header = json.dumps(
        {
            "format": FORMAT,
            "grid": GRID,
            "widths": list(model.widths),
            "floats": offset,
            "tensors": listed,
            "record": record,
        },
        sort_keys=True,
    ).encode()
    header += b" " * (-len(header) % 4)
    body = b"".join(array.tobytes() for _, array in arrays)
    return MAGIC + struct.pack("<I", len(header)) + header + body


def read_exported(data: bytes) -> tuple[dict, dict[str, np.ndarray]]:
    """Header and tensors of a stored file, or ``ValueError``."""
    if len(data) < 12 or data[:8] != MAGIC:
        raise ValueError("Not a device network file")
    (length,) = struct.unpack("<I", data[8:12])
    if length > MAX_HEADER_BYTES or length % 4 or 12 + length > len(data):
        raise ValueError("Invalid device network header")
    try:
        header = json.loads(data[12 : 12 + length])
    except ValueError as error:
        raise ValueError("Invalid device network header") from error
    if not isinstance(header, dict) or header.get("format") != FORMAT:
        raise ValueError("Unknown device network format")
    body = np.frombuffer(data, dtype="<f4", offset=12 + length)
    if body.size != header["floats"]:
        raise ValueError("Device network file has the wrong length")
    tensors = {}
    for item in header["tensors"]:
        size = int(np.prod(item["shape"]))
        tensors[item["name"]] = body[item["offset"] : item["offset"] + size].reshape(item["shape"])
    return header, tensors


def run_exported(data: bytes, inputs: np.ndarray) -> np.ndarray:
    """Likelihoods (B, GRID, GRID) from a stored file, as the browser runs it:
    convolutions with biases and no norms."""
    header, stored = read_exported(data)
    tensors = {name: torch.from_numpy(value.copy()) for name, value in stored.items()}
    levels = len(header["widths"])
    convolve = torch.nn.functional.conv2d

    def pair(x, name):
        for part in ("first", "second"):
            x = torch.relu(
                convolve(
                    x, tensors[f"{name}.{part}.weight"], tensors[f"{name}.{part}.bias"], padding=1
                )
            )
        return x

    with torch.no_grad():
        x = torch.from_numpy(np.asarray(inputs, dtype=np.float32))[:, None]
        kept = []
        for level in range(levels):
            if level:
                x = torch.nn.functional.max_pool2d(x, 2)
            x = pair(x, f"down.{level}")
            kept.append(x)
        for level in reversed(range(levels - 1)):
            x = torch.nn.functional.interpolate(x, scale_factor=2, mode="nearest")
            x = pair(torch.cat([x, kept[level]], dim=1), f"up.{level}")
        return torch.sigmoid(convolve(x, tensors["head.weight"], tensors["head.bias"]))[
            :, 0
        ].numpy()
