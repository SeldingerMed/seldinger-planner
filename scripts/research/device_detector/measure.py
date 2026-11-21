"""How well marked pixels match a mask."""

from __future__ import annotations

import numpy as np

from .network import THRESHOLD

# A marked pixel within this many pixels of the mask counts as on it, and
# the other way round: the masks are drawn by hand along thin lines.
NEAR_PX = 2


def widened(mask: np.ndarray, by: int = NEAR_PX) -> np.ndarray:
    """Each mask of a stack grown by ``by`` pixels (a square neighbourhood)."""
    out = mask.astype(bool).copy()
    for axis in (1, 2):
        grown = out.copy()
        for shift in range(1, by + 1):
            for sign in (1, -1):
                moved = np.roll(out, sign * shift, axis=axis)
                index = [slice(None)] * 3
                index[axis] = slice(0, shift) if sign == 1 else slice(-shift, None)
                moved[tuple(index)] = False
                grown |= moved
        out = grown
    return out


def summary(likely: np.ndarray, mask: np.ndarray) -> dict:
    """Overlap of a stack of likelihoods with a stack of masks."""
    marked, truth = likely >= THRESHOLD, mask.astype(bool)
    both = (marked & truth).sum(axis=(1, 2))
    sizes = marked.sum(axis=(1, 2)) + truth.sum(axis=(1, 2))
    dice = np.where(sizes > 0, 2 * both / np.maximum(sizes, 1), 1.0)
    found = (truth & widened(marked)).sum() / max(int(truth.sum()), 1)
    right = (marked & widened(truth)).sum() / max(int(marked.sum()), 1)
    return {
        "frames": len(mask),
        "dice_mean": round(float(dice.mean()), 4),
        "dice_median": round(float(np.median(dice)), 4),
        "dice_pooled": round(float(2 * both.sum() / max(int(sizes.sum()), 1)), 4),
        # Share of device pixels with a marked pixel within NEAR_PX.
        "found": round(float(found), 4),
        # Share of marked pixels with a device pixel within NEAR_PX.
        "right": round(float(right), 4),
        "marked_share": round(float(marked.mean()), 5),
    }


def on_vessels(likely: np.ndarray, length_mm: np.ndarray, filled_mm: float = 1.0) -> dict:
    """How much of a stack of device-free vessel pictures is marked."""
    marked, vessel = likely >= THRESHOLD, length_mm >= filled_mm
    return {
        "frames": len(likely),
        "marked_share": round(float(marked.mean()), 5),
        "vessel_marked_share": round(float((marked & vessel).sum() / max(int(vessel.sum()), 1)), 5),
        "frames_with_marks": int((marked.sum(axis=(1, 2)) > 20).sum()),
    }
