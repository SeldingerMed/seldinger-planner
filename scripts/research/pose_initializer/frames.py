"""Synthetic angiographic frames of a vessel model, and the network's input.

A frame is drawn through the planner's own camera model (the view frame and
pinhole of planner/carm_geometry.py, plus an in-plane turn): each voxel adds
its volume to the pixels it lands on, giving the length of vessel each ray
crosses, and contrast darkens the frame by that length. What is filled, how
far, the view, the distances, the field, the frame size, the things that are
not vessels and the noise are all drawn at random.

The picture is deliberately simple. There is no bone, no soft tissue and no
flow; the frame passes through the vessel evidence filter before the network
sees it, and only what survives that filter needs to look right.
"""

from __future__ import annotations

import numpy as np

from . import evidence, views

GRID = 128
INPUT_BLUR_PX = (8, 2)
PRIMARY_RANGE_DEG = 125.0
SECONDARY_RANGE_DEG = 55.0
TURN_RANGE_DEG = 25.0
SIDE_PX = (320, 640)
MODES = ("all", "cell", "spill")
MODE_SHARE = (0.2, 0.5, 0.3)
MAX_TRIES = 8


def to_grid(level: np.ndarray, size: int = GRID) -> np.ndarray:
    """Area average of one level onto a square grid.

    The frame is centred and its longer side fills the grid; cells beyond
    the shorter side are zero. Mirrored by web/src/poseInitializer.ts.
    """
    height, width = level.shape
    step = max(height, width) / size

    def weights(length: int) -> np.ndarray:
        start = (length - size * step) / 2 + step * np.arange(size)
        pixel = np.arange(length)
        overlap = np.minimum(start[:, None] + step, pixel[None] + 1) - np.maximum(
            start[:, None], pixel[None]
        )
        return np.clip(overlap, 0, None) / step

    return (weights(height) @ level.astype(np.float64) @ weights(width).T).astype(np.float32)


def network_input(gray: np.ndarray, polarity: str) -> np.ndarray:
    """The two evidence levels the network reads, each on the square grid."""
    levels = evidence.vessel_evidence(gray, polarity, blur_px=INPUT_BLUR_PX)
    return np.stack([to_grid(level) for level in levels])


def project(points, view: dict, isocenter) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Pixel column and row (fractional, pixel centres at halves) and depth."""
    u, v, d = views.turned_frame(view["primary_deg"], view["secondary_deg"], view["turn_deg"])
    source = np.asarray(isocenter, dtype=np.float64) - d * view["source_isocenter_mm"]
    relative = np.asarray(points, dtype=np.float64) - source
    depth = relative @ d
    scale = view["source_detector_mm"] / depth
    x = (relative @ u) * scale / view["detector_width_mm"] + 0.5
    y = 0.5 - (relative @ v) * scale / view["detector_height_mm"]
    return x * view["width_px"], y * view["height_px"], depth


def thickness(points, weight, view: dict, isocenter, voxel_mm3: float) -> np.ndarray:
    """Millimeters of vessel each pixel's ray crosses."""
    width, height = view["width_px"], view["height_px"]
    column, row, depth = project(points, view, isocenter)
    ahead = depth > 1
    # A pixel's footprint at the depth of the voxel, in square millimeters.
    pixel_mm = view["detector_width_mm"] / width
    amount = weight * voxel_mm3 / (pixel_mm * depth / view["source_detector_mm"]) ** 2
    column, row = column - 0.5, row - 0.5
    left, top = np.floor(column).astype(np.int64), np.floor(row).astype(np.int64)
    fx, fy = column - left, row - top
    image = np.zeros(height * width)
    for dx, dy, share in (
        (0, 0, (1 - fx) * (1 - fy)),
        (1, 0, fx * (1 - fy)),
        (0, 1, (1 - fx) * fy),
        (1, 1, fx * fy),
    ):
        x, y = left + dx, top + dy
        inside = ahead & (x >= 0) & (x < width) & (y >= 0) & (y < height)
        image += np.bincount(
            y[inside] * width + x[inside], weights=(amount * share)[inside], minlength=image.size
        )
    return image.reshape(height, width)


def _smooth(image: np.ndarray, sigma: float) -> np.ndarray:
    return evidence.blur(image.astype(np.float32), sigma).astype(np.float64)


def _curve(rng, shape, start, end, wander: float) -> np.ndarray:
    """Distance in pixels from every pixel to a bent line from start to end."""
    height, width = shape
    t = np.linspace(0, 1, 96)[:, None]
    start, end = np.asarray(start, dtype=np.float64), np.asarray(end, dtype=np.float64)
    bend = rng.normal(0, wander, size=(2, 2))
    path = (
        (1 - t) ** 3 * start
        + 3 * (1 - t) ** 2 * t * (start + (end - start) / 3 + bend[0])
        + 3 * (1 - t) * t**2 * (start + 2 * (end - start) / 3 + bend[1])
        + t**3 * end
    )
    ys, xs = np.mgrid[:height, :width]
    nearest = np.full(shape, np.inf)
    for px, py in path:
        np.minimum(nearest, np.hypot(xs + 0.5 - px, ys + 0.5 - py), out=nearest)
    return nearest


def choose_filling(model: dict, rng) -> tuple[np.ndarray, np.ndarray, str]:
    """Which voxels are filled, how strongly, and the mode that was drawn."""
    count = len(model["points"])
    mode = str(rng.choice(MODES, p=MODE_SHARE))
    weight = np.ones(count)
    if mode == "all":
        shown = np.ones(count, dtype=bool)
    else:
        which = int(rng.integers(len(model["inlets"])))
        own = model["cell"] == model["inlets"][which]
        along = model["along"][which].astype(np.float64)
        if not own.any():
            return own, weight, mode
        far = float(np.quantile(along[own], 0.9))
        if mode == "cell":
            # Sometimes early in the injection: only the first part is filled.
            limit = far * rng.uniform(0.35, 1.0) if rng.random() < 0.4 else np.inf
            shown = own & (along <= limit)
        else:
            shown = own | (along <= far * rng.uniform(1.0, 1.4))
        # Contrast thins out with distance from the inlet.
        fade = rng.uniform(0, 0.6)
        weight = 1 - fade * np.clip(np.where(np.isfinite(along), along, 0) / max(far, 1), 0, 1)
    if rng.random() < 0.25:
        z = model["points"][:, 2]
        if rng.random() < 0.5:
            shown = shown & (z <= np.quantile(z, rng.uniform(0.6, 0.95)))
        else:
            shown = shown & (z >= np.quantile(z, rng.uniform(0.05, 0.3)))
    return shown, weight, mode


def choose_view(rng) -> dict:
    side = int(rng.integers(SIDE_PX[0], SIDE_PX[1] + 1))
    width, height = side, side
    if rng.random() < 0.3:
        shorter = int(side * rng.uniform(0.75, 1.0))
        width, height = (shorter, side) if rng.random() < 0.5 else (side, shorter)
    field = rng.uniform(140, 340)
    source_detector = rng.uniform(950, 1250)
    return {
        "primary_deg": float(rng.uniform(-PRIMARY_RANGE_DEG, PRIMARY_RANGE_DEG)),
        "secondary_deg": float(rng.uniform(-SECONDARY_RANGE_DEG, SECONDARY_RANGE_DEG)),
        "turn_deg": float(rng.uniform(-TURN_RANGE_DEG, TURN_RANGE_DEG)),
        "source_detector_mm": float(source_detector),
        "source_isocenter_mm": float(min(rng.uniform(600, 850), source_detector - 250)),
        "detector_width_mm": float(field * width / side),
        "detector_height_mm": float(field * height / side),
        "width_px": width,
        "height_px": height,
    }


def draw(model: dict, shown, weight, view: dict, rng) -> np.ndarray:
    """One 8-bit frame, vessels dark."""
    shape = (view["height_px"], view["width_px"])
    points = model["points"][shown].astype(np.float64)
    isocenter = points.mean(axis=0) + rng.uniform(-30, 30, size=3)
    # Three jittered samples per voxel, so that no gap opens between voxels.
    repeat = 3
    jitter = (rng.random((repeat, len(points), 3)) - 0.5) @ model["edges"].astype(np.float64)
    length = thickness(
        (points[None] + jitter).reshape(-1, 3),
        np.tile(weight[shown] / repeat, repeat),
        view,
        isocenter,
        float(model["voxel_mm3"]),
    )
    length = _smooth(length, rng.uniform(0.7, 1.6))
    absorbed = rng.uniform(0.1, 0.4) * length
    if rng.random() < 0.4:
        # A blush around what is filled.
        haze = _smooth(length, rng.uniform(15, 40))
        absorbed += rng.uniform(0.05, 0.25) * haze / max(float(haze.max()), 1e-6)
    ys, xs = np.mgrid[: shape[0], : shape[1]]
    coarse = rng.normal(0, rng.uniform(3, 18), size=(6, 6))
    gy, gx = ys / shape[0] * 5, xs / shape[1] * 5
    y0, x0 = np.minimum(gy.astype(int), 4), np.minimum(gx.astype(int), 4)
    ty, tx = gy - y0, gx - x0
    background = (
        rng.uniform(150, 215)
        + coarse[y0, x0] * (1 - ty) * (1 - tx)
        + coarse[y0, x0 + 1] * (1 - ty) * tx
        + coarse[y0 + 1, x0] * ty * (1 - tx)
        + coarse[y0 + 1, x0 + 1] * ty * tx
    )
    frame = background * np.exp(-absorbed)
    side = max(shape)
    if rng.random() < 0.5:
        # A catheter: a thin dark line in from the bottom edge.
        start = (rng.uniform(0.2, 0.8) * shape[1], shape[0] + 4)
        end = (rng.uniform(0.2, 0.8) * shape[1], rng.uniform(0.3, 0.9) * shape[0])
        near = _curve(rng, shape, start, end, 0.06 * side)
        frame -= rng.uniform(20, 80) * np.exp(-(near**2) / (2 * rng.uniform(0.8, 1.8) ** 2))
    for _ in range(int(rng.integers(0, 3)) if rng.random() < 0.4 else 0):
        # Faint long edges, as a moved skull leaves after subtraction.
        start = rng.uniform(-0.1, 1.1, size=2) * (shape[1], shape[0])
        end = rng.uniform(-0.1, 1.1, size=2) * (shape[1], shape[0])
        near = _curve(rng, shape, start, end, 0.2 * side)
        frame += rng.uniform(-20, 20) * np.exp(-(near**2) / (2 * rng.uniform(1.5, 5) ** 2))
    frame += rng.normal(0, rng.uniform(1, 6), size=shape)
    if rng.random() < 0.5:
        frame = _smooth(frame, rng.uniform(0.5, 0.9))
    if rng.random() < 0.25:
        # A round field: nothing outside it.
        radius = rng.uniform(0.5, 0.62) * side
        outside = np.hypot(xs + 0.5 - shape[1] / 2, ys + 0.5 - shape[0] / 2) > radius
        frame[outside] = rng.uniform(0, 20)
    return np.clip(np.rint(frame), 0, 255).astype(np.uint8)


def sample(model: dict, rng) -> dict | None:
    """One training example, or ``None`` if no try gave a frame with lines."""
    for _ in range(MAX_TRIES):
        shown, weight, mode = choose_filling(model, rng)
        if int(shown.sum()) < 500:
            continue
        view = choose_view(rng)
        gray = draw(model, shown, weight, view, rng)
        try:
            grid = network_input(gray, "dark")
        except evidence.NoVessels:
            continue
        return {
            "input": np.clip(np.rint(grid * 255), 0, 255).astype(np.uint8),
            "view": view,
            "mode": mode,
            "gray": gray,
        }
    return None
