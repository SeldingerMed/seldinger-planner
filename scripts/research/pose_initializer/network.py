"""The view network, its training targets, and the one file it is stored in.

A small residual network reads the two evidence levels on the square grid
and answers, for every view bin, a score, where in the bin the view lies and
how the frame is turned (see ``views.py``).

The stored file is what the browser reads (web/src/poseInitializer.ts):

  bytes 0 to 7   ASCII ``SLDVIEW1``
  bytes 8 to 11  length of the header in bytes, unsigned, little-endian
  then           the header, JSON in UTF-8, padded with spaces to a multiple
                 of four bytes
  then           every tensor as float32, little-endian, in header order

Batch normalization is folded into the convolution before it, so the file
holds only convolutions and one linear layer, each with a bias.
"""

from __future__ import annotations

import json
import struct

import numpy as np
import torch
from torch import nn

from . import frames, views

MAGIC = b"SLDVIEW1"
FORMAT = "seldinger-view-network-v1"
WIDTHS = (24, 48, 96, 192)
BLOCKS = (1, 2, 2, 2)
OUTPUTS_PER_BIN = 4
CHANNELS = len(frames.INPUT_BLUR_PX)
MAX_HEADER_BYTES = 1 << 20


class Block(nn.Module):
    def __init__(self, inputs: int, outputs: int, stride: int):
        super().__init__()
        self.first = nn.Conv2d(inputs, outputs, 3, stride, 1, bias=False)
        self.first_norm = nn.BatchNorm2d(outputs)
        self.second = nn.Conv2d(outputs, outputs, 3, 1, 1, bias=False)
        self.second_norm = nn.BatchNorm2d(outputs)
        self.skip = None
        if stride != 1 or inputs != outputs:
            self.skip = nn.Conv2d(inputs, outputs, 1, stride, 0, bias=False)
            self.skip_norm = nn.BatchNorm2d(outputs)

    def forward(self, x):
        y = torch.relu(self.first_norm(self.first(x)))
        y = self.second_norm(self.second(y))
        if self.skip is not None:
            x = self.skip_norm(self.skip(x))
        return torch.relu(x + y)


class ViewNetwork(nn.Module):
    def __init__(self, widths=WIDTHS, blocks=BLOCKS, channels=CHANNELS, grid=frames.GRID):
        super().__init__()
        self.widths, self.blocks, self.channels = tuple(widths), tuple(blocks), channels
        self.grid = grid
        self.stem = nn.Conv2d(channels, widths[0], 3, 2, 1, bias=False)
        self.stem_norm = nn.BatchNorm2d(widths[0])
        layers, inputs = [], widths[0]
        for stage, (width, count) in enumerate(zip(widths, blocks, strict=True)):
            for index in range(count):
                layers.append(Block(inputs, width, 2 if stage > 0 and index == 0 else 1))
                inputs = width
        self.layers = nn.ModuleList(layers)
        self.head = nn.Linear(inputs, views.BINS * OUTPUTS_PER_BIN)

    def forward(self, x):
        x = torch.relu(self.stem_norm(self.stem(x)))
        for layer in self.layers:
            x = layer(x)
        return split_answer(self.head(x.mean(dim=(2, 3))))


def split_answer(flat):
    """Scores (B, bins), offsets (B, bins, 2) and turns (B, bins)."""
    answer = flat.reshape(flat.shape[0], views.BINS, OUTPUTS_PER_BIN)
    return answer[..., 0], answer[..., 1:3], answer[..., 3]


def targets(view_deg: torch.Tensor):
    """``views.targets`` for a batch of (primary, secondary, turn) in degrees."""
    device, kind = view_deg.device, view_deg.dtype
    centers = torch.as_tensor(
        np.stack([views.BIN_PRIMARY, views.BIN_SECONDARY], axis=-1), device=device, dtype=kind
    )

    def direction(primary, secondary):
        a, b = torch.deg2rad(primary), torch.deg2rad(secondary)
        return torch.stack([-a.sin() * b.cos(), a.cos() * b.cos(), b.sin()], dim=-1)

    cosine = direction(view_deg[:, 0], view_deg[:, 1]) @ direction(centers[:, 0], centers[:, 1]).T
    apart = torch.rad2deg(torch.acos(cosine.clamp(-1, 1)))
    weight = torch.exp(-0.5 * (apart / views.TARGET_SIGMA_DEG) ** 2)
    weight = torch.where(apart > views.TARGET_REACH_DEG, torch.zeros_like(weight), weight)
    nearest = torch.nn.functional.one_hot(apart.argmin(dim=1), views.BINS).to(kind)
    weight = torch.maximum(weight, 1e-6 * nearest)
    weight = weight / weight.sum(dim=1, keepdim=True)
    offsets = (view_deg[:, None, :2] - centers[None]) / views.BIN_DEG
    turn = (view_deg[:, 2:3] / views.TURN_UNIT_DEG).expand(-1, views.BINS)
    return weight, offsets, turn


def loss(answer, view_deg: torch.Tensor, where_weight: float = 2.0):
    """Soft cross-entropy on the bins plus a robust loss on offsets and turn."""
    scores, offsets, turns = answer
    weight, true_offsets, true_turn = targets(view_deg)
    which = -(weight * torch.log_softmax(scores, dim=1)).sum(dim=1).mean()
    huber = torch.nn.functional.smooth_l1_loss
    miss = huber(offsets, true_offsets, reduction="none", beta=0.5).sum(dim=-1) + huber(
        turns, true_turn, reduction="none", beta=0.5
    )
    where = (weight * miss).sum(dim=1).mean()
    return which + where_weight * where, which, where


def _folded(convolution: nn.Conv2d, norm: nn.BatchNorm2d):
    scale = norm.weight / torch.sqrt(norm.running_var + norm.eps)
    return convolution.weight * scale[:, None, None, None], norm.bias - norm.running_mean * scale


def export_bytes(model: ViewNetwork, record: dict) -> bytes:
    """The stored file for ``model`` in evaluation mode, with its record."""
    tensors: list[tuple[str, torch.Tensor]] = []

    def add(name, pair):
        tensors.extend([(f"{name}.weight", pair[0]), (f"{name}.bias", pair[1])])

    with torch.no_grad():
        add("stem", _folded(model.stem, model.stem_norm))
        for index, layer in enumerate(model.layers):
            add(f"layers.{index}.first", _folded(layer.first, layer.first_norm))
            add(f"layers.{index}.second", _folded(layer.second, layer.second_norm))
            if layer.skip is not None:
                add(f"layers.{index}.skip", _folded(layer.skip, layer.skip_norm))
        add("head", (model.head.weight, model.head.bias))
    arrays = [(name, tensor.detach().cpu().numpy().astype("<f4")) for name, tensor in tensors]
    listed, offset = [], 0
    for name, array in arrays:
        listed.append({"name": name, "shape": list(array.shape), "offset": offset})
        offset += array.size
    header = json.dumps(
        {
            "format": FORMAT,
            "grid": model.grid,
            "input_blur_px": list(frames.INPUT_BLUR_PX),
            "channels": model.channels,
            "widths": list(model.widths),
            "blocks": list(model.blocks),
            "bins": views.BINS,
            "outputs_per_bin": OUTPUTS_PER_BIN,
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
        raise ValueError("Not a view network file")
    (length,) = struct.unpack("<I", data[8:12])
    if length > MAX_HEADER_BYTES or length % 4 or 12 + length > len(data):
        raise ValueError("Invalid view network header")
    try:
        header = json.loads(data[12 : 12 + length])
    except ValueError as error:
        raise ValueError("Invalid view network header") from error
    if not isinstance(header, dict) or header.get("format") != FORMAT:
        raise ValueError("Unknown view network format")
    body = np.frombuffer(data, dtype="<f4", offset=12 + length)
    if body.size != header["floats"]:
        raise ValueError("View network file has the wrong length")
    tensors = {}
    for item in header["tensors"]:
        size = int(np.prod(item["shape"]))
        tensors[item["name"]] = body[item["offset"] : item["offset"] + size].reshape(item["shape"])
    return header, tensors


class Exported(nn.Module):
    """The stored file run as it is stored: convolutions with biases, no norms."""

    def __init__(self, data: bytes):
        super().__init__()
        self.header, tensors = read_exported(data)
        # Parameter names may not hold dots.
        self.tensors = nn.ParameterDict(
            {
                name.replace(".", "/"): nn.Parameter(torch.from_numpy(array.copy()), False)
                for name, array in tensors.items()
            }
        )

    def _tensor(self, name: str):
        return self.tensors[name.replace(".", "/")]

    def _convolve(self, x, name, stride):
        weight = self._tensor(f"{name}.weight")
        padding = weight.shape[-1] // 2
        return torch.nn.functional.conv2d(x, weight, self._tensor(f"{name}.bias"), stride, padding)

    def forward(self, x):
        x = torch.relu(self._convolve(x, "stem", 2))
        index = 0
        for stage, count in enumerate(self.header["blocks"]):
            for position in range(count):
                stride = 2 if stage > 0 and position == 0 else 1
                name = f"layers.{index}"
                y = torch.relu(self._convolve(x, f"{name}.first", stride))
                y = self._convolve(y, f"{name}.second", 1)
                if f"{name}/skip/weight".replace(".", "/") in self.tensors:
                    x = self._convolve(x, f"{name}.skip", stride)
                x = torch.relu(x + y)
                index += 1
        flat = x.mean(dim=(2, 3)) @ self._tensor("head.weight").T + self._tensor("head.bias")
        return split_answer(flat)
