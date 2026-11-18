"""Which way a vessel mask faces.

The files of the source do not all say truthfully where the front of the head
is: in three of its six centres most masks are stored back to front. Two
indicators that share nothing are read, and a mask is used only when both are
clear and agree.

1. The midline. In the upper part of the tree the arteries near the midline
   are the anterior cerebral arteries, which lie in front of the middle of the
   tree.
2. Other people. The mask, as labelled and turned, is laid over artery masks
   of other people whose named arteries are where their names say.

Neither tells left from right. A mask stored back to front is put right by
mirroring it front to back; if such a file was in truth turned half round,
the result is a mirrored head, which is a plausible head with its sides
exchanged.
"""

from __future__ import annotations

import numpy as np
from scipy import ndimage

MIDLINE_HALF_WIDTH_MM = 7.0
UPPER_FROM_PERCENT = 55
MIN_MIDLINE_VOXELS = 50
MIN_MIDLINE_MM = 3.0
GRID = 64
CELL_MM = 3.0
SMOOTH_CELLS = 1.5
MIN_LIKENESS_GAP = 0.01
TURNS = {
    "as_labelled": (1, 1, 1),
    "back_to_front": (1, -1, 1),
    "upside_down": (1, 1, -1),
    "upside_down_back_to_front": (1, -1, -1),
}
# Labels of the reference masks that the check of a reference reads.
BASILAR, RIGHT_MIDDLE, LEFT_MIDDLE, ANTERIOR = 1, 5, 7, (11, 12)


def midline_mm(points: np.ndarray) -> float:
    """How far in front of the middle of the tree its upper midline arteries
    lie, in millimeters along +y. Zero when too little lies on the midline."""
    x, y, z = points[:, 0], points[:, 1], points[:, 2]
    middle = (np.percentile(x, 5) + np.percentile(x, 95)) / 2
    chosen = (z > np.percentile(z, UPPER_FROM_PERCENT)) & (
        np.abs(x - middle) < MIDLINE_HALF_WIDTH_MM
    )
    if int(chosen.sum()) < MIN_MIDLINE_VOXELS:
        return 0.0
    return float(y[chosen].mean() - np.median(y))


def _occupancy(points: np.ndarray, turn) -> np.ndarray:
    moved = points * np.asarray(turn, dtype=np.float64)
    index = np.floor((moved - np.median(moved, axis=0)) / CELL_MM).astype(np.int64) + GRID // 2
    inside = ((index >= 0) & (index < GRID)).all(axis=1)
    grid = np.zeros((GRID, GRID, GRID), dtype=np.float32)
    grid[tuple(index[inside].T)] = 1
    return ndimage.gaussian_filter(grid, SMOOTH_CELLS)


def references(point_sets) -> list[tuple[np.ndarray, float]]:
    """What ``likeness`` needs of each reference mask, given as its points."""
    grids = [_occupancy(points, TURNS["as_labelled"]) for points in point_sets]
    return [(np.conj(np.fft.rfftn(grid)), float((grid * grid).sum())) for grid in grids]


def likeness(points: np.ndarray, others) -> dict[str, float]:
    """For each way the mask may be stored, how well it lies over the
    references at the best shift, averaged over them (1 is identical)."""
    if not others:
        raise ValueError("No reference mask to compare with")
    found = {}
    for name, turn in TURNS.items():
        grid = _occupancy(points, turn)
        spectrum, energy = np.fft.rfftn(grid), float((grid * grid).sum())
        found[name] = float(
            np.mean(
                [
                    np.fft.irfftn(spectrum * other, s=grid.shape, axes=(0, 1, 2)).max()
                    / np.sqrt(max(energy * other_energy, 1e-12))
                    for other, other_energy in others
                ]
            )
        )
    return found


def decide(midline: float, like: dict[str, float]) -> str | None:
    """``as_labelled`` or ``back_to_front`` when both indicators are clear
    and agree, otherwise nothing."""
    gap = like["as_labelled"] - like["back_to_front"]
    if max(like, key=like.get) not in ("as_labelled", "back_to_front"):
        return None
    if abs(midline) < MIN_MIDLINE_MM or abs(gap) < MIN_LIKENESS_GAP:
        return None
    if (midline > 0) != (gap > 0):
        return None
    return "as_labelled" if gap > 0 else "back_to_front"


def named_as_labelled(named: np.ndarray, affine: np.ndarray) -> bool | None:
    """Whether a reference's named arteries are where their names say: the
    basilar artery behind the anterior cerebral arteries, and the right
    middle cerebral artery on the right. Nothing when one of them is absent."""
    affine = np.asarray(affine, dtype=np.float64)

    def center(*labels):
        index = np.argwhere(np.isin(named, labels))
        return None if len(index) == 0 else index.mean(axis=0) @ affine[:3, :3].T + affine[:3, 3]

    basilar, front = center(BASILAR), center(*ANTERIOR)
    right, left = center(RIGHT_MIDDLE), center(LEFT_MIDDLE)
    if any(place is None for place in (basilar, front, right, left)):
        return None
    return bool(basilar[1] < front[1] and right[0] > left[0])
