"""Views as the network answers them: binned C-arm angles and an in-plane turn.

The angle convention is the planner's own (planner/carm_geometry.py): primary
is positive toward the patient's left, secondary toward the head, and at 0/0
the detector is anterior. A frame can also be turned in its own plane; the
planner's view model has no such turn, so it is defined here: a turn of t
degrees rotates image right and image up counter-clockwise by t about the
viewing direction, as seen looking from the detector toward the source.

One frame can have more than one reading, so the answer is a score per view
bin and, per bin, where in the bin the view lies and how the frame is
turned. Proposals are the best bins that are far enough apart.
"""

from __future__ import annotations

import numpy as np

BIN_DEG = 10.0
PRIMARY_CENTERS = np.arange(-120.0, 120.0 + 1, BIN_DEG)
SECONDARY_CENTERS = np.arange(-50.0, 50.0 + 1, BIN_DEG)
BINS = len(PRIMARY_CENTERS) * len(SECONDARY_CENTERS)
# Row-major over (secondary, primary): bin = secondary_index * 25 + primary_index.
BIN_PRIMARY = np.tile(PRIMARY_CENTERS, len(SECONDARY_CENTERS))
BIN_SECONDARY = np.repeat(SECONDARY_CENTERS, len(PRIMARY_CENTERS))
TURN_UNIT_DEG = 30.0
# A frame teaches every bin whose centre is this close to its view.
TARGET_SIGMA_DEG = 6.0
TARGET_REACH_DEG = 15.0
MAX_PROPOSALS = 5
MIN_SEPARATION_DEG = 20.0


def view_frame(primary_deg, secondary_deg):
    """Image right, image up and isocenter-to-detector unit vectors (arrays ok)."""
    a, b = np.radians(primary_deg), np.radians(secondary_deg)
    sa, ca, sb, cb = np.sin(a), np.cos(a), np.sin(b), np.cos(b)
    zero = np.zeros_like(sa * sb)
    return (
        np.stack([-ca + zero, -sa + zero, zero], axis=-1),
        np.stack([sa * sb, -ca * sb, cb + zero], axis=-1),
        np.stack([-sa * cb, ca * cb, sb + zero], axis=-1),
    )


def turned_frame(primary_deg, secondary_deg, turn_deg):
    """The view frame with image right and up turned in the image plane."""
    u, v, d = view_frame(primary_deg, secondary_deg)
    t = np.radians(turn_deg)
    cos, sin = np.cos(t)[..., None], np.sin(t)[..., None]
    return cos * u + sin * v, cos * v - sin * u, d


def angles_of(direction):
    """Primary and secondary angle of an isocenter-to-detector direction."""
    d = np.asarray(direction, dtype=np.float64)
    d = d / np.linalg.norm(d, axis=-1, keepdims=True)
    return (
        np.degrees(np.arctan2(-d[..., 0], d[..., 1])),
        np.degrees(np.arcsin(np.clip(d[..., 2], -1, 1))),
    )


def turn_of(up, primary_deg, secondary_deg):
    """In-plane turn of a frame whose image-up vector is ``up``."""
    u, v, _ = view_frame(primary_deg, secondary_deg)
    up = np.asarray(up, dtype=np.float64)
    return np.degrees(np.arctan2(-(up * u).sum(-1), (up * v).sum(-1)))


def separation_deg(primary_a, secondary_a, primary_b, secondary_b):
    """Angle between two viewing directions."""
    da = view_frame(primary_a, secondary_a)[2]
    db = view_frame(primary_b, secondary_b)[2]
    return np.degrees(np.arccos(np.clip((da * db).sum(-1), -1, 1)))


def targets(primary_deg: float, secondary_deg: float, turn_deg: float):
    """What one frame teaches: bin weights, and per-bin offsets and turn.

    Weights sum to 1 over the bins within ``TARGET_REACH_DEG`` of the view
    (the nearest bin always counts). Offsets are in bin widths.
    """
    apart = separation_deg(primary_deg, secondary_deg, BIN_PRIMARY, BIN_SECONDARY)
    weight = np.exp(-0.5 * (apart / TARGET_SIGMA_DEG) ** 2)
    weight[apart > TARGET_REACH_DEG] = 0
    weight[int(np.argmin(apart))] = max(weight[int(np.argmin(apart))], 1e-6)
    weight = weight / weight.sum()
    offsets = np.stack(
        [(primary_deg - BIN_PRIMARY) / BIN_DEG, (secondary_deg - BIN_SECONDARY) / BIN_DEG], axis=-1
    )
    turn = np.full(BINS, turn_deg / TURN_UNIT_DEG)
    return weight.astype(np.float32), offsets.astype(np.float32), turn.astype(np.float32)


def proposals(scores, offsets, turns):
    """Ranked views from one network answer.

    ``scores`` are per-bin logits, ``offsets`` per-bin (primary, secondary)
    in bin widths and ``turns`` per-bin turns in ``TURN_UNIT_DEG``. Returns
    at most ``MAX_PROPOSALS`` views, best first, no two within
    ``MIN_SEPARATION_DEG``, each with its share of the softmax.
    """
    scores = np.asarray(scores, dtype=np.float64)
    offsets = np.asarray(offsets, dtype=np.float64)
    turns = np.asarray(turns, dtype=np.float64)
    if scores.shape != (BINS,) or offsets.shape != (BINS, 2) or turns.shape != (BINS,):
        raise ValueError("Invalid network answer")
    if not (np.isfinite(scores).all() and np.isfinite(offsets).all() and np.isfinite(turns).all()):
        raise ValueError("Invalid network answer")
    share = np.exp(scores - scores.max())
    share = share / share.sum()
    found: list[dict] = []
    for index in np.argsort(-share, kind="stable"):
        primary = float(np.clip(BIN_PRIMARY[index] + BIN_DEG * offsets[index, 0], -180, 180))
        secondary = float(np.clip(BIN_SECONDARY[index] + BIN_DEG * offsets[index, 1], -90, 90))
        if any(
            separation_deg(primary, secondary, other["primary_deg"], other["secondary_deg"])
            < MIN_SEPARATION_DEG
            for other in found
        ):
            continue
        found.append(
            {
                "primary_deg": primary,
                "secondary_deg": secondary,
                "turn_deg": float(np.clip(TURN_UNIT_DEG * turns[index], -180, 180)),
                "share": float(share[index]),
            }
        )
        if len(found) == MAX_PROPOSALS:
            break
    return found
