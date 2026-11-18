"""Python copy of the vessel evidence filter in web/src/vesselEvidence2d.ts.

Training frames are synthetic and are filtered here; real frames are
filtered in the browser. The network only sees one picture of the world if
the two filters agree, so this copy follows the TypeScript arithmetic step
by step, including where a value is stored as float32 between steps. Both
are held to web/src/__fixtures__/vessel-evidence-levels.json.

Not ported: the block average the browser applies to a frame with a side
longer than ``WORK_SIDE_PX``. No synthetic frame is that long, and a longer
one is refused here.
"""

from __future__ import annotations

import math

import numpy as np

MIN_SIDE_PX = 64
WORK_SIDE_PX = 768
RIDGE_SCALES_PX = (1.2, 2, 3.2, 5, 8)
FLOOR_QUANTILE = 0.75
FULL_QUANTILE = 0.995
PEAK_SHARE = 0.25
PEAK_RANK = 50
BLUR_PX = (16, 8, 4, 2, 1)
MIN_RESPONSE = 1.5
STRONG = 0.5
MIN_STRONG_PX = 40


class NoVessels(Exception):
    """The frame holds too few line-like pixels for the filter to answer."""


def _reflect(index: np.ndarray, n: int) -> np.ndarray:
    low = np.minimum(n - 1, -index - 1)
    high = np.maximum(0, 2 * n - index - 1)
    return np.where(index < 0, low, np.where(index >= n, high, index))


def _kernel(sigma: float) -> np.ndarray:
    radius = math.ceil(3 * sigma)
    raw = [math.exp((-i * i) / (2 * sigma * sigma)) for i in range(-radius, radius + 1)]
    total = 0.0
    for value in raw:
        total += value
    stored = np.asarray(raw, dtype=np.float32).astype(np.float64)
    return (stored / total).astype(np.float32).astype(np.float64)


def _along_rows(source: np.ndarray, kernel: np.ndarray) -> np.ndarray:
    radius = (len(kernel) - 1) // 2
    width = source.shape[1]
    padded = source[:, _reflect(np.arange(-radius, width + radius), width)].astype(np.float64)
    total = np.zeros(source.shape, dtype=np.float64)
    for k, weight in enumerate(kernel):
        total += weight * padded[:, k : k + width]
    return total.astype(np.float32)


def blur(source: np.ndarray, sigma: float) -> np.ndarray:
    """Separable Gaussian blur of a float32 image, reflected at the border."""
    kernel = _kernel(sigma)
    rows = _along_rows(source, kernel)
    return np.ascontiguousarray(_along_rows(rows.T, kernel).T)


def _round(value: np.ndarray) -> np.ndarray:
    """JavaScript ``Math.round``: halves go up."""
    return np.floor(value + 0.5)


def ridge_response(image: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Strongest valley response over the scales, and the step across it."""
    height, width = image.shape
    response = np.zeros((height, width), dtype=np.float32)
    across_x = np.zeros((height, width), dtype=np.int64)
    across_y = np.zeros((height, width), dtype=np.int64)
    for sigma in RIDGE_SCALES_PX:
        margin = math.ceil(2 * sigma) + 1
        reach = math.floor(sigma + 0.5)
        if height - 2 * margin <= 0 or width - 2 * margin <= 0:
            continue
        g = blur(image, sigma).astype(np.float64)
        ys, xs = np.mgrid[margin : height - margin, margin : width - margin]
        at = g[ys, xs]
        right, left = g[ys, xs + 1], g[ys, xs - 1]
        below, above = g[ys + 1, xs], g[ys - 1, xs]
        gx = (right - left) / 2
        gy = (below - above) / 2
        a = right - 2 * at + left
        c = below - 2 * at + above
        b = (g[ys + 1, xs + 1] - g[ys + 1, xs - 1] - g[ys - 1, xs + 1] + g[ys - 1, xs - 1]) / 4
        half = (a + c) / 2
        root = np.hypot((a - c) / 2, b)
        strong = half + root
        weak = half - root
        positive = strong > 0
        ratio = np.divide(weak, strong, out=np.zeros_like(weak), where=positive)
        value = sigma * sigma * strong * np.exp(-2 * ratio * ratio) - 0.5 * sigma * np.hypot(gx, gy)
        keep = positive & ~(ratio > 0.5) & (value > response[ys, xs].astype(np.float64))
        ex, ey = b, strong - a
        flat = np.abs(ex) + np.abs(ey) < 1e-12
        ex = np.where(flat, strong - c, ex)
        ey = np.where(flat, b, ey)
        norm = np.hypot(ex, ey)
        norm = np.where(norm == 0, 1.0, norm)
        dx = _round(ex / norm).astype(np.int64)
        dy = _round(ey / norm).astype(np.int64)
        # A vessel is a dip: lower here than one filter width to either side.
        moved = (dx != 0) | (dy != 0)
        dip = (
            moved
            & (at < g[ys + reach * dy, xs + reach * dx])
            & (at < g[ys - reach * dy, xs - reach * dx])
        )
        keep &= dip
        response[ys[keep], xs[keep]] = value[keep].astype(np.float32)
        across_x[ys[keep], xs[keep]] = dx[keep]
        across_y[ys[keep], xs[keep]] = dy[keep]
    return response, across_x, across_y


def crest_evidence(response: np.ndarray, across_x: np.ndarray, across_y: np.ndarray) -> np.ndarray:
    """Evidence from 0 to 1 on the crest of each line, zero elsewhere."""
    height, width = response.shape
    ordered = np.sort(response, axis=None)
    count = ordered.size

    def quantile(q: float) -> float:
        return float(ordered[min(count - 1, math.floor(count * q))])

    low = quantile(FLOOR_QUANTILE)
    high = max(quantile(FULL_QUANTILE), PEAK_SHARE * float(ordered[max(0, count - PEAK_RANK)]))
    evidence = np.zeros((height, width), dtype=np.float32)
    if not (high >= MIN_RESPONSE and high > low):
        return evidence
    wide = response.astype(np.float64)
    ys, xs = np.mgrid[1 : height - 1, 1 : width - 1]
    value = wide[ys, xs]
    dx, dy = across_x[ys, xs], across_y[ys, xs]
    crest = (
        (value > low)
        & ((dx != 0) | (dy != 0))
        & ~(value < wide[ys + dy, xs + dx])
        & ~(value < wide[ys - dy, xs - dx])
    )
    t = (value - low) / (high - low)
    evidence[ys[crest], xs[crest]] = np.where(t >= 1, 1.0, np.sqrt(np.maximum(t, 0)))[crest]
    return evidence


def level(evidence: np.ndarray, sigma: float) -> np.ndarray:
    """One blurred level, scaled so the middle of a full one-pixel line reads 1."""
    radius = math.ceil(3 * sigma)
    middle = 0.0
    for i in range(-radius, radius + 1):
        middle += math.exp((-i * i) / (2 * sigma * sigma))
    scaled = blur(evidence, sigma).astype(np.float64) * middle
    return np.minimum(1.0, scaled).astype(np.float32)


def vessel_evidence(gray: np.ndarray, polarity: str, blur_px=BLUR_PX) -> list[np.ndarray]:
    """Levels of ``gray`` (uint8, rows by columns) at ``blur_px``, in that order.

    Raises ``NoVessels`` where the browser filter would: fewer than
    ``MIN_STRONG_PX`` pixels of strong evidence at the narrowest level.
    """
    if (
        not isinstance(gray, np.ndarray)
        or gray.dtype != np.uint8
        or gray.ndim != 2
        or min(gray.shape) < MIN_SIDE_PX
        or max(gray.shape) > WORK_SIDE_PX
    ):
        raise ValueError("Frame size is outside the supported range")
    if polarity not in ("dark", "bright"):
        raise ValueError("Invalid vessel polarity")
    if any(sigma not in BLUR_PX for sigma in blur_px):
        raise ValueError("Unknown blur width")
    image = gray.astype(np.float32)
    if polarity == "bright":
        image = np.float32(255) - image
    evidence = crest_evidence(*ridge_response(image))
    narrowest = level(evidence, BLUR_PX[-1])
    if int((narrowest >= STRONG).sum()) < MIN_STRONG_PX:
        raise NoVessels("No line-like vessels were found in this frame at this polarity")
    return [narrowest if sigma == BLUR_PX[-1] else level(evidence, sigma) for sigma in blur_px]
