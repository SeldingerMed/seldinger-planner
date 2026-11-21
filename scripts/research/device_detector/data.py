"""The labelled frames, their split, and synthetic vessels to tell apart.

The WEISS set is three pairs of HDF5 files of 256 by 256 frames with a mask
of catheters and guidewires: a silicone aortic phantom (2,000 frames), frames
of two procedures with their sequences interleaved (436), and frames of four
more procedures one after another (771, changing at frames 200, 400 and 543).

The split is by procedure, so that nothing is measured on a procedure the
network was trained on: the phantom, the first two procedures and the third
for training, the fourth for validation, the fifth and sixth held out.

Vessels come from the vessel models of part 4 (``pose_initializer``): the
millimeters of filled vessel each pixel's ray crosses, at a random view.

Drawn vessel trees are winding vessels that taper and branch, down to under
a pixel wide: the long thin branches and veins the vessel models leave out.

Drawn devices are random smooth curves of one width, most of them entering
at an edge of the frame and some ending in a tight curl. The six procedures
show few devices in few places; the drawn ones are laid over every kind of
ground, vessels included.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from pose_initializer import frames

SIDE = 256
SOURCE = (
    "WEISS Catheter Segmentation in Fluoroscopy Dataset, UCL, doi 10.5522/04/24624243, CC BY 4.0"
)
FILES = {
    "phantom": ("Phantom.hdf5", "test", "Phantom_label.hdf5"),
    "procedures_a": ("T1T2.hdf5", "train_img", "T1T2_label.hdf5"),
    "procedures_b": ("T3-T6.hdf5", "test", "T3-T6_label.hdf5"),
}
# Where the procedures of the third file begin and end.
THIRD, FOURTH, HELD_OUT = (0, 200), (200, 400), (400, 771)
FIELD_MM = (140.0, 340.0)
# A drawn device is stored as closeness to its line: 1 on it, 0 from this far.
DEVICE_REACH_PX = 12.0
# Millimeters to a grid pixel for a drawn vessel tree.
TREE_MM_PER_PX = 0.8


def _read(folder: Path, name: str) -> tuple[np.ndarray, np.ndarray]:
    import h5py  # Only this function needs it.

    images, key, labels = FILES[name]
    with h5py.File(folder / images, "r") as stored:
        gray = stored[key][..., 0]
    with h5py.File(folder / labels, "r") as stored:
        mask = stored["label"][..., 0]
    if gray.shape != mask.shape or gray.shape[1:] != (SIDE, SIDE):
        raise ValueError(f"{images} and {labels} do not match")
    return np.clip(np.rint(gray), 0, 255).astype(np.uint8), (mask > 0).astype(np.uint8)


def load(folder: Path) -> dict:
    """Frames and masks of each split, uint8, in stored order."""
    phantom = _read(folder, "phantom")
    first = _read(folder, "procedures_a")
    later = _read(folder, "procedures_b")
    if len(later[0]) != HELD_OUT[1]:
        raise ValueError("The third file does not have the frames the split names")

    def cut(span):
        return tuple(part[span[0] : span[1]] for part in later)

    third = cut(THIRD)
    return {
        "training": tuple(
            np.concatenate([a, b, c]) for a, b, c in zip(phantom, first, third, strict=True)
        ),
        "validation": cut(FOURTH),
        "held_out": cut(HELD_OUT),
        # Training frames in order: the phantom's, then the procedures'.
        "training_groups": (len(phantom[0]), len(first[0]) + len(third[0])),
    }


def vessel_view(rng) -> dict:
    """A random view onto a square frame of ``SIDE`` pixels."""
    view = frames.choose_view(rng)
    field = float(rng.uniform(*FIELD_MM))
    return {
        **view,
        "width_px": SIDE,
        "height_px": SIDE,
        "detector_width_mm": field,
        "detector_height_mm": field,
    }


def vessel_length(model: dict, rng) -> np.ndarray | None:
    """Millimeters of filled vessel under each pixel, or ``None`` for too few."""
    shown, weight, _ = frames.choose_filling(model, rng)
    if int(shown.sum()) < 500:
        return None
    points = model["points"][shown].astype(np.float64)
    isocenter = points.mean(axis=0) + rng.uniform(-30, 30, size=3)
    repeat = 3
    jitter = (rng.random((repeat, len(points), 3)) - 0.5) @ model["edges"].astype(np.float64)
    length = frames.thickness(
        (points[None] + jitter).reshape(-1, 3),
        np.tile(weight[shown] / repeat, repeat),
        vessel_view(rng),
        isocenter,
        float(model["voxel_mm3"]),
    )
    return frames._smooth(length, rng.uniform(0.7, 1.6)).astype(np.float32)


def vessel_bank(models: list[dict], count: int, seed: int) -> np.ndarray:
    """``count`` vessel pictures, float16, from the models in turn."""
    rng = np.random.default_rng(seed)
    bank = np.zeros((count, SIDE, SIDE), dtype=np.float16)
    made = tries = 0
    while made < count:
        tries += 1
        if tries > 20 * count:
            raise ValueError("The vessel models give too few pictures")
        length = vessel_length(models[tries % len(models)], rng)
        if length is None or float(length.max()) < 1:
            continue
        bank[made] = np.minimum(length, 60000)
        made += 1
    return bank


def device_closeness(rng) -> np.ndarray | None:
    """One random smooth curve as closeness to it, or ``None`` for too short."""
    from scipy import ndimage

    if rng.random() < 0.8:
        along, edge = rng.uniform(0, SIDE), int(rng.integers(4))
        at = [(along, 0.0), (SIDE - 1.0, along), (along, SIDE - 1.0), (0.0, along)][edge]
        heading = np.radians([90, 180, 270, 0][edge] + rng.uniform(-50, 50))
    else:
        at = tuple(rng.uniform(0.2 * SIDE, 0.8 * SIDE, size=2))
        heading = rng.uniform(0, 2 * np.pi)
    steps = int(rng.uniform(120, 840))
    bend = ndimage.gaussian_filter1d(rng.normal(size=steps), rng.uniform(16, 80))
    bend = bend / (bend.std() + 1e-9) * rng.uniform(0.001, 0.015)
    if rng.random() < 0.4:
        tip = int(rng.uniform(30, 120))
        bend[-tip:] += rng.choice([-1, 1]) * rng.uniform(0.015, 0.06)
    turn = heading + np.cumsum(bend)
    x = at[0] + np.cumsum(np.cos(turn)) * 0.5
    y = at[1] + np.cumsum(np.sin(turn)) * 0.5
    inside = (x > -0.5) & (x < SIDE - 0.5) & (y > -0.5) & (y < SIDE - 0.5)
    stop = len(inside) if inside.all() else int(np.argmin(inside))
    if stop < 80:
        return None
    line = np.zeros((SIDE, SIDE), dtype=bool)
    line[np.rint(y[:stop]).astype(int), np.rint(x[:stop]).astype(int)] = True
    away = ndimage.distance_transform_edt(~line)
    return np.clip(1 - away / DEVICE_REACH_PX, 0, 1).astype(np.float32)


def device_bank(count: int, seed: int) -> np.ndarray:
    """``count`` drawn devices as closeness in 0 to 255, uint8."""
    rng = np.random.default_rng(seed)
    bank = np.zeros((count, SIDE, SIDE), dtype=np.uint8)
    made = 0
    while made < count:
        drawn = device_closeness(rng)
        if drawn is not None:
            bank[made] = np.rint(drawn * 255)
            made += 1
    return bank


def tree_length(rng) -> np.ndarray:
    """Millimeters of filled vessel for one to three drawn trees: winding
    vessels that taper and branch, down to under a pixel wide.

    The vessel models end at the larger arteries. A frame also shows long
    thin branches and veins, which alone look like a wire; these stand for
    them, and nothing of them is to be marked."""
    from scipy import ndimage

    xs, ys, rs = [], [], []

    def grow(x0, y0, heading, radius, length, depth):
        steps = max(int(length / 0.5), 8)
        wander = ndimage.gaussian_filter1d(rng.normal(size=steps), rng.uniform(8, 40))
        wander = wander / (wander.std() + 1e-9) * rng.uniform(0.15, 0.7)
        turn = heading + wander - wander[0]
        x = x0 + np.cumsum(np.cos(turn)) * 0.5
        y = y0 + np.cumsum(np.sin(turn)) * 0.5
        r = radius * np.linspace(1, rng.uniform(0.45, 0.9), steps)
        xs.append(x), ys.append(y), rs.append(r)
        if depth == 4:
            return
        for _ in range(int(rng.integers(2, 5) if depth < 2 else rng.integers(1, 4))):
            k = int(rng.integers(steps // 6, steps))
            child = r[k] * rng.uniform(0.55, 0.85)
            if child >= 0.15:
                side = rng.choice([-1, 1]) * rng.uniform(0.35, 1.3)
                grow(x[k], y[k], turn[k] + side, child, length * rng.uniform(0.45, 0.9), depth + 1)

    for _ in range(int(rng.integers(1, 4))):
        if rng.random() < 0.7:
            along, edge = rng.uniform(0, SIDE), int(rng.integers(4))
            at = [(along, 0.0), (SIDE - 1.0, along), (along, SIDE - 1.0), (0.0, along)][edge]
            heading = np.radians([90, 180, 270, 0][edge] + rng.uniform(-50, 50))
        else:
            at = tuple(rng.uniform(0.2 * SIDE, 0.8 * SIDE, size=2))
            heading = rng.uniform(0, 2 * np.pi)
        grow(at[0], at[1], heading, rng.uniform(0.6, 2.6), rng.uniform(100, 260), 0)
    # Drawn at twice the grid, then averaged, so a thin vessel is not broken.
    fine = 2 * SIDE
    x, y, r = (2 * np.concatenate(v) for v in (xs, ys, rs))
    x, y = x + 0.5, y + 0.5
    # Under 0.8 of a fine pixel the radius is held and the depth lowered,
    # which keeps the vessel's cross-section.
    held = np.maximum(r, 0.8)
    depth = (r / held) ** 2
    canvas = np.zeros(fine * fine)
    for wide in (False, True):
        chosen = (held > 2) == wide
        if not chosen.any():
            continue
        reach = int(np.ceil(held[chosen].max())) + 1
        offsets = np.arange(-reach, reach + 1)
        column = np.rint(x[chosen])[:, None, None] + offsets[None, None, :]
        row = np.rint(y[chosen])[:, None, None] + offsets[None, :, None]
        away = (column - x[chosen][:, None, None]) ** 2 + (row - y[chosen][:, None, None]) ** 2
        chord = 2 * np.sqrt(np.clip(held[chosen][:, None, None] ** 2 - away, 0, None))
        chord = chord * depth[chosen][:, None, None]
        row, column = np.broadcast_arrays(row, column)
        inside = (column >= 0) & (column < fine) & (row >= 0) & (row < fine) & (chord > 0)
        np.maximum.at(canvas, (row[inside] * fine + column[inside]).astype(np.int64), chord[inside])
    pooled = canvas.reshape(SIDE, 2, SIDE, 2).mean(axis=(1, 3))
    return (pooled / 2 * TREE_MM_PER_PX).astype(np.float32)


def tree_bank(count: int, seed: int) -> np.ndarray:
    """``count`` pictures of drawn vessel trees, float16."""
    rng = np.random.default_rng(seed)
    return np.stack([tree_length(rng) for _ in range(count)]).astype(np.float16)


def load_models(prepared: Path, split: str) -> list[dict]:
    """The vessel models of one split of ``pose_initializer.prepare``."""
    import json

    listed = json.loads((prepared / "manifest.json").read_text())["cases"]
    models = []
    for case in listed:
        if case.get("split") != split or "model_file" not in case:
            continue
        with np.load(prepared / case["model_file"]) as stored:
            models.append({name: stored[name] for name in stored.files})
    if not models:
        raise ValueError(f"No vessel models of the {split} split in {prepared}")
    return models
